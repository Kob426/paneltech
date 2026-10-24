<script setup lang="ts">
import {watch} from 'vue';
import type {Job} from '../../../shared/contracts';
import {useJobPage,type JobFilters} from '../composables/useJobPage';
import JobResults from './JobResults.vue';
import OperationFilters from './OperationFilters.vue';
import PageNavigation from './PageNavigation.vue';
import {fmt} from '../workspace';
const props=defineProps<{api:(path:string)=>Promise<any>;clubId:string;devices:any[];games:any[];filters:JobFilters;revision:number|null;focusId:string;busy:boolean;online:boolean;draft:(j:Job)=>any}>();
const emit=defineEmits(['reconcile','feedback','reloadFeedback','history']);
const {result,authors,batches,loading,error,page,pageSize,load,go,renew}=useJobPage(props.api,()=>props.clubId,props.filters,()=>props.revision,()=>props.focusId,'active');
let focused='';
watch(()=>props.focusId,()=>focused='');
watch(()=>result.value,()=>{if(props.focusId&&focused!==props.focusId&&result.value?.items.some(j=>j.id===props.focusId)){focused=props.focusId;requestAnimationFrame(()=>document.querySelector<HTMLElement>(`article[data-job-id="${CSS.escape(props.focusId)}"]`)?.focus());}});
</script>
<template>
 <div class="panel paged-tasks"><div class="section-heading"><h2>Задания</h2><span class="muted">Незавершённые первыми · фильтры на сервере</span></div><label class="batch-picker">Задание<select aria-label="Задание" v-model="filters.batchId"><option value="">Все задания клуба</option><option v-if="filters.batchId&&!batches.some(b=>b.id===filters.batchId)" :value="filters.batchId">{{filters.batchId}}</option><option v-for="b in batches" :key="b.id" :value="b.id">{{fmt(b.created)}} · {{b.total}} ПК · {{b.id.slice(0,8)}}</option></select></label>
  <OperationFilters :filters="filters" :devices="devices" :games="games" :authors="authors" tasks />
  <p v-if="error" class="error" role="alert">{{error}} <button @click="load()">Повторить загрузку</button></p><p v-if="loading&&!result" class="empty" role="status">Загрузка заданий…</p>
  <JobResults v-if="result" :jobs="result.items" :busy="busy" :online="online" :batch-id="filters.batchId" :focus-id="focusId" :draft="draft" :page-data="result" full paged @reconcile="emit('reconcile',$event)" @feedback="emit('feedback',$event)" @reload-feedback="emit('reloadFeedback',$event)" @history="emit('history',$event)" />
  <PageNavigation :page="page" :pages="result?.pages??1" :total="result?.total??0" :page-size="pageSize" :loading="loading" @go="go" @size="pageSize=$event" @renew="renew" />
 </div>
</template>
