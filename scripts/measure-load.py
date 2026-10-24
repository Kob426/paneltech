"""Synthetic Linux load only. No user DB argument, external endpoint or Windows operations."""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.request
ROOT=Path(__file__).resolve().parents[1]
LIMIT=20
PHASES=['expire','poll-idle','create65','tick','tick64','http-read','http-heartbeat','http-mixed','profile-reads']
def percentile(values,p):
    return sorted(values)[min(len(values)-1,int((len(values)-1)*p))] if values else None

def call(url,path,body=None,cookie='',csrf='',token=''):
    headers={'Content-Type':'application/json','Cookie':cookie,'X-CSRF-Token':csrf}
    if token:headers['Authorization']='Bearer '+token
    req=urllib.request.Request(url+path,data=json.dumps(body).encode() if body is not None else None,headers=headers)
    with urllib.request.urlopen(req,timeout=LIMIT+5) as response:
        raw=response.read();return json.loads(raw),len(raw),response.headers

def http_load(process,url,phase):
    has_reads=phase!='http-heartbeat';has_agents=phase!='http-read'
    sessions=[]
    if has_reads:
        for n in range(6):
            login,_,headers=call(url,'/api/login',{'username':'load'+str(n),'password':'SyntheticLoad-2026!'})
            sessions.append((headers['Set-Cookie'].split(';')[0],login['csrf']))
    latencies={'read':[],'heartbeat':[]};sizes=[];states=[];errors=[];stop=threading.Event()
    def request(kind,n):
        t=time.perf_counter()
        try:
            if kind=='read':
                path=('/api/state?clubId=load-club-'+str(n%52)+'&gameId=fortnite') if n%2==0 else ('/api/history?clubId=load-club-'+str(n%52)+'&page=1')
                cookie,csrf=sessions[n%6];body,size,_=call(url,path,cookie=cookie,csrf=csrf)
                if n%2==0:
                    assert len(body['devices'])>=65 and len(body['jobs'])<=256
                    assert not any('tokenHash' in d for d in body['devices'])
                    states.append({'devices':len(body['devices']),'bytes':size})
                else:assert len(body['items'])<=25
            else:
                token=hashlib.sha256(('SYNTHETIC-LOAD-ONLY-'+str(n)).encode()).hexdigest()
                body,size,_=call(url,'/api/agent/poll',{'bootId':'load-boot','rules':[],'inspectionVerified':False},token=token)
                assert body['job'] is None
            latencies[kind].append((time.perf_counter()-t)*1000);sizes.append(size)
        except Exception as e:
            errors.append(type(e).__name__)
            stop.set()
    def worker(kind,start,step,count):
        for n in range(start,count,step):
            if stop.is_set():break
            request(kind,n)
    concurrency=(6 if has_reads else 0)+(32 if has_agents else 0)
    begin=time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures=[]
        if has_reads:futures.extend(pool.submit(worker,'read',n,6,120) for n in range(6))
        if has_agents:futures.extend(pool.submit(worker,'heartbeat',n,32,3380) for n in range(32))
        _,pending=concurrent.futures.wait(futures,timeout=LIMIT)
        if pending:
            stop.set();process.kill()
    elapsed=time.perf_counter()-begin;all_latencies=latencies['read']+latencies['heartbeat']
    row={'status':'timeout' if pending else 'ok','requestWindowSeconds':LIMIT,'requests':(120 if has_reads else 0)+(3380 if has_agents else 0),'completed':len(all_latencies),'errors':len(errors),'errorsByType':{e:errors.count(e) for e in sorted(set(errors))},'concurrency':concurrency,'elapsedSeconds':round(elapsed,3),'throughputRps':round(len(all_latencies)/elapsed,2),'latencyP50Ms':percentile(all_latencies,.5),'latencyP95Ms':percentile(all_latencies,.95),'latencyMaxMs':max(all_latencies,default=None),'maxResponseBytes':max(sizes,default=None),'stateMaxResponseBytes':max((s['bytes'] for s in states),default=None),'stateDevices':max((s['devices'] for s in states),default=None)}
    for kind,values in latencies.items():row[kind]={'completed':len(values),'latencyP50Ms':percentile(values,.5),'latencyP95Ms':percentile(values,.95),'latencyMaxMs':max(values,default=None)}
    if not pending:
        assert not errors,errors
        metrics,_,_=call(url,'/__load_finish__',{});row.update(metrics);process.wait(timeout=5)
    else:process.wait(timeout=5)
    return row

def measure(sizes,phases):
    results=[]
    for jobs in sizes:
        with tempfile.TemporaryDirectory(prefix='paneltech-load-') as temp:
            directory=Path(temp);(directory/'SYNTHETIC').write_text('PANELTECH SYNTHETIC LOAD ONLY')
            env=dict(os.environ,PANELTECH_LOAD_DIR=temp,PANELTECH_LOAD_JOBS=str(jobs))
            command=['node','--import','tsx','scripts/load-worker.ts']
            seed=subprocess.run(command,cwd=ROOT,env=dict(env,PANELTECH_LOAD_PHASE='seed'),capture_output=True,text=True,timeout=120)
            assert seed.returncode==0,seed.stderr
            fixture=json.loads(seed.stdout.strip().splitlines()[-1]);print(json.dumps({'fixture':fixture}),flush=True)
            for phase in phases:
                shutil.copyfile(directory/'template.sqlite',directory/'case.sqlite')
                process=subprocess.Popen(command,cwd=ROOT,env=dict(env,PANELTECH_LOAD_PHASE=phase),stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
                started=time.perf_counter();row={'completedJobs':jobs,'phase':phase}
                try:
                    if not phase.startswith('http'):
                        row['processWallLimitSeconds']=LIMIT+10
                        out,err=process.communicate(timeout=LIMIT+10)
                        assert process.returncode==0,err
                        row.update(json.loads(out.strip().splitlines()[-1]));row['status']='ok'
                    else:
                        ready,_,_=select.select([process.stdout],[],[],60)
                        assert ready,'Worker startup timed out'
                        line=process.stdout.readline();assert line,'Worker failed before startup'
                        info=json.loads(line);url='http://127.0.0.1:'+str(info['port']);row.update(info);row.pop('ready');row.pop('port')
                        row.update(http_load(process,url,phase))
                except subprocess.TimeoutExpired:
                    process.kill();process.communicate();row.update(status='timeout',wallSeconds=round(time.perf_counter()-started,3))
                finally:
                    if process.poll() is None:process.kill();process.communicate()
                    for pipe in [process.stdout,process.stderr]:
                        if pipe:pipe.close()
                    for side in ['-wal','-shm','-journal']:(directory/('case.sqlite'+side)).unlink(missing_ok=True)
                results.append(row);print(json.dumps(row),flush=True)
    print(json.dumps({'kind':'synthetic-linux-load','clubs':52,'pcs':3380,'profiles':results}),flush=True)
if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--jobs',nargs='+',type=int,choices=[10000,100000],default=[10000,100000])
    parser.add_argument('--phases',nargs='+',choices=PHASES,default=[p for p in PHASES if p!='profile-reads'])
    args=parser.parse_args();measure(args.jobs,args.phases)
