import {makeLegacy} from './legacy-database';
import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store';
import {Core} from '../server/core';
import {createApp} from '../server/app';
import {JobQueries} from '../server/job-queries';
import type {Job} from '../shared/contracts';

function fixture(){const store=new Store(':memory:'),core=new Core(store);core.seed();const base=core.create({deviceIds:['aurora-1'],gameId:'fortnite',operation:'health'},'admin')[0];store.del('job',base.id);return {store,core,queries:new JobQueries(store),add:(i:number,patch:Partial<Job>={})=>store.put('job',{...base,id:`job-${i}`,batchId:`batch-${i}`,created:1000+i,state:'succeeded',...patch})};}

test('SQL pagination is deterministic for tied timestamps, bounds pages and never duplicates rows',()=>{
 const f=fixture();try{for(let i=0;i<73;i++)f.add(i,{created:1000});
 const a=f.queries.page({pageSize:25}),b=f.queries.page({page:2,pageSize:25,snapshot:a.snapshot}),c=f.queries.page({page:3,pageSize:25,snapshot:a.snapshot});
 assert.deepEqual(a.items.map(j=>j.id),Array.from({length:25},(_,i)=>`job-${72-i}`));
 assert.equal(new Set([...a.items,...b.items,...c.items].map(j=>j.id)).size,73);assert.equal(c.items.length,23);
 assert.equal(a.total,73);assert.equal(a.pages,3);assert.equal(f.queries.page({page:1000}).page,3);
 assert.equal(f.queries.page({author:'missing'}).pages,1);
 }finally{f.store.close();}
});
test('a stable insertion snapshot excludes new jobs on all subsequent pages and refresh includes them',()=>{
 const f=fixture();try{for(let i=0;i<30;i++)f.add(i);const first=f.queries.page({pageSize:10});
 f.add(100);f.add(101,{created:0});const rest=f.queries.page({page:2,pageSize:10,snapshot:first.snapshot});
 assert.equal(rest.total,30);assert.equal(rest.items.some(j=>['job-100','job-101'].includes(j.id)),false);
 assert.equal(new Set([...first.items,...rest.items].map(j=>j.id)).size,20);assert.equal(f.queries.page({}).total,32);
 }finally{f.store.close();}
});
test('club/device/game/author/status/date/batch filters combine and historical authors survive account removal',()=>{
 const f=fixture();try{
 f.add(1,{author:'retired',state:'failed',batchId:'group'});f.add(2,{author:'retired',state:'failed',batchId:'group'});
 f.add(3,{author:'retired',state:'unknown',clubId:'orbit'});f.add(4,{author:'admin',gameId:'pubg'});
 f.add(5,{author:'retired',state:'failed',deviceId:'aurora-2'});
 const r=f.queries.page({clubId:'aurora',deviceId:'aurora-1',gameId:'fortnite',author:'retired',state:'failed',batchId:'group',from:1001,to:1001});
 assert.deepEqual(r.items.map(j=>j.id),['job-1']);assert.deepEqual(r.authors,['admin','retired']);
 assert.equal(f.queries.page({clubId:'aurora',author:"retired' OR 1=1 --"}).total,0);
 assert.equal(f.queries.page({state:'active'}).items[0].id,'job-3');
 }finally{f.store.close();}
});
test('focus locates an operation beyond the first page while respecting filters and club scope',()=>{
 const f=fixture();try{for(let i=0;i<80;i++)f.add(i);f.add(100,{state:'unknown'});
 const r=f.queries.page({focusId:'job-0',pageSize:10,order:'active'});assert.equal(r.page,9);assert.equal(r.items[0].id,'job-0');
 assert.equal(f.queries.page({clubId:'orbit',focusId:'job-0'}).total,0);
 assert.equal(f.queries.page({author:'missing',focusId:'job-0'}).items.length,0);
 assert.equal(f.queries.page({order:'active'}).items[0].id,'job-100');
 }finally{f.store.close();}
});
test('full batch counters and membership remain correct across pages and status/date filters',()=>{
 const f=fixture();try{
 const states:Job['state'][]=['queued','running','unknown','failed','expired','succeeded'];
 for(let i=0;i<120;i++)f.add(i,{batchId:'group',state:states[i%6]});
 f.add(1000,{clubId:'orbit',batchId:'group',state:'unknown'});
 const r=f.queries.page({clubId:'aurora',batchId:'group',state:'failed',pageSize:5,from:1000,to:1100});
 assert.equal(r.items.length,5);assert.equal(r.total,17);assert.equal(r.batch!.members.length,120);
 assert.deepEqual(r.batch!.counts,{total:120,succeeded:20,failed:20,expired:20,unknown:20,pending:40});
 }finally{f.store.close();}
});
test('workspace retains old active operations and latest game-specific facts and helped marks',()=>{
 const f=fixture();try{
 f.add(0,{state:'unknown',deviceId:'aurora-6'});
 f.add(1,{operation:'apply_marking',feedback:{outcome:'helped',reason:'voice',comment:'old useful mark',author:'retired',at:9000}});
 f.add(2,{operation:'apply_marking'});f.add(3,{operation:'health'});
 for(let i=4;i<150;i++)f.add(i,{deviceId:'aurora-2',gameId:'pubg'});
 const scoped=f.queries.workspace('aurora','fortnite');
 assert.equal(scoped.length,64);for(const id of ['job-0','job-1','job-2','job-3'])assert.ok(scoped.some(j=>j.id===id));
 assert.equal(f.queries.workspace().length,61);assert.equal(f.queries.workspace('orbit','fortnite').length,0);
 }finally{f.store.close();}
});
test('snapshot membership is fixed while statuses and feedback remain live',()=>{
 const f=fixture();try{f.add(1,{state:'queued'});const first=f.queries.page({});const j=f.store.get<Job>('job','job-1')!;
 j.state='succeeded';j.feedback={outcome:'helped',reason:'voice',comment:'',author:'admin',at:9000};f.store.put('job',j);
 const next=f.queries.page({snapshot:first.snapshot});assert.equal(next.items[0].state,'succeeded');assert.equal(next.items[0].feedback!.outcome,'helped');
 }finally{f.store.close();}
});
test('opening an existing database adds indexes without changing stored history and survives reopen',()=>{
 const dir=mkdtempSync(join(tmpdir(),'paneltech-pages-')),path=join(dir,'db.sqlite');let store=new Store(path);
 try{const core=new Core(store);core.seed();core.create({deviceIds:['aurora-1'],gameId:'fortnite',operation:'health'},'admin');const before=store.all('job');store.db.exec('DROP INDEX jobs_club_created; DROP INDEX jobs_device_game_created; DROP INDEX jobs_state; DROP INDEX jobs_batch_club;');makeLegacy(store.db);store.close();store=new Store(path);
 assert.deepEqual(store.all('job'),before);assert.equal(new JobQueries(store).page({}).total,1);
 assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='jobs_club_created'").get());
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('paged API requires a session, validates limits/ranges/unknown parameters and returns no account secrets',async()=>{
 const f=fixture(),server=createApp(f.core).listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as any).port}/api`;
 try{
 assert.equal((await fetch(base+'/history')).status,401);
 const login=await fetch(base+'/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'operator',password:'DemoOperator-2026!'})});const cookie=login.headers.get('set-cookie')!.split(';')[0];
 for(const q of ['page=0','page=-1','page=1.2','pageSize=101','pageSize=0','snapshot=-1','state=bad','from=2&to=1','from=NaN','author=a&author=b','unexpected=1'])assert.equal((await fetch(base+'/history?'+q,{headers:{cookie}})).status,400,q);
 f.add(1);const r=await fetch(base+'/history?pageSize=1',{headers:{cookie}});assert.equal(r.status,200);const body=await r.json();assert.equal(body.items.length,1);assert.deepEqual(body.authors,['admin']);assert.equal(JSON.stringify(body).includes('password'),false);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));f.store.close();}
});
