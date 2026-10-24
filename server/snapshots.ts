import {createHash} from 'node:crypto';
import {deflateRawSync,inflateRawSync} from 'node:zlib';
import type {DatabaseSync} from 'node:sqlite';

const MAX_BYTES=8*1024*1024,MIN_BYTES=128;
export const SNAPSHOT_KEY='_ptSnapshots';
export const SNAPSHOT_SQL=`CREATE TABLE snapshots(id INTEGER PRIMARY KEY,digest BLOB NOT NULL UNIQUE,codec INTEGER NOT NULL CHECK(codec IN (0,1)),raw_bytes INTEGER NOT NULL CHECK(raw_bytes>=0),data BLOB NOT NULL);`;
type Payload={id:number;digest:Uint8Array;codec:number;raw_bytes:number;data:Uint8Array};
export type SnapshotCache=Map<string,string>;
function canonical(value:any):any{return Array.isArray(value)?value.map(canonical):value!==null&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;}
function digest(raw:Buffer){return createHash('sha256').update(raw).digest();}
function unpack(row:Payload){
 if(!Number.isSafeInteger(row.raw_bytes)||row.raw_bytes<0||row.raw_bytes>MAX_BYTES||row.data.byteLength>MAX_BYTES||![0,1].includes(row.codec))throw Error('Некорректный общий снимок базы.');
 const raw=row.codec===1?inflateRawSync(row.data,{maxOutputLength:MAX_BYTES}):Buffer.from(row.data);
 if(raw.length!==row.raw_bytes||!digest(raw).equals(Buffer.from(row.digest)))throw Error('Повреждён общий снимок базы.');
 const text=raw.toString('utf8');if(!Array.isArray(JSON.parse(text)))throw Error('Некорректный формат общего снимка.');return text;
}
function save(db:DatabaseSync,value:any[]){
 const text=JSON.stringify(canonical(JSON.parse(JSON.stringify(value)))),raw=Buffer.from(text);
 if(raw.length<MIN_BYTES)return undefined;
 if(raw.length>MAX_BYTES)throw Error('Снимок превышает допустимый размер.');
 const hash=digest(raw),found=db.prepare('SELECT id FROM snapshots WHERE digest=?').get(hash) as {id:number}|undefined;
 if(found)return found.id;
 const compressed=deflateRawSync(raw,{level:6}),useCompressed=compressed.length<raw.length;
 return Number(db.prepare('INSERT INTO snapshots(digest,codec,raw_bytes,data) VALUES(?,?,?,?)').run(hash,useCompressed?1:0,raw.length,useCompressed?compressed:raw).lastInsertRowid);
}
export function encodeRecord(db:DatabaseSync,kind:string,value:Record<string,any>){
 if(Object.hasOwn(value,SNAPSHOT_KEY))throw Error('Зарезервированное поле снимков базы.');
 const record={...value},refs:Record<string,number>={};
 if(kind==='job'||kind==='device')for(const field of kind==='job'?['exes','rules']:['rules']){
  if(!Array.isArray(record[field]))continue;
  const id=save(db,record[field]);if(id!==undefined){refs[field]=id;delete record[field];}
 }
 if(Object.keys(refs).length)record[SNAPSHOT_KEY]=refs;
 return JSON.stringify(record);
}
export function decodeRecord(db:DatabaseSync,text:string,cache?:SnapshotCache){
 const record=JSON.parse(text);
 if(!Object.hasOwn(record,SNAPSHOT_KEY))return record;
 const refs=record[SNAPSHOT_KEY];
 if(refs===null||Array.isArray(refs)||typeof refs!=='object'||!Object.keys(refs).length)throw Error('Некорректные ссылки на снимки.');
 for(const [field,id] of Object.entries(refs)){
  if(!['exes','rules'].includes(field)||Object.hasOwn(record,field)||!Number.isSafeInteger(id)||Number(id)<1)throw Error('Некорректная ссылка на снимок.');
  const row=db.prepare('SELECT * FROM snapshots WHERE id=?').get(Number(id)) as Payload|undefined;
  if(!row)throw Error('Общий снимок отсутствует.');
  const key=Buffer.from(row.digest).toString('hex');let raw=cache?.get(key);
  if(raw===undefined){raw=unpack(row);if(cache&&raw.length<=65536){if(cache.size>=128)cache.delete(cache.keys().next().value!);cache.set(key,raw);}}
  // Each record gets a fresh object; editing one result cannot mutate another's snapshot.
  record[field]=JSON.parse(raw);
 }
 delete record[SNAPSHOT_KEY];return record;
}
export function checkSnapshots(db:DatabaseSync){
 const cache:SnapshotCache=new Map();
 for(const row of db.prepare('SELECT * FROM snapshots').iterate()){const payload=row as Payload,raw=unpack(payload);if(raw.length<=65536){if(cache.size>=128)cache.delete(cache.keys().next().value!);cache.set(Buffer.from(payload.digest).toString('hex'),raw);}}
 for(const row of db.prepare("SELECT data FROM records WHERE json_type(data,'$._ptSnapshots') IS NOT NULL").iterate())decodeRecord(db,String(row.data),cache);
}
export function collectSnapshots(db:DatabaseSync){
 return Number(db.prepare("DELETE FROM snapshots WHERE id NOT IN (SELECT j.value FROM records r,json_each(json_extract(r.data,'$._ptSnapshots')) j)").run().changes);
}
export function vacuumPreservingRowids(db:DatabaseSync){
 db.exec('CREATE TEMP TABLE compact_rowids(kind TEXT,id TEXT,position INTEGER,PRIMARY KEY(kind,id)) WITHOUT ROWID; INSERT INTO compact_rowids SELECT kind,id,rowid FROM records;');
 try{
  db.exec('VACUUM');
  // Updating unchanged rowids churns every secondary index and wastes pages.
  if(!db.prepare('SELECT 1 FROM records r JOIN compact_rowids c ON c.kind=r.kind AND c.id=r.id WHERE r.rowid!=c.position LIMIT 1').get())return;
  db.exec('BEGIN IMMEDIATE');
  try{db.exec('UPDATE records SET rowid=-rowid; UPDATE records SET rowid=(SELECT position FROM compact_rowids c WHERE c.kind=records.kind AND c.id=records.id); COMMIT;');}
  catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}
 }finally{db.exec('DROP TABLE compact_rowids');}
}
