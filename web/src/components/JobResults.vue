<script setup lang="ts">
import {computed,nextTick,onMounted,ref,watch} from 'vue';
import type {Job} from '../../../shared/contracts';
import type {JobPage} from '../composables/useJobPage';
import {batchCounts,fmt,operations,reasons,recentAndUnresolved,statusNames,unresolved} from '../workspace';
const props=defineProps<{jobs:Job[];busy:boolean;online:boolean;batchId:string;focusId:string;draft:(j:Job)=>any;full?:boolean;paged?:boolean;pageData?:JobPage}>();
const emit=defineEmits(['reconcile','feedback','reloadFeedback','history','update:batchId']);
const state=ref('all');
const batches=computed(()=>[...new Set(props.jobs.map(j=>j.batchId))].map(id=>({id,rows:props.jobs.filter(j=>j.batchId===id)})));
const batch=computed(()=>props.jobs.filter(j=>j.batchId===props.batchId));
const summary=computed(()=>props.pageData?.batch??(batch.value.length?{first:batch.value[0],counts:batchCounts(batch.value),members:batch.value}:null));
const counts=computed(()=>summary.value?.counts);
const rows=computed(()=>{
 if(props.paged)return props.jobs;
 const base=props.batchId?batch.value:props.full?props.jobs:recentAndUnresolved(props.jobs,8);
 return base.filter(j=>state.value==='all'||state.value==='active'&&unresolved(j)||j.state===state.value).sort((a,b)=>Number(unresolved(b))-Number(unresolved(a)));
});
async function focusJob(){await nextTick();if(props.focusId)document.querySelector<HTMLElement>(`article[data-job-id="${CSS.escape(props.focusId)}"]`)?.focus({preventScroll:false});}
watch(()=>props.focusId,()=>{state.value='all';if(!props.paged)void focusJob();});
watch(()=>props.batchId,()=>{state.value='all';});
onMounted(()=>{if(!props.paged)void focusJob();});
</script>

<template>
 <section class="panel results" aria-label="Результаты заданий"><div v-if="!paged" class="section-heading"><div><h2>{{full?'Задания':'Результаты по ПК'}}</h2><p class="fine">{{full?'Все операции клуба.':'Последние 8 операций.'}} Незавершённые операции видны независимо от возраста.</p></div><span class="count">{{jobs.filter(unresolved).length}} незавершённых</span></div>
  <div v-if="!paged" class="task-filters"><label>Задание<select aria-label="Задание" :value="batchId" @change="emit('update:batchId',($event.target as HTMLSelectElement).value)"><option value="">Все задания клуба</option><option v-for="b in batches" :key="b.id" :value="b.id">{{fmt(b.rows[0].created)}} · {{operations[b.rows[0].operation]}} · {{b.rows.length}} ПК · {{b.id.slice(0,8)}}</option></select></label><label>Статус операции<select aria-label="Статус операции" v-model="state"><option value="all">Все статусы</option><option value="active">Незавершённые</option><option v-for="(name,id) in statusNames" :key="id" :value="id">{{name}}</option></select></label></div>
  <div v-if="summary&&counts" class="batch-summary"><div><b>Задание {{batchId.slice(0,8)}}</b><p>{{summary.first.author}} · {{fmt(summary.first.created)}} · {{summary.first.gameName}} · {{summary.first.variantName??'без варианта'}}</p></div><div class="batch-counts"><span>Всего <b>{{counts.total}}</b></span><span>Выполнено <b>{{counts.succeeded}}</b></span><span>Ошибка <b>{{counts.failed}}</b></span><span>Истекло <b>{{counts.expired}}</b></span><span>Неизвестно <b>{{counts.unknown}}</b></span><span>Ожидается <b>{{counts.pending}}</b></span></div><details><summary>Состав задания · {{summary.members.length}} ПК</summary><p>{{summary.members.map(j=>j.deviceName).join(', ')}}</p><code>{{batchId}}</code></details><p class="fine">Счётчики отражают отдельные операции. Неизвестный результат требует сверки; автоматических повторов нет.</p></div>
  <p v-if="!rows.length" class="empty">{{jobs.length?'Операций по этому фильтру нет.':'Пока нет заданий. Выберите ПК, игру и вариант; результат появится здесь.'}}</p>
  <article v-for="j in rows" :key="j.id" class="job" :class="{'job-focused':focusId===j.id}" :data-job-id="j.id" tabindex="-1"><div class="job-top"><b>{{j.deviceName}} <span class="subtle">/ {{j.gameName}}</span></b><span><span class="demo-tag">{{j.demo?'DEMO':'WINDOWS'}}</span> <span class="badge" :class="j.state">{{statusNames[j.state]}}</span></span></div><p>{{j.message??'Ожидание выполнения агентом…'}}</p><small>{{operations[j.operation]}} · {{j.variantName??'без варианта'}} · {{fmt(j.created)}} · {{j.author}} · exe r{{j.revision}}</small><p v-if="j.rollback" class="rollback" :class="{'rollback-failed':j.code==='rollback_failed'}">Откат: {{j.rollback}}</p><p v-if="j.state==='unknown'" class="stale-note">Результат неизвестен: изменение могло произойти. {{j.demo?'Выполните отдельную сверку симулятора.':'Нужна свежая инспекция агента; повторное применение заблокировано.'}}</p><button v-if="j.state==='unknown'&&j.demo" :disabled="busy||!online" @click="emit('reconcile',j)">Сверить фактические правила симулятора</button>
   <div v-if="j.state==='succeeded'&&j.operation==='apply_marking'" class="feedback"><label>Результат со слов сотрудника<select v-model="draft(j).outcome"><option value="unchecked">Не проверено</option><option value="helped">Помогло</option><option value="not_helped">Не помогло</option></select></label><label>Симптом<select v-model="draft(j).reason"><option v-for="(v,k) in reasons" :key="k" :value="k">{{v}}</option></select></label><label>Комментарий<input v-model="draft(j).comment" maxlength="1000" placeholder="Необязательно"></label><p v-if="draft(j)._error" class="error feedback-error" role="alert">{{draft(j)._error}}</p><button v-if="draft(j)._conflict" :disabled="busy||!online" @click="emit('reloadFeedback',j)">Загрузить актуальную отметку (заменить черновик)</button><button :disabled="busy||!online" @click="emit('feedback',j)">Сохранить отметку</button></div><small v-if="j.feedback">Отметка: {{j.feedback.outcome==='helped'?'помогло':j.feedback.outcome==='not_helped'?'не помогло':'не проверено'}} · {{j.feedback.author}} · {{fmt(j.feedback.at)}}</small>
   <div class="job-links"><code>Операция {{j.id.slice(0,8)}}</code><button class="text-button" @click="emit('history',j)">В историю ПК и игры →</button></div><details><summary>Технические данные</summary><pre>{{JSON.stringify(j,null,2)}}</pre></details>
  </article>
 </section>
</template>
