import type {SQLInputValue} from 'node:sqlite';
import type {Store} from './store.js';
import type {Job,Device,State} from '../shared/contracts.js';
export const ACTIVE_JOB="json_extract(data,'$.state') IN ('queued','running','unknown')";
export const DUE_JOB="json_extract(data,'$.state') IN ('queued','running')";
export const QUEUE_INDEXES=['queue_device_active','queue_deadline','devices_club','devices_token'];
export const QUEUE_SQL=`
CREATE INDEX IF NOT EXISTS queue_device_active ON records(json_extract(data,'$.deviceId'),json_extract(data,'$.state')) WHERE kind='job' AND ${ACTIVE_JOB};
CREATE INDEX IF NOT EXISTS queue_deadline ON records(json_extract(data,'$.expires')) WHERE kind='job' AND ${DUE_JOB};
CREATE INDEX IF NOT EXISTS devices_club ON records(json_extract(data,'$.clubId')) WHERE kind='device';
CREATE INDEX IF NOT EXISTS devices_token ON records(json_extract(data,'$.tokenHash')) WHERE kind='device';`;
export class QueueQueries {
 constructor(private store:Store){}
 private jobs(sql:string,args:SQLInputValue[]=[]):Job[]{return this.store.db.prepare(sql).all(...args).map(r=>this.store.decode(String(r.data)));}
 active(deviceId:string,states:State[]=['queued','running','unknown']){
  return this.jobs(`SELECT data FROM records INDEXED BY queue_device_active WHERE kind='job' AND ${ACTIVE_JOB} AND json_extract(data,'$.deviceId')=? AND json_extract(data,'$.state') IN (${states.map(()=>'?').join(',')}) ORDER BY rowid`,[deviceId,...states]);
 }
 busy(deviceId:string,states:State[]=['queued','running','unknown']){
  return !!this.store.db.prepare(`SELECT 1 FROM records INDEXED BY queue_device_active WHERE kind='job' AND ${ACTIVE_JOB} AND json_extract(data,'$.deviceId')=? AND json_extract(data,'$.state') IN (${states.map(()=>'?').join(',')}) LIMIT 1`).get(deviceId,...states);
 }
 next(deviceId:string){return this.jobs(`SELECT data FROM records INDEXED BY queue_device_active WHERE kind='job' AND ${ACTIVE_JOB} AND json_extract(data,'$.deviceId')=? AND json_extract(data,'$.state')='queued' ORDER BY rowid LIMIT 1`,[deviceId])[0];}
 due(now:number,deviceId?:string){return this.jobs(`SELECT data FROM records INDEXED BY ${deviceId===undefined?'queue_deadline':'queue_device_active'} WHERE kind='job' AND ${ACTIVE_JOB} AND ${DUE_JOB} AND json_extract(data,'$.expires')<=?${deviceId===undefined?'':" AND json_extract(data,'$.deviceId')=?"} ORDER BY rowid`,deviceId===undefined?[now]:[now,deviceId]);}
 heartbeatDemo(now:number){
  this.store.transaction(()=>this.store.db.prepare("UPDATE records SET data=json_set(data,'$.lastSeen',?) WHERE kind='device' AND json_extract(data,'$.demo')=1 AND COALESCE(json_extract(data,'$.revoked'),0)=0 AND json_extract(data,'$.scenario')!='offline'").run(now));
 }
 demoCandidates():Device[]{
  return this.store.db.prepare(`SELECT data FROM records WHERE kind='device' AND json_extract(data,'$.demo')=1 AND COALESCE(json_extract(data,'$.revoked'),0)=0 AND json_extract(data,'$.scenario')!='offline' AND id IN (SELECT json_extract(data,'$.deviceId') FROM records INDEXED BY queue_device_active WHERE kind='job' AND ${ACTIVE_JOB} AND json_extract(data,'$.state')='queued') ORDER BY rowid`).all().map(r=>this.store.decode(String(r.data)));
 }
}
export class DeviceQueries {
 constructor(private store:Store){}
 token(hash:string):Device|undefined{const r=this.store.db.prepare("SELECT data FROM records INDEXED BY devices_token WHERE kind='device' AND json_extract(data,'$.tokenHash')=? AND json_extract(data,'$.demo')=0 AND COALESCE(json_extract(data,'$.revoked'),0)=0 ORDER BY rowid LIMIT 1").get(hash);return r?this.store.decode(String(r.data)):undefined;}
 list(clubId?:string):Device[]{return this.store.db.prepare("SELECT data FROM records"+(clubId===undefined?'':' INDEXED BY devices_club')+" WHERE kind='device'"+(clubId===undefined?'':" AND json_extract(data,'$.clubId')=?")+' ORDER BY rowid').all(...(clubId===undefined?[]:[clubId])).map(r=>this.store.decode(String(r.data)));}
 counts(now:number){return new Map(this.store.db.prepare("SELECT json_extract(data,'$.clubId') AS id,COUNT(*) AS total,SUM(CASE WHEN COALESCE(json_extract(data,'$.revoked'),0)=0 AND json_extract(data,'$.lastSeen')>? THEN 1 ELSE 0 END) AS online FROM records WHERE kind='device' GROUP BY json_extract(data,'$.clubId')").all(now-15000).map(r=>[String(r.id),{deviceCount:Number(r.total),onlineCount:Number(r.online)}]));}
}
