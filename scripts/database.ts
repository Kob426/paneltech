import {compactDatabase,storageStats} from '../server/database-storage.js';
import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createBackup,restoreBackup,verifyBackup,inspectDatabase} from '../server/database-backup.js';
import {migrate,DatabaseSafetyError} from '../server/migrations.js';

try{
 const command=process.argv[2];
 const {values}=parseArgs({args:process.argv.slice(3),options:{db:{type:'string'},out:{type:'string'},from:{type:'string'},to:{type:'string'}},strict:true,allowPositionals:false});
 if(command==='stats'){
  if(!values.db||values.from||values.to||values.out)throw new DatabaseSafetyError('Используйте: npm run db:stats -- --db .data/local.sqlite');
  console.log(JSON.stringify({ok:true,command,...storageStats(values.db)}));
 }else if(command==='compact'){
  if(!values.db||!values.to||values.from)throw new DatabaseSafetyError('Используйте: npm run db:compact -- --db <исходная-база> --to <новый-файл.sqlite> [--out .data/backups]');
  console.log(JSON.stringify({ok:true,command,...await compactDatabase(values.db,values.to,values.out??'.data/backups')}));
 }else if(command==='check'){
  if(!values.db||values.from||values.to||values.out)throw new DatabaseSafetyError('Используйте: npm run db:check -- --db .data/local.sqlite');
  console.log(JSON.stringify({ok:true,command,...inspectDatabase(values.db)}));
 }else if(command==='backup'){
  if(!values.db||values.from||values.to)throw new DatabaseSafetyError('Используйте: npm run db:backup -- --db .data/local.sqlite [--out .data/backups]');
  const r=await createBackup(values.db,values.out??'.data/backups');
  console.log(JSON.stringify({ok:true,command,path:r.path,schemaVersion:r.manifest.schemaVersion,records:r.manifest.records,sha256:r.manifest.sha256}));
 }else if(command==='verify'){
  if(!values.from||values.db||values.to||values.out)throw new DatabaseSafetyError('Используйте: npm run db:verify -- --from <каталог-копии>');
  const r=await verifyBackup(values.from);console.log(JSON.stringify({ok:true,command,path:r.path,schemaVersion:r.manifest.schemaVersion,records:r.manifest.records}));
 }else if(command==='restore'){
  if(!values.from||!values.to||values.db||values.out)throw new DatabaseSafetyError('Используйте: npm run db:restore -- --from <каталог-копии> --to .data/recovered.sqlite');
  console.log(JSON.stringify({ok:true,command,...await restoreBackup(values.from,values.to)}));
 }else if(command==='migrate'){
  if(!values.db||values.from||values.to)throw new DatabaseSafetyError('Используйте: npm run db:migrate -- --db <существующая-база> [--out .data/backups]');
  const saved=await createBackup(values.db,values.out??'.data/backups');
  const db=new DatabaseSync(resolve(values.db));try{db.exec('PRAGMA busy_timeout=5000');console.log(JSON.stringify({ok:true,command,backup:saved.path,...migrate(db)}));}finally{db.close();}
 }else throw new DatabaseSafetyError('Команда базы не распознана: check / stats / compact / backup / verify / restore / migrate.');
}catch(e){
 // Do not echo malformed database JSON, SQL values, secrets or arbitrary parser errors.
 const labels:Record<string,string>={ENOENT:'Файл или каталог не найден.',EEXIST:'Путь назначения уже существует; перезапись запрещена.',EACCES:'Нет прав доступа к файлу или каталогу.',EPERM:'Операция файловой системы запрещена.',ENOSPC:'На диске недостаточно места.',SQLITE_BUSY:'База занята. Повторите чтение после завершения операции.',SQLITE_CORRUPT:'SQLite сообщает о повреждении базы.',SQLITE_NOTADB:'Файл не является базой SQLite.'};
 const reason=e instanceof DatabaseSafetyError?e.message:labels[(e as NodeJS.ErrnoException).code??'']??'Проверьте параметры, права и совместимость базы. Подробности повреждённых записей не выводятся.';
 console.error(reason+' Инструкция: docs/BACKUP-RESTORE.md');process.exitCode=1;
}
