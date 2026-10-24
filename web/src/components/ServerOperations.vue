<script setup lang="ts">
import {ref,onActivated,onDeactivated,onUnmounted,nextTick} from 'vue';
import type {OperationsStatus} from '../../../shared/operations';
import type {ApiClient} from '../composables/useApiClient';
const props=defineProps<{api:ApiClient}>();
const status=ref<OperationsStatus|null>(null),error=ref(''),sending=ref(false),loading=ref(false),stale=ref(true),notice=ref('');
let timer:ReturnType<typeof setInterval>|undefined,active=false,sequence=0;
const bytes=(value:number|null)=>value===null?'Недоступно':value<1048576?`${(value/1024).toFixed(1)} КиБ`:`${(value/1048576).toFixed(1)} МиБ`;
const date=(value:number|string|null)=>value===null?'Ещё нет':new Date(value).toLocaleString('ru-RU');
const messages={backup_failed:'Не удалось завершить копирование, проверку или обслуживание копий. Проверьте место, права и доступность БД. Новый пакет мог уже сохраниться; проверьте каталог перед повтором.',backup_locked:'Каталог занят другим процессом или осталась блокировка после аварии. Следуйте инструкции восстановления.',worker_failed:'Процесс резервного копирования завершился без результата. Проверьте состояние сервера.',status_invalid:'Не удалось прочитать сохранённый статус. Данные о прежних копиях пока не подтверждены.'};
async function refresh(){
 if(loading.value)return;const id=++sequence;loading.value=true;
 try{const result=await props.api('/admin/operations');if(active&&id===sequence){status.value=result;stale.value=false;error.value='';if(result.backup.phase!=='running')notice.value='';}}
 catch(cause){if(active&&id===sequence){stale.value=true;error.value=(cause as Error).message;}}
 finally{loading.value=false;}
}
async function backup(){
 sending.value=true;error.value='';notice.value='';
 try{await props.api('/admin/operations/backup','POST',{});notice.value='Задание принято. Дождитесь проверенной копии и результата восстановления.';await refresh();}
 catch(cause){error.value=(cause as Error).message.replace('проверьте историю после восстановления связи','проверьте состояние копирования после восстановления связи');await nextTick();document.getElementById('server-error')?.focus();}
 finally{sending.value=false;}
}
onActivated(()=>{active=true;void refresh();timer=setInterval(()=>void refresh(),3000);});
function pause(){active=false;sequence++;if(timer)clearInterval(timer);}
onDeactivated(pause);onUnmounted(pause);
</script>

<template>
 <section class="panel padded server-operations" aria-label="Состояние сервера">
  <div class="section-head"><div><p class="eyebrow">ХРАНЕНИЕ И ВОССТАНОВЛЕНИЕ</p><h2>Состояние сервера</h2></div><button :disabled="loading" @click="refresh">Обновить состояние</button></div>
  <p v-if="error" id="server-error" class="error" role="alert" tabindex="-1">{{error}}</p>
  <p v-if="notice" class="notice" role="status">{{notice}}</p>
  <p v-if="stale&&status" class="warning">Последний снимок. Актуальность состояния не подтверждена.</p>
  <p v-if="!status" class="muted">{{loading?'Проверяем сервер…':'Нет подтверждённого состояния сервера.'}}</p>
  <template v-if="status">
   <div class="server-metrics">
    <div><span class="muted">База данных</span><strong :class="status.database.state==='paused'?'error':''">{{status.database.state==='paused'?'Операции остановлены':'Доступна для операций'}}</strong><small>БД {{bytes(status.database.mainBytes)}} · WAL {{bytes(status.database.walBytes)}}</small></div>
    <div><span class="muted">Свободно на диске БД</span><strong>{{bytes(status.database.freeBytes)}}</strong><small>Память API {{bytes(status.runtime.rssBytes)}}</small></div>
    <div><span class="muted">Последняя успешная копия</span><strong>{{date(status.backup.lastSuccess)}}</strong><small>Следующая: {{status.backup.enabled?(status.backup.phase==='running'?'после завершения текущей проверки':date(status.backup.nextAt)):'расписание выключено'}}</small></div>
   </div>
   <h3>Резервные копии</h3>
   <p><b>{{status.backup.phase==='running'?'Копирование и проверка выполняются':status.backup.phase==='error'?'Последняя попытка не завершена успешно':status.backup.lastSuccess?'Последняя копия создана и проверена':'Проверенных копий пока нет'}}</b></p>
   <p v-if="status.backup.error" class="error" role="alert">{{messages[status.backup.error]}}</p>
   <p v-if="status.backup.enabled&&status.backup.lastSuccess&&Date.now()-status.backup.lastSuccess>status.backup.intervalMinutes*60000+120000" class="warning">Проверенная копия просрочена. Проверьте последнюю попытку и работу расписания.</p>
   <p v-if="status.database.state==='paused'" class="warning">Запись остановлена после ошибки хранилища. Сохраните исходную БД и WAL, проверьте диск и права. Автоматическое возобновление отключено.</p>
   <p class="muted">{{status.backup.enabled?`Каждые ${status.backup.intervalMinutes} мин., пока сервер запущен.`:'Автоматическое расписание выключено; ручная копия доступна.'}} Хранение: до {{status.backup.keep}} копий и {{bytes(status.backup.maxBytes)}}. Последняя проверенная копия сохраняется даже при превышении бюджета.</p>
   <p>Копий на последней проверке: <b>{{status.backup.count}}</b> · Занято ими: <b>{{bytes(status.backup.bytes)}}</b> · Последняя попытка: {{date(status.backup.lastAttempt)}}</p>
   <p v-if="status.backup.budgetExceeded" class="warning">Бюджет хранения превышен. Последняя проверенная копия сохранена; увеличьте доступное место или перенесите копии.</p>
   <p v-if="status.backup.skipped" class="warning">Пакетов вне автоматической очистки: {{status.backup.skipped}}. Они могут быть повреждены, незавершены или созданы вручную; их место не входит в указанный объём проверенных копий.</p>
   <p v-if="status.backup.latest" class="fine">SHA-256 и целостность проверены: {{date(status.backup.latest.verifiedAt)}}. Восстановление в отдельную временную БД проверено: {{date(status.backup.latest.drill.checkedAt)}}. Рабочая БД не заменялась.</p>
   <button class="primary" :disabled="sending||stale||status.backup.phase==='running'||status.database.state==='paused'" @click="backup">Создать и проверить копию</button>
   <p class="fine">Копии содержат данные доступа и историю. Хранятся на диске сервера; скачивание через панель отключено. Для защиты от поломки диска нужна отдельная защищённая копия на другом носителе. История заданий автоматически не удаляется.</p>
  </template>
 </section>
</template>
