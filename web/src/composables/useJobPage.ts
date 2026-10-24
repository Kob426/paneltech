import {onUnmounted,ref,watch} from 'vue';
import type {Job} from '../../../shared/contracts';
export type JobFilters={deviceId:string;gameId:string;author:string;state:string;from:string;to:string;batchId:string};
export const emptyJobFilters=():JobFilters=>({deviceId:'',gameId:'',author:'',state:'',from:'',to:'',batchId:''});
export type JobPage={items:Job[];total:number;page:number;pageSize:number;pages:number;snapshot:number;authors:string[];batches:{id:string;created:number;total:number}[];batch:null|{id:string;first:Job;counts:{total:number;succeeded:number;failed:number;expired:number;unknown:number;pending:number};members:{id:string;deviceId:string;deviceName:string}[]}};
type Api=(path:string)=>Promise<any>;
export function useJobPage(api:Api,club:()=>string,filters:JobFilters,revision:()=>number|null,focus:()=>string=()=>'',order='recent'){
 const authors=ref<string[]>([]),batches=ref<JobPage['batches']>([]);
 const result=ref<JobPage|null>(null),loading=ref(false),error=ref(''),page=ref(1),pageSize=ref(25),snapshot=ref<number|undefined>();
 let previousClub=club();
 let generation=0,disposed=false,pendingKey='',pending:Promise<void>|null=null;
 const identity=()=>JSON.stringify([club(),filters,pageSize.value]);
 function query(focusId=''){
  const q=new URLSearchParams({clubId:club(),page:String(page.value),pageSize:String(pageSize.value),order});
  for(const key of ['deviceId','gameId','author','state','batchId'] as const)if(filters[key])q.set(key,filters[key]);
  const from=filters.from?new Date(filters.from).getTime():undefined,to=filters.to?new Date(filters.to).getTime():undefined;
  if((from!==undefined&&!Number.isFinite(from))||(to!==undefined&&!Number.isFinite(to)))throw Error('Укажите корректные дату и время.');
  if(from!==undefined&&to!==undefined&&from>to)throw Error('Начало периода должно быть не позже конца.');
  if(from!==undefined)q.set('from',String(from));if(to!==undefined)q.set('to',String(to));
  if(snapshot.value!==undefined)q.set('snapshot',String(snapshot.value));
  if(focusId)q.set('focusId',focusId);
  return q.toString();
 }
 function load(focusId=''):Promise<void>{
  if(disposed)return Promise.resolve();
  let key:string;try{key=query(focusId);}catch(e){generation++;result.value=null;error.value=(e as Error).message;loading.value=false;return Promise.resolve();}
  if(pending&&pendingKey===key)return pending;
  const ticket=++generation;pendingKey=key;loading.value=true;error.value='';
  pending=(async()=>{try{const data=await api('/history?'+key);if(!disposed&&ticket===generation){result.value=data;authors.value=data.authors;batches.value=data.batches;snapshot.value=data.snapshot;page.value=data.page;}}
   catch(e){if(!disposed&&ticket===generation)error.value=(e as Error).message;}
   finally{if(!disposed&&ticket===generation){loading.value=false;pending=null;}}
  })();return pending;
 }
 function reset(focusId=''){if(previousClub!==club()){previousClub=club();authors.value=[];batches.value=[];}generation++;pending=null;snapshot.value=undefined;page.value=1;result.value=null;void load(focusId);}
 function go(n:number){page.value=n;generation++;pending=null;result.value=null;void load();}
 function renew(){reset();}
 watch([identity,focus],(now,before)=>reset(now[1]!==before?.[1]?focus():''),{immediate:true});
 watch(revision,()=>{if(!loading.value)void load();});
 onUnmounted(()=>{disposed=true;generation++;});
 return {result,authors,batches,loading,error,page,pageSize,load,go,renew};
}
