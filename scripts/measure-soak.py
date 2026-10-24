"""Bounded Linux open-arrival soak with online backups; synthetic temporary DB only."""
import argparse
import concurrent.futures
import hashlib
import json
import math
import os
from pathlib import Path
import select
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
MAX_IN_FLIGHT = 64


def request(url, path, body=None, cookie='', csrf='', token=''):
    headers = {'Content-Type': 'application/json', 'Cookie': cookie, 'X-CSRF-Token': csrf}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(url + path, data=None if body is None else json.dumps(body).encode(), headers=headers)
    with urllib.request.urlopen(req, timeout=10) as response:
        raw = response.read()
        return json.loads(raw), len(raw), response.headers


def percentile(values, p):
    return sorted(values)[min(len(values) - 1, int((len(values) - 1) * p))] if values else None


def run(args):
    with tempfile.TemporaryDirectory(prefix='paneltech-load-') as temporary:
        directory = Path(temporary)
        (directory / 'SYNTHETIC').write_text('PANELTECH SYNTHETIC LOAD ONLY')
        env = dict(os.environ, PANELTECH_LOAD_DIR=temporary, PANELTECH_LOAD_JOBS=str(args.jobs))
        command = ['node', '--import', 'tsx']
        fixture = subprocess.run(command + ['scripts/load-worker.ts'], cwd=ROOT,
                                 env=dict(env, PANELTECH_LOAD_PHASE='seed'), capture_output=True, text=True, timeout=120)
        assert fixture.returncode == 0, 'Synthetic seed failed: ' + fixture.stderr[-1000:]
        shutil.copyfile(directory / 'template.sqlite', directory / 'case.sqlite')
        print(json.dumps({'fixture': json.loads(fixture.stdout.strip().splitlines()[-1])}), flush=True)
        with open(directory / 'server.err', 'w+') as error_log:
            worker = subprocess.Popen(command + ['scripts/soak-worker.ts'], cwd=ROOT, env=env,
                                      stdout=subprocess.PIPE, stderr=error_log, text=True)
            backup_process = None
            try:
                ready, _, _ = select.select([worker.stdout], [], [], 60)
                assert ready, 'Synthetic server startup timeout'
                line = worker.stdout.readline()
                assert line, 'Synthetic server exited before ready'
                info = json.loads(line)
                url = 'http://127.0.0.1:' + str(info.pop('port'))
                info.pop('ready')
                sessions = []
                for n in range(6):
                    login, _, headers = request(url, '/api/login', {'username': 'load' + str(n), 'password': 'SyntheticLoad-2026!'})
                    sessions.append((headers['Set-Cookie'].split(';')[0], login['csrf']))
                tokens = [hashlib.sha256(('SYNTHETIC-LOAD-ONLY-' + str(n)).encode()).hexdigest() for n in range(64, 3380)]
                samples, backups, errors = [], [], []
                latencies = {kind: [] for kind in ['heartbeat', 'read', 'jobs']}
                offered = {kind: 0 for kind in latencies}
                dropped = {kind: 0 for kind in latencies}
                started_jobs, sizes, schedule_lags = [], [], []
                periods = {'heartbeat': 1 / args.heartbeat_rps, 'read': 1 / 6, 'jobs': 5}
                next_due = {kind: 0.0 for kind in latencies}
                pending = set()
                start = time.perf_counter()
                backup_due = [args.seconds * .2, args.seconds * .65]
                backup_started = 0
                next_sample = 0.0
                overlap_start = None
                max_in_flight = 0

                def work(kind, n, due):
                    begin = time.perf_counter()
                    try:
                        if kind == 'heartbeat':
                            payload, size, _ = request(url, '/api/agent/poll',
                                {'bootId': 'load-boot', 'rules': [], 'inspectionVerified': False}, token=tokens[n % len(tokens)])
                            assert payload['job'] is None, 'Unexpected protocol delivery'
                        else:
                            cookie, csrf = sessions[n % 6]
                            if kind == 'read':
                                club = (n // 6 + n % 6 * 9) % 52
                                path = '/api/state?clubId=load-club-' + str(club) + '&gameId=fortnite' if n // 6 % 2 == 0 else '/api/history?clubId=load-club-' + str(club)
                                payload, size, _ = request(url, path, cookie=cookie, csrf=csrf)
                                if 'devices' in payload:
                                    assert len(payload['devices']) == 65
                                    assert all('tokenHash' not in device for device in payload['devices'])
                                else:
                                    assert len(payload['items']) <= 25
                            else:
                                first = n % 15 * 4
                                ids = ['00000000-0000-4000-8000-' + format(i, '012x') for i in range(first, first + 4)]
                                payload, size, _ = request(url, '/api/jobs', {'deviceIds': ids, 'gameId': 'fortnite',
                                    'operation': 'apply_marking', 'variant': 36 if n % 2 == 0 else 40}, cookie, csrf)
                                assert len(payload) == 4 and all(job['demo'] and job['state'] == 'queued' for job in payload)
                        return kind, (time.perf_counter() - begin) * 1000, size, (begin - start - due) * 1000, payload if kind == 'jobs' else None, None
                    except Exception as cause:
                        # Error class/code only; never print bearer tokens, sessions or response bodies.
                        label = type(cause).__name__ + (':' + str(cause.code) if isinstance(cause, urllib.error.HTTPError) else '')
                        return kind, None, 0, 0, None, label

                def collect(futures):
                    for future in futures:
                        kind, latency, size, lag, jobs, error = future.result()
                        if error:
                            errors.append({'kind': kind, 'error': error})
                        else:
                            latencies[kind].append(latency)
                            sizes.append(size)
                            schedule_lags.append(lag)
                            if jobs:
                                started_jobs.extend(job['id'] for job in jobs)

                with concurrent.futures.ThreadPoolExecutor(max_workers=48) as pool:
                    while time.perf_counter() - start < args.seconds:
                        elapsed = time.perf_counter() - start
                        done = {future for future in pending if future.done()}
                        collect(done)
                        pending -= done
                        for kind, period in periods.items():
                            while next_due[kind] < args.seconds and next_due[kind] <= elapsed:
                                n = offered[kind]
                                offered[kind] += 1
                                if len(pending) >= MAX_IN_FLIGHT or elapsed - next_due[kind] > 1:
                                    dropped[kind] += 1
                                else:
                                    pending.add(pool.submit(work, kind, n, next_due[kind]))
                                    max_in_flight = max(max_in_flight, len(pending))
                                next_due[kind] += period
                        if backup_process is not None and backup_process.poll() is not None:
                            output, stderr = backup_process.communicate()
                            assert backup_process.returncode == 0, 'Online backup failed: ' + stderr[-1000:]
                            result = json.loads(output.strip().splitlines()[-1])
                            after = request(url, '/__soak__/metrics')[0]
                            backups.append({'startedSeconds': overlap_start['elapsedSeconds'], 'finishedSeconds': after['elapsedSeconds'],
                                'markerBefore': overlap_start['markerSequence'], 'markerAfter': after['markerSequence'],
                                'writesContinued': after['markerSequence'] > overlap_start['markerSequence'],
                                'bytes': (Path(result['path']) / 'backup.sqlite').stat().st_size, 'schema': result['schemaVersion']})
                            print(json.dumps({'backup': backups[-1]}), flush=True)
                            backup_process = None
                        if backup_process is None and backup_started < 2 and elapsed >= backup_due[backup_started]:
                            overlap_start = request(url, '/__soak__/metrics')[0]
                            backup_process = subprocess.Popen(command + ['scripts/database.ts', 'backup', '--db', str(directory / 'case.sqlite'),
                                '--out', str(directory / 'copies')], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                            backup_started += 1
                        if elapsed >= next_sample:
                            sample = request(url, '/__soak__/metrics')[0]
                            sample.update(completed={kind: len(values) for kind, values in latencies.items()}, dropped=dict(dropped), errors=len(errors))
                            samples.append(sample)
                            print(json.dumps({'sample': sample}), flush=True)
                            next_sample = elapsed + min(30, args.seconds / 4)
                        if backup_process is not None and elapsed - overlap_start['elapsedSeconds'] > 90:
                            raise AssertionError('Backup process exceeded 90-second wall limit')
                        assert worker.poll() is None, 'Synthetic API exited during soak'
                        time.sleep(.002)
                    collect(concurrent.futures.as_completed(pending))
                expected = {'heartbeat': args.seconds * args.heartbeat_rps, 'read': args.seconds * 6, 'jobs': math.ceil(args.seconds / 5)}
                for kind, count in expected.items():
                    if offered[kind] < count:
                        dropped[kind] += count - offered[kind]
                        offered[kind] = count
                if backup_process is not None:
                    raise AssertionError('Backup did not finish inside the measurement window')
                # Let the last DEMO batch complete before stopping; only its own harness is affected.
                time.sleep(1.1)
                final = request(url, '/__soak__/stop', {})[0]
                worker.wait(timeout=20)
                assert worker.returncode == 0 and final['allNewDemoJobsSucceededOnce'], 'DEMO outcome/history invariant failed'
                assert len(started_jobs) == final['addedJobs'] and len(set(started_jobs)) == len(started_jobs)
                source_hash = hashlib.sha256((directory / 'case.sqlite').read_bytes()).hexdigest()
                verification = subprocess.run(command + ['scripts/soak-worker.ts'], cwd=ROOT,
                    env=dict(env, PANELTECH_SOAK_PHASE='verify'), capture_output=True, text=True, timeout=120)
                assert verification.returncode == 0, 'Restore verification failed: ' + verification.stderr[-1500:]
                assert hashlib.sha256((directory / 'case.sqlite').read_bytes()).hexdigest() == source_hash, 'Restore modified the live source'
                restored = json.loads(verification.stdout.strip().splitlines()[-1])['restored']
                report = {'kind': 'synthetic-linux-open-arrival-soak', 'durationSeconds': args.seconds,
                    'heartbeatOfferedRps': args.heartbeat_rps, 'panelOfferedRps': 6, 'jobBatchEverySeconds': 5,
                    'jobsPerBatch': 4, 'maxInFlightLimit': MAX_IN_FLIGHT, 'maxObservedInFlight': max_in_flight,
                    'offered': offered, 'dropped': dropped, 'errors': len(errors), 'errorDetails': errors[:20],
                    'requests': {kind: {'completed': len(values), 'latencyP50Ms': percentile(values, .5),
                        'latencyP95Ms': percentile(values, .95), 'latencyMaxMs': max(values, default=None)} for kind, values in latencies.items()},
                    'schedulerLagP95Ms': percentile(schedule_lags, .95), 'schedulerLagMaxMs': max(schedule_lags, default=None),
                    'maxResponseBytes': max(sizes, default=None), 'server': info, 'samples': samples, 'final': final,
                    'backups': backups, 'restored': restored, 'windowsQoSVerified': False, 'productionCapacityVerified': False,
                    'liveSourceUnchangedByRestore': True,
                    'sourcesSHA256': {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in
                        ['scripts/measure-soak.py', 'scripts/soak-worker.ts', 'server/core.ts', 'server/app.ts', 'server/store.ts', 'server/database-backup.ts']}}
                report['passed'] = not errors and not any(dropped.values()) and len(backups) == 2 and all(row['writesContinued'] for row in backups)
                print(json.dumps({'result': report}), flush=True)
                assert report['passed'], 'Soak had errors, dropped arrivals or non-overlapping backups'
            finally:
                if backup_process is not None and backup_process.poll() is None:
                    backup_process.kill()
                    backup_process.communicate()
                if worker.poll() is None:
                    worker.kill()
                worker.wait(timeout=10)
                worker.stdout.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seconds', type=int, default=600)
    parser.add_argument('--heartbeat-rps', type=int, default=300)
    parser.add_argument('--jobs', type=int, choices=[10000, 100000], default=100000)
    args = parser.parse_args()
    if not 30 <= args.seconds <= 3600 or not 1 <= args.heartbeat_rps <= 2000:
        parser.error('seconds must be 30..3600; heartbeat-rps must be 1..2000')
    run(args)
