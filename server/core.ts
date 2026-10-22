import {randomUUID,createHash,randomBytes,scryptSync,timingSafeEqual} from 'node:crypto';
import { Store } from './store.js';
import { jobInput, ruleName, type Job, type Device, type Rule } from '../shared/contracts.js';
export const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
export function password(s:string){const salt=randomBytes(16).toString('hex');return salt+':'+scryptSync(s,salt,64).toString('hex');}
export function checkPassword(s:string,h:string){const [salt,key]=h.split(':');return timingSafeEqual(scryptSync(s,salt,64),Buffer.from(key,'hex'));}
export class Fault extends Error {constructor(public status:number,public code:string,message:string){super(message);}}
export const fail=(status:number,code:string,message:string):never=>{throw new Fault(status,code,message);};
export class Core {
 constructor(public store:Store,public now=()=>Date.now()){}
 seed(){if(this.store.get('meta','demo'))return;this.store.transaction(()=>{
 this.store.put('user',{id:'admin',username:'admin',password:password('DemoAdmin-2026!'),role:'admin',disabled:false});
 this.store.put('user',{id:'operator',username:'operator',password:password('DemoOperator-2026!'),role:'operator',disabled:false});
 this.store.put('club',{id:'aurora',name:'Аврора · DEMO',variants:[{id:36,name:'Вариант 36'},{id:40,name:'Вариант 40'}],demo:true});
 this.store.put('club',{id:'orbit',name:'Орбита · DEMO',variants:[{id:39,name:'Вариант 39'},{id:41,name:'Вариант 41'}],demo:true});
 this.store.put('game',{id:'fortnite',name:'Epic Games + Fortnite',revision:1,exes:['EpicGamesLauncher.exe','EpicWebHelper.exe','FortniteClient-Win64-Shipping.exe','FortniteClient-Win64-Shipping_EAC_EOS.exe','FortniteClient-Win64-Shipping_BE.exe']});
 this.store.put('game',{id:'pubg',name:'PUBG — заполните exe',revision:1,exes:[]});
 for(const clubId of ['aurora','orbit'])for(const [i,scenario] of ['success','offline','rights','partial','lost','conflict'].entries()){
 const id=`${clubId}-${i+1}`;this.store.put('device',{id,name:`ПК-${String(i+1).padStart(2,'0')}`,clubId,demo:true,bootId:randomUUID(),lastSeen:scenario==='offline'?0:this.now(),scenario,rules:scenario==='conflict'?[{name:'Legacy-Fortnite',gameId:'foreign',exe:'EpicWebHelper.exe',dscp:10,owned:false}]:[],inspectedAt:null});}
 this.store.put('meta',{id:'demo',version:1});});}
 device(id:string):Device{return this.store.get<Device>('device',id)??fail(404,'not_found','ПК не найден');}
 online(d:Device){return !d.revoked && this.now()-d.lastSeen<15000;}
 create(input:unknown,author:string){const p=jobInput.parse(input);const g=this.store.get('game',p.gameId)??fail(404,'game','Игра не найдена');
 if(['apply_marking','remove_marking'].includes(p.operation)&&!g.exes.length)fail(400,'empty_exes','Заполните список exe игры');
 const devices=p.deviceIds.map(id=>this.device(id));
 for(const d of devices){const c=this.store.get('club',d.clubId);if(p.operation==='apply_marking'&&!c.variants.some((v:any)=>v.id===p.variant))fail(400,'variant','Вариант недоступен в клубе');}
 const batchId=randomUUID();return this.store.transaction(()=>devices.map(d=>{
 const club=this.store.get('club',d.clubId);const t=this.now();
 const j:Job={id:randomUUID(),batchId,deviceId:d.id,deviceName:d.name,clubId:club.id,clubName:club.name,gameId:g.id,gameName:g.name,revision:g.revision,exes:[...g.exes],operation:p.operation,variant:p.variant,variantName:club.variants.find((v:any)=>v.id===p.variant)?.name,allowedVariants:club.variants.map((v:any)=>v.id),author,created:t,expires:t+30000,bootId:d.bootId,state:'queued',demo:d.demo,attempts:0};
 if(!this.online(d)){j.state='failed';j.code='offline';j.message='ПК недоступен. Команда пропущена, не отложена.';j.finished=t;}
 else if(this.store.all<Job>('job').some(x=>x.deviceId===d.id&&['queued','running','unknown'].includes(x.state))){j.state='failed';j.code='busy';j.message='На ПК есть незавершённая операция; сначала выполните сверку.';j.finished=t;}
 this.store.put('job',j);return j;}));}
 poll(d:Device):Job|null{this.expire();if(this.store.all<Job>('job').some(j=>j.deviceId===d.id&&['running','unknown'].includes(j.state)))return null;
 const j=this.store.all<Job>('job').find(j=>j.deviceId===d.id&&j.state==='queued');if(!j)return null;
 if(j.bootId!==d.bootId){j.state='expired';j.code='boot_changed';j.message='Загрузочная сессия изменилась';j.finished=this.now();this.store.put('job',j);return null;}
 j.state='running';j.started=this.now();j.attempts++;this.store.put('job',j);return j;}
 expire(){for(const j of this.store.all<Job>('job')){if(j.state==='queued'&&j.expires<=this.now()){j.state='expired';j.code='expired';j.message='Истёк срок команды';j.finished=this.now();this.store.put('job',j);}else if(j.state==='running'&&j.expires<=this.now()){j.state='unknown';j.code='connection_lost';j.message='Результат неизвестен. Нужна инспекция фактических правил.';this.store.put('job',j);}}}
 conflict(d:Device,j:Job){if(j.operation!=='apply_marking')return false;return d.rules.some(r=>j.exes.some(e=>(r.exe==='*'||e.toLowerCase()===r.exe.split(/[\\/]/).pop()?.toLowerCase()))&&(!r.owned||(r.gameId!==j.gameId&&r.dscp!==j.variant)));}
 expected(j:Job,rules:Rule[]){const own=rules.filter(r=>r.owned&&r.gameId===j.gameId);if(j.operation==='remove_marking')return own.length===0;if(j.operation!=='apply_marking')return true;
 return own.length===j.exes.length&&j.exes.every(e=>own.some(r=>r.exe.toLowerCase()===e.toLowerCase()&&r.dscp===j.variant&&r.name===ruleName(j.gameId,e)));}
 executeDemo(delivered:Job){const j=this.store.get<Job>('job',delivered.id);if(!j||j.state!=='running')return;const d=this.device(j.deviceId);
 const done=(state:Job['state'],code:string,message:string,rollback?:string)=>{j.state=state;j.code=code;j.message=message;j.rollback=rollback;j.rules=structuredClone(d.rules);j.finished=this.now();d.inspectedAt=this.now();this.store.put('device',d);this.store.put('job',j);};
 if(d.bootId!==j.bootId||this.now()>=j.expires)return done('expired','expired','Задание просрочено или изменена загрузочная сессия');
 if(j.operation==='apply_marking'&&(!j.allowedVariants.includes(j.variant!)||!this.store.get('club',d.clubId).variants.some((v:any)=>v.id===j.variant)))return done('failed','variant','Вариант не разрешён устройству');
 if(d.scenario==='rights')return done('failed','permissions','DEMO: недостаточно прав администратора');
 if(this.conflict(d,j))return done('failed','conflict','Конфликт со сторонними правилами или общими exe другой игры');
 if(['inspect_rules','health'].includes(j.operation))return done('succeeded','inspected','DEMO: состояние симулятора прочитано');
 const previous=structuredClone(d.rules);
 d.rules=d.rules.filter(r=>!(r.owned&&r.gameId===j.gameId));
 if(j.operation==='apply_marking')for(const e of j.exes)d.rules.push({name:ruleName(j.gameId,e),gameId:j.gameId,exe:e,dscp:j.variant!,owned:true});
 if(d.scenario==='partial'){d.rules=previous;return done('failed','partial_failure','DEMO: частичный сбой. Предыдущие собственные правила восстановлены.','succeeded; остаточных изменений нет');}
 if(d.scenario==='lost'){this.store.put('device',d);j.state='unknown';j.code='connection_lost';j.message='DEMO: ответ потерян после изменения. Результат неизвестен до сверки.';this.store.put('job',j);return;}
 if(!this.expected(j,d.rules))return done('failed','verification','Фактический набор не совпал');
 done('succeeded','verified',j.operation==='apply_marking'?'DEMO: правила симулятора применены. При необходимости перезапустите игру.':'DEMO: собственные правила выбранной игры удалены.');}
 tick(){this.expire();for(const d of this.store.all<Device>('device').filter(d=>d.demo&&!d.revoked)){
 if(d.scenario==='offline')continue;d.lastSeen=this.now();this.store.put('device',d);
 const j=this.poll(d);if(j)this.executeDemo(j);
 }}
 reboot(id:string){const d=this.device(id);if(!d.demo)fail(400,'demo_only','Перезагрузка разрешена только для симулятора');d.bootId=randomUUID();d.rules=d.rules.filter(r=>!r.owned);d.inspectedAt=null;d.lastSeen=this.now();this.store.put('device',d);
 for(const j of this.store.all<Job>('job').filter(j=>j.deviceId===id&&['queued','running','unknown'].includes(j.state))){j.state=j.state==='queued'?'expired':'unknown';j.code='boot_changed';j.message='Сессия изменилась; старую команду не выполнять. Исторический результат не подтверждает текущее состояние.';this.store.put('job',j);}return d;}
 reconcileDemo(id:string){const j=this.store.get<Job>('job',id)??fail(404,'job','Задание не найдено');const d=this.device(j.deviceId);if(!d.demo||j.state!=='unknown')fail(400,'state','Сверка DEMO доступна для unknown');d.inspectedAt=this.now();this.store.put('device',d);j.reconciled=this.now();j.rules=structuredClone(d.rules);j.state=j.bootId===d.bootId&&this.expected(j,d.rules)?'succeeded':'failed';j.code='reconciled';j.message=`DEMO: выполнена отдельная инспекция. ${j.state==='succeeded'?'Набор симулятора совпал.':'Ожидаемый набор отсутствует или сессия изменилась.'}`;j.finished=this.now();this.store.put('job',j);return j;}
}
