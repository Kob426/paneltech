import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.js';
import {Core} from '../server/core.js';
import {createApp} from '../server/app.js';
import {ruleName,type Job,type Rule} from '../shared/contracts.js';

const input=(deviceId='aurora-5',operation='apply_marking')=>({deviceIds:[deviceId],gameId:'fortnite',operation,variant:36});
const rulesFor=(job:Job):Rule[]=>job.exes.map(exe=>({name:ruleName(job.gameId,exe),gameId:job.gameId,exe,dscp:job.variant!,owned:true}));
const snapshot=(j:Job)=>({gameId:j.gameId,gameName:j.gameName,revision:j.revision,exes:j.exes,variant:j.variant,variantName:j.variantName,clubName:j.clubName,allowedVariants:j.allowedVariants,bootId:j.bootId});
function changeCatalog(s:Store,clubId='aurora'){
 const game=s.get('game','fortnite'),club=s.get('club',clubId);
 s.put('game',{...game,name:'Новая карточка',revision:game.revision+1,exes:['new.exe']});
 s.put('club',{...club,name:'Новое название клуба',variants:[{id:40,name:'Новый доступный вариант'}]});
}

for(const matching of [true,false])test(`DEMO unknown compares original snapshot after catalog/variant changes: matching=${matching}`,()=>{
 const s=new Store(':memory:');try{
  const c=new Core(s);c.seed();const [job]=c.create(input(),'operator');c.tick();
  const original=snapshot(s.get<Job>('job',job.id)!);const before=c.device(job.deviceId).rules;
  changeCatalog(s);
  if(!matching){const d=c.device(job.deviceId);d.rules=[{name:ruleName(job.gameId,'new.exe'),gameId:job.gameId,exe:'new.exe',dscp:40,owned:true}];s.put('device',d);}
  const observed=c.device(job.deviceId).rules;
  c.tick();assert.equal(s.get<Job>('job',job.id)!.state,'unknown');
  assert.equal(c.create({...input(),variant:40},'operator')[0].code,'busy');
  const checked=c.reconcileDemo(job.id);
  assert.equal(checked.state,matching?'succeeded':'failed');assert.deepEqual(snapshot(checked),original);
  assert.deepEqual(c.device(job.deviceId).rules,observed);assert.equal(checked.attempts,1);
  assert.equal(c.poll(c.device(job.deviceId)),null);
  if(matching)assert.deepEqual(observed,before);
  assert.throws(()=>c.create(input(),'operator'),/Вариант недоступен/);
  const [next]=c.create({...input(),variant:40},'operator');assert.equal(next.revision,2);assert.deepEqual(next.exes,['new.exe']);
 }finally{s.close();}
});

test('queued delivery rejects removed variant before leasing to either executor',()=>{
 const s=new Store(':memory:');try{
  const c=new Core(s);c.seed();const [job]=c.create(input('aurora-1'),'admin');changeCatalog(s);
  assert.equal(c.poll(c.device(job.deviceId)),null);
  const rejected=s.get<Job>('job',job.id)!;assert.equal(rejected.state,'failed');assert.equal(rejected.code,'variant');assert.equal(rejected.attempts,0);
  assert.deepEqual(c.device(job.deviceId).rules,[]);
 }finally{s.close();}
});

test('queued work keeps original game snapshot when the variant is still authorized',()=>{
 const s=new Store(':memory:');try{
  const c=new Core(s);c.seed();const [job]=c.create(input('aurora-1'),'admin');const original=snapshot(job);
  const g=s.get('game',job.gameId);s.put('game',{...g,revision:2,exes:['new.exe']});c.tick();
  const completed=s.get<Job>('job',job.id)!;assert.equal(completed.state,'succeeded');assert.deepEqual(snapshot(completed),original);assert.deepEqual(completed.rules,rulesFor(job));
 }finally{s.close();}
});

test('unknown removal reconciles absence of original game rules without removing foreign/other game rules',()=>{
 const s=new Store(':memory:');try{
  const c=new Core(s);c.seed();const d=c.device('aurora-5');
  const foreign:Rule={name:'Foreign',gameId:'foreign',exe:'foreign.exe',dscp:12,owned:false};
  const other:Rule={name:'Other',gameId:'other',exe:'other.exe',dscp:10,owned:true};
  d.rules=[foreign,other,{name:ruleName('fortnite','old.exe'),gameId:'fortnite',exe:'old.exe',dscp:36,owned:true}];s.put('device',d);
  const [job]=c.create(input(d.id,'remove_marking'),'admin');c.tick();assert.equal(s.get<Job>('job',job.id)!.state,'unknown');
  changeCatalog(s);s.del('game','fortnite');const checked=c.reconcileDemo(job.id);
  assert.equal(checked.state,'succeeded');assert.deepEqual(c.device(d.id).rules,[foreign,other]);assert.deepEqual(checked.rules,[foreign,other]);assert.equal(checked.attempts,1);
 }finally{s.close();}
});

async function fixture(){
 const s=new Store(':memory:');let now=1_000_000;const c=new Core(s,()=>now);c.seed();
 const server=createApp(c,{realAgents:true}).listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api`;
 let cookie='',csrf='',token='';
 async function request(path:string,method='GET',body?:unknown,agent=false){
  const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(agent?{Authorization:'Bearer '+token}:{Cookie:cookie,'X-CSRF-Token':csrf})},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
 }
 const auth=await fetch(base+'/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'DemoAdmin-2026!'})});
 cookie=auth.headers.get('set-cookie')!.split(';')[0];csrf=(await auth.json()).csrf;
 const club=await request('/admin/clubs','POST',{name:'Protocol fixture, no Windows PC',variants:[{id:36,name:'Original 36'},{id:40,name:'Original 40'}]});
 const enrollment=await request('/admin/enrollments','POST',{clubId:club.body.id});
 const registration=await request('/agent/register','POST',{deviceId:randomUUID(),name:'HTTP fixture only',bootId:'boot-1',enrollmentToken:enrollment.body.token});
 token=registration.body.deviceToken;
 const device=s.all('device').find(d=>!d.demo)!;
 const poll=(rules:Rule[]=[],inspectionVerified=true,bootId='boot-1')=>request('/agent/poll','POST',{rules,inspectionVerified,bootId},true);
 const create=async(operation='apply_marking',variant=36)=>request('/jobs','POST',{...input(device.id,operation),variant});
 async function unknown(){const made=await create();assert.equal(made.status,201);const job=made.body[0] as Job;assert.equal((await poll()).body.job.id,job.id);now+=30001;c.expire();assert.equal(s.get<Job>('job',job.id)!.state,'unknown');await poll([],false);return job;}
 return {s,c,request,poll,create,unknown,device,clubId:club.body.id,close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));s.close();}};
}

for(const matching of [true,false])test(`authenticated inspection after catalog changes uses original expected rules: matching=${matching}`,async()=>{
 const f=await fixture();try{
  const job=await f.unknown(),original=snapshot(job);changeCatalog(f.s,f.clubId);
  const rules=matching?rulesFor(job):[{name:ruleName(job.gameId,'new.exe'),gameId:job.gameId,exe:'new.exe',dscp:40,owned:true}];
  assert.equal((await f.create('apply_marking',40)).body[0].code,'busy');
  const answer=await f.poll(rules);assert.equal(answer.body.job,null);
  const checked=f.s.get<Job>('job',job.id)!;assert.equal(checked.state,matching?'succeeded':'failed');assert.equal(checked.code,'reconciled');assert.deepEqual(snapshot(checked),original);assert.equal(checked.attempts,1);
  assert.deepEqual(f.c.device(f.device.id).rules,rules);
  const terminal=structuredClone(checked);
  // A stale result cannot rewrite the fresh inspection or a newer job snapshot.
  await f.request('/agent/results/'+job.id,'POST',{bootId:'boot-1',state:'unknown',code:'old',message:'late',rules:[],dryRun:false},true);
  assert.deepEqual(f.s.get('job',job.id),terminal);assert.deepEqual(f.c.device(f.device.id).rules,rules);
  assert.equal((await f.create()).status,400);const next=await f.create('apply_marking',40);assert.equal(next.status,201);assert.deepEqual(next.body[0].exes,['new.exe']);assert.equal(next.body[0].revision,2);
 }finally{await f.close();}
});

test('unverified inspection cannot resolve unknown even with matching old rules and a revised catalog',async()=>{
 const f=await fixture();try{
  const job=await f.unknown();changeCatalog(f.s,f.clubId);
  assert.equal((await f.poll(rulesFor(job),false)).body.job,null);
  assert.equal(f.s.get<Job>('job',job.id)!.state,'unknown');assert.equal((await f.create('apply_marking',40)).body[0].code,'busy');
  assert.equal(f.c.device(f.device.id).rules.length,0);
 }finally{await f.close();}
});

test('new boot cannot prove old unknown even if the rule set happens to match after catalog changes',async()=>{
 const f=await fixture();try{
  const job=await f.unknown();changeCatalog(f.s,f.clubId);await f.poll(rulesFor(job),true,'boot-2');
  const checked=f.s.get<Job>('job',job.id)!;assert.equal(checked.state,'failed');assert.equal(checked.attempts,1);assert.equal(checked.bootId,'boot-1');
 }finally{await f.close();}
});

test('agent endpoint does not deliver a queued variant that was removed before poll',async()=>{
 const f=await fixture();try{
  const made=await f.create();changeCatalog(f.s,f.clubId);const answer=await f.poll();
  assert.equal(answer.body.job,null);assert.deepEqual(answer.body.allowedVariants,[40]);assert.equal(f.s.get<Job>('job',made.body[0].id)!.code,'variant');assert.equal(f.s.get<Job>('job',made.body[0].id)!.attempts,0);
 }finally{await f.close();}
});

test('deleting the current card does not prevent reconciliation of a delivered immutable snapshot',async()=>{
 const f=await fixture();try{
  const job=await f.unknown();f.s.del('game',job.gameId);await f.poll(rulesFor(job));
  assert.equal(f.s.get<Job>('job',job.id)!.state,'succeeded');assert.deepEqual(snapshot(f.s.get<Job>('job',job.id)!),snapshot(job));assert.equal((await f.create()).status,404);
 }finally{await f.close();}
});

test('renaming an allowed DSCP variant changes neither the original snapshot nor the observed outcome',async()=>{
 const f=await fixture();try{
  const job=await f.unknown();const club=f.s.get('club',f.clubId);f.s.put('club',{...club,variants:[{id:36,name:'Переименованный 36'}]});
  const before=snapshot(job);await f.poll(rulesFor(job));
  assert.equal(f.s.get<Job>('job',job.id)!.state,'succeeded');assert.deepEqual(snapshot(f.s.get<Job>('job',job.id)!),before);
  const next=await f.create();assert.equal(next.body[0].variantName,'Переименованный 36');assert.equal(job.variantName,'Original 36');
 }finally{await f.close();}
});

test('fresh inspection rejects missing, extra, wrong DSCP, wrong name and unowned rules after revision change',async()=>{
 for(const fault of ['missing','extra','dscp','name','ownership']){
  const f=await fixture();try{
   const job=await f.unknown();changeCatalog(f.s,f.clubId);const rules=rulesFor(job);
   if(fault==='missing')rules.pop();
   if(fault==='extra')rules.push({...rules[0],name:'Unexpected',exe:'extra.exe'});
   if(fault==='dscp')rules[0].dscp=40;
   if(fault==='name')rules[0].name='Wrong-Owner-Name';
   if(fault==='ownership')rules[0].owned=false;
   await f.poll(rules);const checked=f.s.get<Job>('job',job.id)!;
   assert.equal(checked.state,'failed',fault);assert.equal(checked.attempts,1);assert.deepEqual(f.c.device(f.device.id).rules,rules);assert.deepEqual(checked.exes,job.exes);
  }finally{await f.close();}
 }
});
