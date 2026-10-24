import {randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {appendAudit,type Actor} from './audit.js';
import {Core,digest,fail} from './core.js';
import type {Device} from '../shared/contracts.js';

const secret=z.string().regex(/^[a-f0-9]{64}$/);
const registration=z.object({enrollmentToken:secret,deviceId:z.string().uuid(),name:z.string().min(1).max(80),bootId:z.string().min(1).max(100),deviceToken:secret.optional()}).strict();
export const accessVersion=(d:Device)=>d.accessVersion??1;
export class DeviceAccess {
 constructor(private core:Core){}
 private event(d:Device,actor:Actor,action:string,before:unknown,after:unknown){appendAudit(this.core.store,this.core.now(),actor,action,{kind:'device',id:d.id,name:d.name},before,after);}
 private actor(d:Device):Actor{return {id:d.id,name:d.name,kind:'device'};}
 private response(d:Device,raw:string){return {deviceId:d.id,deviceToken:raw,clubId:d.clubId,accessVersion:accessVersion(d)};}
 private unique(raw:string,id:string){if(this.core.store.db.prepare("SELECT 1 FROM records INDEXED BY devices_token WHERE kind='device' AND json_extract(data,'$.tokenHash')=? AND id!=? LIMIT 1").get(digest(raw),id))fail(409,'token_collision','Нужен другой новый секрет.');}
 private expected(d:Device,body:unknown){
  const p=z.object({expectedAccessVersion:z.number().int().positive()}).parse(body);
  if(p.expectedAccessVersion!==accessVersion(d))fail(409,'access_conflict','Доступ ПК уже изменён. Обновите список устройств.');
 }
 invalidate(d:Device,code:string){
  for(const j of this.core.queue.active(d.id)){
   j.state=j.state==='queued'?'expired':'unknown';j.code=code;j.message='Доступ агента изменён. Старую команду не выполнять; нужна отдельная инспекция.';
   if(j.state==='expired')j.finished=this.core.now();this.core.store.put('job',j);
  }
 }
 cancelRecovery(id:string){this.core.store.db.prepare("DELETE FROM records WHERE kind='enrollment' AND json_extract(data,'$.deviceId')=?").run(id);}
 register(body:unknown){
  const p=registration.parse(body);
  return this.core.store.transaction(()=>{
   const e=this.core.store.get('enrollment',digest(p.enrollmentToken));
   if(!e||e.mode==='recovery'||e.expires<=this.core.now())fail(401,'enrollment','Токен использован или просрочен');
   const existing=this.core.store.get<Device>('device',p.deviceId);
   if(e.used){
    if(p.deviceToken&&existing&&!existing.revoked&&e.deviceId===p.deviceId&&existing.clubId===e.clubId&&existing.tokenHash===digest(p.deviceToken))return this.response(existing,p.deviceToken);
    fail(401,'enrollment','Токен использован или просрочен');
   }
   if(existing)fail(409,'device_exists','ПК уже зарегистрирован; используйте сохранённый доступ или восстановление администратора.');
   const raw=p.deviceToken??randomBytes(32).toString('hex');
   this.unique(raw,p.deviceId);
   const d:Device={id:p.deviceId,name:p.name,clubId:e.clubId,bootId:p.bootId,demo:false,lastSeen:this.core.now(),scenario:'real',rules:[],inspectedAt:null,tokenHash:digest(raw),accessVersion:1};
   e.used=true;e.deviceId=d.id;this.core.store.put('enrollment',e);this.core.store.put('device',d);
   this.event(d,this.actor(d),'device.registered',{},{clubId:d.clubId});return this.response(d,raw);
  });
 }
 requestRotation(d:Device,body:unknown,actor:Actor){
  return this.core.store.transaction(()=>{
   this.expected(d,body);if(d.demo||d.revoked)fail(409,'access_state','Смена доступа доступна только активному настоящему агенту.');
   if(!d.rotationRequested){d.rotationRequested=true;this.core.store.put('device',d);this.event(d,actor,'device.rotation_requested',{accessVersion:accessVersion(d)},{requested:true});}
   return {ok:true,accessVersion:accessVersion(d)};
  });
 }
 rotate(d:Device,body:unknown){
  const p=z.object({newToken:secret,expectedAccessVersion:z.number().int().positive()}).strict().parse(body);
  return this.core.store.transaction(()=>{
   this.expected(d,p);if(d.tokenHash===digest(p.newToken))fail(400,'same_token','Нужен новый секрет.');this.unique(p.newToken,d.id);
   const previous=accessVersion(d);d.tokenHash=digest(p.newToken);d.accessVersion=previous+1;d.rotationRequested=false;
   this.core.store.put('device',d);this.event(d,this.actor(d),'device.token_rotated',{accessVersion:previous},{accessVersion:d.accessVersion});
   return this.response(d,p.newToken);
  });
 }
 issueRecovery(d:Device,body:unknown,actor:Actor){
  return this.core.store.transaction(()=>{
   this.expected(d,body);if(d.demo)fail(400,'demo_only','Восстановление настоящего агента недоступно для DEMO-ПК.');
   const previous=accessVersion(d),raw=randomBytes(32).toString('hex'),expires=this.core.now()+600000;
   this.cancelRecovery(d.id);delete d.tokenHash;d.revoked=true;d.recoveryPending=true;d.rotationRequested=false;d.accessVersion=previous+1;d.commandEpoch=randomUUID();d.inspectedAt=null;
   this.invalidate(d,'access_recovery');this.core.store.put('device',d);
   this.core.store.put('enrollment',{id:digest(raw),mode:'recovery',deviceId:d.id,clubId:d.clubId,accessVersion:d.accessVersion,expires,used:false});
   this.event(d,actor,'device.recovery_issued',{accessVersion:previous},{accessVersion:d.accessVersion,expires});
   return {format:'paneltech-agent-recovery',formatVersion:1,deviceId:d.id,clubId:d.clubId,recoveryToken:raw,expires};
  });
 }
 recover(body:unknown){
  const p=z.object({recoveryToken:secret,deviceToken:secret,deviceId:z.string().uuid(),bootId:z.string().min(1).max(100)}).strict().parse(body);
  return this.core.store.transaction(()=>{
   const e=this.core.store.get('enrollment',digest(p.recoveryToken)),d=this.core.store.get<Device>('device',p.deviceId)??fail(401,'recovery','Код восстановления недействителен.');
   if(!e||e.mode!=='recovery'||e.deviceId!==p.deviceId||e.expires<=this.core.now()||!d||d.demo||d.clubId!==e.clubId)fail(401,'recovery','Код восстановления недействителен.');
   if(e.used){if(!d.revoked&&d.tokenHash===digest(p.deviceToken)&&accessVersion(d)===e.completedVersion)return this.response(d,p.deviceToken);fail(401,'recovery','Код восстановления недействителен.');}
   if(!d.revoked||!d.recoveryPending||accessVersion(d)!==e.accessVersion)fail(401,'recovery','Код восстановления отозван.');
   this.unique(p.deviceToken,d.id);this.invalidate(d,'access_recovered');d.tokenHash=digest(p.deviceToken);d.accessVersion=accessVersion(d)+1;d.revoked=false;d.recoveryPending=false;d.rotationRequested=false;
   d.bootId=p.bootId;d.lastSeen=0;d.inspectedAt=null;d.rules=[];e.used=true;e.completedVersion=d.accessVersion;
   this.core.store.put('device',d);this.core.store.put('enrollment',e);this.event(d,this.actor(d),'device.access_recovered',{},{clubId:d.clubId,accessVersion:d.accessVersion});
   return this.response(d,p.deviceToken);
  });
 }
}
