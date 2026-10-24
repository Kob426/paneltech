// Runs only in the backup child process. Never opens a network listener or executes jobs.
import {createHash,randomUUID} from 'node:crypto';
import {closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,mkdtempSync,openSync,readFileSync,readdirSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,parse,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {createBackup,inspectDatabase,restoreBackup,verifyBackup} from './database-backup.js';
import type {BackupState,BackupSummary} from '../shared/operations.js';

const integer=z.number().int().nonnegative();
const summarySchema=z.object({id:z.string().uuid(),createdAt:z.string().datetime(),bytes:integer,verifiedAt:integer,drill:z.object({checkedAt:integer,expired:integer,unknown:integer,revoked:integer}).strict()}).strict();
export const backupStateSchema=z.object({phase:z.enum(['idle','running','error']),lastAttempt:integer.nullable(),lastSuccess:integer.nullable(),error:z.enum(['backup_failed','backup_locked','worker_failed','status_invalid']).nullable(),latest:summarySchema.nullable(),count:integer,bytes:integer,skipped:integer,budgetExceeded:z.boolean()}).strict();
export const emptyBackupState=():BackupState=>({phase:'idle',lastAttempt:null,lastSuccess:null,error:null,latest:null,count:0,bytes:0,skipped:0,budgetExceeded:false});
export interface BackupConfig {source:string; directory:string; sourceKey:string; enabled:boolean; intervalMs:number; keep:number; maxBytes:number; startupDelayMs:number}

export function backupConfig(source:string,env:NodeJS.ProcessEnv=process.env):BackupConfig {
 source=resolve(source);const sourceKey=createHash('sha256').update(source).digest('hex');
 const number=(key:string,defaultValue:number,min:number,max:number)=>{const raw=env[key];if(raw===undefined)return defaultValue;if(!/^\d+$/.test(raw))throw Error('Некорректная настройка '+key);const value=Number(raw);if(!Number.isSafeInteger(value)||value<min||value>max)throw Error('Некорректная настройка '+key);return value;};
 if(env.AUTO_BACKUP!==undefined&&!['0','1'].includes(env.AUTO_BACKUP))throw Error('AUTO_BACKUP: допустимы 0 или 1');
 return {source,sourceKey,directory:join(resolve(env.BACKUP_DIRECTORY??join(dirname(source),'backups')),'automatic-'+sourceKey.slice(0,16)),enabled:env.AUTO_BACKUP!=='0',intervalMs:number('BACKUP_INTERVAL_MINUTES',360,5,10080)*60000,keep:number('BACKUP_KEEP',7,2,100),maxBytes:number('BACKUP_MAX_MIB',1024,16,1048576)*1024*1024,startupDelayMs:60000};
}
export function noLinks(path:string){
 path=resolve(path);let current=parse(path).root;
 for(const part of path.slice(current.length).split(/[\\/]/).filter(Boolean)){current=join(current,part);try{if(lstatSync(current).isSymbolicLink())throw Error('unsafe_path');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
}
export function safeJson(path:string){const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw Error('unsafe_metadata');return JSON.parse(readFileSync(path,'utf8'));}
function flush(path:string){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
export function atomicJson(path:string,value:unknown){
 noLinks(path);const temporary=path+'.'+randomUUID()+'.tmp';
 try{writeFileSync(temporary,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});flush(temporary);renameSync(temporary,path);if(process.platform!=='win32')flush(dirname(path));}finally{rmSync(temporary,{force:true});}
}
const ownerSchema=z.object({format:z.literal('paneltech-automatic-backups'),version:z.literal(1),sourceKey:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export function prepareDirectory(config:BackupConfig){
 noLinks(config.source);noLinks(config.directory);
 mkdirSync(config.directory,{recursive:true,mode:0o700});
 const marker=join(config.directory,'.owner.json');
 if(!existsSync(marker)){
  // Never adopt an existing populated directory for automatic deletion.
  if(readdirSync(config.directory).length)throw Error('unowned_directory');
  writeFileSync(marker,JSON.stringify({format:'paneltech-automatic-backups',version:1,sourceKey:config.sourceKey})+'\n',{flag:'wx',mode:0o600});flush(marker);
 }
 if(ownerSchema.parse(safeJson(marker)).sourceKey!==config.sourceKey)throw Error('wrong_source');
}
export function persistFailure(config:BackupConfig,state:BackupState){
 try{prepareDirectory(config);atomicJson(join(config.directory,'.status.json'),state);}catch{/* Failure may include the status disk itself. Keep the in-memory error. */}
}
const receiptSchema=z.object({format:z.literal('paneltech-automatic-copy'),version:z.literal(1),sourceKey:z.string().regex(/^[a-f0-9]{64}$/),summary:summarySchema}).strict();
const packageName=/^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9-]{36}$/;
async function managedCopies(config:BackupConfig){
 const copies:{path:string;summary:BackupSummary;bytes:number}[]=[];let skipped=0;
 for(const entry of readdirSync(config.directory)){
  if(['.owner.json','.status.json','.running.lock'].includes(entry))continue;
  if(entry.startsWith('.')){skipped++;continue;}
  const path=join(config.directory,entry);
  try{
   if(!packageName.test(entry)||!lstatSync(path).isDirectory()||lstatSync(path).isSymbolicLink())throw Error('unmanaged');
   if(readdirSync(path).sort().join(',')!=='automatic.json,backup.sqlite,manifest.json')throw Error('foreign_files');
   const receipt=receiptSchema.parse(safeJson(join(path,'automatic.json')));
   if(receipt.sourceKey!==config.sourceKey)throw Error('wrong_source');
   const copy=await verifyBackup(path);
   if(receipt.summary.id!==copy.manifest.id||receipt.summary.bytes!==copy.manifest.bytes||receipt.summary.createdAt!==copy.manifest.createdAt)throw Error('wrong_receipt');
   const bytes=readdirSync(path).reduce((sum,name)=>sum+lstatSync(join(path,name)).size,0);
   copies.push({path,summary:receipt.summary,bytes});
  }catch{skipped++;}
 }
 copies.sort((a,b)=>b.summary.createdAt.localeCompare(a.summary.createdAt)||b.summary.id.localeCompare(a.summary.id));
 return {copies,skipped};
}
export async function restoreDrill(directory:string,workspace:string){
 noLinks(workspace);const temporary=mkdtempSync(join(workspace,'.drill-'));
 try{
  const result=await restoreBackup(directory,join(temporary,'restored.sqlite'));inspectDatabase(result.path);
  const restored=new DatabaseSync(result.path,{readOnly:true}),original=new DatabaseSync(join(directory,'backup.sqlite'),{readOnly:true});
  try{
   const count=(db:DatabaseSync,kind:string)=>Number(db.prepare('SELECT count(*) n FROM records WHERE kind=?').get(kind)!.n);
   for(const kind of ['job','audit','user','club','game'])if(count(restored,kind)!==count(original,kind))throw Error('restore_count');
   if(count(restored,'session')||count(restored,'enrollment'))throw Error('restore_trust');
   if(Number(restored.prepare("SELECT count(*) n FROM records WHERE kind='job' AND json_extract(data,'$.state') IN ('queued','running')").get()!.n))throw Error('restore_replay');
   if(Number(restored.prepare("SELECT count(*) n FROM records WHERE kind='device' AND (json_type(data,'$.tokenHash') IS NOT NULL OR (coalesce(json_extract(data,'$.demo'),0)=0 AND coalesce(json_extract(data,'$.revoked'),0)<>1))").get()!.n))throw Error('restore_trust');
  }finally{original.close();restored.close();}
  return {checkedAt:Date.now(),expired:result.expired,unknown:result.unknown,revoked:result.revoked};
 }finally{rmSync(temporary,{recursive:true,force:true});}
}
export async function automaticBackup(config:BackupConfig){
 prepareDirectory(config);
 const lock=join(config.directory,'.running.lock');let fd:number;
 try{fd=openSync(lock,'wx',0o600);}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw Error('backup_locked');throw e;}
 try{
  writeFileSync(fd,JSON.stringify({pid:process.pid,startedAt:Date.now()})+'\n');fsyncSync(fd);
  const started=Date.now(),created=await createBackup(config.source,config.directory);
  const drill=await restoreDrill(created.path,config.directory);
  const summary:BackupSummary={id:created.manifest.id,createdAt:created.manifest.createdAt,bytes:created.manifest.bytes,verifiedAt:Date.now(),drill};
  atomicJson(join(created.path,'automatic.json'),{format:'paneltech-automatic-copy',version:1,sourceKey:config.sourceKey,summary});
  const inventory=await managedCopies(config);
  if(!inventory.copies.some(copy=>copy.summary.id===summary.id))throw Error('published_copy_invalid');
  let bytes=inventory.copies.reduce((sum,item)=>sum+item.bytes,0);
  // A new fully verified/restorable copy exists before any older package is pruned.
  while(inventory.copies.length>1&&(inventory.copies.length>config.keep||bytes>config.maxBytes)){
   const oldest=inventory.copies.at(-1)!;
   if(oldest.summary.id===summary.id)break;
   noLinks(oldest.path);await verifyBackup(oldest.path);
   rmSync(oldest.path,{recursive:true});inventory.copies.pop();bytes-=oldest.bytes;
  }
  const state:BackupState={phase:'idle',lastAttempt:started,lastSuccess:Date.now(),error:null,latest:summary,count:inventory.copies.length,bytes,skipped:inventory.skipped,budgetExceeded:bytes>config.maxBytes||inventory.copies.length>config.keep};
  atomicJson(join(config.directory,'.status.json'),state);return state;
 }catch(error){
  try{
   let previous=emptyBackupState();const path=join(config.directory,'.status.json');
   if(existsSync(path))previous=backupStateSchema.parse(safeJson(path));
   atomicJson(path,{...previous,phase:'error',lastAttempt:Date.now(),error:'backup_failed'});
  }catch{/* A disk failure may also prevent persisting status. The parent retains the error. */}
  throw error;
 }finally{closeSync(fd);rmSync(lock,{force:true});}
}
