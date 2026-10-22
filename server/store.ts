import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
export class Store {
 db:DatabaseSync;
 constructor(path:string){if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});this.db=new DatabaseSync(path);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id))');}
 get<T=any>(kind:string,id:string):T|undefined{const r=this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind,id) as {data:string}|undefined;return r?JSON.parse(r.data):undefined;}
 all<T=any>(kind:string):T[]{return (this.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid').all(kind) as {data:string}[]).map(r=>JSON.parse(r.data));}
 put(kind:string,r:{id:string;[k:string]:any}){this.db.prepare('INSERT INTO records VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind,r.id,JSON.stringify(r));return r;}
 del(kind:string,id:string){this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind,id);}
 transaction<T>(f:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const r=f();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 close(){this.db.close();}
}
