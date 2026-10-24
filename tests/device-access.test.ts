import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomBytes,randomUUID} from 'node:crypto';
import {Store} from '../server/store';
import {Core,digest} from '../server/core';
import {createApp} from '../server/app';

const token=()=>randomBytes(32).toString('hex');
async function fixture(real=true){
 let now=Date.now();const store=new Store(':memory:'),core=new Core(store,()=>now);core.seed();
 store.put('club',{id:'real',name:'SYNTHETIC ONLY',demo:false,variants:[{id:36,name:'36'}]});
 const server=createApp(core,{realAgents:real}).listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api`;
 let cookie='',csrf='';
 async function call(path:string,body?:unknown,bearer?:string,extra:Record<string,string>={}){
  const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf,...(bearer?{Authorization:'Bearer '+bearer}:{}),...extra},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,body:await r.json(),headers:r.headers};
 }
 async function login(name='admin',secret='DemoAdmin-2026!'){
  const r=await call('/login',{username:name,password:secret});cookie=r.headers.get('set-cookie')!.split(';')[0];csrf=r.body.csrf;
 }
 await login();
 async function register(){
  const grant=(await call('/admin/enrollments',{clubId:'real'})).body,raw=token(),id=randomUUID();
  const body={enrollmentToken:grant.token,deviceId:id,name:'SYNTHETIC DEVICE',bootId:'boot',deviceToken:raw};
  const r=await call('/agent/register',body);assert.equal(r.status,200);return {raw,id,body,grant};
 }
 return {store,core,call,login,register,advance:(ms:number)=>{now+=ms;},close:async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();}};
}
const poll={bootId:'boot',rules:[],inspectionVerified:false};
test('lost registration response is retryable only for the same device/candidate, with one record and audit event',async()=>{
 const f=await fixture();try{
  const a=await f.register();assert.equal((await f.call('/agent/register',a.body)).status,200);
  assert.equal(f.store.all('device').filter(d=>!d.demo).length,1);
  assert.equal(f.store.all('audit').filter(e=>e.action==='device.registered').length,1);
  assert.equal((await f.call('/agent/register',{...a.body,deviceId:randomUUID()})).status,401);
  assert.equal((await f.call('/agent/register',{...a.body,deviceToken:token()})).status,401);
  f.advance(600000);assert.equal((await f.call('/agent/register',a.body)).status,401);
  assert.equal((await f.call('/agent/access',undefined,a.raw)).body.deviceId,a.id);
 }finally{await f.close();}
});
test('rotation immediately rejects the old secret, preserves identity/outbox jobs and does not expose credentials',async()=>{
 const f=await fixture();try{
  const a=await f.register(),next=token();const job=f.core.create({deviceIds:[a.id],gameId:'fortnite',variant:36,operation:'apply_marking'},'admin')[0];
  assert.equal((await f.call('/agent/poll',poll,a.raw)).body.job.id,job.id);
  assert.equal((await f.call('/agent/access/rotate',{newToken:next,expectedAccessVersion:1},a.raw)).status,200);
  assert.equal((await f.call('/agent/access',undefined,a.raw)).status,401);
  assert.equal((await f.call('/agent/access',undefined,next)).body.accessVersion,2);
  assert.equal(f.store.get('job',job.id).attempts,1);assert.equal(f.store.get('job',job.id).state,'running');
  assert.equal((await f.call('/agent/results/'+job.id,{bootId:'boot',state:'failed',code:'dry_run',message:'SYNTHETIC',rules:[],dryRun:true},next)).status,200);
  const serialized=JSON.stringify((await f.call('/state')).body)+JSON.stringify((await f.call('/admin/audit')).body);
  for(const secret of [a.raw,next,digest(next)])assert.ok(!serialized.includes(secret));
  assert.equal(f.store.all('audit').filter(e=>e.action==='device.token_rotated').length,1);
 }finally{await f.close();}
});
test('requested rotation pauses new delivery, is idempotent, then resumes without changing queued job snapshots',async()=>{
 const f=await fixture();try{
  const a=await f.register(),body={expectedAccessVersion:1};
  const j=f.core.create({deviceIds:[a.id],gameId:'fortnite',variant:36,operation:'apply_marking'},'admin')[0];
  assert.equal((await f.call('/admin/devices/'+a.id+'/rotate',body)).status,200);
  assert.equal((await f.call('/admin/devices/'+a.id+'/rotate',body)).status,200);
  const p=(await f.call('/agent/poll',poll,a.raw)).body;assert.equal(p.rotateToken,true);assert.equal(p.job,null);
  const next=token();await f.call('/agent/access/rotate',{newToken:next,expectedAccessVersion:1},a.raw);
  assert.equal((await f.call('/agent/poll',poll,next)).body.job.id,j.id);
  assert.equal(f.store.all('audit').filter(e=>e.action==='device.rotation_requested').length,1);
 }finally{await f.close();}
});
test('recovery binds the original club/device, expires queues, preserves unknown and rejects old token/results',async()=>{
 const f=await fixture();try{
  const a=await f.register(),j=f.core.create({deviceIds:[a.id],gameId:'fortnite',variant:36,operation:'apply_marking'},'admin')[0];
  await f.call('/agent/poll',poll,a.raw);
  const grant=(await f.call('/admin/devices/'+a.id+'/recovery',{expectedAccessVersion:1})).body;
  assert.equal((await f.call('/agent/poll',poll,a.raw)).status,401);assert.equal(f.store.get('job',j.id).state,'unknown');
  const next=token(),body={recoveryToken:grant.recoveryToken,deviceId:a.id,deviceToken:next,bootId:'boot'};
  assert.equal((await f.call('/agent/recover',{...body,deviceId:randomUUID()})).status,401);
  const done=await f.call('/agent/recover',body);assert.equal(done.status,200);assert.equal(done.body.clubId,'real');
  assert.equal((await f.call('/agent/recover',body)).status,200);
  assert.equal((await f.call('/agent/recover',{...body,deviceToken:token()})).status,401);
  assert.equal((await f.call('/agent/results/'+j.id,{bootId:'boot',state:'succeeded',code:'old_outbox',message:'SYNTHETIC',rules:[],dryRun:false},next)).status,409);
  assert.equal((await f.call('/agent/poll',poll,next)).body.job,null);
  assert.equal(f.store.get('job',j.id).attempts,1);assert.equal(f.store.get('job',j.id).state,'unknown');
  assert.equal(f.store.all('device').filter(d=>!d.demo).length,1);
  const data=JSON.stringify((await f.call('/state')).body)+JSON.stringify((await f.call('/admin/audit')).body);
  for(const secret of [next,grant.recoveryToken,digest(grant.recoveryToken)])assert.ok(!data.includes(secret));
  assert.equal(f.store.all('audit').filter(e=>e.action==='device.access_recovered').length,1);
 }finally{await f.close();}
});
test('recovery of a queued command never delivers it, even on the same boot',async()=>{
 const f=await fixture();try{
  const a=await f.register(),j=f.core.create({deviceIds:[a.id],gameId:'fortnite',variant:36,operation:'apply_marking'},'admin')[0];
  const grant=(await f.call('/admin/devices/'+a.id+'/recovery',{expectedAccessVersion:1})).body;
  const next=token();await f.call('/agent/recover',{recoveryToken:grant.recoveryToken,deviceToken:next,deviceId:a.id,bootId:'boot'});
  assert.equal((await f.call('/agent/poll',poll,next)).body.job,null);assert.equal(f.store.get('job',j.id).state,'expired');assert.equal(f.store.get('job',j.id).attempts,0);
 }finally{await f.close();}
});
test('new recovery grant cancels the previous grant; revoke also cancels a pending recovery',async()=>{
 const f=await fixture();try{
  const a=await f.register();const first=(await f.call('/admin/devices/'+a.id+'/recovery',{expectedAccessVersion:1})).body;
  const second=(await f.call('/admin/devices/'+a.id+'/recovery',{expectedAccessVersion:2})).body;
  const body={deviceId:a.id,deviceToken:token(),bootId:'boot'};
  assert.equal((await f.call('/agent/recover',{...body,recoveryToken:first.recoveryToken})).status,401);
  await f.call('/admin/devices/'+a.id+'/revoke',{});
  assert.equal((await f.call('/agent/recover',{...body,recoveryToken:second.recoveryToken})).status,401);
  assert.equal(f.store.get('device',a.id).recoveryPending,false);
 }finally{await f.close();}
});
test('a fresh inspection after lost ownership cannot declare an old remove command successful',async()=>{
 const f=await fixture();try{
  const a=await f.register(),j=f.core.create({deviceIds:[a.id],gameId:'fortnite',operation:'remove_marking'},'admin')[0];
  await f.call('/agent/poll',poll,a.raw);
  const grant=(await f.call('/admin/devices/'+a.id+'/recovery',{expectedAccessVersion:1})).body;
  const next=token();await f.call('/agent/recover',{recoveryToken:grant.recoveryToken,deviceToken:next,deviceId:a.id,bootId:'boot'});
  assert.equal((await f.call('/agent/poll',{...poll,inspectionVerified:true},next)).body.job,null);
  assert.equal(f.store.get('job',j.id).state,'failed');assert.equal(f.store.get('job',j.id).code,'access_recovery_inspected');assert.equal(f.store.get('job',j.id).attempts,1);
 }finally{await f.close();}
});
test('expired grants, stale versions and token collisions cannot replace another device credential',async()=>{
 const f=await fixture();try{
  const a=await f.register(),b=await f.register();
  assert.equal((await f.call('/agent/access/rotate',{newToken:b.raw,expectedAccessVersion:1},a.raw)).status,409);
  assert.equal((await f.call('/agent/access/rotate',{newToken:token(),expectedAccessVersion:99},a.raw)).status,409);
  const grant=(await f.call('/admin/devices/'+a.id+'/recovery',{expectedAccessVersion:1})).body;
  assert.equal((await f.call('/admin/devices/'+a.id+'/recovery',{expectedAccessVersion:1})).status,409);
  assert.equal((await f.call('/agent/recover',{recoveryToken:grant.recoveryToken,deviceId:a.id,deviceToken:b.raw,bootId:'boot'})).status,409);
  f.advance(600000);assert.equal((await f.call('/agent/recover',{recoveryToken:grant.recoveryToken,deviceId:a.id,deviceToken:token(),bootId:'boot'})).status,401);
  assert.equal((await f.call('/agent/access',undefined,b.raw)).body.deviceId,b.id);
 }finally{await f.close();}
});
test('access mutations roll back if audit storage fails',async()=>{
 const f=await fixture();try{
  const a=await f.register();f.store.db.exec("CREATE TRIGGER reject_access_audit BEFORE INSERT ON records WHEN NEW.kind='audit' BEGIN SELECT RAISE(ABORT,'injected'); END");
  assert.equal((await f.call('/admin/devices/'+a.id+'/recovery',{expectedAccessVersion:1})).status,500);
  assert.equal((await f.call('/agent/access',undefined,a.raw)).status,200);assert.equal(f.store.get('device',a.id).revoked,undefined);
  assert.equal((await f.call('/agent/access/rotate',{newToken:token(),expectedAccessVersion:1},a.raw)).status,500);
  assert.equal((await f.call('/agent/access',undefined,a.raw)).body.accessVersion,1);
 }finally{await f.close();}
});
test('operator/CSRF and DEMO/forwarded HTTP boundaries protect new access endpoints',async()=>{
 const f=await fixture();try{
  const a=await f.register();assert.equal((await f.call('/admin/devices/'+a.id+'/rotate',{expectedAccessVersion:1},undefined,{'X-CSRF-Token':'bad'})).status,403);
  assert.equal((await f.call('/agent/access',undefined,a.raw,{'X-Forwarded-For':'192.0.2.1'})).status,403);
  await f.login('operator','DemoOperator-2026!');
  for(const path of ['rotate','recovery'])assert.equal((await f.call('/admin/devices/'+a.id+'/'+path,{expectedAccessVersion:1})).status,403);
 }finally{await f.close();}
 const demo=await fixture(false);try{
  assert.equal((await demo.call('/admin/devices/aurora-1/recovery',{expectedAccessVersion:1})).status,403);
  assert.equal((await demo.call('/agent/recover',{})).status,403);
 }finally{await demo.close();}
});
