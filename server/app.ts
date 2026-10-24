import {DeviceAccess,accessVersion} from './device-access.js';
import {DeviceQueries} from './queue-queries.js';
import {appendAudit,auditPage,editVersion,requireVersion,publicUser,userFacts,gameFacts,clubFacts,feedbackFacts,type Actor} from './audit.js';
import {StorageUnavailable,isStorageError} from './storage-errors.js';
import express, {type Request,type Response,type NextFunction} from 'express';
import { randomBytes,randomUUID } from 'node:crypto';
import {JobQueries} from './job-queries.js';
import { LoginLimiter } from './login-limiter.js';
import {z,ZodError} from 'zod';
import type {Operations} from './operations.js';
import {Core,Fault,fail,digest,password,checkPassword} from './core.js';
import {clubInput,gameInput,feedbackInput,accountInput,accountPassword,scenarios,type Device,type Job,exe,ruleName} from '../shared/contracts.js';
const token=()=>randomBytes(32).toString('hex');
const dummyPasswordHash=password(token());
const sessionToken=(req:Request)=>{const raw=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('session='))?.slice(8);return raw&&/^[a-f0-9]{64}$/.test(raw)?raw:undefined;};
const ruleSchema=z.object({name:z.string().max(220),gameId:z.string().max(80),exe:z.string().max(1024),dscp:z.number().int().min(0).max(63),owned:z.boolean()});
export function createApp(core:Core,options:{operations?:Operations;realAgents?:boolean;secureCookies?:boolean;personalAccounts?:boolean;dist?:string}={}){
 const queries=new JobQueries(core.store),deviceQueries=new DeviceQueries(core.store),deviceAccess=new DeviceAccess(core);
 const actor=(res:Response):Actor=>({id:res.locals.user.id,name:res.locals.user.username,kind:'user'});
 const record=(res:Response,action:string,kind:string,value:any,before:unknown={},after:unknown={})=>appendAudit(core.store,core.now(),actor(res),action,{kind,id:value.id,name:value.name??value.username??value.deviceName??value.id},before,after);
 function editRecord(req:Request,res:Response,kind:string,action:string,change:(before:any)=>any,facts:(value:any)=>unknown,extra:Record<string,unknown>={}){
  return core.store.transaction(()=>{const before=core.store.get(kind,String(req.params.id))??fail(404,'not_found','Запись не найдена');requireVersion(req.body,kind,before);let after=change(before);if(!['game','job'].includes(kind))after={...after,version:editVersion(kind,before)+1};core.store.put(kind,after);record(res,action,kind,after,facts(before),{...facts(after) as any,...extra});return after;});
 }
 const app=express();app.set('trust proxy','loopback');app.disable('x-powered-by');
 app.use((req,res,next)=>{res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'"});if(req.path.startsWith('/api'))res.set('Cache-Control','no-store');next();});
 app.use(express.json({limit:'128kb'}));
 // Monitoring stays readable after a write failure. Authenticate with SELECT only:
 // no session cleanup, no mutation and no bypass for normal application routes.
 app.get('/api/admin/operations',(req,res)=>{
  const read=(kind:string,id:string)=>{const row=core.store.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind,id) as {data:string}|undefined;return row?JSON.parse(row.data):null;};
  const raw=sessionToken(req),session=raw?read('session',digest(raw)):null,user=session?read('user',session.userId):null;
  if(!session||session.expires<=core.now()||!user||user.disabled)fail(401,'auth','Войдите в панель');
  if(user.role!=='admin')fail(403,'role','Требуется администратор');
  if(!options.operations)fail(503,'operations_unavailable','Контроль сервера не настроен');
  res.json(options.operations!.status());
 });
 app.use('/api',(_req,res,next)=>{if(core.store.halted)return res.status(503).json({ok:false,code:'storage_unavailable',message:new StorageUnavailable().message});next();});
 const attempts=new LoginLimiter();
 const originCheck=(req:Request)=>{if(req.headers['sec-fetch-site']==='cross-site')fail(403,'origin','Запрос с другого сайта запрещён');if(req.headers.origin&&req.headers.origin!==`${req.protocol}://${req.headers.host}`)fail(403,'origin','Запрос с другого сайта запрещён');};
 app.post('/api/login',(req,res)=>{
 originCheck(req);
 const p=z.object({username:z.string().min(1).max(80),password:z.string().min(1).max(200)}).parse(req.body);
 const keys=['ip:'+digest(req.ip??'local'),'account:'+digest(p.username)];
 attempts.check(keys,core.now());
 const u=core.store.all('user').find(u=>u.username===p.username);
 const valid=checkPassword(p.password,u?.password??dummyPasswordHash);
 if(!u||u.disabled||!valid){attempts.failed(keys,core.now());fail(401,'credentials','Неверный логин или пароль');}
 const previous=sessionToken(req),t=token(),csrf=token();
 core.store.transaction(()=>{if(previous)core.store.del('session',digest(previous));core.store.put('session',{id:digest(t),userId:u.id,csrf,expires:core.now()+8*3600000});});
 res.cookie('session',t,{httpOnly:true,sameSite:'strict',secure:options.secureCookies,maxAge:8*3600000,path:'/'});
 res.json({user:{id:u.id,username:u.username,role:u.role},csrf});
 });
 const auth=(req:Request,res:Response,next:NextFunction)=>{const raw=sessionToken(req);const s=raw?core.store.get('session',digest(raw)):null;const u=s?core.store.get('user',s.userId):null;if(!s||s.expires<=core.now()||!u||u.disabled){if(s)core.store.del('session',s.id);fail(401,'auth','Войдите в панель');}res.locals.user=u;res.locals.session=s;if(!['GET','HEAD'].includes(req.method)){originCheck(req);if(req.headers['x-csrf-token']!==s.csrf)fail(403,'csrf','Неверный CSRF-токен');}next();};
 const admin=(_req:Request,res:Response,next:NextFunction)=>{if(res.locals.user.role!=='admin')fail(403,'role','Требуется администратор');next();};
 app.get('/api/health',(_req,res)=>res.json({ok:true,mode:options.realAgents?'PILOT':'DEMO',realAgents:!!options.realAgents,personalAccounts:!!options.personalAccounts}));
 // Device endpoints are distinct from browser sessions. No browser-authenticated remote execution.
 const agentAuth=(req:Request,res:Response,next:NextFunction)=>{if(!options.realAgents)fail(403,'real_disabled','Настоящие агенты отключены в домашнем DEMO');if(!req.secure&&(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress??'')||!!req.headers['x-forwarded-for']))fail(403,'tls','Нужен HTTPS');const raw=/^Bearer ([a-f0-9]{64})$/i.exec(req.headers.authorization??'')?.[1]??'';if(!raw)fail(401,'device','Требуется индивидуальный Bearer-токен устройства');const d=deviceQueries.token(digest(raw));if(!d)fail(401,'device','Доступ устройства отозван или токен неверен');res.locals.device=d;next();};
 const registrationTransport=(req:Request)=>{if(!options.realAgents)fail(403,'real_disabled','Настоящие агенты отключены');if(!req.secure&&(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress??'')||!!req.headers['x-forwarded-for']))fail(403,'tls','Нужен HTTPS');};
 app.post('/api/agent/register',(req,res)=>{registrationTransport(req);res.json(deviceAccess.register(req.body));});
 app.post('/api/agent/recover',(req,res)=>{registrationTransport(req);res.json(deviceAccess.recover(req.body));});
 app.get('/api/agent/access',agentAuth,(_req,res)=>{const d=res.locals.device as Device;res.json({deviceId:d.id,clubId:d.clubId,accessVersion:accessVersion(d)});});
 app.post('/api/agent/access/rotate',agentAuth,(req,res)=>res.json(deviceAccess.rotate(res.locals.device,req.body)));
 app.post('/api/agent/poll',agentAuth,(req,res)=>{const p=z.object({bootId:z.string().min(1).max(100),rules:z.array(ruleSchema).max(500),inspectionVerified:z.boolean()}).parse(req.body);const d=res.locals.device as Device;const response=core.store.transaction(()=>{const changed=d.bootId!==p.bootId;if(changed){for(const j of core.queue.active(d.id)){j.state=j.state==='queued'?'expired':'unknown';j.code='boot_changed';j.message='Смена загрузочной сессии: прошлую команду не выполнять';core.store.put('job',j);}d.bootId=p.bootId;d.rules=[];d.inspectedAt=null;}if(p.inspectionVerified){d.rules=p.rules;d.inspectedAt=core.now();}d.lastSeen=core.now();core.store.put('device',d);
 // An authenticated fresh inspection can resolve an uncertain result, without re-delivery.
 for(const j of (p.inspectionVerified?core.queue.active(d.id,['unknown']):[])){j.rules=p.rules;j.state=j.commandEpoch===d.commandEpoch&&j.bootId===d.bootId&&core.expected(j,p.rules)?'succeeded':'failed';j.code=j.commandEpoch!==d.commandEpoch?'access_recovery_inspected':'reconciled';j.message=j.commandEpoch!==d.commandEpoch?'После восстановления доступа старый результат не подтверждён. Получена новая инспекция; повтор и присвоение старых правил не выполнялись.':`Выполнена сверка фактического набора агентом по снимку задания r${j.revision}, без повторного применения. ${j.state==='succeeded'?'Набор совпал.':'Набор не совпал или загрузочная сессия изменилась.'}`;j.reconciled=core.now();j.finished=core.now();core.store.put('job',j);}
 const club=core.store.get('club',d.clubId);return {job:d.rotationRequested?null:core.poll(d),rotateToken:!!d.rotationRequested,allowedVariants:club.variants.map((v:any)=>v.id),serverTime:core.now()};});res.json(response);});
 app.post('/api/agent/results/:id',agentAuth,(req,res)=>{const j=core.store.get<Job>('job',String(req.params.id))??fail(404,'job','Задание не найдено');const d=res.locals.device as Device;if(j.deviceId!==d.id)fail(403,'isolation','Чужое задание');if(['succeeded','failed','expired'].includes(j.state))return res.json(j);if(!['running','unknown'].includes(j.state))fail(409,'not_delivered','Задание ещё не было выдано агенту');
 const p=z.object({bootId:z.string().max(100),state:z.enum(['succeeded','failed','unknown']),code:z.string().max(80),message:z.string().max(2000),rules:z.array(ruleSchema).max(500),rollback:z.string().max(2000).nullable().optional(),dryRun:z.boolean()}).parse(req.body);
 if(j.commandEpoch!==d.commandEpoch)fail(409,'access_changed','Доступ восстановлен: старый результат требует новой инспекции, без повторной отправки.');
 if(j.bootId!==p.bootId||d.bootId!==p.bootId)fail(409,'boot','Загрузочная сессия не совпала');
 j.state=p.state;j.code=p.code;j.message=p.message;j.rules=p.rules;j.rollback=p.rollback??undefined;
 if(p.dryRun){j.state='failed';j.code='dry_run';j.message='DRY-RUN: параметры проверены; изменения Windows не выполнялись.';}
 else if(p.state==='succeeded'&&!core.expected(j,p.rules)){j.state='failed';j.code='verification';j.message='Фактические правила не совпадают с ожидаемым набором';}
 j.finished=core.now();d.lastSeen=core.now();if(!p.dryRun&&(p.state==='succeeded'||p.code==='partial_failure')){d.rules=p.rules;d.inspectedAt=core.now();}else if(p.state==='unknown'){d.inspectedAt=null;}core.store.transaction(()=>{core.store.put('device',d);core.store.put('job',j);});res.json(j);});
 app.use('/api',auth);
 app.get('/api/me',(_req,res)=>res.json({user:{id:res.locals.user.id,username:res.locals.user.username,role:res.locals.user.role},csrf:res.locals.session.csrf}));
 app.post('/api/logout',(_req,res)=>{core.store.del('session',res.locals.session.id);res.clearCookie('session',{path:'/',httpOnly:true,sameSite:'strict',secure:options.secureCookies});res.json({ok:true});});
 app.get('/api/state',(req,res)=>{const q=z.object({clubId:z.string().min(1).max(100).optional(),gameId:z.string().min(1).max(100).optional()}).parse(req.query);core.expire();const counts=deviceQueries.counts(core.now());const devices=deviceQueries.list(q.clubId).map(({tokenHash,...d})=>({...d,online:core.online(d),fresh:d.inspectedAt!==null&&core.now()-d.inspectedAt<15000}));res.json({mode:options.realAgents?'PILOT':'DEMO',clubs:core.store.all('club').map(c=>({...c,version:editVersion('club',c),deviceCount:0,onlineCount:0,...counts.get(c.id)})),games:core.store.all('game'),devices,jobs:queries.workspace(q.clubId,q.gameId),realAgents:!!options.realAgents,personalAccounts:!!options.personalAccounts});});
 app.post('/api/jobs',(req,res)=>{const jobs=core.store.transaction(()=>{const rows=core.create(req.body,res.locals.user.username);record(res,'batch.created','batch',{id:rows[0].batchId,name:rows[0].gameName},{},{operation:rows[0].operation,count:rows.length,gameId:rows[0].gameId});return rows;});res.status(201).json(jobs);});
 app.get('/api/history',(req,res)=>{core.expire();res.json(queries.page(req.query));});
 app.get('/api/jobs/:id/feedback',(req,res)=>{const j=core.store.get('job',String(req.params.id))??fail(404,'job','Задание не найдено');res.json({feedback:j.feedback,feedbackVersion:editVersion('job',j)});});
 app.post('/api/jobs/:id/feedback',(req,res)=>{const p=feedbackInput.parse(req.body);const j=core.store.get<Job>('job',String(req.params.id))??fail(404,'job','Задание не найдено');if(j.state!=='succeeded'||j.operation!=='apply_marking')fail(400,'feedback','Отметка доступна после проверенного применения');res.json(editRecord(req,res,'job','feedback.updated',before=>({...before,feedback:{...p,author:res.locals.user.username,at:core.now()},feedbackVersion:editVersion('job',before)+1}),feedbackFacts));});
 app.post('/api/demo/devices/:id/scenario',(req,res)=>{const d=core.device(String(req.params.id));if(!d.demo)fail(400,'demo_only','Только DEMO');const scenario=z.enum(scenarios).parse(req.body.scenario),before=d.scenario;core.store.transaction(()=>{d.scenario=scenario;d.lastSeen=d.scenario==='offline'?0:core.now();core.store.put('device',d);record(res,'device.demo_scenario','device',d,{scenario:before},{scenario});});res.json({ok:true});});
 app.post('/api/demo/devices/:id/reboot',(req,res)=>{core.store.transaction(()=>{const d=core.reboot(String(req.params.id));record(res,'device.demo_reboot','device',d,{},{bootId:d.bootId});});res.json({ok:true});});
 app.post('/api/demo/jobs/:id/reconcile',(req,res)=>{const j=core.store.transaction(()=>{const result=core.reconcileDemo(String(req.params.id));record(res,'job.demo_reconciled','job',result,{state:'unknown'},{state:result.state,code:result.code});return result;});res.json(j);});
 app.get('/api/admin/audit',admin,(req,res)=>res.json(auditPage(core.store,req.query)));
 app.post('/api/admin/operations/backup',admin,(req,res)=>{
  z.object({}).strict().parse(req.body);
  if(!options.operations)fail(503,'operations_unavailable','Контроль сервера не настроен');
  if(options.operations!.status().backup.phase==='running')fail(409,'backup_busy','Копирование уже выполняется. Дождитесь результата.');
  core.store.transaction(()=>record(res,'backup.requested','server',{id:'database',name:'База сервера'},{},{manual:true}));
  if(!options.operations!.run())fail(409,'backup_busy','Копирование не запущено. Проверьте состояние сервера.');
  res.status(202).json({accepted:true});
 });
 app.get('/api/admin/games/:id',admin,(req,res)=>res.json(core.store.get('game',String(req.params.id))??fail(404,'game','Игра не найдена')));
 app.get('/api/admin/clubs/:id',admin,(req,res)=>{const c=core.store.get('club',String(req.params.id))??fail(404,'club','Клуб не найден');res.json({...c,version:editVersion('club',c)});});
 app.post('/api/admin/games',admin,(req,res)=>{const p=gameInput.parse(req.body);const g={id:randomUUID(),...p,revision:1};core.store.transaction(()=>{core.store.put('game',g);record(res,'game.created','game',g,{},gameFacts(g));});res.status(201).json(g);});
 app.put('/api/admin/games/:id',admin,(req,res)=>{const p=gameInput.parse(req.body);res.json(editRecord(req,res,'game','game.updated',g=>({...g,...p,revision:g.revision+1}),gameFacts));});
 app.post('/api/admin/clubs',admin,(req,res)=>{const p=clubInput.parse(req.body);const c={id:randomUUID(),...p,demo:false,version:1};core.store.transaction(()=>{core.store.put('club',c);record(res,'club.created','club',c,{},clubFacts(c));});res.status(201).json(c);});
 app.put('/api/admin/clubs/:id',admin,(req,res)=>{const p=clubInput.parse(req.body);res.json(editRecord(req,res,'club','club.updated',c=>({...c,...p}),clubFacts));});
 app.get('/api/admin/users',admin,(_req,res)=>res.json(core.store.all('user').map(publicUser)));
 app.post('/api/admin/users',admin,(req,res)=>{const p=accountInput.parse(req.body);if(core.store.all('user').some(u=>u.username===p.username))fail(409,'username','Логин занят');const u={id:randomUUID(),...p,password:password(p.password),disabled:false,version:1};core.store.transaction(()=>{core.store.put('user',u);record(res,'user.created','user',u,{},userFacts(u));});res.status(201).json(publicUser(u));});
 app.put('/api/admin/users/:id',admin,(req,res)=>{const p=z.object({role:z.enum(['admin','operator']),disabled:z.boolean(),password:accountPassword.optional()}).parse(req.body);const updated=editRecord(req,res,'user','user.updated',u=>{if(u.id===res.locals.user.id&&(p.disabled||p.role!=='admin'))fail(400,'self','Нельзя отключить или понизить самого себя');for(const session of core.store.all('session').filter(s=>s.userId===u.id))core.store.del('session',session.id);return {...u,...p,password:p.password?password(p.password):u.password};},userFacts,p.password?{passwordChanged:true}:{});res.json(publicUser(updated));});
 app.post('/api/admin/users/:id/password',admin,(req,res)=>{const p=z.object({password:accountPassword}).parse(req.body);const updated=editRecord(req,res,'user','user.password_reset',u=>{for(const session of core.store.all('session').filter(s=>s.userId===u.id))core.store.del('session',session.id);return {...u,password:password(p.password)};},userFacts,{passwordChanged:true});res.json(publicUser(updated));});
 app.post('/api/admin/enrollments',admin,(req,res)=>{if(!options.realAgents)fail(403,'real_disabled','Регистрация реальных ПК отключена. Для пилота нужен отдельный сервер.');const clubId=z.string().parse(req.body.clubId);const c=core.store.get('club',clubId)??fail(404,'club','Клуб не найден');if(c.demo)fail(400,'demo_only','Реальный агент нельзя зарегистрировать в DEMO-клуб');const raw=token();core.store.transaction(()=>{core.store.put('enrollment',{id:digest(raw),clubId,expires:core.now()+600000,used:false});record(res,'enrollment.created','club',c,{},{expires:core.now()+600000});});res.json({token:raw,expires:core.now()+600000});});
 app.post('/api/admin/devices/:id/rotate',admin,(req,res)=>{if(!options.realAgents)fail(403,'real_disabled','Настоящие агенты отключены');res.json(deviceAccess.requestRotation(core.device(String(req.params.id)),req.body,actor(res)));});
 app.post('/api/admin/devices/:id/recovery',admin,(req,res)=>{if(!options.realAgents)fail(403,'real_disabled','Настоящие агенты отключены');res.json({...deviceAccess.issueRecovery(core.device(String(req.params.id)),req.body,actor(res)),serverOrigin:req.protocol+'://'+req.get('host')});});
 app.post('/api/admin/devices/:id/revoke',admin,(req,res)=>{const d=core.device(String(req.params.id));if(d.revoked&&!d.recoveryPending)return res.json({ok:true});const before={revoked:!!d.revoked,...(d.recoveryPending?{recoveryPending:true}:{})};d.revoked=true;d.recoveryPending=false;d.rotationRequested=false;d.accessVersion=accessVersion(d)+1;delete d.tokenHash;core.store.transaction(()=>{deviceAccess.cancelRecovery(d.id);core.store.put('device',d);for(const j of core.queue.active(d.id,['queued','running'])){j.state=j.state==='queued'?'expired':'unknown';j.code='revoked';j.message='Доступ устройства отозван';core.store.put('job',j);}record(res,'device.revoked','device',d,before,{revoked:true,...(before.recoveryPending?{recoveryPending:false}:{})});});res.json({ok:true});});
 if(options.dist)app.use(express.static(options.dist,{index:'index.html'}));
 app.use((error:any,_req:Request,res:Response,_next:NextFunction)=>{
 if(error instanceof StorageUnavailable||isStorageError(error)){core.store.halted=true;res.status(503).json({code:'storage_unavailable',message:new StorageUnavailable().message});return;}
 const status=error instanceof Fault?error.status:error instanceof ZodError?400:[400,413].includes(error.status)?error.status:500;
 const code=error instanceof Fault?error.code:error instanceof ZodError?'validation':status===413?'body_too_large':status===400?'invalid_json':'internal';
 const message=error instanceof Fault?error.message:error instanceof ZodError?error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; '):status===413?'Размер запроса превышает допустимый предел':status===400?'Некорректный JSON запроса':'Внутренняя ошибка сервера';
 res.status(status).json({code,message});
 });return app;
}
