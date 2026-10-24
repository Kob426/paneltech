import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store';
import {Core} from '../server/core';
import {makeLegacy} from './legacy-database';
import {inspectSchema,migrate} from '../server/migrations';
import {collectSnapshots,decodeRecord,vacuumPreservingRowids} from '../server/snapshots';
import {compactDatabase,storageStats} from '../server/database-storage';
import {JobQueries} from '../server/job-queries';
import {createBackup,restoreBackup} from '../server/database-backup';
import type {Job} from '../shared/contracts';

function fixture(){const s=new Store(':memory:'),c=new Core(s);c.seed();const j=c.create({deviceIds:['aurora-1'],gameId:'fortnite',operation:'apply_marking',variant:36},'admin')[0];c.tick();return {s,c,job:s.get<Job>('job',j.id)!};}
const count=(db:DatabaseSync)=>Number(db.prepare('SELECT COUNT(*) AS n FROM snapshots').get()!.n);

test('repeated exe/rule arrays share compressed immutable snapshots and hydrate independent values',()=>{
 const {s,job}=fixture();try{
  assert.equal(count(s.db),2);
  s.put('job',{...job,id:'copy',rules:job.rules!.map(r=>Object.fromEntries(Object.entries(r).reverse()))});
  assert.equal(count(s.db),2);
  const raw=JSON.parse(String(s.db.prepare("SELECT data FROM records WHERE kind='job' AND id='copy'").get()!.data));
  assert.equal(raw.exes,undefined);assert.equal(raw.rules,undefined);assert.equal(Object.keys(raw._ptSnapshots).length,2);
  assert.ok(Number(s.db.prepare('SELECT SUM(length(data)) AS n FROM snapshots').get()!.n)<Number(s.db.prepare('SELECT SUM(raw_bytes) AS n FROM snapshots').get()!.n));
  const a=s.get<Job>('job','copy')!;assert.deepEqual(a.exes,job.exes);assert.deepEqual(a.rules,job.rules);a.rules![0].dscp=1;a.exes[0]='changed.exe';
  assert.deepEqual(s.get<Job>('job',job.id)!.rules,job.rules);assert.deepEqual(s.get<Job>('job','copy')!.exes,job.exes);
 }finally{s.close();}
});
test('new revisions, different DSCP and edits never replace prior snapshots',()=>{
 const {s,job}=fixture();try{
  const next={...job,id:'new-revision',revision:2,exes:['NewRevision.exe',...job.exes],rules:job.rules!.map(r=>({...r,dscp:40}))};s.put('job',next);
  assert.equal(count(s.db),4);assert.deepEqual(s.get<Job>('job',job.id)!.exes,job.exes);assert.deepEqual(s.get<Job>('job',job.id)!.rules,job.rules);
  assert.deepEqual(s.get<Job>('job',next.id),next);
 }finally{s.close();}
});
test('small arrays stay inline, while snapshot inserts and failed record writes roll back together',()=>{
 const s=new Store(':memory:');try{s.put('device',{id:'tiny',rules:[]});assert.equal(count(s.db),0);
  const bad:any={id:'bad',exes:Array.from({length:15},(_,i)=>'Executable-'+i+'.exe')};bad.cycle=bad;
  assert.throws(()=>s.put('job',bad));assert.equal(count(s.db),0);assert.equal(s.get('job','bad'),undefined);
  assert.throws(()=>s.transaction(()=>{s.put('job',{id:'rollback',exes:bad.exes});throw Error('stop');}));assert.equal(count(s.db),0);
 }finally{s.close();}
});
test('legacy snapshot migration preserves rowids, full logical records, filters and original JSON on failure',()=>{
 const {s,job}=fixture();try{
  s.put('job',{...job,id:'gap'});s.db.prepare("UPDATE records SET rowid=10000 WHERE kind='job' AND id='gap'").run();
  makeLegacy(s.db);const before=s.db.prepare('SELECT rowid,kind,id,data FROM records ORDER BY rowid').all(),logical=s.all<Job>('job');
  assert.deepEqual(migrate(s.db),{from:0,to:5});assert.equal(inspectSchema(s.db).version,5);
  assert.deepEqual(s.all<Job>('job'),logical);assert.deepEqual(s.db.prepare('SELECT rowid,kind,id FROM records ORDER BY rowid').all().map(r=>({...r})),before.map(({data,...r})=>r));
  assert.deepEqual(new JobQueries(s).page({deviceId:job.deviceId}).items.map(j=>j.exes),[job.exes,job.exes]);
 }finally{s.close();}
});
test('a failed compact migration rolls back already converted records, payloads and the migration version',()=>{
 const {s,job}=fixture();try{
  s.put('job',{...job,id:'second'});makeLegacy(s.db);
  const before=s.db.prepare('SELECT rowid,* FROM records').all(),prepare=s.db.prepare.bind(s.db);let writes=0;
  s.db.prepare=(sql:string)=>{if(sql.startsWith('UPDATE records SET data=')&&++writes===before.length)throw Error('injected v3 failure');return prepare(sql);};
  assert.throws(()=>migrate(s.db),/injected/);s.db.prepare=prepare;
  assert.deepEqual(s.db.prepare('SELECT rowid,* FROM records').all(),before);assert.equal(s.db.prepare('PRAGMA user_version').get()!.user_version,0);assert.equal(s.db.prepare("SELECT name FROM sqlite_master WHERE name='snapshots'").get(),undefined);
 }finally{s.close();}
});
test('missing references, checksum corruption and oversized compressed payload metadata fail verification',()=>{
 for(const change of ["DELETE FROM snapshots WHERE id=(SELECT MIN(id) FROM snapshots)","UPDATE snapshots SET data=x'000102'",'UPDATE snapshots SET raw_bytes=999999999']){
  const {s}=fixture();try{s.db.exec(change);assert.throws(()=>inspectSchema(s.db),/снимков/);const text=String(s.db.prepare("SELECT data FROM records WHERE kind='job'").get()!.data);assert.throws(()=>decodeRecord(s.db,text));}finally{s.close();}
 }
});
test('garbage collection removes only unused snapshots and VACUUM preserves sparse history rowids',()=>{
 const {s,job}=fixture();try{
  s.put('job',{...job,id:'temporary',exes:[...job.exes,'TemporaryExtra.exe']});s.del('job','temporary');
  assert.equal(count(s.db),3);assert.equal(collectSnapshots(s.db),1);assert.equal(count(s.db),2);
  s.db.prepare("UPDATE records SET rowid=20000 WHERE kind='job'").run();const before=s.db.prepare('SELECT rowid,kind,id FROM records ORDER BY rowid').all();
  vacuumPreservingRowids(s.db);assert.deepEqual(s.db.prepare('SELECT rowid,kind,id FROM records ORDER BY rowid').all(),before);assert.deepEqual(s.get<Job>('job',job.id)!.rules,job.rules);
 }finally{s.close();}
});
test('compaction produces a smaller independent database, preserves history and never overwrites the source',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'paneltech-space-')),source=join(dir,'legacy.sqlite'),target=join(dir,'compact.sqlite');let s:Store|undefined,restored:Store|undefined;
 try{
  s=new Store(source);const c=new Core(s);c.seed();const base=c.create({deviceIds:['aurora-1'],gameId:'fortnite',operation:'apply_marking',variant:36},'admin')[0];c.tick();const job=s.get<Job>('job',base.id)!;
  s.transaction(()=>{for(let i=0;i<1000;i++)s!.put('job',{...job,id:'history-'+i,created:i,state:i%6===0?'succeeded':'failed',rules:i%6===0?job.rules:i%6===1?[]:undefined});});makeLegacy(s.db);s.db.exec('VACUUM');s.close();s=undefined;
  const before=readFileSync(source);const result=await compactDatabase(source,target,join(dir,'copies'));
  assert.ok(result.after.databaseBytes<result.before.databaseBytes*.8);assert.deepEqual(readFileSync(source),before);
  restored=new Store(target);assert.equal(restored.all('job').length,1001);assert.deepEqual(restored.get<Job>('job','history-42')!.rules,job.rules);assert.equal(restored.get<Job>('job','history-42')!.revision,job.revision);
  assert.equal(storageStats(target).version,5);assert.equal(count(restored.db),2);
  const copiesBefore=readFileSync(join(result.backup,'manifest.json'));await assert.rejects(()=>compactDatabase(source,target,join(dir,'copies')));assert.deepEqual(readFileSync(join(result.backup,'manifest.json')),copiesBefore);
  assert.deepEqual(readFileSync(source),before);
 }finally{restored?.close();s?.close();rmSync(dir,{recursive:true,force:true});}
});
test('backups and restored v3 histories retain shared payloads and full technical outcomes',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'paneltech-shared-backup-'));let s:Store|undefined,r:Store|undefined;
 try{s=new Store(join(dir,'live.sqlite'));const c=new Core(s);c.seed();const j=c.create({deviceIds:['aurora-1'],gameId:'fortnite',operation:'apply_marking',variant:36},'admin')[0];c.tick();const before=s.get<Job>('job',j.id)!;
  const saved=await createBackup(join(dir,'live.sqlite'),join(dir,'copies'));await restoreBackup(saved.path,join(dir,'restore.sqlite'));r=new Store(join(dir,'restore.sqlite'));assert.deepEqual(r.get<Job>('job',j.id),before);assert.deepEqual(new JobQueries(r).page({}).items[0],before);assert.equal(count(r.db),2);
 }finally{r?.close();s?.close();rmSync(dir,{recursive:true,force:true});}
});
