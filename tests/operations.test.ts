import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,readdirSync,existsSync,mkdirSync,symlinkSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {Store} from '../server/store';
import {Core,digest} from '../server/core';
import {createApp} from '../server/app';
import {automaticBackup,backupConfig,prepareDirectory,restoreDrill} from '../server/automatic-backup';
import {createBackup,verifyBackup} from '../server/database-backup';
import {Operations} from '../server/operations';

function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'paneltech-operations-')),source=join(directory,'demo.sqlite'),store=new Store(source),core=new Core(store);core.seed();
 const config={...backupConfig(source,{}),keep:2,startupDelayMs:10};
 return {directory,source,store,core,config,close:()=>{store.close();rmSync(directory,{recursive:true,force:true});}};
}
const packages=(directory:string)=>readdirSync(directory).filter(name=>name.startsWith('backup-'));
test('automatic backup configuration is bounded, private per source and enabled by default',()=>{
 const a=backupConfig('/tmp/one.sqlite',{}),b=backupConfig('/tmp/two.sqlite',{});
 assert.notEqual(a.directory,b.directory);assert.equal(a.enabled,true);assert.equal(a.intervalMs,21600000);assert.equal(a.keep,7);assert.equal(a.maxBytes,1073741824);
 assert.equal(backupConfig('/tmp/one.sqlite',{AUTO_BACKUP:'0'}).enabled,false);
 for(const env of [{BACKUP_KEEP:'1'},{BACKUP_KEEP:'101'},{BACKUP_INTERVAL_MINUTES:'4'},{BACKUP_MAX_MIB:'abc'},{AUTO_BACKUP:'yes'},{BACKUP_KEEP:'1e2'}])assert.throws(()=>backupConfig('/tmp/one.sqlite',env));
});
test('scheduled package is verified and restore-tested without touching live history, receipts or trust',async()=>{
 const f=fixture();try{
  const device=f.store.all('device')[0];
  f.store.put('device',{id:'synthetic',clubId:device.clubId,name:'synthetic',demo:false,revoked:false,tokenHash:digest('canary-token'),bootId:'b',lastSeen:Date.now(),inspectedAt:null,rules:[]});
  f.store.put('session',{id:'canary-session',userId:'admin',csrf:'canary-csrf',expires:Date.now()+60000});
  const job=f.core.create({deviceIds:[device.id],gameId:'fortnite',variant:36,operation:'apply_marking'},'admin')[0];
  const before=JSON.stringify(f.store.all('job')),state=await automaticBackup(f.config);
  assert.equal(state.count,1);assert.equal(state.phase,'idle');assert.equal(state.latest!.drill.expired,1);assert.equal(state.latest!.drill.revoked,1);
  assert.equal(JSON.stringify(f.store.all('job')),before);assert.equal(f.store.get('job',job.id).attempts,0);assert.ok(f.store.get('session','canary-session'));assert.ok(f.store.get('device','synthetic').tokenHash);
  const copy=join(f.config.directory,packages(f.config.directory)[0]);await verifyBackup(copy);
  assert.ok(!readdirSync(f.config.directory).some(n=>n.startsWith('.drill-')));
  for(const name of ['.status.json','.owner.json',join(packages(f.config.directory)[0],'automatic.json')])assert.ok(!readFileSync(join(f.config.directory,name),'utf8').includes('canary-'));
 }finally{f.close();}
});
test('retention keeps newest verified copies and never deletes manual backups or source history',async()=>{
 const f=fixture();try{
  const manual=await createBackup(f.source,join(f.directory,'manual'));
  const first=await automaticBackup(f.config),second=await automaticBackup(f.config),third=await automaticBackup(f.config);
  assert.equal(third.count,2);assert.equal(packages(f.config.directory).length,2);
  const ids=packages(f.config.directory).map(name=>JSON.parse(readFileSync(join(f.config.directory,name,'manifest.json'),'utf8')).id);
  assert.ok(!ids.includes(first.latest!.id));assert.ok(ids.includes(second.latest!.id));assert.ok(ids.includes(third.latest!.id));await verifyBackup(manual.path);
  assert.equal(f.store.all('club').length,2);
 }finally{f.close();}
});
test('byte budget retains the last usable copy even if that copy exceeds the budget',async()=>{
 const f=fixture();try{
  await automaticBackup(f.config);const state=await automaticBackup({...f.config,maxBytes:1});
  assert.equal(state.count,1);assert.equal(state.budgetExceeded,true);assert.ok(state.bytes>1);await verifyBackup(join(f.config.directory,packages(f.config.directory)[0]));
 }finally{f.close();}
});
test('corrupt, unmarked, foreign and partial packages are reported and excluded from deletion',async()=>{
 const f=fixture();try{
  await automaticBackup(f.config);const old=join(f.config.directory,packages(f.config.directory)[0]);appendFileSync(join(old,'backup.sqlite'),'broken');
  const manual=await createBackup(f.source,f.config.directory);mkdirSync(join(f.config.directory,'.partial-test'));writeFileSync(join(f.config.directory,'.partial-test','keep'),'canary');
  const foreign=join(f.config.directory,'operator-notes');mkdirSync(foreign);writeFileSync(join(foreign,'keep'),'canary');writeFileSync(join(f.config.directory,'.orphan-metadata.tmp'),'canary');
  const state=await automaticBackup({...f.config,maxBytes:1});assert.equal(state.count,1);assert.equal(state.skipped,5);
  assert.ok(existsSync(old));await verifyBackup(manual.path);assert.ok(existsSync(join(foreign,'keep')));assert.ok(existsSync(join(f.config.directory,'.partial-test','keep')));
 }finally{f.close();}
});
test('failed new backup leaves previous copies and persists an error for restart',async()=>{
 const f=fixture();try{
  const previous=await automaticBackup(f.config);
  await assert.rejects(()=>automaticBackup({...f.config,source:join(f.directory,'missing.sqlite')}));
  assert.equal(packages(f.config.directory).length,1);await verifyBackup(join(f.config.directory,packages(f.config.directory)[0]));
  const status=JSON.parse(readFileSync(join(f.config.directory,'.status.json'),'utf8'));assert.equal(status.error,'backup_failed');assert.equal(status.lastSuccess,previous.lastSuccess);
  const restarted=new Operations(f.config,()=>false);assert.equal(restarted.status().backup.error,'backup_failed');await restarted.stop();
 }finally{f.close();}
});
test('metadata write failure is visible without halting the source or discarding the previous usable copy',async()=>{
 const f=fixture();const first=await automaticBackup(f.config),statusPath=join(f.config.directory,'.status.json');
 // Deterministic write fault, including under root: a directory cannot be replaced by a file.
 rmSync(statusPath);mkdirSync(statusPath);const operations=new Operations(f.config,()=>f.store.halted);
 try{
  operations.run();await operations.settled();assert.equal(operations.status().backup.error,'backup_failed');assert.equal(f.store.halted,false);
  const copies=packages(f.config.directory);assert.equal(copies.length,2);
  let preserved=false;for(const name of copies){const copy=await verifyBackup(join(f.config.directory,name));if(copy.manifest.id===first.latest!.id)preserved=true;}
  assert.ok(preserved);assert.ok(f.store.get('user','admin'));assert.equal(existsSync(join(f.config.directory,'.running.lock')),false);
  rmSync(statusPath,{recursive:true});operations.run();await operations.settled();assert.equal(operations.status().backup.phase,'idle');assert.equal(operations.status().backup.count,2);
 }finally{await operations.stop();f.close();}
});
test('managed root refuses populated unowned directories, symlinks and a foreign source marker',async()=>{
 const f=fixture();try{
  mkdirSync(f.config.directory,{recursive:true});writeFileSync(join(f.config.directory,'keep'),'safe');
  await assert.rejects(()=>automaticBackup(f.config),/unowned_directory/);assert.equal(readFileSync(join(f.config.directory,'keep'),'utf8'),'safe');rmSync(f.config.directory,{recursive:true});
  prepareDirectory(f.config);assert.throws(()=>prepareDirectory({...f.config,sourceKey:'0'.repeat(64)}),/wrong_source/);
  if(process.platform!=='win32'){
   const link=join(f.directory,'linked');symlinkSync(f.config.directory,link);await assert.rejects(()=>automaticBackup({...f.config,directory:link}),/unsafe_path/);
   const outside=join(f.directory,'outside');mkdirSync(outside);writeFileSync(join(outside,'keep'),'safe');symlinkSync(outside,join(f.config.directory,'backup-symlink'));await automaticBackup(f.config);assert.equal(readFileSync(join(outside,'keep'),'utf8'),'safe');
  }
 }finally{f.close();}
});
test('cross-process lock refuses overlapping work and never clears an existing stale lock automatically',async()=>{
 const f=fixture();try{
  prepareDirectory(f.config);const lock=join(f.config.directory,'.running.lock');writeFileSync(lock,'stale');
  await assert.rejects(()=>automaticBackup(f.config),/backup_locked/);assert.equal(readFileSync(lock,'utf8'),'stale');assert.equal(packages(f.config.directory).length,0);
  rmSync(lock);await automaticBackup(f.config);assert.equal(existsSync(lock),false);
 }finally{f.close();}
});
test('separate restore drill rejects tampering and cleans scratch files',async()=>{
 const f=fixture();try{
  const copy=await createBackup(f.source,join(f.directory,'manual'));appendFileSync(join(copy.path,'backup.sqlite'),'bad');
  await assert.rejects(()=>restoreDrill(copy.path,f.directory));assert.ok(!readdirSync(f.directory).some(name=>name.startsWith('.drill-')));
 }finally{f.close();}
});
test('scheduler uses one child, survives restart without copying early, and pauses with failed storage',async()=>{
 const f=fixture();let now=Date.now(),halted=false;const operations=new Operations(f.config,()=>halted,()=>now);
 try{
  assert.equal(operations.status().backup.phase,'idle');now+=11;operations.tick();assert.equal(operations.status().backup.phase,'running');assert.equal(operations.run(),false);
  await operations.settled();assert.equal(operations.status().backup.count,1);assert.equal(operations.status().backup.phase,'idle');
  const restarted=new Operations(f.config,()=>false,()=>now);assert.equal(restarted.status().backup.count,1);assert.ok(restarted.status().backup.nextAt!>now+10000);await restarted.stop();
  now=operations.status().backup.nextAt!+1;halted=true;operations.tick();assert.equal(operations.run(),false);assert.equal(operations.status().database.state,'paused');
  halted=false;operations.tick();await operations.settled();assert.equal(operations.status().backup.count,2);
 }finally{await operations.stop();f.close();}
});
test('disabled schedule supports explicit manual copies and invalid status does not prevent safe backup',async()=>{
 const f=fixture();prepareDirectory(f.config);writeFileSync(join(f.config.directory,'.status.json'),'not json');const operations=new Operations({...f.config,enabled:false},()=>false);
 try{
  assert.equal(operations.status().backup.error,'status_invalid');assert.equal(operations.status().backup.nextAt,null);operations.tick();assert.equal(packages(f.config.directory).length,0);
  assert.equal(operations.run(),true);await operations.settled();assert.equal(operations.status().backup.phase,'idle');assert.equal(operations.status().backup.nextAt,null);assert.equal(operations.status().backup.count,1);
 }finally{await operations.stop();f.close();}
});
test('worker errors are sanitized and retry is explicit after fixing a lock',async()=>{
 const f=fixture();prepareDirectory(f.config);writeFileSync(join(f.config.directory,'.running.lock'),'CANARY_SECRET');const operations=new Operations(f.config,()=>false);
 try{
  operations.run();await operations.settled();assert.equal(operations.status().backup.error,'backup_locked');assert.ok(!JSON.stringify(operations.status()).includes('CANARY_SECRET'));
  rmSync(join(f.config.directory,'.running.lock'));operations.run();await operations.settled();assert.equal(operations.status().backup.phase,'idle');
 }finally{await operations.stop();f.close();}
});
test('a killed backup process leaves a visible persisted failure and preserves previous verified copies',async()=>{
 const f=fixture();await automaticBackup(f.config);const operations=new Operations(f.config,()=>false);
 try{
  operations.run();const child=(operations as any).child;child.once('spawn',()=>child.kill('SIGKILL'));await operations.settled();
  assert.equal(operations.status().backup.error,'worker_failed');assert.equal(packages(f.config.directory).length,1);await verifyBackup(join(f.config.directory,packages(f.config.directory)[0]));
  const restarted=new Operations(f.config,()=>false);assert.equal(restarted.status().backup.error,'worker_failed');await restarted.stop();
 }finally{await operations.stop();f.close();}
});

test('operations API enforces admin/CSRF, returns 202, rejects overlap and still reports paused storage',async()=>{
 const f=fixture();let now=Date.now();const core=new Core(f.store,()=>now),operations=new Operations({...f.config,enabled:false},()=>f.store.halted);
 const server=createApp(core,{operations}).listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api`;
 let cookie='',csrf='';
 const call=async(path:string,body?:unknown,extra:Record<string,string>={})=>{const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json',...extra},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json(),headers:response.headers};};
 const login=async(operator=false)=>{const r=await call('/login',{username:operator?'operator':'admin',password:operator?'DemoOperator-2026!':'DemoAdmin-2026!'});cookie=r.headers.get('set-cookie')!.split(';')[0];csrf=r.body.csrf;};
 try{
  assert.equal((await call('/admin/operations')).status,401);await login(true);assert.equal((await call('/admin/operations')).status,403);assert.equal((await call('/admin/operations/backup',{})).status,403);
  await login();assert.equal((await call('/admin/operations/backup',{}, {'X-CSRF-Token':''})).status,403);assert.equal((await call('/admin/operations/backup',{path:'/arbitrary'})).status,400);
  assert.equal((await call('/admin/operations/backup',{})).status,202);assert.equal((await call('/admin/operations/backup',{})).status,409);await operations.settled();
  assert.equal((await call('/admin/operations')).body.backup.count,1);assert.equal(f.store.all('audit').filter(e=>e.action==='backup.requested').length,1);
  const serialized=JSON.stringify((await call('/admin/operations')).body);for(const secret of [f.source,f.config.directory,csrf,cookie])assert.ok(!serialized.includes(secret));
  const sessions=f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='session'").get()!.n;
  f.store.halted=true;assert.equal((await call('/state')).status,503);assert.equal((await call('/admin/operations/backup',{})).status,503);const paused=await call('/admin/operations');assert.equal(paused.status,200);assert.equal(paused.body.database.state,'paused');
  now+=8*3600000;assert.equal((await call('/admin/operations')).status,401);assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='session'").get()!.n,sessions);
 }finally{await operations.stop();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));f.close();}
});
