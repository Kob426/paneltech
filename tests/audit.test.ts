import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store';
import {Core,password} from '../server/core';
import {createApp} from '../server/app';
import {appendAudit,auditPage} from '../server/audit';
import {inspectSchema,migrate} from '../server/migrations';
import {createBackup,restoreBackup} from '../server/database-backup';
const ownerSecret='DemoAdmin-2026!',staffSecret='SECRET_AUDIT_PASSWORD_2026';
async function fixture(path=':memory:'){
 const s=new Store(path),c=new Core(s);c.seed();s.put('user',{id:'second',username:'second',password:password(ownerSecret),role:'admin',disabled:false});
 const server=createApp(c,{realAgents:true}).listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/api`;
 type Auth={cookie:string;csrf:string};
 async function req(path:string,method='GET',body?:unknown,auth?:Auth,bearer?:string){const r=await fetch(url+path,{method,headers:{'Content-Type':'application/json',...(auth?{Cookie:auth.cookie,'X-CSRF-Token':auth.csrf}:{}),...(bearer?{Authorization:'Bearer '+bearer}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:r.headers.get('content-type')?.includes('json')?await r.json():await r.text(),headers:r.headers};}
 async function login(username='admin',secret=ownerSecret){const r=await req('/login','POST',{username,password:secret});assert.equal(r.status,200);return {cookie:r.headers.get('set-cookie')!.split(';')[0],csrf:r.body.csrf};}
 return {s,c,req,login,close:async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));s.close();}};
}

test('two admins cannot overwrite the same game or club; stale and missing versions add no events',async()=>{
 const f=await fixture();try{const a=await f.login(),b=await f.login('second');
  for(const [kind,id,data] of [['games','fortnite',{name:'First',exes:['first.exe']}],['clubs','aurora',{name:'First club',variants:[{id:36,name:'36'}]}]] as const){
   const route='/admin/'+kind+'/'+id,first=await f.req(route,'PUT',{...data,expectedVersion:1},a);assert.equal(first.status,200);
   const count=f.s.all('audit').length;
   const conflict=await f.req(route,'PUT',{...data,name:'STALE',expectedVersion:1},b);assert.equal(conflict.status,409);assert.equal(conflict.body.code,'edit_conflict');
   assert.equal((await f.req(route,'PUT',data,b)).status,428);assert.equal(f.s.all('audit').length,count);
   assert.equal((await f.req(route,'GET',undefined,b)).body.name,data.name);
  }
 }finally{await f.close();}
});

test('simultaneous HTTP saves with the same version produce one commit, one conflict and one event',async()=>{
 const f=await fixture();try{const a=await f.login(),b=await f.login('second');const results=await Promise.all([
  f.req('/admin/games/fortnite','PUT',{name:'Request A',exes:['a.exe'],expectedVersion:1},a),
  f.req('/admin/games/fortnite','PUT',{name:'Request B',exes:['b.exe'],expectedVersion:1},b)
 ]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal(f.s.get('game','fortnite').revision,2);assert.equal(f.s.all('audit').length,1);assert.equal(f.s.all('audit')[0].after.name,f.s.get('game','fortnite').name);}
 finally{await f.close();}
});

test('a stale password reset cannot revoke sessions or replace a newer role/password',async()=>{
 const f=await fixture();try{const a=await f.login(),b=await f.login('second');
  const created=await f.req('/admin/users','POST',{username:'staff',role:'operator',password:staffSecret},a),id=created.body.id;
  const employee=await f.login('staff',staffSecret);
  assert.equal((await f.req('/admin/users/'+id,'PUT',{role:'admin',disabled:false,expectedVersion:1},a)).status,200);
  const relogged=await f.login('staff',staffSecret),count=f.s.all('audit').length;
  assert.equal((await f.req('/admin/users/'+id+'/password','POST',{password:'NEW_PASSWORD_CANARY_2026',expectedVersion:1},b)).status,409);
  assert.equal((await f.req('/me','GET',undefined,relogged)).status,200);assert.equal((await f.req('/me','GET',undefined,employee)).status,401);
  assert.equal(f.s.get('user',id).role,'admin');assert.equal(f.s.all('audit').length,count);
 }finally{await f.close();}
});

test('password reset shares the staff edit version and records only a boolean password marker',async()=>{
 const f=await fixture();try{const a=await f.login(),created=await f.req('/admin/users','POST',{username:'staff',role:'operator',password:staffSecret},a),id=created.body.id;
  assert.equal((await f.req('/admin/users/'+id+'/password','POST',{password:'SECOND_SECRET_PASSWORD_2026',expectedVersion:1},a)).status,200);
  assert.equal((await f.req('/admin/users/'+id,'PUT',{role:'admin',disabled:true,expectedVersion:1},a)).status,409);
  const event=f.s.all('audit').at(-1);assert.equal(event.action,'user.password_reset');assert.equal(event.after.passwordChanged,true);assert.equal(event.entity.name,'staff');
  assert.doesNotMatch(JSON.stringify(f.s.all('audit')),/SECRET|scrypt|password":|csrf|tokenHash/);
 }finally{await f.close();}
});

test('feedback uses its own version and protects an earlier operator mark from a stale draft',async()=>{
 const f=await fixture();try{const a=await f.login(),b=await f.login('operator','DemoOperator-2026!');const [j]=f.c.create({deviceIds:['aurora-1'],gameId:'fortnite',operation:'apply_marking',variant:36},'admin');f.c.tick();
  const route='/jobs/'+j.id+'/feedback';assert.equal((await f.req(route,'POST',{outcome:'helped',reason:'voice',comment:'PRIVATE_COMMENT_CANARY',expectedVersion:0},a)).status,200);
  assert.equal((await f.req(route,'POST',{outcome:'not_helped',reason:'ping',expectedVersion:0},b)).status,409);
  const latest=(await f.req(route,'GET',undefined,b)).body;assert.equal(latest.feedbackVersion,1);assert.equal(latest.feedback.outcome,'helped');assert.equal(f.s.get('job',j.id).revision,j.revision);
  assert.doesNotMatch(JSON.stringify(f.s.all('audit')),/PRIVATE_COMMENT_CANARY/);
  assert.equal((await f.req(route,'POST',{outcome:'not_helped',reason:'ping',expectedVersion:1},b)).status,200);
  assert.deepEqual(f.s.all('audit').map(e=>e.actor.name),['admin','operator']);
 }finally{await f.close();}
});

test('audit access is admin-only; caller supplied author/version/secret fields are never trusted',async()=>{
 const f=await fixture();try{const a=await f.login(),operator=await f.login('operator','DemoOperator-2026!');
  assert.equal((await f.req('/admin/audit')).status,401);assert.equal((await f.req('/admin/audit','GET',undefined,operator)).status,403);
  await f.req('/admin/clubs','POST',{name:'Safe name',variants:[{id:36,name:'36'}],actor:{name:'FORGED'},token:'SECRET_CANARY',version:900},a);
  const events=(await f.req('/admin/audit','GET',undefined,a)).body;assert.equal(events.items[0].actor.name,'admin');assert.equal(events.items[0].after.name,'Safe name');assert.doesNotMatch(JSON.stringify(events),/FORGED|SECRET_CANARY/);
  assert.equal((await f.req('/admin/audit/'+events.items[0].id,'DELETE',{},a)).status,404);
 }finally{await f.close();}
});

test('agent registration, enrollment and revocation are recorded without credential values; repeated revoke adds no event',async()=>{
 const f=await fixture();try{const a=await f.login();const club=(await f.req('/admin/clubs','POST',{name:'NO REAL PC',variants:[{id:36,name:'36'}]},a)).body;
  const enrollment=(await f.req('/admin/enrollments','POST',{clubId:club.id},a)).body;const id=randomUUID();
  const registered=await f.req('/agent/register','POST',{enrollmentToken:enrollment.token,deviceId:id,name:'CONTRACT ONLY',bootId:'boot'});assert.equal(registered.status,200);
  assert.equal((await f.req('/admin/devices/'+id+'/revoke','POST',{},a)).status,200);const count=f.s.all('audit').length;
  assert.equal((await f.req('/admin/devices/'+id+'/revoke','POST',{},a)).status,200);assert.equal(f.s.all('audit').length,count);
  const text=JSON.stringify((await f.req('/admin/audit','GET',undefined,a)).body);assert.equal(text.includes(enrollment.token),false);assert.equal(text.includes(registered.body.deviceToken),false);assert.equal(text.includes(f.s.get('user','admin').password),false);
  assert.deepEqual(f.s.all('audit').map(e=>e.action),['club.created','enrollment.created','device.registered','device.revoked']);
 }finally{await f.close();}
});

test('audit failure rolls back the catalog change and password reset/session revocation',async()=>{
 const f=await fixture();try{const a=await f.login();const staff=(await f.req('/admin/users','POST',{username:'staff',password:staffSecret,role:'operator'},a)).body,employee=await f.login('staff',staffSecret);
  f.s.db.exec("CREATE TEMP TRIGGER fail_audit BEFORE INSERT ON records WHEN NEW.kind='audit' BEGIN SELECT RAISE(ABORT,'SECRET_SQL_CANARY'); END");
  const before=f.s.get('game','fortnite');const response=await f.req('/admin/games/fortnite','PUT',{name:'Never committed',exes:[],expectedVersion:1},a);assert.equal(response.status,500);assert.doesNotMatch(JSON.stringify(response),/SECRET_SQL_CANARY/);assert.deepEqual(f.s.get('game','fortnite'),before);
  assert.equal((await f.req('/admin/users/'+staff.id+'/password','POST',{password:'NeverCommitted-2026!',expectedVersion:1},a)).status,500);assert.equal((await f.req('/me','GET',undefined,employee)).status,200);assert.equal(f.s.get('user',staff.id).version,1);
 }finally{await f.close();}
});

test('SQLite and Store forbid changing, deleting and replacing audit events',()=>{
 const s=new Store(':memory:');try{const event=s.transaction(()=>appendAudit(s,1,{id:'a',name:'A',kind:'user'},'game.created',{id:'g',name:'G',kind:'game'}));const row=s.db.prepare("SELECT rowid FROM records WHERE kind='audit'").get()!;
  assert.throws(()=>s.put('audit',event),/immutable/);assert.throws(()=>s.del('audit',event.id),/immutable/);
  assert.throws(()=>s.db.prepare("UPDATE records SET data=? WHERE kind='audit'").run(JSON.stringify({...event,at:5})),/immutable/);
  assert.throws(()=>s.db.prepare("INSERT OR REPLACE INTO records(kind,id,data) VALUES('audit',?,?)").run(event.id,JSON.stringify(event)),/immutable/);
  assert.throws(()=>s.db.prepare("INSERT OR REPLACE INTO records(rowid,kind,id,data) VALUES(?,'meta','replace','{\"id\":\"replace\"}')").run(row.rowid!),/immutable/);
  assert.equal(s.all('audit').length,1);assert.deepEqual(s.all('audit')[0],event);
 }finally{s.close();}
});

test('audit pages have stable membership and combine actor/action/date filters with validation',()=>{
 const s=new Store(':memory:');try{
  for(let i=0;i<57;i++)s.transaction(()=>appendAudit(s,i,{id:i%2?'a':'b',name:'Actor',kind:'user'},i%3?'game.updated':'club.updated',{id:String(i),name:'Name',kind:'game'}));
  const first=auditPage(s,{});assert.equal(first.total,57);assert.equal(first.items.length,25);const second=auditPage(s,{page:2,snapshot:first.snapshot});assert.equal(second.items.some(i=>first.items.some(j=>j.id===i.id)),false);
  s.transaction(()=>appendAudit(s,99,{id:'a',name:'Actor',kind:'user'},'game.updated',{id:'new',name:'New',kind:'game'}));assert.equal(auditPage(s,{snapshot:first.snapshot}).total,57);assert.equal(auditPage(s,{}).total,58);
  const filter=auditPage(s,{actor:'a',action:'game.updated',from:10,to:40});assert.ok(filter.total>0);assert.ok(filter.items.every(i=>i.actor.id==='a'&&i.action==='game.updated'&&i.at>=10&&i.at<=40));
  assert.throws(()=>auditPage(s,{from:4,to:1}));assert.throws(()=>auditPage(s,{page:0}));assert.throws(()=>auditPage(s,{unknown:'x'}));
 }finally{s.close();}
});

test('v3 migration adds append-only protection without rewriting existing records or rowids',()=>{
 const s=new Store(':memory:');try{s.put('meta',{id:'old',value:1});s.db.exec('DROP TRIGGER audit_no_insert_replace;DROP TRIGGER audit_no_update;DROP TRIGGER audit_no_delete;DROP INDEX audit_created;DELETE FROM schema_migrations WHERE version>=4;PRAGMA user_version=3');const before=s.db.prepare('SELECT rowid,* FROM records').all();assert.deepEqual(migrate(s.db),{from:3,to:5});assert.deepEqual(s.db.prepare('SELECT rowid,* FROM records').all(),before);assert.equal(inspectSchema(s.db).version,5);
  s.db.exec('DROP TRIGGER audit_no_delete');assert.throws(()=>inspectSchema(s.db),/защита/);
 }finally{s.close();}
});

test('backup and restore preserve audit events exactly and keep their append-only protection',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'paneltech-audit-copy-'));let s:Store|undefined=new Store(join(dir,'live.sqlite'));try{new Core(s).seed();s.transaction(()=>appendAudit(s!,2,{id:'chief',name:'Chief',kind:'user'},'game.updated',{id:'fortnite',name:'Game',kind:'game'},{revision:1},{revision:2}));const before=s.all('audit'),backup=await createBackup(join(dir,'live.sqlite'),join(dir,'copies'));const target=join(dir,'restored.sqlite');await restoreBackup(backup.path,target);s.close();s=new Store(target);assert.deepEqual(s.all('audit'),before);assert.throws(()=>s!.del('audit',before[0].id),/immutable/);}
 finally{s?.close();rmSync(dir,{recursive:true,force:true});}
});

test('a batch creates one compact audit event rather than one copy of all job snapshots',async()=>{
 const f=await fixture();try{const a=await f.login();const result=await f.req('/jobs','POST',{deviceIds:['aurora-1','aurora-3'],gameId:'fortnite',operation:'apply_marking',variant:36},a);assert.equal(result.status,201);const events=f.s.all('audit');assert.equal(events.length,1);assert.equal(events[0].entity.id,result.body[0].batchId);assert.equal(events[0].after.count,2);assert.equal(JSON.stringify(events).includes('FortniteClient-Win64'),false);}
 finally{await f.close();}
});
