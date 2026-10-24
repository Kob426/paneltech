import {fork,type ChildProcess} from 'node:child_process';
import {statSync,statfsSync,existsSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {backupStateSchema,emptyBackupState,safeJson,noLinks,persistFailure,type BackupConfig} from './automatic-backup.js';
import type {BackupState,OperationsStatus} from '../shared/operations.js';

export class Operations {
 private state:BackupState=emptyBackupState();
 private timer?:ReturnType<typeof setInterval>;
 private child?:ChildProcess;
 private stopped=false;
 private nextAt:number|null;
 private pending?:Promise<void>;
 constructor(readonly config:BackupConfig,private halted:()=>boolean,private now:()=>number=Date.now){
  try{
   noLinks(config.directory);const path=join(config.directory,'.status.json');
   if(existsSync(path))this.state=backupStateSchema.parse(safeJson(path));
   if(existsSync(join(config.directory,'.running.lock')))this.state={...this.state,phase:'error',error:'backup_locked'};
  }catch{this.state={...emptyBackupState(),phase:'error',error:'status_invalid'};}
  this.nextAt=config.enabled?Math.max(this.now()+config.startupDelayMs,(this.state.lastSuccess??0)+config.intervalMs):null;
 }
 start(){if(this.timer||this.stopped)return;this.timer=setInterval(()=>this.tick(),1000);this.timer.unref();}
 tick(){if(this.nextAt!==null&&this.now()>=this.nextAt&&!this.child&&!this.halted())this.run();}
 run(){
  if(this.child||this.stopped)return false;
  if(this.halted())return false;
  this.state={...this.state,phase:'running',lastAttempt:this.now(),error:null};this.nextAt=null;
  let child:ChildProcess;
  try{child=fork(fileURLToPath(new URL('./backup-task.ts',import.meta.url)),[],{execArgv:['--import','tsx'],stdio:['ignore','ignore','ignore','ipc'],env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot}});}
  catch{this.fail('worker_failed');return false;}
  this.child=child;
  this.pending=new Promise<void>(resolve=>{
   let received=false;
   const timeout=setTimeout(()=>child.kill('SIGKILL'),120000);timeout.unref();
   child.on('message',(message:any)=>{
    if(received)return;
    if(message?.ok){const parsed=backupStateSchema.safeParse(message.state);if(parsed.success){this.state=parsed.data;received=true;}}
    else if(message?.ok===false){this.fail(message.code==='backup_locked'?'backup_locked':'backup_failed');received=true;}
   });
   child.once('error',()=>{if(!received){this.fail('worker_failed');received=true;}});
   child.once('exit',()=>{clearTimeout(timeout);if(!received)this.fail('worker_failed');this.child=undefined;this.nextAt=this.config.enabled?this.now()+this.config.intervalMs:null;resolve();});
  });
  child.send(this.config,error=>{if(error)child.kill();});return true;
 }
 private fail(error:NonNullable<BackupState['error']>){this.state={...this.state,phase:'error',error};if(error!=='backup_locked')persistFailure(this.config,this.state);console.error('automatic_backup: '+error);}
 async settled(){await this.pending;}
 async stop(){this.stopped=true;if(this.timer)clearInterval(this.timer);await this.pending;}
 status():OperationsStatus {
  const size=(path:string)=>{try{return statSync(path).size;}catch{return null;}};
  let freeBytes:number|null=null;try{const disk=statfsSync(dirname(this.config.source));freeBytes=disk.bavail*disk.bsize;}catch{}
  return {database:{state:this.halted()?'paused':'ready',mainBytes:size(this.config.source),walBytes:size(this.config.source+'-wal')??0,freeBytes},runtime:{uptimeSeconds:Math.floor(process.uptime()),rssBytes:process.memoryUsage().rss},backup:{...this.state,enabled:this.config.enabled,intervalMinutes:this.config.intervalMs/60000,keep:this.config.keep,maxBytes:this.config.maxBytes,nextAt:this.nextAt}};
 }
}
