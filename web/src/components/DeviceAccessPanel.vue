<script setup lang="ts">
import {onDeactivated,ref,watch} from 'vue';
import type {AdminDevice} from '../admin';
import {useAdminActions,type AdminServices} from '../composables/useAdminActions';
import {fmt} from '../workspace';
const props=defineProps<{devices:AdminDevice[];realAgents:boolean;busy:boolean;online:boolean;services:AdminServices}>();
const {errors,run,reloadSaved}=useAdminActions(props.services);
const target=ref<AdminDevice|null>(null),grant=ref<{deviceId:string;expires:number;json:string}|null>(null);
function clear(){target.value=null;grant.value=null;}
watch(props.services.selectedClubId,clear);onDeactivated(clear);
async function rotate(device:AdminDevice){await run('agent-access',async()=>{
 await props.services.api('/admin/devices/'+device.id+'/rotate','POST',{expectedAccessVersion:device.accessVersion??1});
 props.services.notify('Смена токена запрошена. Обновлённый агент выполнит её при следующем опросе. Для немедленной блокировки используйте отзыв.');
 await reloadSaved(props.services.refresh);
});}
async function recover(){const device=target.value;if(!device)return;grant.value=null;await run('agent-access',async()=>{
 const result=await props.services.api('/admin/devices/'+device.id+'/recovery','POST',{expectedAccessVersion:device.accessVersion??1});
 grant.value={deviceId:device.id,expires:result.expires,json:JSON.stringify(result,null,2)};target.value=null;
 props.services.notify('Старый доступ отозван. Скачайте файл восстановления и передайте локальному администратору этого ПК. Правила Windows не менялись.');
 await reloadSaved(props.services.refresh);
});}
function download(){if(!grant.value)return;const url=URL.createObjectURL(new Blob([grant.value.json],{type:'application/json'}));
 const link=document.createElement('a');link.href=url;link.download='paneltech-recovery-'+grant.value.deviceId+'.json';link.click();URL.revokeObjectURL(url);
}
async function revoke(device:AdminDevice){await run('agent-access',async()=>{await props.services.api('/admin/devices/'+device.id+'/revoke','POST',{});clear();await reloadSaved(props.services.refresh);});}
</script>
<template>
 <section aria-label="Доступ агентов">
  <h3>Доступ агентов</h3>
  <p class="fine">Смена токена сохраняет ID и задания. Восстановление отзывает доступ и требует локальной подготовки агента; существующие правила не присваиваются.</p>
  <p v-if="errors['agent-access']" id="agent-access-error" class="error form-error" role="alert" tabindex="-1">{{errors['agent-access']}}</p>
  <div v-for="device in devices" :key="device.id" class="user-row">
   <b>{{device.name}}</b><span>{{device.recoveryPending?'Ожидает восстановления':device.revoked?'Отозван':device.rotationRequested?'Ожидает смены токена':'Активен'}} · v{{device.accessVersion??1}}</span>
   <button :disabled="busy||!online||!realAgents||device.demo||device.revoked||device.rotationRequested" :aria-label="'Сменить токен '+device.name" @click="rotate(device)">Сменить токен</button>
   <button :disabled="busy||!online||!realAgents||device.demo" :aria-label="'Восстановить доступ '+device.name" @click="clear();target={...device}">Восстановить доступ</button>
   <button :disabled="busy||!online||(device.revoked&&!device.recoveryPending)" @click="revoke(device)">Отозвать</button>
  </div>
  <div v-if="target" class="empty-state" role="region" aria-label="Подтверждение восстановления агента">
   <b>Восстановить доступ: {{target.name}}</b>
   <p>Старый токен перестанет работать сразу. Ожидающие команды истекут, начатые останутся с неизвестным результатом. ID и история ПК сохранятся. На самом ПК нужно остановить агент и явно подготовить восстановление.</p>
   <button :disabled="busy||!online" @click="recover">Отозвать доступ и выдать файл</button>
   <button :disabled="busy" @click="target=null">Отмена</button>
  </div>
  <div v-if="grant" class="empty-state" role="region" aria-label="Файл восстановления агента">
   <b>Файл для ПК {{grant.deviceId}}</b><p>Действует до {{fmt(grant.expires)}}. Это секрет доступа: передайте через защищённый локальный канал. Файл скрывается при смене клуба/вкладки и выходе. Утраченный файл можно только заменить новым.</p>
   <button @click="download">Скачать файл восстановления</button><button @click="grant=null">Скрыть файл</button>
  </div>
 </section>
</template>
