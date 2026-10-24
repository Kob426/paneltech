import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {Store} from '../server/store';
import {Core,digest} from '../server/core';
import {createApp} from '../server/app';
import {QueueQueries,DeviceQueries,ACTIVE_JOB,QUEUE_INDEXES} from '../server/queue-queries';
import {migrate,inspectSchema} from '../server/migrations';
import {JobQueries} from '../server/job-queries';
import type {Job,Device} from '../shared/contracts';
const input=(ids=['aurora-1'])=>({deviceIds:ids,gameId:'fortnite',operation:'apply_marking',variant:36});
function fixture(){let now=1000000;const s=new Store(':memory:'),c=new Core(s,()=>now);c.seed();return {s,c,advance:(n:number)=>now+=n};}
function history(s:Store,c:Core,n=2000){const [j]=c.create(input(),'admin');c.tick();const base=s.get<Job>('job',j.id)!;s.transaction(()=>{for(let i=0;i<n;i++)s.put('job',{...base,id:'cold-'+i,created:i,expires:i+1});});return base;}
function coldHash(s:Store){const hash=createHash('sha256');for(const r of s.db.prepare("SELECT data FROM records WHERE kind='job' AND id LIKE 'cold-%' ORDER BY rowid").iterate())hash.update(String(r.data));return hash.digest('hex');}
function forbidGlobalHydration(s:Store){const all=s.all.bind(s);s.all=<T=any>(kind:string):T[]=>{assert.ok(!['job','device'].includes(kind),'hot path attempted global hydration: '+kind);return all<T>(kind);};}

test('create, poll, expire, reboot and idle tick never hydrate terminal history or global device lists',()=>{
 const {s,c}=fixture();try{history(s,c);const before=coldHash(s);forbidGlobalHydration(s);const decode=s.decode.bind(s);s.decode=text=>{assert.ok(!JSON.parse(text).id.startsWith('cold-'),'terminal history decoded by queue');return decode(text);};
  const [j]=c.create(input(),'admin');assert.equal(j.state,'queued');const delivered=c.poll(c.device('aurora-1'))!;assert.equal(delivered.id,j.id);c.executeDemo(delivered);c.expire();c.reboot('aurora-1');c.tick();assert.equal(s.get<Job>('job',j.id)!.state,'succeeded');assert.equal(coldHash(s),before);
 }finally{s.close();}
});

test('queue selects only the addressed device, preserves insertion FIFO and uses active states',()=>{
 const {s,c}=fixture();try{const [base]=c.create(input(),'admin');s.put('job',{...base,id:'later',created:0});s.put('job',{...base,id:'foreign-device',deviceId:'orbit-1'});const q=new QueueQueries(s);
  assert.equal(q.next('aurora-1')!.id,base.id);assert.equal(q.active('aurora-1').length,2);assert.equal(q.busy('orbit-1'),true);assert.equal(q.busy('orbit-2'),false);
  const first=c.poll(c.device('aurora-1'));assert.equal(first!.id,base.id);assert.equal(c.poll(c.device('aurora-1')),null);assert.equal(s.get<Job>('job','foreign-device')!.attempts,0);
 }finally{s.close();}
});

test('indexed deadlines expire queued, make running unknown, and leave terminal/unknown outcomes untouched',()=>{
 const {s,c,advance}=fixture();try{const [base]=c.create(input(),'admin');
  for(const state of ['queued','running','unknown','succeeded','failed','expired'] as const)s.put('job',{...base,id:'state-'+state,state});
  const untouched=['unknown','succeeded','failed','expired'].map(state=>s.get('job','state-'+state));advance(30000);assert.equal(c.queue.due(c.now()).length,3);c.expire();
  assert.equal(s.get('job','state-queued').state,'expired');assert.equal(s.get('job','state-queued').finished,c.now());assert.equal(s.get('job','state-running').state,'unknown');assert.equal(s.get('job','state-running').code,'connection_lost');assert.deepEqual(['unknown','succeeded','failed','expired'].map(state=>s.get('job','state-'+state)),untouched);
 }finally{s.close();}
});

test('a device poll expires only its lease; the global timer still expires other devices',()=>{
 const {s,c,advance}=fixture();try{const [a,b]=c.create(input(['aurora-1','aurora-3']),'admin');advance(30000);assert.equal(c.poll(c.device(a.deviceId)),null);assert.equal(s.get('job',a.id).state,'expired');assert.equal(s.get('job',b.id).state,'queued');c.tick();assert.equal(s.get('job',b.id).state,'expired');
 }finally{s.close();}
});

test('an old unknown blocks a fresh apply and survives unrelated history and demo heartbeats',()=>{
 const {s,c,advance}=fixture();try{const base=history(s,c);s.put('job',{...base,id:'old-unknown',state:'unknown',created:0});advance(1000);const before=s.get<Job>('job','old-unknown');forbidGlobalHydration(s);
  assert.equal(c.create(input(),'admin')[0].code,'busy');assert.equal(c.poll(c.device('aurora-1')),null);c.tick();assert.deepEqual(s.get('job','old-unknown'),before);
 }finally{s.close();}
});

test('bulk demo heartbeat preserves compressed rules/boot/freshness and skips offline, revoked and protocol devices',()=>{
 const {s,c,advance}=fixture();try{history(s,c,50);const protocol=c.device('aurora-3');protocol.demo=false;protocol.tokenHash=digest('ab'.repeat(32));s.put('device',protocol);const revoked=c.device('aurora-4');revoked.revoked=true;s.put('device',revoked);
  const before=s.all<Device>('device'),payloads=s.db.prepare('SELECT * FROM snapshots').all(),audit=s.all('audit');advance(4000);c.tick();
  for(const d of before){const after=c.device(d.id);assert.deepEqual(after.rules,d.rules);assert.equal(after.bootId,d.bootId);assert.equal(after.inspectedAt,d.inspectedAt);assert.equal(after.lastSeen,d.demo&&!d.revoked&&d.scenario!=='offline'?c.now():d.lastSeen);}
  assert.deepEqual(s.db.prepare('SELECT * FROM snapshots').all(),payloads);assert.deepEqual(s.all('audit'),audit);
 }finally{s.close();}
});

test('tick hydrates only queued demo candidates and never repeats completed actions',()=>{
 const {s,c}=fixture();try{history(s,c,500);s.transaction(()=>{for(let i=0;i<200;i++)s.put('device',{...c.device('aurora-1'),id:'extra-'+i,name:String(i)});});const jobs=c.create(input(Array.from({length:10},(_,i)=>'extra-'+i)),'admin');let hydrated=0;const decode=s.decode.bind(s);s.decode=text=>{hydrated++;return decode(text);};forbidGlobalHydration(s);
  c.tick();assert.ok(hydrated<100,'idle devices/history were unnecessarily hydrated');for(const j of jobs)assert.equal(s.get('job',j.id).state,'succeeded');const results=jobs.map(j=>s.get('job',j.id));c.tick();assert.deepEqual(jobs.map(j=>s.get('job',j.id)),results);
 }finally{s.close();}
});

test('scoped state returns one club, global sidebar counts and no tokens; unscoped API stays compatible',async()=>{
 const {s,c}=fixture();const server=createApp(c).listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/api`;
 try{const login=await fetch(url+'/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'DemoAdmin-2026!'})});const cookie=login.headers.get('set-cookie')!.split(';')[0];forbidGlobalHydration(s);
  const state=await(await fetch(url+'/state?clubId=aurora&gameId=fortnite',{headers:{Cookie:cookie}})).json();assert.equal(state.devices.length,6);assert.ok(state.devices.every((d:Device)=>d.clubId==='aurora'&&!('tokenHash' in d)));assert.equal(state.clubs.find((c:any)=>c.id==='orbit').deviceCount,6);assert.equal(state.clubs.find((c:any)=>c.id==='orbit').onlineCount,5);
  const all=await(await fetch(url+'/state',{headers:{Cookie:cookie}})).json();assert.equal(all.devices.length,12);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));s.close();}
});

test('protocol authentication/heartbeat use a single indexed device and still reject revoked tokens',async()=>{
 const {s,c}=fixture();const token='cd'.repeat(32),d=c.device('aurora-1');d.demo=false;d.tokenHash=digest(token);s.put('device',d);const server=createApp(c,{realAgents:true}).listen(0,'127.0.0.1');await once(server,'listening');
 try{forbidGlobalHydration(s);const request=()=>fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/api/agent/poll`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({bootId:d.bootId,rules:[],inspectionVerified:false})});assert.equal((await request()).status,200);assert.equal(new DeviceQueries(s).token(digest(token))!.id,d.id);d.revoked=true;s.put('device',d);assert.equal((await request()).status,401);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));s.close();}
});

test('SQLite plans search active-device, deadline and token indexes instead of history',()=>{
 const {s,c}=fixture();try{history(s,c,100);const plan=(sql:string,args:any[])=>s.db.prepare('EXPLAIN QUERY PLAN '+sql).all(...args).map(r=>String(r.detail)).join('\n');
  assert.match(plan(`SELECT data FROM records WHERE kind='job' AND ${ACTIVE_JOB} AND json_extract(data,'$.deviceId')=?`,['aurora-1']),/queue_device_active/);
  assert.match(plan("SELECT data FROM records INDEXED BY queue_deadline WHERE kind='job' AND json_extract(data,'$.state') IN ('queued','running') AND json_extract(data,'$.expires')<=?",[c.now()]),/queue_deadline/);
  assert.match(plan("SELECT data FROM records WHERE kind='device' AND json_extract(data,'$.tokenHash')=?",['x']),/devices_token/);
 }finally{s.close();}
});

test('workspace plans keep successful/helped lookups inside the selected club and active rows outside history',()=>{
 const {s,c}=fixture();try{history(s,c,100);const prepare=s.db.prepare.bind(s.db),plans:string[]=[];
  s.db.prepare=sql=>{const statement:any=prepare(sql);if(sql.includes('ROW_NUMBER()')){const all=statement.all.bind(statement);statement.all=(...args:any[])=>{plans.push(...prepare('EXPLAIN QUERY PLAN '+sql).all(...args).map(r=>String(r.detail)));return all(...args);};}return statement;};
  const rows=new JobQueries(s).workspace('aurora','fortnite');assert.ok(rows.length>0);assert.ok(plans.some(p=>p.includes('queue_device_active')));assert.ok(plans.some(p=>p.includes('jobs_club_created')));assert.ok(!plans.some(p=>p.includes('jobs_state')),'workspace scanned all successful jobs across clubs');
 }finally{s.close();}
});

test('v4 queue migration preserves records, snapshots, audit and rowids; partial DDL failure rolls back',()=>{
 for(const injected of [false,true]){const {s,c}=fixture();try{history(s,c,30);for(const index of QUEUE_INDEXES)s.db.exec('DROP INDEX '+index);s.db.exec('DELETE FROM schema_migrations WHERE version=5;PRAGMA user_version=4');const before=s.db.prepare('SELECT rowid,* FROM records ORDER BY rowid').all(),payloads=s.db.prepare('SELECT * FROM snapshots').all(),exec=s.db.exec.bind(s.db);
  if(injected){s.db.exec=sql=>{if(sql.includes('queue_deadline')){exec(sql.split(';')[0]+';');throw Error('injected partial queue migration');}exec(sql);};assert.throws(()=>migrate(s.db),/injected/);s.db.exec=exec;assert.equal(s.db.prepare('PRAGMA user_version').get()!.user_version,4);assert.equal(s.db.prepare("SELECT name FROM sqlite_master WHERE name='queue_device_active'").get(),undefined);}
  else{assert.deepEqual(migrate(s.db),{from:4,to:5});assert.equal(inspectSchema(s.db).version,5);}
  assert.deepEqual(s.db.prepare('SELECT rowid,* FROM records ORDER BY rowid').all(),before);assert.deepEqual(s.db.prepare('SELECT * FROM snapshots').all(),payloads);
 }finally{s.close();}}
});

test('current-schema startup validates without an unnecessary write transaction',()=>{
 const {s}=fixture();try{const exec=s.db.exec.bind(s.db);s.db.exec=()=>{throw Error('Unexpected write lock');};assert.deepEqual(migrate(s.db),{from:5,to:5});s.db.exec=exec;s.db.exec('DROP INDEX queue_deadline');assert.throws(()=>migrate(s.db),/индексы/);
 }finally{s.close();}
});
