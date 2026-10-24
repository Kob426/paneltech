import {automaticBackup,backupStateSchema} from './automatic-backup.js';
// Config is delivered over IPC, never interpolated into a shell command.
process.once('message',async(config:Parameters<typeof automaticBackup>[0])=>{
 try{const state=backupStateSchema.parse(await automaticBackup(config));process.send?.({ok:true,state});}
 catch(error){process.send?.({ok:false,code:error instanceof Error&&error.message==='backup_locked'?'backup_locked':'backup_failed'});}
 finally{process.disconnect?.();}
});
