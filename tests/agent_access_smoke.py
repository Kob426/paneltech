"""Actual .NET dry-run process + API + lost-response proxy; isolated loopback data only."""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
DOTNET = os.environ.get('PANELTECH_DOTNET') or shutil.which('dotnet') or '/workspace/.tools/dotnet/dotnet'
DLL = Path(os.environ.get('PANELTECH_AGENT_DLL',str(ROOT / 'agent/bin/Release/net10.0/PanelTech.Agent.dll'))).resolve()
API = 'http://127.0.0.1:3110'


def wait_for(test, timeout=20):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            if test(): return
        except (OSError, json.JSONDecodeError): pass
        time.sleep(.05)
    raise AssertionError('Timed out waiting for agent access evidence')


class Proxy(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self): self.forward()
    def do_POST(self): self.forward()
    def forward(self):
        if self.headers.get('Transfer-Encoding', '').lower() == 'chunked':
            chunks = []
            while True:
                size = int(self.rfile.readline().split(b';')[0], 16)
                if not size:
                    while self.rfile.readline() != b'\r\n': pass
                    break
                chunks.append(self.rfile.read(size));self.rfile.read(2)
            body = b''.join(chunks)
        else: body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        headers = {k: v for k, v in self.headers.items() if k.lower() in ['authorization', 'content-type', 'cookie', 'x-csrf-token', 'host']}
        request = urllib.request.Request(API + self.path, data=body if self.command == 'POST' else None, headers=headers, method=self.command)
        try:
            try: response = urllib.request.urlopen(request, timeout=10)
            except urllib.error.HTTPError as error: response = error
            with response:
                raw = response.read();status = response.status
                self.server.counts[self.path] = self.server.counts.get(self.path, 0) + 1
                if status == 200 and self.path in self.server.drop:
                    self.server.drop.remove(self.path)
                    self.connection.shutdown(socket.SHUT_RDWR);self.connection.close();return
                if status == 200 and self.path == '/api/agent/access/rotate' and self.server.fail_save:
                    self.server.fail_save = False
                    (self.server.state / 'identity.json.tmp').mkdir()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json');self.send_header('Content-Length', str(len(raw)))
                for value in response.headers.get_all('Set-Cookie', []): self.send_header('Set-Cookie', value)
                self.end_headers();self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError): pass


def run():
    with tempfile.TemporaryDirectory(prefix='paneltech-agent-access-') as temporary:
        directory = Path(temporary);state = directory / 'state';processes = [];secrets = []
        with open(directory / 'process.log', 'w+') as log:
            api = subprocess.Popen(['node', '--import', 'tsx', 'server/index.ts'], cwd=ROOT,
                env=dict(os.environ, ENABLE_REAL_AGENTS='1', PORT='3110', DB_PATH=str(directory / 'test.sqlite'),
                    ADMIN_USERNAME='fixture', ADMIN_PASSWORD='AccessFixture-2026!'), stdout=log, stderr=log)
            processes.append(api)
            proxy = ThreadingHTTPServer(('127.0.0.1', 0), Proxy);proxy.daemon_threads = True
            proxy.drop = {'/api/agent/register'};proxy.counts = {};proxy.fail_save = False;proxy.state = state
            thread = threading.Thread(target=proxy.serve_forever, daemon=True);thread.start()
            url = 'http://127.0.0.1:' + str(proxy.server_port)
            config = directory / 'config.json';config.write_text(json.dumps({'serverUrl': url, 'stateDirectory': str(state), 'name': 'LINUX ACCESS DRY-RUN'}))
            cookie = '';csrf = ''
            def request(path, body=None, token=None):
                headers = {'Content-Type': 'application/json', 'Cookie': cookie, 'X-CSRF-Token': csrf}
                if token: headers['Authorization'] = 'Bearer ' + token
                req = urllib.request.Request(url + '/api' + path, data=None if body is None else json.dumps(body).encode(), headers=headers)
                try: response = urllib.request.urlopen(req, timeout=5)
                except urllib.error.HTTPError as error: response = error
                with response: return response.status, json.load(response), response.headers
            def identity(): return json.loads((state / 'identity.json').read_text())
            def start(enroll=False):
                args = [DOTNET, str(DLL), '--config', str(config)]
                if enroll: args += ['--enrollment-file', str(directory / 'enroll.txt')]
                p = subprocess.Popen(args, cwd=ROOT, stdout=log, stderr=log, env=dict(os.environ, DOTNET_CLI_HOME='/tmp/paneltech-dotnet-home'))
                processes.append(p);return p
            def stop(p):
                if p.poll() is None:
                    p.terminate()
                    try:p.wait(timeout=5)
                    except subprocess.TimeoutExpired:p.kill();p.wait()
            try:
                wait_for(lambda: urllib.request.urlopen(API + '/api/health', timeout=1).status == 200)
                status, login, headers = request('/login', {'username': 'fixture', 'password': 'AccessFixture-2026!'})
                assert status == 200;cookie = headers['Set-Cookie'].split(';')[0];csrf = login['csrf']
                club = request('/admin/clubs', {'name': 'SYNTHETIC ACCESS ONLY', 'variants': [{'id':36,'name':'36'}]})[1]
                game = request('/admin/games', {'name':'SYNTHETIC GAME','exes':['fixture.exe']})[1]
                grant = request('/admin/enrollments', {'clubId':club['id']})[1];secrets.append(grant['token'])
                (directory / 'enroll.txt').write_text(grant['token'])
                agent = start(True);assert agent.wait(timeout=15) == 1
                first = identity();secrets.append(first['deviceToken']);assert first['registrationPending']
                device_id = first['deviceId'];assert len(request('/state')[1]['devices']) == 1
                (directory / 'enroll.txt').unlink();agent = start()
                wait_for(lambda: not identity()['registrationPending'])
                assert proxy.counts['/api/agent/register'] == 1
                job = request('/jobs', {'deviceIds':[device_id], 'gameId':game['id'], 'operation':'apply_marking','variant':36})[1][0]
                wait_for(lambda: request('/history')[1]['items'][0]['state'] == 'failed')
                wait_for(lambda: json.loads((state/'receipts.json').read_text())[0]['delivered'])
                old = identity()['deviceToken'];proxy.drop.add('/api/agent/access/rotate')
                assert request('/admin/devices/'+device_id+'/rotate', {'expectedAccessVersion':1})[0] == 200
                wait_for(lambda: identity()['deviceToken'] != old and identity()['pendingToken'] is None)
                assert agent.poll() is None and request('/agent/access',token=old)[0] == 401
                assert request('/history')[1]['items'][0]['attempts'] == 1
                secrets.append(identity()['deviceToken'])
                # A committed rotation followed by a failed local promotion must be restartable.
                proxy.fail_save = True
                request('/admin/devices/'+device_id+'/rotate', {'expectedAccessVersion':2})
                assert agent.wait(timeout=15) == 1
                pending = identity();assert pending['pendingToken'];secrets.extend([pending['deviceToken'],pending['pendingToken']])
                assert request('/agent/access',token=pending['pendingToken'])[0] == 200
                (state/'identity.json.tmp').rmdir();agent = start()
                wait_for(lambda: identity()['pendingToken'] is None)
                assert identity()['deviceToken'] == pending['pendingToken']
                stop(agent)
                pending_job = request('/jobs', {'deviceIds':[device_id], 'gameId':game['id'], 'operation':'apply_marking','variant':36})[1][0]
                access = request('/admin/devices/'+device_id+'/recovery', {'expectedAccessVersion':3})[1]
                secrets.append(access['recoveryToken']);assert access['serverOrigin'] == url
                recovery_file = directory/'recover.json';recovery_file.write_text(json.dumps(access))
                (state/'identity.json').write_text('{broken');(state/'receipts.json').unlink()
                manifest = '[{"name":"PanelTech-old.exe","exe":"old.exe","gameId":"old"}]'
                (state/'ownership.json').write_text(manifest)
                args = [DOTNET,str(DLL),'--config',str(config),'--recover-file',str(recovery_file)]
                assert subprocess.run(args,cwd=ROOT,stdout=log,stderr=log).returncode == 1
                assert (state/'ownership.json').read_text() == manifest
                assert subprocess.run(args+['--confirm-state-reset'],cwd=ROOT,stdout=log,stderr=log).returncode == 0
                prepared = identity();assert prepared['deviceId'] == device_id
                assert not (state/'ownership.json').exists()
                assert list(state.glob('quarantine-*/ownership.json'))[0].read_text() == manifest
                assert json.loads((state/'receipts.json').read_text()) == []
                assert subprocess.run(args+['--confirm-state-reset'],cwd=ROOT,stdout=log,stderr=log).returncode == 0
                assert identity() == prepared, 'Repeated local prepare must keep the same candidate'
                proxy.drop.add('/api/agent/recover');agent = start();assert agent.wait(timeout=15) == 1
                assert identity()['recoveryToken'] == access['recoveryToken']
                recovery_file.unlink();agent = start();wait_for(lambda: identity()['recoveryToken'] is None)
                secrets.append(identity()['deviceToken']);assert identity()['deviceId'] == device_id
                assert request('/agent/access',token=pending['pendingToken'])[0] == 401
                all_jobs = request('/history')[1]['items']
                assert next(j for j in all_jobs if j['id']==pending_job['id'])['state'] == 'expired'
                assert next(j for j in all_jobs if j['id']==pending_job['id'])['attempts'] == 0
                assert next(j for j in all_jobs if j['id']==job['id'])['attempts'] == 1
                assert len(request('/state')[1]['devices']) == 1
                request('/admin/devices/'+device_id+'/revoke',{});assert agent.wait(timeout=12) == 1
                assert identity()['deviceId'] == device_id
                log.flush();log.seek(0);output = log.read()
                for value in secrets: assert value not in output, 'Credential leaked in process log'
                print('PASS actual .NET/API access: lost enrollment, expired-file-free restart, rotation/lost response, post-commit disk failure/restart, corrupt identity/missing receipts, explicit/idempotent quarantine recovery, lost recovery response, same ID/club, no replay/ownership claim, revocation; Linux dry-run only')
            finally:
                for process in reversed(processes):stop(process)
                proxy.shutdown();proxy.server_close();thread.join(timeout=3)

if __name__ == '__main__':run()
