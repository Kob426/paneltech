import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Store} from './store.js';
import {fail} from './core.js';
export type Actor={id:string;name:string;kind:'user'|'device'|'system'};
export type Entity={kind:string;id:string;name:string};
export function editVersion(kind:string,record:any):number{return kind==='game'?record.revision:kind==='job'?record.feedbackVersion??0:record.version??1;}
export function requireVersion(body:any,kind:string,record:any){
 if(body?.expectedVersion===undefined)fail(428,'version_required','Загрузите запись перед сохранением: требуется её версия.');
 const expected=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(body.expectedVersion);
 if(expected!==editVersion(kind,record))fail(409,'edit_conflict','Запись уже изменил другой сотрудник. Загрузите актуальную запись и сравните изменения.');
}
export function appendAudit(store:Store,at:number,actor:Actor,action:string,entity:Entity,before:unknown={},after:unknown={}){
 // Call inside the transaction of the recorded change. Only explicit safe projections belong here.
 if(!store.db.isTransaction)throw Error('audit_requires_transaction');
 const event={id:randomUUID(),at,actor,action,entity,before,after};
 store.db.prepare("INSERT INTO records(kind,id,data) VALUES('audit',?,?)").run(event.id,JSON.stringify(event));return event;
}
export function publicUser(u:any){const {password,...safe}=u;return {...safe,version:editVersion('user',u)};}
export function userFacts(u:any){return {username:u.username,role:u.role,disabled:!!u.disabled};}
export function gameFacts(g:any){return {name:g.name,revision:g.revision,exes:g.exes};}
export function clubFacts(c:any){return {name:c.name,variants:c.variants};}
export function feedbackFacts(j:any){return j.feedback?{outcome:j.feedback.outcome,reason:j.feedback.reason,commentLength:j.feedback.comment?.length??0,version:editVersion('job',j)}:{};}
const natural=z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export function auditPage(store:Store,query:unknown){
 const q=z.object({page:z.coerce.number().int().min(1).max(1000000).default(1),snapshot:natural.optional(),actor:z.string().min(1).max(100).optional(),action:z.string().min(1).max(80).optional(),from:natural.optional(),to:natural.optional()}).strict().parse(query);
 if(q.from!==undefined&&q.to!==undefined&&q.from>q.to)fail(400,'period','Начало периода позже конца.');
 const snapshot=q.snapshot??Number(store.db.prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM records WHERE kind='audit'").get()!.n);
 const terms=["kind='audit'",'rowid<=?'],args:any[]=[snapshot];
 for(const [value,sql] of [[q.actor,"json_extract(data,'$.actor.id')=?"],[q.action,"json_extract(data,'$.action')=?"],[q.from,"json_extract(data,'$.at')>=?"],[q.to,"json_extract(data,'$.at')<=?"]] as const)if(value!==undefined){terms.push(sql);args.push(value);}
 const where=terms.join(' AND '),total=Number(store.db.prepare('SELECT COUNT(*) AS n FROM records WHERE '+where).get(...args)!.n),pages=Math.max(1,Math.ceil(total/25)),page=Math.min(q.page,pages);
 const items=store.db.prepare('SELECT data FROM records WHERE '+where+' ORDER BY rowid DESC LIMIT 25 OFFSET ?').all(...args,(page-1)*25).map(r=>JSON.parse(String(r.data)));
 const actors=store.db.prepare("SELECT DISTINCT json_extract(data,'$.actor') AS actor FROM records WHERE kind='audit' ORDER BY json_extract(data,'$.actor.name')").all().map(r=>JSON.parse(String(r.actor)));
 const actions=store.db.prepare("SELECT DISTINCT json_extract(data,'$.action') AS action FROM records WHERE kind='audit' ORDER BY action").all().map(r=>r.action);
 return {items,total,page,pages,snapshot,actors,actions};
}
