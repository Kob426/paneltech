// Fictional browser fixtures only. Invoked with a temporary DB_PATH by browser_workspace.py.
import {randomUUID} from 'node:crypto';
import {Core} from '../server/core';
import {Store} from '../server/store';
if(!process.env.DB_PATH)throw Error('Temporary fixture DB_PATH required');
const store=new Store(process.env.DB_PATH),core=new Core(store);core.seed();
for(const d of store.all('device'))store.del('device',d.id);
for(const [clubId,count] of [['aurora',65],['orbit',20]] as const){
 for(let i=0;i<count;i++){
  const name=['1','2','10','63','pubg1-pc1','PUBG1-PC10','ПК с очень длинным именем '+ 'Д'.repeat(60)][i]??`room-pc${i+1}`;
  store.put('device',{id:`${clubId}-fixture-${i+1}`,name,clubId,demo:true,bootId:randomUUID(),lastSeen:i===7?0:Date.now(),scenario:i===7?'offline':'success',rules:[],inspectedAt:null});
 }
}
const old=core.create({deviceIds:['aurora-fixture-65'],gameId:'fortnite',operation:'apply_marking',variant:36},'operator')[0];
old.created-=3600000;old.state='unknown';old.message='DEMO: старый неизвестный результат; нужна сверка.';store.put('job',old);
for(let i=0;i<80;i++)store.put('job',{...old,id:randomUUID(),batchId:randomUUID(),created:Date.now()+i,deviceId:'aurora-fixture-64',deviceName:'room-pc64',state:'succeeded',operation:'health',message:'DEMO: архивная проверка',finished:Date.now()});
store.close();
