<script setup lang="ts">
import {useJobPage,type JobFilters} from '../composables/useJobPage';
import {fmt,operations,reasons,statusNames} from '../workspace';
import OperationFilters from './OperationFilters.vue';
import PageNavigation from './PageNavigation.vue';
const props=defineProps<{api:(path:string)=>Promise<any>;clubId:string;devices:any[];games:any[];filters:JobFilters;revision:number|null;focusId:string}>();
const emit=defineEmits(['open-job']);
const {result,authors,loading,error,page,pageSize,load,go,renew}=useJobPage(props.api,()=>props.clubId,props.filters,()=>props.revision,()=>props.focusId);
</script>
<template>
 <section class="panel history-panel"><div class="section-heading"><h2>История операций</h2><span class="muted">Сохраняется после перезапуска API</span></div><OperationFilters :filters="filters" :devices="devices" :games="games" :authors="authors" />
  <p v-if="error" class="error" role="alert">{{error}} <button @click="load()">Повторить загрузку</button></p>
  <div class="table-scroll"><table><thead><tr><th>Дата / автор</th><th>ПК / игра</th><th>Операция</th><th>Технический результат</th><th>Отметка сотрудника</th></tr></thead><tbody><tr v-for="j in result?.items??[]" :key="j.id" :data-history-id="j.id" :class="{'history-focused':j.id===focusId}"><td>{{fmt(j.created)}}<small>{{j.author}} · {{j.demo?'DEMO':'Windows'}}</small></td><td><b>{{j.deviceName}}</b><small>{{j.gameName}} · r{{j.revision}}</small><button class="text-button" @click="emit('open-job',j)">Открыть операцию {{j.id.slice(0,8)}}</button></td><td>{{operations[j.operation]}}<small>{{j.variantName??'—'}}</small></td><td><span class="badge" :class="j.state">{{statusNames[j.state]}}</span><small>{{j.message}}</small><small v-if="j.rollback">Откат: {{j.rollback}}</small></td><td>{{j.feedback?({helped:'Помогло',not_helped:'Не помогло',unchecked:'Не проверено'} as any)[j.feedback.outcome]:'Не проверено'}}<small v-if="j.feedback">{{reasons[j.feedback.reason]}} · {{j.feedback.author}}<br>{{j.feedback.comment}}</small><details><summary>Снимок задания</summary><pre>{{JSON.stringify(j,null,2)}}</pre></details></td></tr><tr v-if="!result?.items.length"><td colspan="5" class="empty">{{loading?'Загрузка истории…':error?'Историю загрузить не удалось.':'По этим фильтрам операций нет.'}}</td></tr></tbody></table></div>
  <PageNavigation :page="page" :pages="result?.pages??1" :total="result?.total??0" :page-size="pageSize" :loading="loading" @go="go" @size="pageSize=$event" @renew="renew" />
 </section>
</template>
