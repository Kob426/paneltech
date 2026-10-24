import {z} from 'zod';
import type {SQLInputValue} from 'node:sqlite';
import type {Job} from '../shared/contracts.js';
import type {Store} from './store.js';

const text=z.string().min(1).max(100);
export const jobQuery=z.object({
 clubId:text.optional(),deviceId:text.optional(),gameId:text.optional(),batchId:text.optional(),author:z.string().min(1).max(80).optional(),
 state:z.enum(['queued','running','succeeded','failed','expired','unknown','active']).optional(),
 from:z.coerce.number().int().min(0).max(8640000000000000).optional(),to:z.coerce.number().int().min(0).max(8640000000000000).optional(),
 page:z.coerce.number().int().min(1).max(1000000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(25),
 snapshot:z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),focusId:text.optional(),
 order:z.enum(['recent','active']).default('recent')
}).strict().refine(q=>q.from===undefined||q.to===undefined||q.from<=q.to,{message:'Начало периода должно быть не позже конца',path:['from']});
const active="json_extract(data,'$.state') IN ('queued','running','unknown')";
const created="json_extract(data,'$.created')";
const col=(name:string)=>`json_extract(data,'$.${name}')`;
type Row={data:string};

export class JobQueries {
 constructor(private store:Store){}
 private rows(sql:string,args:SQLInputValue[]=[]):Job[]{return (this.store.db.prepare(sql).all(...args) as Row[]).map(r=>this.store.decode(r.data));}
 page(input:unknown){
  const q=jobQuery.parse(input);
  const snapshot=q.snapshot??Number((this.store.db.prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM records WHERE kind='job'").get() as {n:number}).n);
  const where=["kind='job'",'rowid<=?'],args:SQLInputValue[]=[snapshot];
  for(const k of ['clubId','deviceId','gameId','batchId','author'] as const)if(q[k]!==undefined){where.push(col(k)+'=?');args.push(q[k]!);}
  if(q.state==='active')where.push(active);else if(q.state){where.push(col('state')+'=?');args.push(q.state);}
  if(q.from!==undefined){where.push(created+'>=?');args.push(q.from);}
  if(q.to!==undefined){where.push(created+'<=?');args.push(q.to);}
  const clause=where.join(' AND '),order=q.order==='active'?`(${active}) DESC, ${created} DESC,rowid DESC`:`${created} DESC,rowid DESC`;
  const total=Number((this.store.db.prepare(`SELECT COUNT(*) AS n FROM records WHERE ${clause}`).get(...args) as {n:number}).n);
  const pages=Math.max(1,Math.ceil(total/q.pageSize));let page=Math.min(q.page,pages);
  if(q.focusId){
   const rank=this.store.db.prepare(`SELECT n FROM (SELECT id,ROW_NUMBER() OVER (ORDER BY ${order}) AS n FROM records WHERE ${clause}) WHERE id=?`).get(...args,q.focusId) as {n:number}|undefined;
   if(rank)page=Math.floor((Number(rank.n)-1)/q.pageSize)+1;
  }
  const items=this.rows(`SELECT data FROM records WHERE ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`,[...args,q.pageSize,(page-1)*q.pageSize]);
  const scope=q.clubId?` AND ${col('clubId')}=?`:'',scopeArgs=q.clubId?[q.clubId]:[];
  const authors=(this.store.db.prepare(`SELECT DISTINCT ${col('author')} AS author FROM records WHERE kind='job'${scope} ORDER BY author COLLATE NOCASE`).all(...scopeArgs) as {author:string}[]).map(r=>r.author);
  const batches=this.store.db.prepare(`SELECT ${col('batchId')} AS id,MAX(${created}) AS created,COUNT(*) AS total FROM records WHERE kind='job'${scope} GROUP BY ${col('batchId')} ORDER BY created DESC,id DESC LIMIT 25`).all(...scopeArgs) as {id:string;created:number;total:number}[];
  let batch=null;
  if(q.batchId){
   // Full club batch, deliberately independent of page, status, author, dates and snapshot.
   const members=this.rows(`SELECT data FROM records WHERE kind='job'${scope} AND ${col('batchId')}=? ORDER BY ${created} DESC,rowid DESC`,[...scopeArgs,q.batchId]);
   if(members.length){
    const counts={total:members.length,succeeded:0,failed:0,expired:0,unknown:0,pending:0};
    for(const j of members)if(j.state==='queued'||j.state==='running')counts.pending++;else counts[j.state]++;
    batch={id:q.batchId,first:members[0],counts,members:members.map(({id,deviceId,deviceName})=>({id,deviceId,deviceName}))};
   }
  }
  return {items,total,page,pageSize:q.pageSize,pages,snapshot,authors,batches,batch};
 }
 workspace(clubId?:string,gameId?:string){
  const scope=clubId?` AND ${col('clubId')}=?`:'',args:SQLInputValue[]=clubId?[clubId]:[];
  const source=clubId?'records INDEXED BY jobs_club_created':'records';
  const ids=[`SELECT id FROM records INDEXED BY queue_device_active WHERE kind='job'${scope} AND ${active}`,
   `SELECT id FROM (SELECT id FROM ${source} WHERE kind='job'${scope} ORDER BY ${created} DESC,rowid DESC LIMIT 60)`];
  const params=[...args,...args];
  if(clubId&&gameId){
   for(const extra of ['',` AND ${col('operation')}='apply_marking' AND ${col('state')}='succeeded'`,` AND ${col('operation')}='apply_marking' AND ${col('state')}='succeeded' AND json_extract(data,'$.feedback.outcome')='helped'`]){
    const helped=extra.includes('feedback');
    ids.push(`SELECT id FROM (SELECT id,ROW_NUMBER() OVER (PARTITION BY ${col('deviceId')} ORDER BY ${helped?"json_extract(data,'$.feedback.at') DESC,":''}${created} DESC,rowid DESC) AS n FROM ${source} WHERE kind='job'${scope} AND ${col('gameId')}=?${extra}) WHERE n=1`);
    params.push(...args,gameId);
   }
  }
  return this.rows(`SELECT data FROM records WHERE kind='job' AND id IN (${ids.join(' UNION ')}) ORDER BY ${created} DESC,rowid DESC`,params);
 }
}
