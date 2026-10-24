import {backup,DatabaseSync,type BackupOptions} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream,chmodSync,closeSync,constants,copyFileSync,fsyncSync,linkSync,lstatSync,mkdirSync,mkdtempSync,openSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {z} from 'zod';
import {decodeRecord,encodeRecord,collectSnapshots,vacuumPreservingRowids} from './snapshots.js';
import {inspectSchema,migrate,DatabaseSafetyError} from './migrations.js';

const manifestSchema=z.object({format:z.literal('paneltech-backup'),formatVersion:z.literal(1),id:z.string().uuid(),createdAt:z.string().datetime(),schemaVersion:z.number().int().min(0),records:z.number().int().min(0),mode:z.enum(['empty','demo','personal-demo','pilot']),bytes:z.number().int().positive(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type BackupManifest=z.infer<typeof manifestSchema>;
function regular(path:string){const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink())throw new DatabaseSafetyError('Нужен обычный файл, без символической ссылки.');return s;}
function exists(path:string){try{lstatSync(path);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}}
export function requireUnusedTarget(path:string){if([path,path+'-wal',path+'-shm',path+'-journal'].some(exists))throw new DatabaseSafetyError('Путь назначения или его служебные файлы уже существуют. Укажите новое имя; перезапись запрещена.');}
async function sha256(path:string){const hash=createHash('sha256');for await(const data of createReadStream(path))hash.update(data);return hash.digest('hex');}
function flushFile(path:string){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function flushDirectory(path:string){if(process.platform==='win32')return;const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function checkDatabase(db:DatabaseSync){
 const rows=db.prepare('PRAGMA integrity_check').all();
 if(rows.length!==1||Object.values(rows[0])[0]!=='ok')throw new DatabaseSafetyError('Проверка целостности SQLite не пройдена.');
 return inspectSchema(db);
}
function readonly(path:string){regular(path);const db=new DatabaseSync(path,{readOnly:true});db.exec('PRAGMA busy_timeout=5000; PRAGMA query_only=ON');return db;}

export function inspectDatabase(path:string){
 const db=readonly(resolve(path));
 try{db.exec('BEGIN');const info=checkDatabase(db);db.exec('COMMIT');return info;}finally{db.close();}
}

export async function createBackup(source:string,directory:string,options:Pick<BackupOptions,'rate'|'progress'>={}){
 source=resolve(source);directory=resolve(directory);
 const db=readonly(source);
 let stage='';
 try{
  // Pin one WAL read snapshot. Otherwise writes on the API connection can restart
  // every incremental backup step indefinitely. WAL writers remain enabled.
  db.exec('BEGIN');checkDatabase(db);mkdirSync(directory,{recursive:true,mode:0o700});
  const id=randomUUID(),name='backup-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+id;
  const temporary=join(directory,'.partial-'+id);mkdirSync(temporary,{mode:0o700});stage=temporary;
  const file=join(stage,'backup.sqlite'),started=Date.now();
  await backup(db,file,{rate:options.rate??128,progress:p=>{if(Date.now()-started>30000)throw new DatabaseSafetyError('Резервное копирование превысило 30 секунд. Готовая копия не опубликована.');options.progress?.(p);}});
  // Release the source reader before destination validation/hash/fsync.
  db.exec('COMMIT');
  chmodSync(file,0o600);
  // Make the destination standalone: no dependency on a live source WAL/SHM.
  const copy=new DatabaseSync(file);let info:ReturnType<typeof inspectSchema>;
  try{copy.exec('PRAGMA journal_mode=DELETE');info=checkDatabase(copy);}finally{copy.close();}
  const manifest:BackupManifest={format:'paneltech-backup',formatVersion:1,id,createdAt:new Date().toISOString(),schemaVersion:info.version,records:info.records,mode:info.mode as BackupManifest['mode'],bytes:regular(file).size,sha256:await sha256(file)};
  const manifestPath=join(stage,'manifest.json');writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});flushFile(file);flushFile(manifestPath);flushDirectory(stage);
  await verifyBackup(stage);
  const destination=join(directory,name);if(exists(destination))throw new DatabaseSafetyError('Каталог копии уже существует.');
  renameSync(stage,destination);stage='';flushDirectory(directory);
  return {path:destination,manifest};
 }finally{db.close();if(stage)rmSync(stage,{recursive:true,force:true});}
}

export async function verifyBackup(directory:string){
 directory=resolve(directory);
 const folder=lstatSync(directory);if(!folder.isDirectory()||folder.isSymbolicLink())throw new DatabaseSafetyError('Нужен каталог резервной копии, без символической ссылки.');
 const meta=join(directory,'manifest.json');if(regular(meta).size>16384)throw new DatabaseSafetyError('Манифест резервной копии слишком большой.');
 let manifest:BackupManifest;
 try{manifest=manifestSchema.parse(JSON.parse(readFileSync(meta,'utf8')));}catch{throw new DatabaseSafetyError('Некорректный манифест резервной копии.');}
 const file=join(directory,'backup.sqlite');
 if(['-wal','-shm','-journal'].some(suffix=>exists(file+suffix)))throw new DatabaseSafetyError('Копия содержит служебные файлы SQLite. Нужен самостоятельный backup без WAL/SHM/journal.');
 if(regular(file).size!==manifest.bytes||await sha256(file)!==manifest.sha256)throw new DatabaseSafetyError('Размер или SHA-256 резервной копии не совпал. Восстановление запрещено.');
 const db=readonly(file);try{if(db.prepare('PRAGMA journal_mode').get()!.journal_mode!=='delete')throw new DatabaseSafetyError('Резервная копия должна иметь DELETE journal mode.');const info=checkDatabase(db);if(info.version!==manifest.schemaVersion||info.records!==manifest.records||info.mode!==manifest.mode)throw new DatabaseSafetyError('Манифест не соответствует содержимому базы.');}finally{db.close();}
 return {path:directory,file,manifest};
}

export async function restoreBackup(directory:string,target:string,options:{compact?:boolean}={}){
 target=resolve(target);requireUnusedTarget(target);
 const verified=await verifyBackup(directory);
 mkdirSync(dirname(target),{recursive:true,mode:0o700});
 const stagingDirectory=mkdtempSync(join(dirname(target),'.restore-'));
 const stage=join(stagingDirectory,'database.sqlite');
 try{
  copyFileSync(verified.file,stage,constants.COPYFILE_EXCL);chmodSync(stage,0o600);
  if(regular(stage).size!==verified.manifest.bytes||await sha256(stage)!==verified.manifest.sha256)throw new DatabaseSafetyError('Копия изменилась во время чтения. Восстановление отменено.');
  const db=new DatabaseSync(stage);let expired=0,unknown=0,revoked=0;
  try{
   migrate(db);db.exec('BEGIN IMMEDIATE');
   try{
    db.prepare("DELETE FROM records WHERE kind IN ('session','enrollment')").run();
    for(const {id,data} of db.prepare("SELECT id,data FROM records WHERE kind='device'").all() as {id:string;data:string}[]){
     const d=decodeRecord(db,data);delete d.tokenHash;d.lastSeen=0;d.inspectedAt=null;
     if(d.demo){d.bootId=randomUUID();d.rules=(d.rules??[]).filter((r:{owned:boolean})=>!r.owned);}else{d.revoked=true;revoked++;}
     db.prepare("UPDATE records SET data=? WHERE kind='device' AND id=?").run(encodeRecord(db,'device',d),id);
    }
    for(const {id,data} of db.prepare("SELECT id,data FROM records WHERE kind='job' AND json_extract(data,'$.state') IN ('queued','running','unknown')").all() as {id:string;data:string}[]){
     const j=decodeRecord(db,data);j.restoredAt=Date.now();
     if(j.state==='queued'){j.state='expired';j.code='restore_expired';j.finished=j.restoredAt;j.message='Восстановление из копии: старая команда не исполняется.';expired++;}
     else{if(j.state==='running'){j.state='unknown';j.code='restore_unknown';}j.message=(j.message?j.message+' ':'')+'Восстановлено из копии. Результат неизвестен; нужна свежая сверка, без повтора команды.';unknown++;}
     db.prepare("UPDATE records SET data=? WHERE kind='job' AND id=?").run(encodeRecord(db,'job',j),id);
    }
    if(verified.manifest.mode==='pilot')db.prepare("INSERT INTO records(kind,id,data) VALUES('meta','restoration',?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data").run(JSON.stringify({id:'restoration',sourceMode:'pilot',restoredAt:Date.now()}));
    db.exec('COMMIT');
   }catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}
   if(options.compact){collectSnapshots(db);vacuumPreservingRowids(db);}
   checkDatabase(db);db.exec('PRAGMA journal_mode=DELETE');
  }finally{db.close();}
  flushFile(stage);requireUnusedTarget(target);
  // Hard-link publication is atomic and fails if another process created the target.
  linkSync(stage,target);flushDirectory(dirname(target));
  return {path:target,sourceSchema:verified.manifest.schemaVersion,expired,unknown,revoked};
 }finally{
  rmSync(stagingDirectory,{recursive:true,force:true});
  // A published target is never deleted or overwritten, even if a later directory fsync fails.
 }
}
