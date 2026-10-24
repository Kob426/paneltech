"""Exact npm database commands against a running private DEMO API, temporary data only."""
import hashlib
import http.cookiejar
import json
import os
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
URL='http://127.0.0.1:3107'
OWNER='OwnerDatabaseSmoke-2026!'
STAFF='StaffDatabaseSmoke-2026!'

class Client:
    def __init__(self):
        self.opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.csrf=''
    def call(self,path,method='GET',body=None):
        req=urllib.request.Request(URL+'/api'+path,method=method,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json','X-CSRF-Token':self.csrf})
        try:
            with self.opener.open(req,timeout=5) as r:return r.status,json.load(r)
        except urllib.error.HTTPError as e:return e.code,json.load(e)
    def login(self,name,secret):
        status,result=self.call('/login','POST',{'username':name,'password':secret});assert status==200
        self.csrf=result['csrf'];return result['user']

def cli(command,*args,success=True):
    r=subprocess.run(['npm','run','db:'+command,'--',*map(str,args)],cwd=ROOT,capture_output=True,text=True,timeout=45)
    assert all(secret not in r.stdout+r.stderr for secret in [OWNER,STAFF,'CLI_SECRET_CANARY_DO_NOT_PRINT'])
    if not success:
        assert r.returncode!=0,'Rejected database operation unexpectedly succeeded';return None
    assert r.returncode==0,'Database CLI failed: '+r.stderr
    result=[json.loads(line) for line in r.stdout.splitlines() if line.startswith('{')][-1]
    assert result['ok'];return result

def run():
    with tempfile.TemporaryDirectory(prefix='paneltech-db-smoke-') as temp:
        root=Path(temp);live=root/'live.sqlite';restored=root/'recovered.sqlite';copies=root/'copies'
        env=dict(os.environ,DB_PATH=str(live),PORT='3107',ENABLE_REAL_AGENTS='0',FIXTURE_OWNER_PASSWORD=OWNER)
        subprocess.run(['node','--import','tsx','--input-type=module','-e',"import {Store} from './server/store.ts';import {initializeLocalOwner} from './server/local-owner.ts';const s=new Store(process.env.DB_PATH);initializeLocalOwner(s,'chief',process.env.FIXTURE_OWNER_PASSWORD);s.close();"],cwd=ROOT,env=env,check=True,capture_output=True)
        with open(root/'server.log','w+') as log:
            server=None
            def start(path):
                nonlocal server
                server=subprocess.Popen(['node','--import','tsx','server/index.ts','--local'],cwd=ROOT,env=dict(env,DB_PATH=str(path)),stdout=log,stderr=log)
                for _ in range(100):
                    try:
                        urllib.request.urlopen(URL+'/api/health',timeout=1).close();return
                    except OSError:
                        if server.poll() is not None:raise AssertionError('Database fixture server exited')
                        time.sleep(.1)
                raise AssertionError('Database fixture server did not start')
            def stop():
                nonlocal server
                if server:
                    server.terminate()
                    try:server.wait(timeout=5)
                    except subprocess.TimeoutExpired:server.kill();server.wait()
                    server=None
            try:
                start(live);owner=Client();assert owner.login('chief',OWNER)['role']=='admin'
                assert owner.call('/admin/users','POST',{'username':'staff','password':STAFF,'role':'operator'})[0]==201
                status,made=owner.call('/jobs','POST',{'deviceIds':['aurora-1'],'gameId':'fortnite','operation':'apply_marking','variant':36});assert status==201
                for _ in range(100):
                    status,result=owner.call('/history?deviceId=aurora-1')
                    if result['items'][0]['state']=='succeeded':break
                    time.sleep(.1)
                else:raise AssertionError('Simulation job did not finish')
                job=made[0]
                assert owner.call('/jobs/'+job['id']+'/feedback','POST',{'outcome':'helped','reason':'voice','comment':'DEMO database smoke','expectedVersion':0})[0]==200
                pid=server.pid
                saved=cli('backup','--db',live,'--out',copies)
                assert server.pid==pid and server.poll() is None
                assert owner.call('/health')[1]['realAgents'] is False
                cli('verify','--from',saved['path']);cli('check','--db',live)
                assert owner.call('/jobs','POST',{'deviceIds':['aurora-1'],'gameId':'fortnite','operation':'health'})[0]==201
                assert owner.call('/history')[1]['total']==2
                recovered=cli('restore','--from',saved['path'],'--to',restored)
                assert recovered['path']==str(restored)
                assert cli('check','--db',restored)['version']==5
                cli('restore','--from',saved['path'],'--to',restored,success=False)
                assert owner.call('/history')[1]['total']==2 # live file was never replaced
                stop();start(restored)
                assert owner.call('/me')[0]==401 # old browser cookie cannot survive restoration
                assert owner.login('chief',OWNER)['role']=='admin'
                history=owner.call('/history')[1]
                assert history['total']==1
                assert history['items'][0]['id']==job['id']
                assert history['items'][0]['feedback']['outcome']=='helped'
                assert history['items'][0]['revision']==job['revision']
                state=owner.call('/state')[1]
                assert not state['realAgents'] and state['personalAccounts']
                assert all(not d['fresh'] for d in state['devices'])
                assert all(not any(r['owned'] for r in d['rules']) for d in state['devices'])
                staff=Client();assert staff.login('staff',STAFF)['role']=='operator'
                assert staff.call('/admin/users')[0]==403
                assert staff.call('/history')[1]['items'][0]['feedback']['comment']=='DEMO database smoke'
                stop()
                stats=cli('stats','--db',restored);assert stats['version']==5 and stats['snapshots']['count']>=2
                compacted=root/'compact.sqlite';before_compact=hashlib.sha256(restored.read_bytes()).hexdigest()
                compact=cli('compact','--db',restored,'--to',compacted,'--out',copies)
                assert compact['after']['version']==5 and compact['after']['totalBytes']>0
                assert hashlib.sha256(restored.read_bytes()).hexdigest()==before_compact
                cli('compact','--db',restored,'--to',compacted,'--out',copies,success=False)
                # Migrate an old-layout copy only, with a mandatory pre-migration package.
                legacy=root/'legacy.sqlite';shutil.copyfile(restored,legacy)
                subprocess.run(['node','--import','tsx','--input-type=module','-e',"import {DatabaseSync} from 'node:sqlite';import {makeLegacy} from './tests/legacy-database.ts';const d=new DatabaseSync(process.argv[1]);makeLegacy(d);d.close();",str(legacy)],cwd=ROOT,check=True,capture_output=True)
                migrated=cli('migrate','--db',legacy,'--out',copies)
                assert (migrated['from'],migrated['to'])==(0,5)
                assert cli('verify','--from',migrated['backup'])['schemaVersion']==0
                assert cli('check','--db',legacy)['version']==5
                # A damaged package fails before any destination file is created.
                with open(Path(saved['path'])/'backup.sqlite','ab') as f:f.write(b'broken')
                cli('verify','--from',saved['path'],success=False)
                rejected=root/'must-not-exist.sqlite';cli('restore','--from',saved['path'],'--to',rejected,success=False)
                assert not rejected.exists()
                # Unknown schema and malformed records cannot leak their contents through CLI errors.
                future=root/'future.sqlite';shutil.copyfile(legacy,future)
                subprocess.run(['node','--input-type=module','-e',"import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync(process.argv[1]);d.exec('PRAGMA user_version=99');d.close();",str(future)],cwd=ROOT,check=True,capture_output=True)
                before=hashlib.sha256(future.read_bytes()).hexdigest();cli('migrate','--db',future,'--out',copies,success=False)
                assert hashlib.sha256(future.read_bytes()).hexdigest()==before
                malformed=root/'malformed.sqlite';shutil.copyfile(legacy,malformed)
                subprocess.run(['node','--input-type=module','-e',"""import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync(process.argv[1]);d.prepare("INSERT INTO records(kind,id,data) VALUES('meta','bad',?)").run('CLI_SECRET_CANARY_DO_NOT_PRINT');d.close();""",str(malformed)],cwd=ROOT,check=True,capture_output=True)
                cli('check','--db',malformed,success=False)
                print('PASS database CLI: online WAL backup without API restart, check/verify, isolated restore, owner/staff/feedback preserved, session invalidation, no rule replay, stats/compact-copy without source replacement, existing target rejection, backup-before-migrate, unknown schema and corrupt package refusal; Linux DEMO only')
            finally:stop()

if __name__=='__main__':run()
