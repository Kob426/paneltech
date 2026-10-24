import {DatabaseSync} from 'node:sqlite';
import {lstatSync} from 'node:fs';
import {resolve} from 'node:path';
import {inspectDatabase,createBackup,restoreBackup,requireUnusedTarget} from './database-backup.js';
export function storageStats(path:string){
 path=resolve(path);const info=inspectDatabase(path),db=new DatabaseSync(path,{readOnly:true});
 try{
  const pageSize=Number(db.prepare('PRAGMA page_size').get()!.page_size),pages=Number(db.prepare('PRAGMA page_count').get()!.page_count),freePages=Number(db.prepare('PRAGMA freelist_count').get()!.freelist_count);
  const snapshots=info.version>=3?db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(raw_bytes),0) AS rawBytes,COALESCE(SUM(length(data)),0) AS storedBytes FROM snapshots').get():{count:0,rawBytes:0,storedBytes:0};
  const bytes=(file:string)=>{try{return lstatSync(file).size;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return 0;throw e;}};
  const databaseBytes=bytes(path),walBytes=bytes(path+'-wal'),shmBytes=bytes(path+'-shm');
  return {...info,pageSize,pages,freePages,reusableBytes:freePages*pageSize,databaseBytes,walBytes,shmBytes,totalBytes:databaseBytes+walBytes+shmBytes,snapshots};
 }finally{db.close();}
}
export async function compactDatabase(source:string,target:string,backupDirectory:string){
 requireUnusedTarget(resolve(target));
 const before=storageStats(source);
 const saved=await createBackup(source,backupDirectory);
 const restored=await restoreBackup(saved.path,target,{compact:true});
 return {path:restored.path,backup:saved.path,before,after:storageStats(target),recovery:{expired:restored.expired,unknown:restored.unknown,revoked:restored.revoked}};
}
