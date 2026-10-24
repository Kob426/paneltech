// Isolated synthetic benchmark worker. No production test flags or Windows executor.
import {readFileSync,realpathSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,cpus} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {monitorEventLoopDelay,performance} from 'node:perf_hooks';
import {Store} from '../server/store.js';
import {Core,password,digest} from '../server/core.js';
import {createApp} from '../server/app.js';
import {JobQueries} from '../server/job-queries.js';
import {DeviceQueries} from '../server/queue-queries.js';
import {appendAudit} from '../server/audit.js';
import {SCHEMA_VERSION} from '../server/migrations.js';
import {ruleName,type Job} from '../shared/contracts.js';
const dir=realpathSync(process.env.PANELTECH_LOAD_DIR??'');
if(!dir.startsWith(join(realpathSync(tmpdir()),'paneltech-load-'))||readFileSync(join(dir,'SYNTHETIC'),'utf8')!=='PANELTECH SYNTHETIC LOAD ONLY')throw Error('Synthetic temporary directory required');
const phase=process.env.PANELTECH_LOAD_PHASE??'',count=Number(process.env.PANELTECH_LOAD_JOBS??10000),clubs=52,perClub=65,pcs=clubs*perClub;
const token=(n:number)=>createHash('sha256').update('SYNTHETIC-LOAD-ONLY-'+n).digest('hex');
const id=(n:number)=>'00000000-0000-4000-8000-'+n.toString(16).padStart(12,'0');
const rss=()=>Math.round(process.resourceUsage().maxRSS/1024*100)/100;
if(phase==='seed'){
 if(![10000,100000].includes(count))throw Error('Unsupported synthetic size');
 const store=new Store(join(dir,'template.sqlite')),core=new Core(store);core.seed();
 const now=Date.now(),exes=core.store.get('game','fortnite').exes as string[],rules=exes.map(exe=>({name:ruleName('fortnite',exe),gameId:'fortnite',exe,dscp:36,owned:true}));
 store.transaction(()=>{
  for(const d of store.all('device'))store.del('device',d.id);for(const c of store.all('club'))store.del('club',c.id);
  const hash=password('SyntheticLoad-2026!');for(let n=0;n<6;n++)store.put('user',{id:'load-user-'+n,username:'load'+n,password:hash,role:'operator',disabled:false});
  for(let c=0;c<clubs;c++){
   store.put('club',{id:'load-club-'+c,name:'SYNTHETIC CLUB '+c,demo:false,variants:[{id:36,name:'36'},{id:40,name:'40'}]});
   for(let p=0;p<perClub;p++){const n=c*perClub+p;store.put('device',{id:id(n),name:p%2?'pubg'+c+'-pc'+p:String(p+1),clubId:'load-club-'+c,demo:false,bootId:'load-boot',lastSeen:now-1000,inspectedAt:now-1000,scenario:'success',rules:p%2?rules:[],tokenHash:digest(token(n))});}
  }
  const base:Job={id:id(100000),batchId:'batch-0',deviceId:id(0),deviceName:'1',clubId:'load-club-0',clubName:'SYNTHETIC CLUB 0',gameId:'fortnite',gameName:'Synthetic Fortnite snapshot',revision:1,exes,operation:'apply_marking',variant:36,variantName:'36',allowedVariants:[36,40],author:'load0',created:now-count*1000,expires:now-1000,bootId:'load-boot',state:'succeeded',demo:true,attempts:1,finished:now-1000,rules};
  for(let n=0;n<count;n++){
   const d=n%pcs,c=Math.floor(d/perClub),created=now-(count-n)*1000;
   store.put('job',{...base,id:id(100000+n),batchId:'batch-'+Math.floor(n/65),deviceId:id(d),deviceName:String(d%perClub+1),clubId:'load-club-'+c,clubName:'SYNTHETIC CLUB '+c,author:'load'+n%6,created,expires:created+30000,finished:created+2000,...(n%10===0?{feedback:{outcome:'helped',reason:'voice',comment:'',author:'load'+n%6,at:created+3000}}:{})});
   if(n%5===0)appendAudit(store,created,{id:'load-user-'+n%6,name:'load'+n%6,kind:'user'},'batch.created',{kind:'batch',id:'batch-'+n,name:'SYNTHETIC'},{},{count:1});
  }
  for(let c=0;c<clubs;c++)store.put('job',{...base,id:id(300000+c),batchId:'old-unknown-'+c,clubId:'load-club-'+c,deviceId:id(c*perClub+64),state:'unknown',created:now-count*1000-10000});
  store.put('meta',{id:'load-fixture',synthetic:true,now,clubs,perClub,pcs,completedJobs:count,unresolved:clubs,auditEvents:count/5});
 });const sqliteVersion=store.db.prepare('SELECT sqlite_version() AS version').get()!.version;store.close();console.log(JSON.stringify({seeded:true,clubs,pcs,completedJobs:count,schema:SCHEMA_VERSION,bytes:statSync(join(dir,'template.sqlite')).size,node:process.version,sqlite:sqliteVersion,cpu:cpus()[0]?.model}));
}else{
 const opened=performance.now(),store=new Store(join(dir,'case.sqlite')),startupMs=performance.now()-opened,meta=store.get('meta','load-fixture');if(!meta?.synthetic)throw Error('Not a synthetic fixture');
 const core=new Core(store,()=>meta.now),memoryStartMiB=rss();
 const anchor=store.db.prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM records WHERE kind='job'").get()!.n!;
 const hashHistory=()=>{const h=createHash('sha256');for(const r of store.db.prepare("SELECT data FROM records WHERE kind='job' AND rowid<=? ORDER BY rowid").iterate(anchor))h.update(String(r.data));return h.digest('hex');};
 if(phase.startsWith('http-')){
  const started=performance.now();core.now=()=>meta.now+Math.floor(performance.now()-started);
  const lag=monitorEventLoopDelay({resolution:10});lag.enable();
  const app=createApp(core,{realAgents:true});
  const server=app.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({ready:true,port:(server.address() as {port:number}).port,startupMs,memoryStartMiB})));
  // Private benchmark-only endpoint on an ephemeral loopback server, never in createApp/production.
  app.post('/__load_finish__',(_req,res)=>{lag.disable();res.json({startupMs,memoryStartMiB,maxRssMiB:rss(),heapUsedMiB:process.memoryUsage().heapUsed/1048576,eventLoopP95Ms:lag.percentile(95)/1e6,eventLoopMaxMs:lag.max/1e6});server.close(()=>{store.close();process.exit(0);});});
 }else if(phase==='profile-reads'){
  const prepare=store.db.prepare.bind(store.db),stats=new Map<string,{sql:string;ms:number;calls:number;plan:string[]}>();
  store.db.prepare=sql=>{const statement:any=prepare(sql);for(const method of ['all','get']){const original=statement[method].bind(statement);statement[method]=(...args:any[])=>{const start=performance.now(),value=original(...args),ms=performance.now()-start;const row=stats.get(sql)??{sql,ms:0,calls:0,plan:prepare('EXPLAIN QUERY PLAN '+sql).all(...args).map(r=>String(r.detail))};row.ms+=ms;row.calls++;stats.set(sql,row);return value;};}return statement;};
  const jobs=new JobQueries(store),devices=new DeviceQueries(store),times:Record<string,number>={};
  for(const [name,fn] of [['workspace',()=>jobs.workspace('load-club-0','fortnite')],['history',()=>jobs.page({clubId:'load-club-0'})],['devices',()=>devices.list('load-club-0')],['counts',()=>devices.counts(meta.now)]] as const){const start=performance.now();fn();times[name]=performance.now()-start;}
  console.log(JSON.stringify({phase,startupMs,maxRssMiB:rss(),timesMs:times,queries:[...stats.values()].sort((a,b)=>b.ms-a.ms)}));store.close();
 }else{
  if(phase==='tick'||phase==='tick64')store.transaction(()=>store.db.exec("UPDATE records SET data=json_set(data,'$.demo',json('true')) WHERE kind='device'"));
  const before=hashHistory(),times:number[]=[];let added=0;
  const make=()=>core.create({deviceIds:Array.from({length:65},(_,n)=>id(n)),gameId:'fortnite',operation:'apply_marking',variant:36},'load0');
  let execution:Job[]=[];if(phase==='tick64'){execution=make();added=65;}
  for(let r=0;r<(phase==='create65'||phase==='tick'||phase==='tick64'?1:3);r++){
   const begin=performance.now();
   if(phase==='expire')core.expire();
   else if(phase==='poll-idle'){if(core.poll(core.device(id(0)))!==null)throw Error('Unexpected delivery');}
   else if(phase==='create65'){const jobs=make();if(jobs.length!==65||jobs.filter(j=>j.state==='queued').length!==64||jobs.filter(j=>j.code==='busy').length!==1)throw Error('Incorrect batch outcome');added=65;}
   else if(phase==='tick'||phase==='tick64')core.tick();
   else throw Error('Unknown phase');times.push(performance.now()-begin);
  }
  if(hashHistory()!==before)throw Error('History mutated during idle benchmark');
  if(phase==='tick64'){if(execution.filter(j=>store.get<Job>('job',j.id)?.state==='succeeded').length!==64)throw Error('Incorrect DEMO execution');core.tick();if(execution.some(j=>store.get<Job>('job',j.id)!.attempts>1))throw Error('Duplicate execution');}
  console.log(JSON.stringify({phase,startupMs,memoryStartMiB,maxRssMiB:rss(),heapUsedMiB:process.memoryUsage().heapUsed/1048576,timesMs:times,historyUnchanged:true,addedJobs:added,executedDemoJobs:phase==='tick64'?64:0}));store.close();
 }
}
