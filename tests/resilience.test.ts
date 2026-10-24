import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.js';
import {Core,digest} from '../server/core.js';
import {createApp} from '../server/app.js';
import {StorageUnavailable} from '../server/storage-errors.js';
import {ruleName,type Job} from '../shared/contracts.js';

const input=(ids=['aurora-1'])=>({deviceIds:ids,gameId:'fortnite',operation:'apply_marking',variant:36});
const raw=(s:Store,kind:string,id:string)=>JSON.parse(String(s.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind,id)!.data));
function failWrite(s:Store,kind:string,nth=1){
 const put=s.put.bind(s);let calls=0;
 s.put=(k,r)=>{if(k===kind&&++calls===nth)throw Object.assign(Error('SECRET_DISK_CANARY'),{code:'ERR_SQLITE_ERROR',errcode:13});return put(k,r);};
}
async function fixture(path=':memory:'){
 const s=new Store(path),c=new Core(s);c.seed();const server=createApp(c,{realAgents:true}).listen(0,'127.0.0.1');await once(server,'listening');
 const url=`http://127.0.0.1:${(server.address() as any).port}/api`;let cookie='',csrf='';
 async function req(path:string,method='GET',body?:unknown,bearer?:string){
  const response=await fetch(url+path,{method,headers:{'Content-Type':'application/json',...(bearer?{Authorization:'Bearer '+bearer}:{Cookie:cookie,'X-CSRF-Token':csrf})},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json();return {status:response.status,data,headers:response.headers};
 }
 const login=await req('/login','POST',{username:'admin',password:'DemoAdmin-2026!'});assert.equal(login.status,200);cookie=login.headers.get('set-cookie')!.split(';')[0];csrf=login.data.csrf;
 const token='ac'.repeat(32),id=randomUUID();
 s.put('club',{id:'test',name:'ISOLATED TEST',demo:false,variants:[{id:36,name:'36'}]});
 s.put('device',{id,clubId:'test',name:'NO WINDOWS',demo:false,bootId:'boot',lastSeen:c.now(),inspectedAt:null,rules:[],scenario:'real',tokenHash:digest(token)});
 return {s,c,req,token,id,close:async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));s.close();}};
}

test('real SQLITE_FULL rolls back the entire transaction without masking the cause; store halts',()=>{
 const s=new Store(':memory:');try{
  s.put('meta',{id:'original',text:'preserved'});
  const pages=Number(s.db.prepare('PRAGMA page_count').get()!.page_count);s.db.exec(`PRAGMA max_page_count=${pages}`);
  assert.throws(()=>s.transaction(()=>{s.put('meta',{id:'first',text:'partial'});s.put('meta',{id:'large',text:'x'.repeat(500000)});}),StorageUnavailable);
  assert.equal(s.db.isTransaction,false);assert.equal(s.halted,true);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM records WHERE id IN ('first','large')").get()!.n,0);
  assert.equal(raw(s,'meta','original').text,'preserved');assert.throws(()=>s.put('meta',{id:'retry'}),StorageUnavailable);
 }finally{s.close();}
});

test('read-only storage returns safe 503 and blocks further mutations and healthy status',async()=>{
 const f=await fixture();try{
  f.s.db.exec('PRAGMA query_only=ON');
  const result=await f.req('/jobs','POST',input());assert.equal(result.status,503);assert.equal(result.data.code,'storage_unavailable');
  assert.equal(f.s.db.prepare("SELECT COUNT(*) AS n FROM records WHERE kind='job'").get()!.n,0);
  assert.equal((await f.req('/health')).status,503);assert.equal((await f.req('/jobs','POST',input())).status,503);
  assert.doesNotMatch(JSON.stringify(result),/SQLITE|SECRET|SELECT|INSERT/);
 }finally{await f.close();}
});

test('batch write failure creates no partial batch and never returns accepted jobs',async()=>{
 const f=await fixture();try{
  failWrite(f.s,'job',2);const result=await f.req('/jobs','POST',input(['aurora-1','aurora-3']));
  assert.equal(result.status,503);assert.equal(f.s.db.prepare("SELECT COUNT(*) AS n FROM records WHERE kind='job'").get()!.n,0);
  assert.doesNotMatch(JSON.stringify(result),/SECRET_DISK_CANARY/);
 }finally{await f.close();}
});

test('poll write failure rolls back heartbeat, boot invalidation and delivery together',async()=>{
 const f=await fixture();try{
  const [j]=f.c.create(input([f.id]),'operator'),before=raw(f.s,'device',f.id);failWrite(f.s,'job');
  const result=await f.req('/agent/poll','POST',{bootId:'new-boot',rules:[],inspectionVerified:true},f.token);
  assert.equal(result.status,503);assert.deepEqual(raw(f.s,'device',f.id),before);assert.equal(raw(f.s,'job',j.id).state,'queued');assert.equal(raw(f.s,'job',j.id).attempts,0);
 }finally{await f.close();}
});

test('failed delivery commit never exposes a job or persists a newer inspection',async()=>{
 const f=await fixture();try{
  const [j]=f.c.create(input([f.id]),'operator'),before=raw(f.s,'device',f.id);failWrite(f.s,'job');
  const result=await f.req('/agent/poll','POST',{bootId:'boot',rules:[],inspectionVerified:true},f.token);
  assert.equal(result.status,503);assert.equal(result.data.job,undefined);assert.deepEqual(raw(f.s,'device',f.id),before);assert.equal(raw(f.s,'job',j.id).state,'queued');
 }finally{await f.close();}
});

test('failed result save has no false success; after restart only result delivery is retried',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'paneltech-result-')),path=join(dir,'test.sqlite');let f=await fixture(path);
 try{
  const [j]=f.c.create(input([f.id]),'operator');f.c.poll(f.c.device(f.id));const before=raw(f.s,'device',f.id);
  const body={bootId:'boot',state:'succeeded',code:'verified',message:'ISOLATED CONTRACT TEST',rules:j.exes.map(exe=>({name:ruleName(j.gameId,exe),gameId:j.gameId,exe,dscp:36,owned:true})),dryRun:false};
  failWrite(f.s,'job');const result=await f.req('/agent/results/'+j.id,'POST',body,f.token);assert.equal(result.status,503);
  assert.equal(raw(f.s,'job',j.id).state,'running');assert.deepEqual(raw(f.s,'device',f.id),before);
  const token=f.token;await f.close();f=await fixture(path);
  const saved=await f.req('/agent/results/'+j.id,'POST',body,token);assert.equal(saved.status,200);assert.equal(saved.data.state,'succeeded');
  const again=await f.req('/agent/results/'+j.id,'POST',body,token);assert.deepEqual(again.data,saved.data);assert.equal(saved.data.attempts,1);
 }finally{await f.close();rmSync(dir,{recursive:true,force:true});}
});

test('DEMO execution save failure keeps both rules and running result unchanged',()=>{
 const s=new Store(':memory:'),c=new Core(s);c.seed();try{
  const [j]=c.create(input(),'operator');c.poll(c.device(j.deviceId));const before=raw(s,'device',j.deviceId);failWrite(s,'job');
  assert.throws(()=>c.executeDemo(j),StorageUnavailable);assert.deepEqual(raw(s,'device',j.deviceId),before);assert.equal(raw(s,'job',j.id).state,'running');
 }finally{s.close();}
});

test('DEMO reboot and reconciliation failures never partially update device facts',()=>{
 for(const action of ['reboot','reconcile'] as const){const s=new Store(':memory:'),c=new Core(s);c.seed();try{
  const [j]=c.create(input(),'operator');if(action==='reconcile'){j.state='unknown';s.put('job',j);}
  const before=raw(s,'device',j.deviceId),jobBefore=raw(s,'job',j.id);failWrite(s,'job');
  assert.throws(()=>action==='reboot'?c.reboot(j.deviceId):c.reconcileDemo(j.id),StorageUnavailable);
  assert.deepEqual(raw(s,'device',j.deviceId),before);assert.deepEqual(raw(s,'job',j.id),jobBefore);
 }finally{s.close();}}
});

test('revocation failure rolls back token and pending jobs in one transaction',async()=>{
 const f=await fixture();try{
  const [j]=f.c.create(input([f.id]),'operator'),before=raw(f.s,'device',f.id);failWrite(f.s,'job');
  assert.equal((await f.req('/admin/devices/'+f.id+'/revoke','POST',{})).status,503);
  assert.deepEqual(raw(f.s,'device',f.id),before);assert.equal(raw(f.s,'job',j.id).state,'queued');
 }finally{await f.close();}
});

test('malformed result cannot replace a running job with a fabricated success',async()=>{
 const f=await fixture();try{
  const [j]=f.c.create(input([f.id]),'operator');f.c.poll(f.c.device(f.id));
  for(const rules of [null,[null],[{name:'bad',gameId:'fortnite',exe:'x.exe',dscp:64,owned:true}]]){
   const r=await f.req('/agent/results/'+j.id,'POST',{bootId:'boot',state:'succeeded',code:'ok',message:'SECRET_RESULT_CANARY',rules,dryRun:false},f.token);
   assert.equal(r.status,400);assert.equal(f.s.get<Job>('job',j.id)!.state,'running');assert.equal(f.s.get<Job>('job',j.id)!.attempts,1);
  }
 }finally{await f.close();}
});
