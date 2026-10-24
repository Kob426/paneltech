import {withCurrentVersion} from './edit-request';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {Store} from '../server/store.js';
import {Core,checkPassword} from '../server/core.js';
import {initializeLocalOwner} from '../server/local-owner.js';
import {createApp} from '../server/app.js';

const ownerSecret='OwnerFixture-2026!',staffSecret='StaffFixture-2026!',nextSecret='NextFixture-2026!';
test('local owner initialization creates one private administrator and fictional PCs, without demo credentials',()=>{
 const s=new Store(':memory:');try{
  initializeLocalOwner(s,'chief',ownerSecret);const users=s.all('user');assert.equal(users.length,1);assert.equal(users[0].role,'admin');assert.equal(users[0].username,'chief');assert.notEqual(users[0].password,ownerSecret);assert.equal(checkPassword(ownerSecret,users[0].password),true);
  assert.equal(s.get('meta','demo').personalAccounts,true);assert.equal(s.all('device').length,12);assert.equal(s.all('device').every(d=>d.demo),true);
 }finally{s.close();}
});
test('local bootstrap cannot overwrite existing users, a demo database or partially populated data',()=>{
 for(const state of ['personal','demo','partial']){const s=new Store(':memory:');try{
  if(state==='personal')initializeLocalOwner(s,'chief',ownerSecret);else if(state==='demo')new Core(s).seed();else s.put('club',{id:'existing',name:'Existing data'});
  const before=s.db.prepare('SELECT * FROM records ORDER BY kind,id').all();assert.throws(()=>initializeLocalOwner(s,'different',nextSecret),/уже содержит/);assert.deepEqual(s.db.prepare('SELECT * FROM records ORDER BY kind,id').all(),before);
 }finally{s.close();}}
});
test('invalid owner input creates no records and never includes the submitted secret in errors',()=>{
 const s=new Store(':memory:');try{
  for(const [name,secret] of [['ab',ownerSecret],['chief','short'],['chief','x'.repeat(201)]]){
   assert.throws(()=>initializeLocalOwner(s,name,secret),(error:unknown)=>error instanceof Error&&!error.message.includes(secret));assert.deepEqual(s.all('user'),[]);assert.equal(s.get('meta','demo'),undefined);
  }
 }finally{s.close();}
});
async function fixture(){
 const s=new Store(':memory:');initializeLocalOwner(s,'chief',ownerSecret);const c=new Core(s);
 const server=createApp(c,{personalAccounts:true}).listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/api`;
 type Auth={cookie:string;csrf:string};
 async function request(path:string,body?:unknown,auth?:Auth){body=withCurrentVersion(s,path,body);const r=await fetch(url+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Cookie:auth?.cookie??'','X-CSRF-Token':auth?.csrf??''},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]??''};}
 async function login(username:string,password:string){const r=await request('/login',{username,password});return {...r,auth:{cookie:r.cookie,csrf:r.body.csrf}};}
 const owner=await login('chief',ownerSecret);
 return {s,request,login,owner:owner.auth,close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));s.close();}};
}
test('private local API advertises personal login, keeps real agents disabled and rejects public demo credentials',async()=>{
 const f=await fixture();try{
  const health=await f.request('/health');assert.equal(health.body.personalAccounts,true);assert.equal(health.body.realAgents,false);assert.equal(health.body.mode,'DEMO');
  assert.equal((await f.login('admin','DemoAdmin-2026!')).status,401);assert.equal((await f.login('operator','DemoOperator-2026!')).status,401);
  assert.equal((await f.request('/state',undefined,f.owner)).status,200);assert.equal((await f.request('/agent/register',{})).status,403);
 }finally{await f.close();}
});
test('owner creates staff; password-only reset revokes every target session while preserving role and owner access',async()=>{
 const f=await fixture();try{
  assert.equal((await f.request('/admin/users',{username:'staff',password:staffSecret,role:'operator'},f.owner)).status,201);
  const first=await f.login('staff',staffSecret),second=await f.login('staff',staffSecret);const target=f.s.all('user').find(u=>u.username==='staff')!;
  assert.equal((await f.request('/admin/users',undefined,first.auth)).status,403);
  const response=await f.request('/admin/users/'+target.id+'/password',{password:nextSecret,role:'admin',disabled:true},f.owner);
  assert.equal(response.status,200);assert.equal(response.body.id,target.id);assert.equal(response.body.version,2);assert.equal('password' in response.body,false);assert.equal(f.s.get('user',target.id).role,'operator');assert.equal(f.s.get('user',target.id).disabled,false);
  for(const employee of [first,second])assert.equal((await f.request('/me',undefined,employee.auth)).status,401);
  assert.equal((await f.request('/me',undefined,f.owner)).status,200);assert.equal((await f.login('staff',staffSecret)).status,401);assert.equal((await f.login('staff',nextSecret)).status,200);
  const listed=await f.request('/admin/users',undefined,f.owner);assert.equal(listed.body.some((u:Record<string,unknown>)=>'password' in u),false);
 }finally{await f.close();}
});
test('reset rejects operator, missing CSRF, unknown user and invalid password without changing the target',async()=>{
 const f=await fixture();try{
  await f.request('/admin/users',{username:'staff',password:staffSecret,role:'operator'},f.owner);const employee=await f.login('staff',staffSecret),target=f.s.all('user').find(u=>u.username==='staff')!;const before=f.s.get('user',target.id);
  assert.equal((await f.request('/admin/users/'+target.id+'/password',{password:nextSecret},employee.auth)).status,403);
  assert.equal((await f.request('/admin/users/'+target.id+'/password',{password:nextSecret},{...f.owner,csrf:''})).status,403);
  assert.equal((await f.request('/admin/users/absent/password',{password:nextSecret},f.owner)).status,404);
  assert.equal((await f.request('/admin/users/'+target.id+'/password',{password:'short'},f.owner)).status,400);
  assert.deepEqual(f.s.get('user',target.id),before);assert.equal((await f.request('/me',undefined,employee.auth)).status,200);
 }finally{await f.close();}
});
