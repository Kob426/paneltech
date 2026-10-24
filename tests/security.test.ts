import {withCurrentVersion} from './edit-request';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { Core } from '../server/core.js';
import { createApp } from '../server/app.js';
import { LoginLimiter } from '../server/login-limiter.js';

type Auth = { cookie: string; csrf: string };
async function fixture(realAgents = false, secureCookies = false) {
  let now = Date.now();
  const store = new Store(':memory:');
  const core = new Core(store, () => now); core.seed();
  const server = createApp(core, { realAgents, secureCookies }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}/api`;
  async function request(path:string, options:{method?:string; body?:unknown; raw?:string; auth?:Auth; headers?:Record<string,string>} = {}) {
    options={...options,body:withCurrentVersion(store,path,options.body)};
    const response = await fetch(base + path, {
      method: options.method ?? (options.body === undefined && options.raw === undefined ? 'GET' : 'POST'),
      headers: {'Content-Type':'application/json', ...(options.auth ? {Cookie:options.auth.cookie,'X-CSRF-Token':options.auth.csrf} : {}), ...options.headers},
      body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    });
    return { status:response.status, body:await response.json(), headers:response.headers };
  }
  async function login(username='admin', password='DemoAdmin-2026!', auth?:Auth) {
    const result = await request('/login',{body:{username,password},auth});
    assert.equal(result.status,200);
    return {cookie:result.headers.get('set-cookie')!.split(';')[0],csrf:result.body.csrf};
  }
  return { store,core,request,login,setNow:(value:number)=>now=value,advance:(ms:number)=>now+=ms,close:async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();} };
}

test('session expires at the exact boundary and the expired record is removed', async()=>{
  const f=await fixture();try{
    const auth=await f.login();const session=f.store.all('session')[0];
    f.setNow(session.expires-1);assert.equal((await f.request('/me',{auth})).status,200);
    f.setNow(session.expires);assert.equal((await f.request('/me',{auth})).status,401);
    assert.equal(f.store.all('session').length,0);
  }finally{await f.close();}
});

test('login replaces the current cookie session, preserving independent sessions; cookies are hardened', async()=>{
  const f=await fixture(false,true);try{
    const first=await f.login(), independent=await f.login(), rotated=await f.login('admin','DemoAdmin-2026!',first);
    assert.notEqual(rotated.cookie,first.cookie);
    assert.equal((await f.request('/me',{auth:first})).status,401);
    assert.equal((await f.request('/me',{auth:independent})).status,200);
    const logout=await f.request('/logout',{auth:rotated,body:{}});
    assert.equal(logout.status,200);
    const cookie=logout.headers.get('set-cookie')!;
    for(const attribute of ['HttpOnly','SameSite=Strict','Secure'])assert.ok(cookie.includes(attribute));
    assert.equal((await f.request('/me',{auth:rotated})).status,401);
    assert.equal(f.store.all('session').length,1);
  }finally{await f.close();}
});

test('changing forwarded IP cannot bypass the failed-login account limit, which resets at expiry', async()=>{
  const f=await fixture();try{
    for(let i=1;i<=10;i++)assert.equal((await f.request('/login',{body:{username:'admin',password:'wrong'},headers:{'X-Forwarded-For':`203.0.113.${i}`}})).status,401);
    assert.equal((await f.request('/login',{body:{username:'admin',password:'DemoAdmin-2026!'},headers:{'X-Forwarded-For':'203.0.113.50'}})).status,429);
    f.advance(300000);
    assert.equal((await f.request('/login',{body:{username:'admin',password:'DemoAdmin-2026!'},headers:{'X-Forwarded-For':'203.0.113.50'}})).status,200);
  }finally{await f.close();}
});

test('changing account names cannot bypass the failed-login IP limit', async()=>{
  const f=await fixture();try{
    for(let i=0;i<10;i++)assert.equal((await f.request('/login',{body:{username:'missing-'+i,password:'wrong'}})).status,401);
    assert.equal((await f.request('/login',{body:{username:'admin',password:'DemoAdmin-2026!'}})).status,429);
  }finally{await f.close();}
});

test('rate-limit capacity fails closed rather than evicting live windows',()=>{
  const limiter=new LoginLimiter(2,100,4);
  limiter.check(['ip:a','account:a'],0);limiter.failed(['ip:a','account:a'],0);
  limiter.check(['ip:b','account:b'],1);limiter.failed(['ip:b','account:b'],1);
  assert.throws(()=>limiter.check(['ip:c','account:c'],2),(e:any)=>e.status===429);
  limiter.check(['ip:a','account:a'],3);limiter.failed(['ip:a','account:a'],3);
  assert.throws(()=>limiter.check(['ip:a','account:a'],4),(e:any)=>e.status===429);
  assert.doesNotThrow(()=>limiter.check(['ip:c','account:c'],101));
});

test('CSRF, wrong Origin and cross-site fetch fail closed, without creating jobs',async()=>{
  const f=await fixture();try{
    const auth=await f.login();const body={deviceIds:['aurora-1'],gameId:'fortnite',variant:36,operation:'apply_marking'};
    assert.equal((await f.request('/jobs',{auth,body,headers:{'X-CSRF-Token':'wrong'}})).status,403);
    assert.equal((await f.request('/jobs',{auth,body,headers:{Origin:'https://attacker.invalid'}})).status,403);
    assert.equal((await f.request('/jobs',{auth,body,headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
    assert.equal((await f.request('/login',{body:{username:'admin',password:'DemoAdmin-2026!'},headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
    assert.equal(f.store.all('job').length,0);
  }finally{await f.close();}
});

test('malformed and oversized JSON have safe errors and security headers without echoing supplied text',async()=>{
  const f=await fixture();try{
    for(const [raw,status] of [['{"password":"DO_NOT_ECHO",',400],['{"password":"'+ 'x'.repeat(140000) +'"}',413]] as const){
      const response=await f.request('/login',{raw});assert.equal(response.status,status);
      assert.equal(response.headers.get('cache-control'),'no-store');
      assert.equal(response.headers.get('x-content-type-options'),'nosniff');
      assert.equal(response.headers.get('x-frame-options'),'DENY');
      assert.ok(!JSON.stringify(response.body).includes('DO_NOT_ECHO'));
      assert.ok(JSON.stringify(response.body).length<300);
    }
  }finally{await f.close();}
});

test('operator cannot promote itself; password reset revokes prior sessions',async()=>{
  const f=await fixture();try{
    const admin=await f.login(), operator=await f.login('operator','DemoOperator-2026!');
    assert.equal((await f.request('/admin/users/operator',{method:'PUT',auth:operator,body:{role:'admin',disabled:false}})).status,403);
    assert.equal(f.store.get('user','operator').role,'operator');
    assert.equal((await f.request('/admin/users/operator',{method:'PUT',auth:admin,body:{role:'operator',disabled:false,password:'ChangedOperator-2026!'}})).status,200);
    assert.equal((await f.request('/state',{auth:operator})).status,401);
    assert.equal((await f.request('/login',{body:{username:'operator',password:'DemoOperator-2026!'}})).status,401);
    await f.login('operator','ChangedOperator-2026!');
  }finally{await f.close();}
});

test('browser sessions and device tokens are separate; an agent can report only delivered own jobs and revocation is immediate',async()=>{
  const f=await fixture(true);try{
    const admin=await f.login();f.store.put('club',{id:'pilot',name:'Security fixture',demo:false,variants:[{id:36,name:'36'}]});
    async function enroll(){const e=await f.request('/admin/enrollments',{auth:admin,body:{clubId:'pilot'}});const id=randomUUID();const result=await f.request('/agent/register',{body:{enrollmentToken:e.body.token,deviceId:id,name:'Fixture',bootId:'boot'}});assert.equal(result.status,200);return {id,token:result.body.deviceToken};}
    const a=await enroll(), b=await enroll();const bearer={Authorization:'Bearer '+a.token};
    const poll={bootId:'boot',rules:[],inspectionVerified:true};
    assert.equal((await f.request('/agent/poll',{auth:admin,body:poll})).status,401);
    assert.equal((await f.request('/me',{headers:bearer})).status,401);
    assert.equal((await f.request('/agent/poll',{body:poll,headers:{Authorization:a.token}})).status,401);
    const [job]=f.core.create({deviceIds:[a.id],gameId:'fortnite',operation:'health'},'admin');
    const result={bootId:'boot',state:'succeeded',code:'inspected',message:'Fixture',rules:[],dryRun:false};
    assert.equal((await f.request('/agent/results/'+job.id,{body:result,headers:{Authorization:'Bearer '+b.token}})).status,403);
    assert.equal((await f.request('/agent/results/'+job.id,{body:result,headers:bearer})).status,409);
    assert.equal(f.store.get('job',job.id).state,'queued');
    assert.equal((await f.request('/agent/poll',{body:poll,headers:bearer})).body.job.id,job.id);
    assert.equal((await f.request('/agent/results/'+job.id,{body:result,headers:bearer})).status,200);
    await f.request('/admin/devices/'+a.id+'/revoke',{auth:admin,body:{}});
    assert.equal((await f.request('/agent/poll',{body:poll,headers:bearer})).status,401);
    assert.equal((await f.request('/agent/results/'+job.id,{body:result,headers:bearer})).status,401);
    const state=await f.request('/state',{auth:admin});
    assert.equal(state.body.devices.some((d:any)=>'tokenHash' in d),false);
  }finally{await f.close();}
});
