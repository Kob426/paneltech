<script setup lang="ts">
import {ref,reactive,computed,onMounted,onUnmounted,watch,nextTick} from 'vue';
import ConfirmDialog from './components/ConfirmDialog.vue';
import GameCatalog from './components/GameCatalog.vue';
import AdminManagement from './components/AdminManagement.vue';
import ServerOperations from './components/ServerOperations.vue';
import type {AdminServices} from './composables/useAdminActions';
import DeviceWorkspace from './components/DeviceWorkspace.vue';
import JobResults from './components/JobResults.vue';
import JobBrowser from './components/JobBrowser.vue';
import AuditPanel from './components/AuditPanel.vue';
import HistoryPanel from './components/HistoryPanel.vue';
import {emptyJobFilters} from './composables/useJobPage';
import {fmt,operations,unresolved} from './workspace';
import { useApiClient, ApiError } from './composables/useApiClient';
const user=ref<any>(null),csrf=ref(''),error=ref(''),notice=ref(''),busy=ref(false),loading=ref(true);
const {api,connection,connectionLabel,lastResponse}=useApiClient(csrf,()=>{user.value=null;confirm.value=null;});
const username=ref(''),password=ref('');
const data=ref<any>({clubs:[],devices:[],games:[],jobs:[]});
const clubId=ref('aurora'),search=ref(''),tab=ref('devices'),selected=ref<string[]>([]),gameId=ref('fortnite'),variant=ref<number>(36);
const focusedPcId=ref('');
const taskFilters=reactive(emptyJobFilters()),historyFilters=reactive(emptyJobFilters()),historyFocus=ref('');
const focusJobId=ref(''),lastBatch=ref('');
const pending=ref<{operation:string;ids:string[];gameId:string;variant:number}|null>(null);
const confirm=ref<string|null>(null),feedback=ref<Record<string,any>>({});

const club=computed(()=>data.value.clubs.find((c:any)=>c.id===clubId.value));
const game=computed(()=>data.value.games.find((g:any)=>g.id===gameId.value));
const devices=computed(()=>data.value.devices.filter((d:any)=>d.clubId===clubId.value));
const clubs=computed(()=>data.value.clubs.filter((c:any)=>c.name.toLowerCase().includes(search.value.toLowerCase())));
const jobs=computed(()=>data.value.jobs.filter((j:any)=>j.clubId===clubId.value));
const activeCount=computed(()=>jobs.value.filter(unresolved).length);
const variants=computed(()=>club.value?.variants??[]);
const chosen=computed(()=>devices.value.filter((d:any)=>(pending.value?.ids??selected.value).includes(d.id)));
const pendingGame=computed(()=>data.value.games.find((g:any)=>g.id===pending.value?.gameId));
let actions=0;
async function act(fn:()=>Promise<void>){error.value='';notice.value='';lastBatch.value='';actions++;busy.value=true;try{await fn();}catch(e){error.value=(e as Error).message;}finally{actions--;busy.value=actions>0;}}
async function login(){await act(async()=>{const r=await api('/login','POST',{username:username.value,password:password.value});user.value=r.user;csrf.value=r.csrf;password.value='';await refresh();});}
const lastSync=ref<number|null>(null);
let refreshing=false;
function stateQuery(){const q=new URLSearchParams();if(clubId.value)q.set('clubId',clubId.value);if(gameId.value)q.set('gameId',gameId.value);return q.toString();}
async function refresh(){
 if(!user.value||refreshing)return;refreshing=true;
 const query=stateQuery();
 try{const result=await api('/state?'+query);if(query!==stateQuery())return;data.value=result;if(!data.value.games.some((g:any)=>g.id===gameId.value))gameId.value=data.value.games[0]?.id??'';if(!data.value.clubs.some((c:any)=>c.id===clubId.value))clubId.value=data.value.clubs[0]?.id??'';lastSync.value=Date.now();}
 finally{refreshing=false;if(user.value&&query!==stateQuery())void refresh().catch(e=>error.value=e.message);}
}
function openJob(j:any){Object.assign(taskFilters,emptyJobFilters(),{batchId:j.batchId});focusJobId.value=j.id;tab.value='tasks';}
function openLastTask(){Object.assign(taskFilters,emptyJobFilters(),{batchId:lastBatch.value});focusJobId.value='';tab.value='tasks';}
function pcHistory(id:string){Object.assign(historyFilters,emptyJobFilters(),{deviceId:id,gameId:gameId.value});historyFocus.value='';tab.value='history';}
function jobHistory(j:any){Object.assign(historyFilters,emptyJobFilters(),{deviceId:j.deviceId,gameId:j.gameId});historyFocus.value=j.id;tab.value='history';}
function requestOperation(op:string,ids:string[]=selected.value){
 if(connection.value!=='online'){error.value='Нет подтверждённой связи с API. Дождитесь восстановления.';return;}
 if(!ids.length)return;
 pending.value={operation:op,ids:[...ids],gameId:gameId.value,variant:variant.value};
 if(ids.length>1&&['apply_marking','remove_marking'].includes(op))confirm.value=op;else void run();
}
async function run(){
 const command=pending.value;if(!command)return;
 const opener=document.activeElement instanceof HTMLElement?document.activeElement:null;
 confirm.value=null;
 await act(async()=>{
  const created=await api('/jobs','POST',{deviceIds:command.ids,gameId:command.gameId,variant:command.operation==='apply_marking'?command.variant:undefined,operation:command.operation});
  lastBatch.value=created[0]?.batchId??'';
  data.value.jobs=[...created,...data.value.jobs.filter((j:any)=>!created.some((c:any)=>c.id===j.id))];
  notice.value=`Задание ${lastBatch.value.slice(0,8)} создано для ${created.length} ПК. Итог каждой операции показан отдельно.`;
  await refresh();
 });
 pending.value=null;
 await nextTick();
 if(opener?.isConnected&&(document.activeElement===document.body||document.activeElement===opener)){if(opener.matches(':disabled'))document.querySelector<HTMLButtonElement>('.notice-link')?.focus();else opener.focus();}
}
async function reboot(d:any){await act(async()=>{await api(`/demo/devices/${d.id}/reboot`,'POST',{});notice.value='DEMO: новая загрузочная сессия. Временные правила исчезли; история сохранена. Автовосстановления нет.';await refresh();});}
async function scenario(d:any,event:Event){await act(async()=>{await api(`/demo/devices/${d.id}/scenario`,'POST',{scenario:(event.target as HTMLSelectElement).value});await refresh();});}
async function reconcile(j:any){await act(async()=>{await api(`/demo/jobs/${j.id}/reconcile`,'POST',{});await refresh();});}
function draft(j:any){return feedback.value[j.id]??(feedback.value[j.id]={outcome:j.feedback?.outcome??'unchecked',reason:j.feedback?.reason??'launch',comment:j.feedback?.comment??'',expectedVersion:j.feedbackVersion??0});}
async function saveFeedback(j:any){await act(async()=>{const d=draft(j);d._error='';try{const saved=await api(`/jobs/${j.id}/feedback`,'POST',d);delete feedback.value[j.id];draft(saved);notice.value='Отметка сохранена для всех сотрудников.';await refresh();}catch(e){if(e instanceof ApiError&&e.code==='edit_conflict'){d._error=e.message+' Ваш черновик сохранён.';d._conflict=true;}else throw e;}});}
async function reloadFeedback(j:any){await act(async()=>{const latest=await api(`/jobs/${j.id}/feedback`);delete feedback.value[j.id];draft({...j,...latest});notice.value='Загружена актуальная отметка. Проверьте её перед изменением.';await refresh();});}
const adminServices:AdminServices={
 api,act,refresh,selectedClubId:()=>clubId.value,
 isAuthenticated:()=>!!user.value,
 notify:message=>{notice.value=message;},
 reportError:message=>{error.value=message;},
};
watch(user,(current,previous)=>{if(!current||current.id!==previous?.id){tab.value='devices';selected.value=[];focusedPcId.value='';pending.value=null;Object.assign(taskFilters,emptyJobFilters());Object.assign(historyFilters,emptyJobFilters());historyFocus.value='';lastBatch.value='';focusJobId.value='';feedback.value={};}});
watch(clubId,()=>{selected.value=[];focusedPcId.value='';pending.value=null;confirm.value=null;Object.assign(taskFilters,emptyJobFilters());Object.assign(historyFilters,emptyJobFilters());historyFocus.value='';lastBatch.value='';focusJobId.value='';variant.value=variants.value[0]?.id;});
watch([clubId,gameId],()=>{if(user.value)void refresh().catch(e=>error.value=e.message);});
function applyHealth(h:any){const personal=!!h.personalAccounts,changed=data.value.mode!==h.mode||data.value.personalAccounts!==personal;data.value.mode=h.mode;data.value.personalAccounts=personal;if(changed){username.value=h.mode==='DEMO'&&!personal?'admin':'';password.value=h.mode==='DEMO'&&!personal?'DemoAdmin-2026!':'';}}
let timer:ReturnType<typeof setInterval>;
onMounted(async()=>{try{const h=await api('/health');applyHealth(h);const r=await api('/me');user.value=r.user;csrf.value=r.csrf;await refresh();}catch(e){if(!(e instanceof ApiError&&e.status===401))error.value=(e as Error).message;}loading.value=false;timer=setInterval(()=>{if(busy.value)return;if(user.value)void refresh().catch(e=>error.value=e.message);else void api('/health').then(applyHealth).catch(()=>{});},1500);});
onUnmounted(()=>clearInterval(timer));
</script>

<template>
<div v-if="loading" class="loading">Загрузка панели…</div>
<div v-else-if="!user" class="login-wrap">
 <form class="login-card" @submit.prevent="login"><div class="brand-mark">P<span>·</span>T</div><p class="eyebrow">PANELTECH / SUPPORT TOOLS</p><h1>Маркировка игр</h1><p class="muted">Рабочее место поддержки компьютерных клубов</p><div class="demo-note"><b>{{data.mode==='PILOT'?'ОТДЕЛЬНЫЙ ПИЛОТНЫЙ СТЕНД':'ДОМАШНЯЯ ДЕМОНСТРАЦИЯ'}}</b><br>{{data.mode==='PILOT'?'Реальные операции разрешаются только локальной настройкой агента.':'Вымышленные ПК. Изменения QoS не выполняются.'}}</div><p v-if="data.personalAccounts" class="fine">Личные учётные записи: войдите логином, созданным в локальном мастере или администратором.</p><label>Логин<input v-model="username" autocomplete="username" required></label><label>Пароль<input v-model="password" type="password" autocomplete="current-password" required></label><p v-if="error" class="error" role="alert">{{error}}</p><button class="primary full" :disabled="busy">Войти в панель →</button><details v-if="data.mode==='DEMO'&&!data.personalAccounts"><summary>Демонстрационные учётные записи</summary><p>admin / DemoAdmin-2026!<br>operator / DemoOperator-2026!</p></details></form>
</div>
<div v-else class="shell">
 <aside class="sidebar"><div class="brand"><div class="brand-mark small">P<span>·</span>T</div><div>PanelTech<small>Панель поддержки</small></div></div><span class="demo-pill">● {{data.mode==='PILOT'?'PILOT / WINDOWS':'DEMO / СИМУЛЯЦИЯ'}}</span><p class="side-label">КЛУБЫ <span>{{data.clubs.length}}</span></p><input v-model="search" placeholder="Поиск клуба" aria-label="Поиск клуба"><nav class="clubs"><button v-for="c in clubs" :key="c.id" :class="{active:clubId===c.id}" :disabled="busy" @click="clubId=c.id"><span class="club-icon">▦</span>{{c.name}}<small>{{c.onlineCount??data.devices.filter((d:any)=>d.clubId===c.id&&d.online).length}} в сети</small></button><p v-if="!clubs.length" class="muted">Клубы не найдены</p></nav><div class="sidebar-bottom"><b>{{user.username}}</b><span>{{user.role==='admin'?'Администратор':'Оператор'}}</span><button @click="act(async()=>{await api('/logout','POST',{});user=null;})">Выйти</button></div></aside>
 <main>
  <header><div><p class="eyebrow">КЛУБ / {{data.mode==='PILOT'?'ПИЛОТ':'ДЕМОНСТРАЦИЯ'}}</p><h1>{{club?.name??'Выберите клуб'}}</h1></div><div class="header-meta"><div class="connection-status" :class="connection" role="status" aria-live="polite" aria-atomic="true"><span class="live-dot" aria-hidden="true"></span>{{connectionLabel}}</div><small>Последний ответ: {{fmt(lastResponse)}}</small><small>{{devices.filter((d:any)=>d.online).length}} из {{devices.length}} ПК доступны</small></div></header>
  <div class="demo-banner"><b>{{data.mode??'DEMO'}}</b><span>{{data.mode==='PILOT'?'Проверка QoS-правил не подтверждает маршрут MikroTik, пинг или голосовой чат.':'Результаты симуляции не подтверждают маркировку Windows, маршрут MikroTik, пинг или голосовой чат.'}}</span></div>
  <div v-if="connection!=='online'" class="connection-warning" role="status">{{connectionLabel}}. Данные — последний загруженный снимок ({{fmt(lastSync)}}). Действия не отправляются до восстановления связи.</div>
  <div class="tabs"><button v-for="t in [['devices','Компьютеры'],['tasks','Задания'+(activeCount?' · '+activeCount:'')],['history','История'],...(user.role==='admin'?[['catalog','Каталог игр'],['admin','Управление'],['audit','Журнал действий'],['server','Сервер']]:[])]" :key="t[0]" :class="{active:tab===t[0]}" @click="tab=t[0]">{{t[1]}}</button></div>
  <div v-if="error" class="error toast" role="alert">{{error}}<button @click="error=''">×</button></div><div v-if="notice" class="notice toast" role="status">{{notice}}<div><button v-if="lastBatch" class="notice-link" @click="openLastTask">Открыть задание →</button><button aria-label="Закрыть уведомление" @click="notice=''">×</button></div></div>
  <DeviceWorkspace v-if="tab==='devices'" v-model:focused-id="focusedPcId" :devices="devices" :jobs="jobs" :club-id="clubId" :club-name="club?.name??''" :games="data.games" v-model:game-id="gameId" v-model:variant="variant" :variants="variants" v-model:selected="selected" :busy="busy" :online="connection==='online'" :admin="user.role==='admin'" @operation="requestOperation" @scenario="scenario" @reboot="reboot" @open-job="openJob" @open-active="Object.assign(taskFilters,emptyJobFilters(),{state:'active'});focusJobId='';tab='tasks'" @history="pcHistory" @catalog="tab='catalog'" />
  <JobResults v-if="tab==='devices'" :jobs="jobs" :busy="busy" :online="connection==='online'" batch-id="" focus-id="" :draft="draft" @update:batch-id="v=>{Object.assign(taskFilters,emptyJobFilters(),{batchId:v});focusJobId='';tab='tasks';}" @reconcile="reconcile" @feedback="saveFeedback" @reload-feedback="reloadFeedback" @history="jobHistory" />
  <JobBrowser v-if="tab==='tasks'" :api="api" :club-id="clubId" :devices="devices" :games="data.games" :filters="taskFilters" :revision="lastSync" :focus-id="focusJobId" :busy="busy" :online="connection==='online'" :draft="draft" @reconcile="reconcile" @feedback="saveFeedback" @reload-feedback="reloadFeedback" @history="jobHistory" />
  <HistoryPanel v-if="tab==='history'" :api="api" :club-id="clubId" :devices="devices" :games="data.games" :filters="historyFilters" :revision="lastSync" :focus-id="historyFocus" @open-job="openJob" />
  <AuditPanel v-if="tab==='audit'&&user.role==='admin'" :api="api" />
  <!-- Keep drafts across tabs; unmount them on logout/account changes. -->
  <KeepAlive v-if="user.role==='admin'" :key="user.id">
   <GameCatalog v-if="tab==='catalog'" :games="data.games" :services="adminServices" :busy="busy" :online="connection==='online'" />
   <AdminManagement v-else-if="tab==='admin'" :user-id="user.id" :clubs="data.clubs" :club="club" :devices="devices" :real-agents="!!data.realAgents" :services="adminServices" :busy="busy" :online="connection==='online'" />
   <ServerOperations v-else-if="tab==='server'" :api="api" />
  </KeepAlive>
  <footer>PanelTech MVP · Состояние правил и пользовательская отметка — разные результаты. История не запускает восстановление правил.</footer>
 </main>
 <ConfirmDialog :open="!!confirm" :disabled="busy||connection!=='online'||!chosen.length" :confirm-text="`Запустить для ${chosen.length} ПК`" @close="confirm=null;pending=null" @confirm="run">
  <p class="eyebrow">МАССОВОЕ ЗАДАНИЕ · {{data.mode}}</p><h2 id="confirm-title">{{confirm?operations[confirm]:''}} маркировку?</h2>
  <dl><dt>Клуб</dt><dd>{{club?.name}}</dd><dt>Компьютеры</dt><dd>{{chosen.length}}: {{chosen.map((d:any)=>d.name).join(', ')}}</dd><dt>Игра</dt><dd>{{pendingGame?.name}} · {{pendingGame?.exes.length}} exe</dd><dt>Вариант</dt><dd>{{confirm==='apply_marking'?variants.find((v:any)=>v.id===pending?.variant)?.name:'Удаление собственных правил игры'}}</dd></dl>
  <p id="confirm-description" class="muted">Недоступные ПК будут пропущены. Ошибка одного ПК не остановит остальные.</p>
 </ConfirmDialog>
</div>
</template>
