"""Real .NET process failures against a loopback stub and FILE simulation, never Windows QoS.
Build tests/agent-harness/AgentHarness.csproj first. Uses only Python stdlib.
"""
import copy
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
DOTNET = os.environ.get('PANELTECH_DOTNET') or shutil.which('dotnet') or '/workspace/.tools/dotnet/dotnet'
DLL = ROOT / 'tests/agent-harness/bin/Release/net8.0/AgentHarness.dll'
TOKEN = 'ab' * 32
DEVICE = str(uuid.uuid4())


def wait_for(predicate, timeout=8):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return
        time.sleep(.02)
    raise AssertionError('Timed out waiting for process evidence')


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.send_response(200 if self.path == '/__paneltech_test_stub__' else 404)
        self.end_headers()
        self.wfile.write(b'PANELTECH FILE SIMULATION ONLY')

    def do_POST(self):
        stub = self.server
        if self.headers.get('Transfer-Encoding', '').lower() == 'chunked':
            chunks = []
            while True:
                size = int(self.rfile.readline().split(b';')[0], 16)
                if size == 0:
                    while self.rfile.readline() != b'\r\n':
                        pass
                    break
                chunks.append(self.rfile.read(size))
                assert self.rfile.read(2) == b'\r\n'
            raw = b''.join(chunks)
        else:
            raw = self.rfile.read(int(self.headers['Content-Length']))
        body = json.loads(raw)
        stub.requests.append((self.path, body))
        status = 401 if stub.revoked else 200
        if self.headers.get('Authorization') != 'Bearer ' + TOKEN:
            status = 401
        if status == 401:
            response = {'code': 'device'}
        elif self.path == '/api/agent/poll':
            stub.polls.append(body)
            job = stub.job
            stub.job = None
            response = {'job': job, 'allowedVariants': [36], 'serverTime': int(time.time() * 1000)}
            if stub.malformed:
                stub.malformed = False
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"broken":"SECRET_RESPONSE_CANARY"')
                return
        elif self.path.startswith('/api/agent/results/'):
            stub.results.append(body)
            if stub.drop_response:
                stub.drop_response = False
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
                return
            response = {'accepted': True}
        else:
            status, response = 404, {}
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(response).encode())


class Recovery(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='paneltech-recovery-')
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name)
        self.identity = self.state / 'identity.json'
        self.receipts = self.state / 'receipts.json'
        self.identity.write_text(json.dumps({'deviceId': DEVICE, 'deviceToken': TOKEN}))
        self.receipts.write_text('[]')
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.server.job = self.job()
        self.server.requests, self.server.polls, self.server.results = [], [], []
        self.server.revoked = self.server.drop_response = self.server.malformed = False
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.config = self.state / 'config.json'
        self.config.write_text(json.dumps({'serverUrl': f'http://127.0.0.1:{self.server.server_port}',
                                          'stateDirectory': str(self.state), 'name': 'TEST SIMULATION'}))
        self.processes, self.logs = [], []
        self.addCleanup(self.stop_all)

    def job(self):
        return {'id': str(uuid.uuid4()), 'deviceId': DEVICE, 'bootId': 'test-boot',
                'gameId': 'game', 'operation': 'apply_marking', 'exes': ['game.exe'],
                'variant': 36, 'allowedVariants': [36], 'expires': int(time.time()*1000)+30000}

    def start(self, barrier='', offset=0, boot='test-boot'):
        log = open(self.state / f'process-{len(self.logs)}.log', 'w+')
        self.logs.append(log)
        env = dict(os.environ, DOTNET_CLI_HOME='/tmp/paneltech-dotnet-home')
        p = subprocess.Popen([DOTNET, str(DLL), str(self.config), barrier, str(offset), boot],
                             cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, env=env)
        self.processes.append(p)
        return p

    def stop_all(self):
        for p in self.processes:
            if p.poll() is None:
                p.kill()
            p.wait(timeout=5)
        for log in self.logs:
            log.seek(0)
            contents = log.read()
            log.close()
            self.assertNotIn(TOKEN, contents)
            self.assertNotIn('SECRET_RESPONSE_CANARY', contents)
            self.assertNotIn('SECRET_STATE_CANARY', contents)

    def count(self):
        p = self.state / 'fake-executions.txt'
        return len(p.read_text().splitlines()) if p.exists() else 0

    def crash_at(self, barrier):
        p = self.start(barrier)
        wait_for(lambda: (self.state / 'barrier').exists())
        p.kill()
        p.wait(timeout=5)
        (self.state / 'barrier').unlink()

    def delivered(self):
        return any(r['delivered'] for r in json.loads(self.receipts.read_text()))

    def test_crash_after_receipt_never_executes_on_restart(self):
        self.crash_at('receipt_saved')
        self.assertEqual(self.count(), 0)
        self.start()
        wait_for(lambda: self.server.results and self.delivered())
        self.assertEqual(self.server.results[0]['code'], 'process_interrupted')
        self.assertEqual(self.server.results[0]['state'], 'unknown')
        self.assertEqual(self.count(), 0)

    def test_crash_after_effect_inspects_without_repeating(self):
        self.crash_at('executed')
        self.assertEqual(self.count(), 1)
        self.start()
        wait_for(lambda: self.server.results and len(self.server.polls) >= 2)
        self.assertEqual(self.server.results[0]['state'], 'unknown')
        self.assertEqual(len(self.server.polls[-1]['rules']), 1)  # FILE simulation only
        self.assertEqual(self.count(), 1)

    def test_crash_after_result_resends_cached_result(self):
        self.crash_at('result_saved')
        cached = json.loads(self.receipts.read_text())[0]['result']
        self.start()
        wait_for(lambda: self.server.results and self.delivered())
        self.assertEqual(self.server.results[0], cached)
        self.assertEqual(self.count(), 1)

    def test_lost_ack_retries_identical_outbox(self):
        self.server.drop_response = True
        self.start()
        wait_for(lambda: len(self.server.results) >= 2 and self.delivered())
        self.assertEqual(self.server.results[0], self.server.results[1])
        self.assertEqual(self.count(), 1)

    def test_duplicate_job_id_uses_cached_result(self):
        job = copy.deepcopy(self.server.job)
        self.start()
        wait_for(lambda: self.delivered())
        self.server.job = job
        wait_for(lambda: len(self.server.results) >= 2)
        self.assertEqual(self.server.results[0], self.server.results[1])
        self.assertEqual(self.count(), 1)

    def test_revoked_token_stops_before_any_execution(self):
        self.server.revoked = True
        p = self.start()
        self.assertEqual(p.wait(timeout=8), 1)
        self.assertEqual(len(self.server.requests), 1)
        self.assertEqual(self.count(), 0)

    def test_revocation_keeps_pending_result(self):
        p = self.start('result_saved')
        wait_for(lambda: (self.state / 'barrier').exists())
        before = json.loads(self.receipts.read_text())
        self.server.revoked = True
        (self.state / 'continue').write_text('resume')
        self.assertEqual(p.wait(timeout=8), 1)
        after = json.loads(self.receipts.read_text())
        self.assertEqual(before, after)
        self.assertFalse(after[0]['delivered'])
        self.assertEqual(self.count(), 1)

    def test_expired_job_is_rejected(self):
        self.server.job['expires'] = int(time.time()*1000)-1
        self.start()
        wait_for(lambda: self.server.results)
        self.assertEqual(self.server.results[0]['code'], 'expired')
        self.assertEqual(self.count(), 0)

    def test_clock_skew_both_directions_rejected(self):
        for offset in [-120000, 120000]:
            with self.subTest(offset=offset):
                self.receipts.write_text('[]')
                self.server.results.clear()
                self.server.job = self.job()
                p = self.start(offset=offset)
                wait_for(lambda: self.server.results)
                p.kill()
                p.wait(timeout=5)
                self.assertEqual(self.server.results[0]['code'], 'clock_skew')
                self.assertEqual(self.count(), 0)

    def test_server_deadline_rejects_expiry_with_slow_local_clock(self):
        self.server.job['expires'] = int(time.time()*1000)-1
        self.start(offset=-10000)
        wait_for(lambda: self.server.results)
        self.assertEqual(self.server.results[0]['code'], 'expired')
        self.assertEqual(self.count(), 0)

    def test_expiry_while_paused_after_receipt_prevents_execution(self):
        deadline = int(time.time()*1000)+2000
        self.server.job['expires'] = deadline
        self.start('receipt_saved')
        wait_for(lambda: (self.state / 'barrier').exists())
        wait_for(lambda: int(time.time()*1000) > deadline)
        (self.state / 'continue').write_text('resume')
        wait_for(lambda: self.server.results)
        self.assertEqual(self.server.results[0]['code'], 'expired')
        self.assertEqual(self.count(), 0)

    def test_wrong_boot_job_is_rejected(self):
        self.server.job['bootId'] = 'obsolete-boot'
        self.start()
        wait_for(lambda: len(self.server.polls) >= 2)
        self.assertEqual(self.server.results, [])
        self.assertEqual(json.loads(self.receipts.read_text()), [])
        self.assertEqual(self.count(), 0)

    def test_boot_change_never_replays_old_receipt(self):
        self.crash_at('receipt_saved')
        self.start(boot='next-boot')
        wait_for(lambda: any(p['bootId'] == 'next-boot' for p in self.server.polls))
        self.assertEqual(self.server.results, [])
        self.assertEqual(self.count(), 0)
        self.assertFalse(json.loads(self.receipts.read_text())[0]['delivered'])

    def test_corrupt_state_fails_closed_without_network_or_overwrite(self):
        identity = self.identity.read_text()
        for target, content in [(self.identity, 'null'), (self.identity, '{}'),
                                (self.identity, '{"SECRET_STATE_CANARY":'),
                                (self.receipts, 'null'), (self.receipts, '[null]'),
                                (self.receipts, '[{}]')]:
            with self.subTest(file=target.name, content=content):
                self.identity.write_text(identity)
                self.receipts.write_text('[]')
                target.write_text(content)
                p = self.start()
                self.assertEqual(p.wait(timeout=8), 1)
                self.assertEqual(target.read_text(), content)
                self.assertEqual(self.server.requests, [])
                self.assertEqual(self.count(), 0)

    def test_missing_journal_does_not_reset_execution_history(self):
        self.receipts.unlink()
        p = self.start()
        self.assertEqual(p.wait(timeout=8), 1)
        self.assertFalse(self.receipts.exists())
        self.assertEqual(self.server.requests, [])

    def test_missing_identity_does_not_register_another_device(self):
        self.identity.unlink()
        p = self.start()
        self.assertEqual(p.wait(timeout=8), 1)
        self.assertFalse(self.identity.exists())
        self.assertEqual(self.server.requests, [])

    def test_interrupted_first_write_requires_recovery(self):
        self.identity.unlink()
        self.receipts.unlink()
        temporary = self.state / 'identity.json.tmp'
        temporary.write_text('{"SECRET_STATE_CANARY":')
        p = self.start()
        self.assertEqual(p.wait(timeout=8), 1)
        self.assertTrue(temporary.exists())
        self.assertFalse(self.identity.exists())
        self.assertEqual(self.server.requests, [])

    def test_malformed_poll_does_not_execute_or_leak_response(self):
        self.server.malformed = True
        self.start()
        wait_for(lambda: len(self.server.polls) >= 2)
        self.assertEqual(self.count(), 0)
        self.assertEqual(json.loads(self.receipts.read_text()), [])

    def test_null_exes_rejected_without_execution(self):
        self.server.job['exes'] = None
        self.start()
        wait_for(lambda: self.server.results)
        self.assertEqual(self.server.results[0]['code'], 'invalid_exe')
        self.assertEqual(self.count(), 0)


if __name__ == '__main__':
    if not DLL.exists():
        raise SystemExit('Build tests/agent-harness/AgentHarness.csproj first; see docs/AGENT-RECOVERY-TESTS.md')
    unittest.main(verbosity=2)
