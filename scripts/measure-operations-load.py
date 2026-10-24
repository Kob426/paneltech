"""Automatic backup/restore/retention under bounded Linux open-arrival load; synthetic temporary DB only."""
import argparse
import concurrent.futures
import hashlib
import json
import math
import os
from pathlib import Path
import select
import signal
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


def reap_completed(pending,collect):
    done={future for future in pending if future.done()}
    collect(done)
    pending.difference_update(done)


def run(args):
    with tempfile.TemporaryDirectory(prefix='paneltech-load-') as temporary:
        directory = Path(temporary)
        (directory / 'SYNTHETIC').write_text('PANELTECH SYNTHETIC LOAD ONLY')
        env = dict(os.environ, PANELTECH_LOAD_DIR=temporary, PANELTECH_LOAD_JOBS=str(args.jobs), PANELTECH_LOAD_QUICK='1' if args.quick else '0')
        command = ['node', '--import', 'tsx']
        fixture = subprocess.run(command + ['scripts/load-worker.ts'], cwd=ROOT,
                                 env=dict(env, PANELTECH_LOAD_PHASE='seed'), capture_output=True, text=True, timeout=120)
        assert fixture.returncode == 0, 'Synthetic seed failed: ' + fixture.stderr[-1000:]
        shutil.copyfile(directory / 'template.sqlite', directory / 'case.sqlite')
        print(json.dumps({'fixture': json.loads(fixture.stdout.strip().splitlines()[-1])}), flush=True)
        with open(directory / 'server.err', 'w+') as error_log:
            worker = subprocess.Popen(command + ['scripts/operations-load-worker.ts'], cwd=ROOT, env=env,
                                      stdout=subprocess.PIPE, stderr=error_log, text=True,start_new_session=True)
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
                drop_reasons={'capacity':0,'late':0,'endOfWindow':0}
                drop_samples=[]
                started_jobs, sizes, schedule_lags = [], [], []
                periods = {'heartbeat': 1 / args.heartbeat_rps, 'read': 1 / 6, 'jobs': 5}
                next_due = {kind: 0.0 for kind in latencies}
                pending = set()
                start = time.perf_counter()
                next_backup_poll = 0.0
                observed_ids = set()
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
                        reap_completed(pending,collect)
                        for kind, period in periods.items():
                            while next_due[kind] < args.seconds and next_due[kind] <= elapsed:
                                n = offered[kind]
                                offered[kind] += 1
                                if len(pending)>=MAX_IN_FLIGHT:
                                    reap_completed(pending,collect)
                                if len(pending) >= MAX_IN_FLIGHT or elapsed - next_due[kind] > 1:
                                    dropped[kind] += 1
                                    reason='capacity' if len(pending)>=MAX_IN_FLIGHT else 'late'
                                    drop_reasons[reason]+=1
                                    if len(drop_samples)<20:drop_samples.append({'kind':kind,'reason':reason,'atSeconds':elapsed,'lagSeconds':elapsed-next_due[kind],'pending':len(pending)})
                                else:
                                    pending.add(pool.submit(work, kind, n, next_due[kind]))
                                    max_in_flight = max(max_in_flight, len(pending))
                                next_due[kind] += period
                        if elapsed >= next_backup_poll:
                            current = request(url, '/__soak__/metrics')[0]
                            state = current['backup']
                            assert state['phase'] != 'error', 'Automatic backup failed: '+str(state['error'])
                            if state['phase'] == 'running' and overlap_start is None:
                                overlap_start = current
                            latest = state['latest']
                            if latest and latest['id'] not in observed_ids:
                                assert overlap_start is not None, 'Missed start of automatic backup'
                                observed_ids.add(latest['id'])
                                backups.append({'id':latest['id'],'startedSeconds':overlap_start['elapsedSeconds'],
                                    'finishedSeconds':current['elapsedSeconds'],'markerBefore':overlap_start['markerSequence'],
                                    'markerAfter':current['markerSequence'],'writesContinued':current['markerSequence']>overlap_start['markerSequence'],
                                    'bytes':latest['bytes'],'drill':latest['drill'],'retainedCount':state['count'],
                                    'retainedBytes':state['bytes'],'skipped':state['skipped']})
                                print(json.dumps({'automaticBackup':backups[-1]}),flush=True)
                                overlap_start = None
                            next_backup_poll = elapsed + .2
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
                        drop_reasons['endOfWindow'] += count-offered[kind]
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
                verification = subprocess.run(command + ['scripts/operations-load-worker.ts'], cwd=ROOT,
                    env=dict(env, PANELTECH_SOAK_PHASE='verify'), capture_output=True, text=True, timeout=120)
                assert verification.returncode == 0, 'Restore verification failed: ' + verification.stderr[-1500:]
                assert hashlib.sha256((directory / 'case.sqlite').read_bytes()).hexdigest() == source_hash, 'Restore modified the live source'
                restored = json.loads(verification.stdout.strip().splitlines()[-1])['restored']
                report = {'kind': 'synthetic-linux-automatic-backup-load', 'durationSeconds': args.seconds,
                    'heartbeatOfferedRps': args.heartbeat_rps, 'panelOfferedRps': 6, 'jobBatchEverySeconds': 5,
                    'jobsPerBatch': 4, 'maxInFlightLimit': MAX_IN_FLIGHT, 'maxObservedInFlight': max_in_flight,
                    'offered': offered, 'dropped': dropped,'dropReasons':drop_reasons,'dropSamples':drop_samples, 'errors': len(errors), 'errorDetails': errors[:20],
                    'requests': {kind: {'completed': len(values), 'latencyP50Ms': percentile(values, .5),
                        'latencyP95Ms': percentile(values, .95), 'latencyMaxMs': max(values, default=None)} for kind, values in latencies.items()},
                    'schedulerLagP95Ms': percentile(schedule_lags, .95), 'schedulerLagMaxMs': max(schedule_lags, default=None),
                    'maxResponseBytes': max(sizes, default=None), 'server': info, 'samples': samples, 'final': final,
                    'backups': backups, 'restored': restored, 'windowsQoSVerified': False, 'productionCapacityVerified': False,
                    'liveSourceUnchangedByRestore': True,'quickProfile':args.quick,'automaticIntervalSeconds':30 if args.quick else 300,'startupDelaySeconds':5 if args.quick else 60,'retentionKeep':2,
                    'sourcesSHA256': {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in
                        ['scripts/measure-operations-load.py', 'scripts/operations-load-worker.ts', 'server/core.ts', 'server/app.ts', 'server/store.ts', 'server/database-backup.ts','server/operations.ts','server/automatic-backup.ts','server/backup-task.ts']}}
                report['passed'] = not errors and not any(dropped.values()) and len(backups) >= 3 and final['backup']['count']==2 and final['backup']['skipped']==0 and all(row['writesContinued'] for row in backups)
                print(json.dumps({'result': report}), flush=True)
                assert report['passed'], 'Soak had errors, dropped arrivals or non-overlapping backups'
            finally:
                if backup_process is not None and backup_process.poll() is None:
                    backup_process.kill()
                    backup_process.communicate()
                if worker.poll() is None:
                    worker.kill()
                worker.wait(timeout=10)
                try: os.killpg(worker.pid,signal.SIGKILL)
                except ProcessLookupError: pass
                worker.stdout.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seconds', type=int, default=900)
    parser.add_argument('--heartbeat-rps', type=int, default=600)
    parser.add_argument('--jobs', type=int, choices=[10000, 100000], default=100000)
    parser.add_argument('--quick',action='store_true',help='Synthetic smoke only: 5s startup/30s interval; use 120 seconds')
    args = parser.parse_args()
    if not 30 <= args.seconds <= 3600 or not 1 <= args.heartbeat_rps <= 2000:
        parser.error('seconds must be 30..3600; heartbeat-rps must be 1..2000')
    run(args)
