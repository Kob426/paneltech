import {createInterface} from 'node:readline/promises';
import {Store} from '../server/store.js';
import {initializeLocalOwner} from '../server/local-owner.js';

async function readSecret(prompt:string):Promise<string>{
 const previous=process.stdin.isRaw;process.stdin.setRawMode(true);process.stdin.resume();process.stdin.setEncoding('utf8');process.stdout.write(prompt);
 return new Promise((resolve,reject)=>{
  let value='';
  const finish=(error?:Error)=>{process.stdin.off('data',data);process.stdin.setRawMode(previous);process.stdin.pause();process.stdout.write('\n');if(error)reject(error);else resolve(value);value='';};
  const data=(chunk:string)=>{for(const char of chunk){if(char==='\u0003'){finish(new Error('Настройка отменена.'));return;}if(char==='\r'||char==='\n'){finish();return;}if(char==='\u007f'||char==='\b')value=value.slice(0,-1);else if(char.charCodeAt(0)>=32)value+=char;}};
  process.stdin.on('data',data);
 });
}
try{
 if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error('Нужен интерактивный терминал. Пароль не принимается через аргументы/pipe.');
 if(process.env.ENABLE_REAL_AGENTS==='1')throw new Error('Этот мастер только для локальной симуляции без реальных агентов.');
 const rl=createInterface({input:process.stdin,output:process.stdout});
 const username=(await rl.question('Логин владельца (латиница, 3–50 символов): ')).trim();rl.close();
 const secret=await readSecret('Пароль (12–200 символов, ввод скрыт): ');
 const confirmation=await readSecret('Повторите пароль (ввод скрыт): ');
 if(secret!==confirmation)throw new Error('Пароли не совпали. База не изменена.');
 const store=new Store(process.env.DB_PATH??'.data/local.sqlite');
 try{initializeLocalOwner(store,username,secret);}finally{store.close();}
 console.log('Администратор создан. Запустите npm run local, откройте http://127.0.0.1:3000 и войдите своим логином. Управление → Сотрудники. Реальные ПК отключены.');
}catch(e){console.error((e as Error).message);process.exitCode=1;}
