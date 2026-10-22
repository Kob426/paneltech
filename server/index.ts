import { resolve } from 'node:path';
import {Store} from './store.js';
import {Core,password} from './core.js';
import {createApp} from './app.js';
const real=process.env.ENABLE_REAL_AGENTS==='1';
const store=new Store(process.env.DB_PATH??(real?'.data/pilot.sqlite':'.data/demo.sqlite'));const core=new Core(store);
if(real){if(store.all('club').some(c=>c.demo))throw Error('Нельзя использовать DEMO-базу для пилота');if(!store.all('user').length){const username=process.env.ADMIN_USERNAME;const pw=process.env.ADMIN_PASSWORD;if(!username||!pw||pw.length<12)throw Error('Для пустой pilot-базы задайте ADMIN_USERNAME и ADMIN_PASSWORD (>=12 символов)');store.put('user',{id:'pilot-admin',username,password:password(pw),role:'admin',disabled:false});}}else core.seed();
const host=process.env.HOST??'127.0.0.1';if(!['127.0.0.1','::1','localhost'].includes(host))throw Error('Прототип слушает только loopback. Для TLS-пилота используйте локальный reverse proxy.');
const app=createApp(core,{realAgents:process.env.ENABLE_REAL_AGENTS==='1',secureCookies:process.env.SECURE_COOKIES==='1',dist:resolve('dist')});
const server=app.listen(Number(process.env.PORT??3000),host,()=>console.log('PanelTech '+(real?'PILOT':'DEMO')+': loopback port '+(process.env.PORT??3000)+'; реальные агенты '+(process.env.ENABLE_REAL_AGENTS==='1'?'включены явно':'отключены')));
const timer=setInterval(()=>core.tick(),1000);let closing=false;
function shutdown(){if(closing)return;closing=true;clearInterval(timer);server.close(()=>{store.close();process.exit(0);});}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
