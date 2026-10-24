import type {DatabaseSync} from 'node:sqlite';
import {SNAPSHOT_SQL,encodeRecord,checkSnapshots} from './snapshots.js';
import {AUDIT_SQL,AUDIT_TRIGGERS} from './audit-schema.js';
import {QUEUE_SQL,QUEUE_INDEXES} from './queue-queries.js';

export const SCHEMA_VERSION=5;
export class DatabaseSafetyError extends Error {}
const migrations=[
 {version:1,name:'records-v1',sql:`CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));`},
 {version:2,name:'job-query-indexes-v2',sql:`
 CREATE INDEX IF NOT EXISTS jobs_club_created ON records(json_extract(data,'$.clubId'),json_extract(data,'$.created') DESC) WHERE kind='job';
 CREATE INDEX IF NOT EXISTS jobs_device_game_created ON records(json_extract(data,'$.deviceId'),json_extract(data,'$.gameId'),json_extract(data,'$.created') DESC) WHERE kind='job';
 CREATE INDEX IF NOT EXISTS jobs_state ON records(json_extract(data,'$.state')) WHERE kind='job';
 CREATE INDEX IF NOT EXISTS jobs_batch_club ON records(json_extract(data,'$.batchId'),json_extract(data,'$.clubId')) WHERE kind='job';`},
 {version:3,name:'shared-compressed-snapshots-v3',sql:SNAPSHOT_SQL},
 {version:4,name:'append-only-audit-v4',sql:AUDIT_SQL},
 {version:5,name:'indexed-device-queue-v5',sql:QUEUE_SQL}
] as const;
const indexes=['jobs_club_created','jobs_device_game_created','jobs_state','jobs_batch_club'];
const versionOf=(db:DatabaseSync)=>Number((db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);
const tables=(db:DatabaseSync)=>(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[]).map(r=>r.name);

export function inspectSchema(db:DatabaseSync,allowEmpty=false){
 const version=versionOf(db);
 if(version<0)throw new DatabaseSafetyError('Версия базы не поддерживается.');
 if(version>SCHEMA_VERSION)throw new DatabaseSafetyError('Версия базы новее программы. Откройте её совместимой версией; база не изменена.');
 const triggers=db.prepare("SELECT sql FROM sqlite_master WHERE type IN ('trigger','view') ORDER BY name").all();
 const normalized=(sql:string)=>sql.trim().replace(/;$/,'');
 const expected=version>=4?AUDIT_TRIGGERS.map(normalized).sort():[];
 if(JSON.stringify(triggers.map(r=>normalized(String(r.sql))).sort())!==JSON.stringify(expected))throw new DatabaseSafetyError('В базе отсутствует защита журнала или обнаружены неподдерживаемые triggers/views.');
 const names=tables(db);
 if(names.some(n=>!(version>=3?['records','schema_migrations','snapshots']:['records','schema_migrations']).includes(n)))throw new DatabaseSafetyError('Это не поддерживаемая база PanelTech.');
 if(!names.includes('records')){
  if(allowEmpty&&version===0&&names.length===0)return {version,records:0,mode:'empty' as const};
  throw new DatabaseSafetyError('В базе отсутствует таблица records PanelTech.');
 }
 const columns=db.prepare('PRAGMA table_info(records)').all() as {name:string;type:string;notnull:number;pk:number}[];
 if(columns.length!==3||columns.some((c,i)=>c.name!==['kind','id','data'][i]||c.type.toUpperCase()!=='TEXT'||c.notnull!==1||c.pk!==[1,2,0][i]))throw new DatabaseSafetyError('Схема records не поддерживается.');
 const bad=db.prepare(`SELECT 1 FROM records WHERE CASE WHEN json_valid(data)=0 THEN 1 WHEN json_type(data,'$.id') IS NOT 'text' THEN 1 WHEN json_extract(data,'$.id') IS NOT id THEN 1 ELSE 0 END LIMIT 1`).get();
 if(bad)throw new DatabaseSafetyError('В базе повреждён формат записей. Данные не изменены.');
 if(version>0){
  if(!names.includes('schema_migrations'))throw new DatabaseSafetyError('Отсутствует журнал миграций.');
  const log=db.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all() as {version:number;name:string}[];
  if(log.length!==version||log.some((r,i)=>r.version!==migrations[i]?.version||r.name!==migrations[i]?.name))throw new DatabaseSafetyError('Журнал миграций не соответствует версии базы.');
  if(version>=2){
   const found=new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as {name:string}[]).map(r=>r.name));
   if(indexes.some(n=>!found.has(n)))throw new DatabaseSafetyError('В базе отсутствуют индексы текущей версии. Требуется проверка копии.');
   if(version>=4&&!found.has('audit_created'))throw new DatabaseSafetyError('Отсутствует индекс журнала действий.');
   if(version>=5&&QUEUE_INDEXES.some(name=>!found.has(name)))throw new DatabaseSafetyError('Отсутствуют индексы очереди/устройств.');
  }
 }else if(names.includes('schema_migrations'))throw new DatabaseSafetyError('Неверная версия журнала миграций.');
 if(version>=3){if(!names.includes('snapshots'))throw new DatabaseSafetyError('Отсутствует таблица общих снимков.');try{checkSnapshots(db);}catch{throw new DatabaseSafetyError('Повреждены данные или ссылки общих снимков.');}}
 const records=Number((db.prepare('SELECT COUNT(*) AS n FROM records').get() as {n:number}).n);
 const meta=db.prepare("SELECT data FROM records WHERE kind='meta' AND id='demo'").get() as {data:string}|undefined;
 const mode=meta?(JSON.parse(meta.data).personalAccounts?'personal-demo':'demo'):records?'pilot':'empty';
 return {version,records,mode};
}

// Legacy v0 is the original unversioned records table. Adoption preserves rows and rowids.
export function migrate(db:DatabaseSync){
 const initial=inspectSchema(db,true);
 // An already-current store needs validation once, without an unused writer lock or two repeat scans.
 if(initial.version===SCHEMA_VERSION)return {from:initial.version,to:initial.version};
 db.exec('BEGIN IMMEDIATE');
 try{
  const before=inspectSchema(db,true);
  if(before.version<SCHEMA_VERSION){
   db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at INTEGER NOT NULL)');
   for(const m of migrations.filter(m=>m.version>before.version)){
    db.exec(m.sql);
    if(m.version===3){for(const row of db.prepare('SELECT rowid,kind,data FROM records').all() as {rowid:number;kind:string;data:string}[]){db.prepare('UPDATE records SET data=? WHERE rowid=?').run(encodeRecord(db,row.kind,JSON.parse(row.data)),row.rowid);}}
    db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)').run(m.version,m.name,Date.now());
    db.exec(`PRAGMA user_version=${m.version}`);
   }
  }
  const after=inspectSchema(db);
  db.exec('COMMIT');return {from:before.version,to:after.version};
 }catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}
}
