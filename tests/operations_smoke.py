"""Wall-clock automatic scheduling/restart on a temporary live DEMO API; no hardware."""
import http.cookiejar
import json
import os
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = 'http://127.0.0.1:3114/api'


def run():
    with tempfile.TemporaryDirectory(prefix='paneltech-schedule-') as temporary:
        directory = Path(temporary)
        env = dict(os.environ, DB_PATH=str(directory/'demo.sqlite'), PORT='3114', ENABLE_REAL_AGENTS='0', AUTO_BACKUP='1', BACKUP_INTERVAL_MINUTES='5', BACKUP_DIRECTORY=str(directory/'backups'))
        client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

        def call(path, body=None):
            data = None if body is None else json.dumps(body).encode()
            request = urllib.request.Request(BASE+path, data=data, headers={'Content-Type': 'application/json'})
            with client.open(request, timeout=5) as response:
                return json.load(response)

        with open(directory/'api.log', 'w+') as log:
            server = None

            def start():
                process = subprocess.Popen(['node', '--import', 'tsx', 'server/index.ts'], cwd=ROOT, env=env, stdout=log, stderr=log)
                for _ in range(100):
                    try:
                        assert call('/health')['realAgents'] is False
                        return process
                    except OSError:
                        if process.poll() is not None:
                            raise AssertionError('DEMO server exited')
                        time.sleep(.1)
                process.terminate()
                process.wait(timeout=15)
                raise AssertionError('API startup timeout')

            try:
                server = start()
                call('/login', {'username': 'admin', 'password': 'DemoAdmin-2026!'})
                initial = call('/admin/operations')
                assert initial['backup']['count'] == 0
                assert initial['backup']['nextAt'] is not None
                started = time.monotonic()
                reads = 0
                while time.monotonic()-started < 85:
                    status = call('/admin/operations')
                    assert call('/health')['ok'] is True
                    reads += 1
                    if status['backup']['phase'] == 'error':
                        raise AssertionError(status['backup']['error'])
                    if status['backup']['count'] == 1 and status['backup']['phase'] == 'idle':
                        break
                    time.sleep(.5)
                else:
                    raise AssertionError('Real 60-second automatic startup schedule did not run')
                elapsed = time.monotonic()-started
                assert elapsed >= 55, 'Backup ran before the documented initial delay'
                assert status['backup']['latest']['drill']['checkedAt'] > 0
                assert status['backup']['nextAt'] > status['backup']['lastSuccess']+290000
                root = next((directory/'backups').iterdir())
                copy = next(root.glob('backup-*'))
                subprocess.run(['npm', 'run', 'db:verify', '--', '--from', str(copy)], cwd=ROOT, check=True, capture_output=True)
                server.terminate()
                assert server.wait(timeout=15) == 0
                server = start()
                # Existing login and persisted backup metadata survive a normal restart.
                restarted = call('/admin/operations')
                assert restarted['backup']['count'] == 1
                assert restarted['backup']['latest']['id'] == status['backup']['latest']['id']
                assert restarted['backup']['nextAt'] >= status['backup']['lastSuccess']+300000
                assert len(list(root.glob('backup-*'))) == 1
                assert not list(root.glob('.drill-*'))
                assert not (root/'.running.lock').exists()
                print(json.dumps({'ok': True, 'profile': 'real startup timer + live API + verified backup/restore drill + restart', 'elapsedSeconds': round(elapsed, 2), 'successfulMonitoringReads': reads, 'copiesAfterRestart': 1, 'realAgents': False}))
            finally:
                if server is not None and server.poll() is None:
                    server.terminate()
                    server.wait(timeout=15)


if __name__ == '__main__':
    run()
