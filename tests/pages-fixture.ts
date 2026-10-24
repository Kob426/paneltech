// Add fictional historical operations to the workspace fixture, never to a user DB.
import {Core} from '../server/core';
import {Store} from '../server/store';
if(!process.env.DB_PATH)throw Error('Temporary fixture DB_PATH required');
const s=new Store(process.env.DB_PATH),c=new Core(s);
const base=c.create({deviceIds:['aurora-fixture-1'],gameId:'fortnite',operation:'health'},'admin')[0];s.del('job',base.id);
const devices=s.all('device').filter(d=>d.clubId==='aurora');
for(let i=0;i<120;i++){
 const d=devices[i%devices.length];
 s.put('job',{...base,id:`page-job-${i}`,batchId:'pagination-batch',deviceId:d.id,deviceName:d.name,created:Date.now()+5000-i,
  operation:'apply_marking',state:i%2?'succeeded':'failed',variant:36,variantName:'Вариант 36',author:i===119?'retired':i%3?'operator':'admin',message:`DEMO: историческая операция ${i}`,finished:Date.now()});
}
s.close();
