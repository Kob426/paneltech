import {makeLegacy} from './legacy-database';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {appendFileSync,existsSync,lstatSync,mkdtempSync,readFileSync,readdirSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Store} from '../server/store';
import {Core,checkPassword,password} from '../server/core';
import {initializeLocalOwner} from '../server/local-owner';
import {createBackup,verifyBackup,restoreBackup} from '../server/database-backup';
import {inspectSchema} from '../server/migrations';
import type {Job} from '../shared/contracts';

function fixture(){const dir=mkdtempSync(join(tmpdir(),'paneltech-online-')),path=join(dir,'live.sqlite'),store=new Store(path);initializeLocalOwner(store,'chief','OwnerBackupFixture-2026!');return {dir,path,store,core:new Core(store),out:join(dir,'copies'),close:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};}
const input=(id:string)=>({deviceIds:[id],gameId:'fortnite',variant:36,operation:'apply_marking'});

test('online WAL backup pins a coherent read snapshot while another connection commits between steps',async()=>{
 const f=fixture();let second:Store|undefined;
 try{
  f.store.db.exec('PRAGMA wal_autocheckpoint=0');
  for(let i=0;i<160;i++)f.store.put('meta',{id:'padding-'+i,value:'x'.repeat(8192)});
  f.store.transaction(()=>{f.store.put('meta',{id:'left',generation:1});f.store.put('meta',{id:'right',generation:1});});
  second=new Store(f.path);let wrote=false,steps=0;
  const saved=await createBackup(f.path,f.out,{rate:1,progress:()=>{steps++;if(!wrote){wrote=true;second!.transaction(()=>{second!.put('meta',{id:'left',generation:2});second!.put('meta',{id:'right',generation:2});});}}});
  assert.ok(wrote&&steps>1);await verifyBackup(saved.path);
  const copy=new DatabaseSync(join(saved.path,'backup.sqlite'),{readOnly:true});try{const gen=(id:string)=>JSON.parse((copy.prepare("SELECT data FROM records WHERE kind='meta' AND id=?").get(id) as {data:string}).data).generation;assert.equal(gen('left'),1);assert.equal(gen('right'),1);assert.equal(copy.prepare('PRAGMA journal_mode').get()!.journal_mode,'delete');}finally{copy.close();}
  assert.equal(f.store.get('meta','left').generation,2);
  assert.equal(existsSync(join(saved.path,'backup.sqlite-wal')),false);assert.equal(existsSync(join(saved.path,'backup.sqlite-shm')),false);
  assert.deepEqual(readdirSync(saved.path).sort(),['backup.sqlite','manifest.json']);
  if(process.platform!=='win32'){assert.equal(lstatSync(saved.path).mode&0o777,0o700);assert.equal(lstatSync(join(saved.path,'backup.sqlite')).mode&0o777,0o600);}
 }finally{second?.close();f.close();}
});
test('continuous commits cannot restart incremental backup and source reader releases on success or failure',async()=>{
 const f=fixture();let writer:Store|undefined;
 try{
  for(let n=0;n<160;n++)f.store.put('meta',{id:'bulk-'+n,value:'x'.repeat(8192)});
  f.store.put('meta',{id:'generation',value:0});writer=new Store(f.path);
  let previous=Infinity,writes=0;
  const saved=await createBackup(f.path,f.out,{rate:8,progress:p=>{
   assert.ok(p.remainingPages<previous,'backup must progress despite commits');previous=p.remainingPages;
   writer!.put('meta',{id:'generation',value:++writes});
  }});
  assert.ok(writes>5);await verifyBackup(saved.path);
  const copy=new DatabaseSync(join(saved.path,'backup.sqlite'),{readOnly:true});
  try{assert.equal(JSON.parse(String(copy.prepare("SELECT data FROM records WHERE kind='meta' AND id='generation'").get()!.data)).value,0);}finally{copy.close();}
  assert.equal(f.store.get('meta','generation').value,writes);
  assert.equal(writer.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()!.busy,0);
  await assert.rejects(()=>createBackup(f.path,f.out,{rate:8,progress:()=>{
   writer!.put('meta',{id:'generation',value:++writes});throw Error('stop-copy');
  }}),/stop-copy/);
  assert.equal(writer.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()!.busy,0);
  assert.equal(readdirSync(f.out).filter(name=>name.startsWith('.partial-')).length,0);
 }finally{writer?.close();f.close();}
});
test('restore preserves owner, catalog snapshots and helped marks while expiring queues and revoking old access',async()=>{
 const f=fixture();let restored:Store|undefined;
 try{
  const done=f.core.create(input('aurora-1'),'chief')[0];f.core.tick();
  const saved=f.store.get<Job>('job',done.id)!;saved.feedback={outcome:'helped',reason:'voice',comment:'DEMO backup mark',author:'chief',at:Date.now()};f.store.put('job',saved);
  const queued=f.core.create(input('aurora-3'),'chief')[0],running=f.core.create(input('aurora-4'),'chief')[0];f.core.poll(f.core.device(running.deviceId));
  const uncertain=f.core.create(input('aurora-5'),'chief')[0];f.core.executeDemo(f.core.poll(f.core.device(uncertain.deviceId))!);
  f.store.put('session',{id:'old-session',userId:'local-owner',expires:Date.now()+60000});f.store.put('enrollment',{id:'old-enrollment',expires:Date.now()+60000});
  f.store.put('device',{id:'real-fixture',name:'Not a real PC',clubId:'aurora',demo:false,tokenHash:'old-token-hash',bootId:'old-boot',lastSeen:Date.now(),inspectedAt:Date.now(),rules:[]});
  const terminal=f.store.db.prepare("SELECT data FROM records WHERE kind='job' AND id=?").get(done.id)!.data;
  const backup=await createBackup(f.path,f.out),target=join(f.dir,'restored.sqlite');
  f.store.del('job',done.id);const game=f.store.get('game','fortnite');f.store.put('game',{...game,revision:2,exes:['changed.exe']});
  const result=await restoreBackup(backup.path,target);assert.deepEqual([result.expired,result.unknown,result.revoked],[1,2,1]);
  restored=new Store(target);assert.equal(inspectSchema(restored.db).version,5);
  assert.equal(checkPassword('OwnerBackupFixture-2026!',restored.get('user','local-owner').password),true);
  assert.equal(restored.db.prepare("SELECT data FROM records WHERE kind='job' AND id=?").get(done.id)!.data,terminal);
  assert.equal(restored.get('game','fortnite').revision,1);assert.equal(restored.get('job',queued.id).state,'expired');assert.equal(restored.get('job',running.id).state,'unknown');assert.equal(restored.get('job',uncertain.id).state,'unknown');
  assert.deepEqual(restored.all('session'),[]);assert.deepEqual(restored.all('enrollment'),[]);
  assert.equal(restored.get('device','real-fixture').revoked,true);assert.equal(restored.get('device','real-fixture').tokenHash,undefined);
  assert.equal(restored.get('device','aurora-1').inspectedAt,null);assert.equal(restored.get('device','aurora-1').rules.filter((r:any)=>r.owned).length,0);
  const count=restored.all('job').length;new Core(restored).tick();assert.equal(restored.all('job').length,count);assert.equal(restored.get('job',running.id).attempts,1);
 }finally{restored?.close();f.close();}
});
test('unexpected SQLite sidecars and checksum corruption prevent restore without creating a destination',async()=>{
 const f=fixture();try{const r=await createBackup(f.path,f.out);const target=join(f.dir,'rejected.sqlite');writeFileSync(join(r.path,'backup.sqlite-wal'),'unexpected WAL');await assert.rejects(()=>restoreBackup(r.path,target),/служебные/);assert.equal(existsSync(target),false);rmSync(join(r.path,'backup.sqlite-wal'));await verifyBackup(r.path);appendFileSync(join(r.path,'backup.sqlite'),'damage');await assert.rejects(()=>verifyBackup(r.path),/SHA-256/);await assert.rejects(()=>restoreBackup(r.path,target),/SHA-256/);assert.equal(existsSync(target),false);}finally{f.close();}
});
test('manifest validation and database checks reject mismatched metadata and invalid SQLite even with a recomputed hash',async()=>{
 const f=fixture();try{
  const r=await createBackup(f.path,f.out),meta=join(r.path,'manifest.json'),file=join(r.path,'backup.sqlite');
  writeFileSync(meta,JSON.stringify({...r.manifest,records:r.manifest.records+1}));await assert.rejects(()=>verifyBackup(r.path),/Манифест/);
  writeFileSync(file,'not SQLite; fixture-secret-do-not-print');const data=readFileSync(file);writeFileSync(meta,JSON.stringify({...r.manifest,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')}));await assert.rejects(()=>verifyBackup(r.path));
 }finally{f.close();}
});
test('restore refuses existing files, dangling symlinks and orphan WAL files without changing them',async()=>{
 const f=fixture();try{
  const r=await createBackup(f.path,f.out),existing=join(f.dir,'existing.sqlite');writeFileSync(existing,'untouched');await assert.rejects(()=>restoreBackup(r.path,existing),/существуют/);assert.equal(readFileSync(existing,'utf8'),'untouched');
  const orphan=join(f.dir,'orphan.sqlite');writeFileSync(orphan+'-wal','untouched WAL');await assert.rejects(()=>restoreBackup(r.path,orphan),/существуют/);assert.equal(existsSync(orphan),false);assert.equal(readFileSync(orphan+'-wal','utf8'),'untouched WAL');
  if(process.platform!=='win32'){const link=join(f.dir,'dangling.sqlite');symlinkSync(join(f.dir,'missing.sqlite'),link);await assert.rejects(()=>restoreBackup(r.path,link),/существуют/);assert.equal(lstatSync(link).isSymbolicLink(),true);}
 }finally{f.close();}
});
test('backup failures leave the live database usable and publish no partial package',async()=>{
 const f=fixture();try{
  for(let i=0;i<40;i++)f.store.put('meta',{id:'padding-'+i,value:'x'.repeat(8192)});
  await assert.rejects(()=>createBackup(f.path,f.out,{rate:1,progress:()=>{throw Error('injected backup failure');}}),/injected/);
  assert.deepEqual(readdirSync(f.out),[]);assert.equal(f.store.get('user','local-owner').username,'chief');
  const blocked=join(f.dir,'not-a-directory');writeFileSync(blocked,'untouched');await assert.rejects(()=>createBackup(f.path,join(blocked,'nested')));assert.equal(readFileSync(blocked,'utf8'),'untouched');
  assert.ok((await createBackup(f.path,f.out)).manifest.records>40);
 }finally{f.close();}
});
test('legacy backup is verified without mutation and upgraded only in the new restored file',async()=>{
 const f=fixture();let restored:Store|undefined;
 try{
  makeLegacy(f.store.db);
  const before=f.store.db.prepare('SELECT rowid,* FROM records ORDER BY rowid').all();
  const r=await createBackup(f.path,f.out);assert.equal(r.manifest.schemaVersion,0);assert.equal(f.store.db.prepare('PRAGMA user_version').get()!.user_version,0);assert.deepEqual(f.store.db.prepare('SELECT rowid,* FROM records ORDER BY rowid').all(),before);
  const target=join(f.dir,'upgraded.sqlite');await restoreBackup(r.path,target);restored=new Store(target);assert.equal(inspectSchema(restored.db).version,5);assert.equal(restored.get('user','local-owner').username,'chief');
 }finally{restored?.close();f.close();}
});
test('pilot restore stays marked as pilot and never silently becomes public demo',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'paneltech-pilot-backup-')),path=join(dir,'pilot.sqlite');const s=new Store(path);let restored:Store|undefined;
 try{s.put('user',{id:'pilot-owner',username:'owner',password:password('PilotBackupFixture-2026!'),role:'admin',disabled:false});s.put('club',{id:'pilot',name:'Fictional pilot',demo:false,variants:[{id:36,name:'36'}]});const r=await createBackup(path,join(dir,'copies'));assert.equal(r.manifest.mode,'pilot');const target=join(dir,'restored.sqlite');await restoreBackup(r.path,target);restored=new Store(target);assert.equal(restored.get('meta','restoration').sourceMode,'pilot');assert.equal(restored.get('user','admin'),undefined);}finally{restored?.close();s.close();rmSync(dir,{recursive:true,force:true});}
});
