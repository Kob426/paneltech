import type {Device, Job} from '../../shared/contracts';

export type VisibleDevice = Device & {online:boolean;fresh:boolean};
export const statusNames:Record<string,string> = {queued:'В очереди',running:'Выполняется',succeeded:'Выполнено',failed:'Ошибка',expired:'Истекло',unknown:'Неизвестно'};
export const operations:Record<string,string> = {apply_marking:'Применить',remove_marking:'Удалить',inspect_rules:'Инспекция',health:'Проверка агента'};
export const reasons:Record<string,string> = {launch:'Запуск / авторизация',server:'Подключение к серверу',ping:'Пинг',voice:'Голосовой чат',other:'Другое'};
export const scenarioNames:Record<string,string> = {success:'Успех',offline:'Офлайн',rights:'Нет прав',partial:'Частичный сбой + откат',rollback_failed:'Сбой отката / остаточные правила',lost:'Потеря ответа',conflict:'Чужие правила'};
export const fmt=(n:number|null|undefined)=>n?new Date(n).toLocaleString('ru-RU'):'Нет данных';
export const unresolved=(j:Pick<Job,'state'>)=>['queued','running','unknown'].includes(j.state);
const collator = new Intl.Collator('ru',{numeric:true,sensitivity:'base'});
export function filterDevices(devices:VisibleDevice[],jobs:Job[],query:string,filter:string){
 const q=query.trim().toLocaleLowerCase('ru');
 const busy=new Set(jobs.filter(unresolved).map(j=>j.deviceId));
 const uncertain=new Set(jobs.filter(j=>j.state==='unknown').map(j=>j.deviceId));
 return devices.filter(d=>(!q||d.name.toLocaleLowerCase('ru').includes(q)||d.id.toLowerCase().includes(q))&&
  (filter==='all'||filter==='online'&&d.online||filter==='offline'&&!d.online||filter==='busy'&&busy.has(d.id)||filter==='unknown'&&uncertain.has(d.id)))
 .sort((a,b)=>{
  const exact=(d:VisibleDevice)=>Number(!!q&&(d.name.toLocaleLowerCase('ru')===q||d.id.toLowerCase()===q));
  return exact(b)-exact(a)||collator.compare(a.name,b.name)||a.id.localeCompare(b.id);
 });
}
export function recentAndUnresolved(jobs:Job[],limit=60){
 const recent=new Set(jobs.slice(0,limit).map(j=>j.id));
 return jobs.filter(j=>recent.has(j.id)||unresolved(j));
}
export function batchCounts(jobs:Job[]){
 return {total:jobs.length,succeeded:jobs.filter(j=>j.state==='succeeded').length,failed:jobs.filter(j=>j.state==='failed').length,
 expired:jobs.filter(j=>j.state==='expired').length,unknown:jobs.filter(j=>j.state==='unknown').length,
 pending:jobs.filter(j=>j.state==='queued'||j.state==='running').length};
}
