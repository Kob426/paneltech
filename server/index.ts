import { resolve } from 'node:path';
import {Store} from './store.js';
import {Core,password} from './core.js';
import {createApp} from './app.js';
import {backupConfig} from './automatic-backup.js';
import {Operations} from './operations.js';
const real=process.env.ENABLE_REAL_AGENTS==='1',personal=process.argv.includes('--local');
if(real&&personal)throw Error('Личный локальный режим не разрешает реальных агентов');
const source=process.env.DB_PATH??(personal?'.data/local.sqlite':real?'.data/pilot.sqlite':'.data/demo.sqlite');
const backupOptions=backupConfig(source);
const store=new Store(source);const core=new Core(store);
if(store.get('meta','restoration')?.sourceMode==='pilot'&&!real)throw Error('Восстановлена пилотная база: запуск в DEMO запрещён. Настройка пилота требует отдельной проверки.');
if(personal){if(!store.get('meta','demo')?.personalAccounts||!store.all('user').some(u=>u.role==='admin'&&!u.disabled))throw Error('Сначала выполните npm run setup:owner для отдельной пустой локальной базы');}
else if(store.get('meta','demo')?.personalAccounts)throw Error('Эта база использует личные аккаунты. Запустите npm run local');
else if(real){if(store.all('club').some(c=>c.demo))throw Error('Нельзя использовать DEMO-базу для пилота');if(!store.all('user').length){const username=process.env.ADMIN_USERNAME;const pw=process.env.ADMIN_PASSWORD;if(!username||!pw||pw.length<12)throw Error('Для пустой pilot-базы задайте ADMIN_USERNAME и ADMIN_PASSWORD (>=12 символов)');store.put('user',{id:'pilot-admin',username,password:password(pw),role:'admin',disabled:false});}}else core.seed();
const host=process.env.HOST??'127.0.0.1';if(!['127.0.0.1','::1','localhost'].includes(host))throw Error('Прототип слушает только loopback. Для TLS-пилота используйте локальный reverse proxy.');
const operations=new Operations(backupOptions,()=>store.halted);
const app=createApp(core,{operations,realAgents:process.env.ENABLE_REAL_AGENTS==='1',personalAccounts:personal,secureCookies:process.env.SECURE_COOKIES==='1',dist:resolve('dist')});
const server=app.listen(Number(process.env.PORT??3000),host,()=>{operations.start();console.log('PanelTech '+(real?'PILOT':'DEMO')+': loopback port '+(process.env.PORT??3000)+'; реальные агенты '+(process.env.ENABLE_REAL_AGENTS==='1'?'включены явно':'отключены'));});
const timer=setInterval(()=>{if(store.halted)return;try{core.tick();}catch{store.halted=true;console.error('storage_paused: операции остановлены; проверьте хранилище, сохраните базу и перезапустите сервер. Данные ошибки не выводятся.');}},1000);let closing=false;
function shutdown(){if(closing)return;closing=true;clearInterval(timer);const drained=operations.stop();server.close(async()=>{await drained;store.close();process.exit(0);});}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
