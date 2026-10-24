<script setup lang="ts">
import {onMounted,onBeforeUnmount,ref} from 'vue';
import {fmt} from '../workspace';
const props=defineProps<{api:(path:string)=>Promise<any>}>();
const result=ref<any>(null),loading=ref(false),error=ref(''),actor=ref(''),action=ref(''),from=ref(''),to=ref('');
let sequence=0,disposed=false;
const labels:Record<string,string>={'backup.requested':'Резервная копия запрошена','game.created':'Игра создана','game.updated':'Игра изменена','club.created':'Клуб создан','club.updated':'Клуб изменён','user.created':'Сотрудник создан','user.updated':'Доступ сотрудника изменён','user.password_reset':'Пароль сотрудника сброшен','feedback.updated':'Отметка результата изменена','enrollment.created':'Токен регистрации выдан','device.registered':'Агент зарегистрирован','device.rotation_requested':'Смена токена запрошена','device.token_rotated':'Токен агента изменён','device.recovery_issued':'Файл восстановления выдан','device.access_recovered':'Доступ агента восстановлен','device.revoked':'Доступ агента отозван','batch.created':'Задание создано','device.demo_scenario':'Сценарий DEMO изменён','device.demo_reboot':'Перезагрузка DEMO','job.demo_reconciled':'Сверка DEMO выполнена'};
async function load(page=1,renew=false){
 const request=++sequence;loading.value=true;error.value='';
 const q=new URLSearchParams({page:String(page)});
 if(!renew&&result.value)q.set('snapshot',String(result.value.snapshot));
 if(actor.value)q.set('actor',actor.value);if(action.value)q.set('action',action.value);
 if(from.value)q.set('from',String(new Date(from.value+'T00:00:00').getTime()));
 if(to.value)q.set('to',String(new Date(to.value+'T23:59:59.999').getTime()));
 try{const value=await props.api('/admin/audit?'+q);if(!disposed&&request===sequence)result.value=value;}
 catch(e){if(!disposed&&request===sequence)error.value=(e as Error).message;}
 finally{if(!disposed&&request===sequence)loading.value=false;}
}
onMounted(()=>load());onBeforeUnmount(()=>{disposed=true;sequence++;});
</script>
<template>
 <section class="panel padded audit-panel" aria-label="Журнал действий">
  <h2>Журнал действий</h2><p class="muted">Кто и когда изменил настройки или отметку результата. Пароли и токены в журнал не записываются.</p>
  <form class="audit-filters" aria-label="Фильтры журнала" @submit.prevent="load(1,true)">
   <label>Сотрудник или агент<select v-model="actor" aria-label="Сотрудник или агент"><option value="">Все</option><option v-for="a in result?.actors??[]" :key="a.id" :value="a.id">{{a.name}}</option></select></label>
   <label>Действие<select v-model="action" aria-label="Действие"><option value="">Все действия</option><option v-for="a in result?.actions??[]" :key="a" :value="a">{{labels[a]??a}}</option></select></label>
   <label>С даты<input type="date" v-model="from"></label><label>По дату<input type="date" v-model="to"></label>
   <button type="submit" :disabled="loading">Применить фильтры</button>
  </form>
  <p class="fine">Даты — в часовом поясе вашего браузера. Новые события появятся после обновления выборки.</p>
  <p v-if="error" class="error" role="alert">{{error}} <button @click="load(1,true)">Повторить загрузку журнала</button></p>
  <p v-if="loading" role="status">Загрузка журнала…</p><p v-if="result&&!result.items.length&&!loading" class="empty">По выбранным фильтрам событий нет.</p>
  <article v-for="event in result?.items??[]" :key="event.id" class="audit-event">
   <div class="job-top"><b>{{labels[event.action]??event.action}}</b><small>{{fmt(event.at)}}</small></div>
   <p>{{event.actor.name}} · {{event.entity.name}}</p>
   <details><summary>Изменения</summary><div class="audit-values"><div><b>До</b><pre>{{JSON.stringify(event.before,null,2)}}</pre></div><div><b>После</b><pre>{{JSON.stringify(event.after,null,2)}}</pre></div></div><small>Объект {{event.entity.id}} · событие {{event.id}}</small></details>
  </article>
  <div v-if="result" class="audit-pages"><span role="status">{{result.total}} событий · страница {{result.page}} из {{result.pages}}</span><button :disabled="loading||result.page<=1" @click="load(result.page-1)">Назад</button><button :disabled="loading||result.page>=result.pages" @click="load(result.page+1)">Далее</button><button :disabled="loading" @click="load(1,true)">Обновить выборку</button></div>
 </section>
</template>
