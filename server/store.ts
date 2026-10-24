import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {decodeRecord,encodeRecord,type SnapshotCache} from './snapshots.js';
import {migrate} from './migrations.js';
import {isStorageError,StorageUnavailable} from './storage-errors.js';
export class Store {
 db:DatabaseSync;
 private snapshots:SnapshotCache=new Map();
 halted=false;
 private access<T>(f:()=>T):T{if(this.halted)throw new StorageUnavailable();try{return f();}catch(e){if(isStorageError(e)){this.halted=true;throw new StorageUnavailable();}throw e;}}
 decode(text:string){return decodeRecord(this.db,text,this.snapshots);}
 constructor(path:string){if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});this.db=new DatabaseSync(path);try{this.db.exec('PRAGMA busy_timeout=5000');migrate(this.db);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON');}catch(e){this.db.close();throw e;}}
 get<T=any>(kind:string,id:string):T|undefined{return this.access(()=>{const r=this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind,id) as {data:string}|undefined;return r?this.decode(r.data):undefined;});}
 all<T=any>(kind:string):T[]{return this.access(()=>(this.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid').all(kind) as {data:string}[]).map(r=>this.decode(r.data)));}
 put(kind:string,r:{id:string;[k:string]:any}){if(kind==='audit')throw Error('audit_immutable');const save=()=>this.db.prepare('INSERT INTO records(kind,id,data) VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind,r.id,encodeRecord(this.db,kind,r));if(this.db.isTransaction)save();else this.transaction(save);return r;}
 del(kind:string,id:string){this.access(()=>this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind,id));}
 transaction<T>(f:()=>T):T{return this.access(()=>{if(this.db.isTransaction)return f();this.db.exec('BEGIN IMMEDIATE');try{const r=f();this.db.exec('COMMIT');return r;}catch(e){if(this.db.isTransaction){try{this.db.exec('ROLLBACK');}catch{this.halted=true;throw new StorageUnavailable();}}throw e;}});}
 close(){this.db.close();}
}
