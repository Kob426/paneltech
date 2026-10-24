// Synthetic temporary databases only. Never opens a user DB or connects to PCs.
import {DatabaseSync,backup} from 'node:sqlite';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {Store} from '../server/store.js';
import {Core} from '../server/core.js';
import {SCHEMA_VERSION} from '../server/migrations.js';
import {storageStats} from '../server/database-storage.js';
import {collectSnapshots,vacuumPreservingRowids} from '../server/snapshots.js';
import type {Job} from '../shared/contracts.js';

const count=20000;
const stable=(v:any):any=>Array.isArray(v)?v.map(stable):v!==null&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const dir=mkdtempSync(join(tmpdir(),'paneltech-storage-measure-'));
try{
 const results=[];
 for(const profile of ['applied','mixed']){
  const seed=new Store(':memory:'),core=new Core(seed);core.seed();const created=core.create({deviceIds:['aurora-1'],gameId:'fortnite',operation:'apply_marking',variant:36},'admin')[0];core.tick();const base=seed.get<Job>('job',created.id)!;
  const source=join(dir,profile+'-v2.sqlite'),target=join(dir,profile+'-v'+SCHEMA_VERSION+'.sqlite'),legacy=new DatabaseSync(source);
  legacy.exec(`CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
   CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at INTEGER NOT NULL);
   INSERT INTO schema_migrations VALUES(1,'records-v1',1),(2,'job-query-indexes-v2',1);PRAGMA user_version=2;
   CREATE INDEX jobs_club_created ON records(json_extract(data,'$.clubId'),json_extract(data,'$.created') DESC) WHERE kind='job';
   CREATE INDEX jobs_device_game_created ON records(json_extract(data,'$.deviceId'),json_extract(data,'$.gameId'),json_extract(data,'$.created') DESC) WHERE kind='job';
   CREATE INDEX jobs_state ON records(json_extract(data,'$.state')) WHERE kind='job';
   CREATE INDEX jobs_batch_club ON records(json_extract(data,'$.batchId'),json_extract(data,'$.clubId')) WHERE kind='job'; BEGIN;`);
  const insert=legacy.prepare('INSERT INTO records(kind,id,data) VALUES(?,?,?)');
  for(const row of seed.db.prepare("SELECT kind,data FROM records WHERE kind!='job'").all()){const value=seed.decode(String(row.data));insert.run(row.kind!,value.id,JSON.stringify(value));}
  const devices=Array.from({length:65},()=>randomUUID());
  for(let i=0;i<count;i++){
   const revision=1+Math.floor(i/2500),variant=i%2?36:40;
   const exes=[...base.exes.slice(0,-1),`GameRevision${revision}.exe`];
   const rules=exes.map(exe=>({name:'PanelTech-fortnite-'+exe.toLowerCase(),gameId:'fortnite',exe,dscp:variant,owned:true}));
   const states:Job['state'][]=['succeeded','failed','failed','failed','expired','unknown'];const state=profile==='applied'?'succeeded':states[i%6];
   const job={...base,id:randomUUID(),batchId:`fixture-batch-${Math.floor(i/65)}`,deviceId:devices[i%65],deviceName:`ПК-${i%65+1}`,author:`fixture-operator-${i%6}`,created:1700000000000+i,expires:1700000030000+i,finished:1700000000100+i,revision,variant,variantName:`Вариант ${variant}`,exes,rules:profile==='applied'||i%6===0||i%6===3?rules:i%6===1||i%6===4?undefined:[],state,message:`DEMO: ${state}`,feedback:state==='succeeded'&&i%4===0?{outcome:'helped',reason:'voice',comment:'Synthetic storage measurement',author:'fixture-operator-0',at:1700000000200+i}:undefined};
   insert.run('job',job.id,JSON.stringify(job));
  }
  legacy.exec('COMMIT; VACUUM;');seed.close();
  const beforeHash=createHash('sha256');for(const row of legacy.prepare("SELECT rowid,data FROM records WHERE kind='job' ORDER BY rowid").iterate())beforeHash.update(String(row.rowid)+JSON.stringify(stable(JSON.parse(String(row.data)))));
  await backup(legacy,target);legacy.close();
  const compact=new Store(target);collectSnapshots(compact.db);vacuumPreservingRowids(compact.db);
  const afterHash=createHash('sha256');for(const row of compact.db.prepare("SELECT rowid,data FROM records WHERE kind='job' ORDER BY rowid").iterate())afterHash.update(String(row.rowid)+JSON.stringify(stable(compact.decode(String(row.data)))));
  const logicalHistoryUnchanged=beforeHash.digest('hex')===afterHash.digest('hex');if(!logicalHistoryUnchanged)throw Error('Storage measurement lost history');
  compact.close();
  const beforeBytes=statSync(source).size,afterBytes=statSync(target).size;
  const result={profile,jobs:count,exePerGame:5,catalogRevisions:8,variants:2,devices:65,authors:6,beforeBytes,afterBytes,savedPercent:Math.round((1-afterBytes/beforeBytes)*10000)/100,bytesPerJobBefore:Math.round(beforeBytes/count),bytesPerJobAfter:Math.round(afterBytes/count),logicalHistoryUnchanged,snapshots:storageStats(target).snapshots};
  results.push(result);console.log(JSON.stringify(result));
 }
 const versionDb=new DatabaseSync(':memory:');const sqlite=versionDb.prepare('SELECT sqlite_version() AS version').get()!.version;versionDb.close();
 console.log(JSON.stringify({node:process.version,sqlite,kind:'synthetic-storage-only',targetSchemaVersion:SCHEMA_VERSION,auditEvents:0,results}));
}finally{rmSync(dir,{recursive:true,force:true});}
