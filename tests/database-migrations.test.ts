import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store';
import {migrate,inspectSchema,SCHEMA_VERSION} from '../server/migrations';

const legacy=(db:DatabaseSync)=>db.exec("CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id)); INSERT INTO records VALUES('meta','fixture','{\"id\":\"fixture\",\"note\":\"keep exact bytes\"}');");
const rows=(db:DatabaseSync)=>db.prepare('SELECT rowid,* FROM records').all();

test('new databases have an ordered migration log; reopen is idempotent without rewriting records',()=>{
 const dir=mkdtempSync(join(tmpdir(),'paneltech-schema-'));let s:Store|undefined;
 try{s=new Store(join(dir,'db.sqlite'));s.put('meta',{id:'fixture',value:1});const before=rows(s.db),log=s.db.prepare('SELECT * FROM schema_migrations').all();assert.equal(inspectSchema(s.db).version,SCHEMA_VERSION);s.close();s=new Store(join(dir,'db.sqlite'));assert.deepEqual(rows(s.db),before);assert.deepEqual(s.db.prepare('SELECT * FROM schema_migrations').all(),log);}finally{s?.close();rmSync(dir,{recursive:true,force:true});}
});
test('unversioned legacy migration preserves exact JSON, IDs and SQLite rowids',()=>{
 const db=new DatabaseSync(':memory:');try{legacy(db);const before=rows(db);assert.deepEqual(migrate(db),{from:0,to:5});assert.deepEqual(rows(db),before);assert.equal(inspectSchema(db).records,1);}finally{db.close();}
});
test('version one upgrades only missing migrations, preserving the first log entry and all records',()=>{
 const db=new DatabaseSync(':memory:');try{legacy(db);db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at INTEGER NOT NULL);INSERT INTO schema_migrations VALUES(1,'records-v1',123);PRAGMA user_version=1");const before=rows(db);assert.deepEqual(migrate(db),{from:1,to:5});assert.deepEqual(rows(db),before);assert.equal(db.prepare('SELECT applied_at FROM schema_migrations WHERE version=1').get()!.applied_at,123);}finally{db.close();}
});
test('a newer database version is rejected without downgrading or modifying the file',()=>{
 const dir=mkdtempSync(join(tmpdir(),'paneltech-future-')),path=join(dir,'future.sqlite');try{const db=new DatabaseSync(path);legacy(db);db.exec('PRAGMA user_version=99');db.close();const before=readFileSync(path);assert.throws(()=>new Store(path),/новее/);assert.deepEqual(readFileSync(path),before);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('failed second migration rolls back its log, indexes and user_version together',()=>{
 const db=new DatabaseSync(':memory:');try{legacy(db);const before=rows(db),exec=db.exec.bind(db);db.exec=(sql:string)=>{if(sql.includes('CREATE INDEX'))throw Error('injected migration failure');exec(sql);};assert.throws(()=>migrate(db),/injected/);db.exec=exec;assert.deepEqual(rows(db),before);assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,0);assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='schema_migrations'").get(),undefined);}finally{db.close();}
});
test('foreign layouts, malformed record envelopes, inconsistent logs and custom triggers fail closed',()=>{
 for(const sql of [
  'CREATE TABLE foreign_data(id TEXT);',
  "CREATE TABLE records(kind TEXT,id TEXT,data TEXT);",
  "CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));INSERT INTO records VALUES('meta','x','invalid secret-canary');",
  "CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));INSERT INTO records VALUES('meta','x','{\"id\":\"other\"}');",
  "CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT,applied_at INTEGER);INSERT INTO schema_migrations VALUES(1,'wrong',123);PRAGMA user_version=1;",
  "CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));CREATE TRIGGER surprise AFTER INSERT ON records BEGIN DELETE FROM records; END;"
 ]){
  const db=new DatabaseSync(':memory:');try{db.exec(sql);const before=db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all();assert.throws(()=>migrate(db),e=>e instanceof Error&&!e.message.includes('secret-canary'));assert.deepEqual(db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all(),before);}finally{db.close();}
 }
});
