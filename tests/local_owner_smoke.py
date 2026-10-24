"""Exercise the actual hidden terminal setup and production --local server in Linux."""
import json
import os
from pathlib import Path
import pty
import select
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
SECRET='TerminalFixture-2026!'


def setup(env):
    master,slave=pty.openpty()
    process=subprocess.Popen(['npm','run','setup:owner'],cwd=ROOT,env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
    os.close(slave)
    transcript=b''
    try:
        for marker,answer in [('Логин владельца','chief'),('Пароль (12',SECRET),('Повторите пароль',SECRET)]:
            deadline=time.monotonic()+8
            while marker.encode() not in transcript:
                if time.monotonic()>deadline:
                    raise AssertionError('Setup terminal prompt timed out')
                if select.select([master],[],[],.1)[0]:
                    transcript+=os.read(master,4096)
            os.write(master,(answer+'\r').encode())
        deadline=time.monotonic()+8
        while process.poll() is None and time.monotonic()<deadline:
            if select.select([master],[],[],.1)[0]:
                try:
                    transcript+=os.read(master,4096)
                except OSError:
                    break
        assert process.wait(timeout=5)==0,'Setup failed (transcript withheld to protect inputs)'
        assert SECRET.encode() not in transcript,'Password appeared in terminal output'
    finally:
        if process.poll() is None:
            os.killpg(process.pid,signal.SIGKILL);process.wait()
        os.close(master)


def run():
    with tempfile.TemporaryDirectory(prefix='paneltech-local-owner-') as temp:
        env=dict(os.environ,DB_PATH=str(Path(temp)/'local.sqlite'),PORT='3103',ENABLE_REAL_AGENTS='0')
        setup(env)
        # No password parameters or piped input allowed by the CLI.
        refused=subprocess.run(['node','--import','tsx','scripts/setup-owner.ts'],cwd=ROOT,env=env,input='',text=True,capture_output=True)
        assert refused.returncode==1
        base='http://127.0.0.1:3103/api'
        def request(path,body=None):
            req=urllib.request.Request(base+path,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json'})
            try:
                with urllib.request.urlopen(req,timeout=3) as response:
                    return response.status,json.load(response)
            except urllib.error.HTTPError as error:
                return error.code,json.load(error)
        with open(Path(temp)/'server.log','w+') as log:
            process=subprocess.Popen(['npm','run','local'],cwd=ROOT,env=env,stdout=log,stderr=log,start_new_session=True)
            try:
                for _ in range(100):
                    try:
                        status,health=request('/health')
                        break
                    except OSError:
                        if process.poll() is not None:
                            raise AssertionError('Local server exited')
                        time.sleep(.1)
                else:
                    raise AssertionError('Local server did not start')
                assert status==200 and health['personalAccounts'] and not health['realAgents']
                assert request('/login',{'username':'chief','password':SECRET})[0]==200
                assert request('/login',{'username':'admin','password':'DemoAdmin-2026!'})[0]==401
                assert request('/agent/register',{})[0]==403
            finally:
                os.killpg(process.pid,signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid,signal.SIGKILL);process.wait()
            log.seek(0)
            assert SECRET not in log.read()
        # Personal DB cannot silently run as public-demo login or permit real agents.
        for args,enabled in [([], '0'),(['--local'],'1')]:
            refused=subprocess.run(['node','--import','tsx','server/index.ts',*args],cwd=ROOT,env=dict(env,ENABLE_REAL_AGENTS=enabled),capture_output=True,text=True,timeout=10)
            assert refused.returncode!=0
        print('PASS terminal owner setup: hidden password, private local login, separate DB, real agents disabled, mode guards; Linux only')

if __name__=='__main__':
    run()
