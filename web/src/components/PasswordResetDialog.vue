<script setup lang="ts">
import {ref,watch,nextTick,onBeforeUnmount} from 'vue';
const props=defineProps<{target:{id:string;username:string}|null;online:boolean;reset:(id:string,password:string)=>Promise<void>}>();
const emit=defineEmits<{close:[];saved:[username:string]}>();
const dialog=ref<HTMLDialogElement|null>(null),cancel=ref<HTMLButtonElement|null>(null),alert=ref<HTMLElement|null>(null);
const secret=ref(''),repeat=ref(''),confirmed=ref(false),pending=ref(false),error=ref('');
let opener:HTMLElement|null=null,overflow='';
function clear(){secret.value='';repeat.value='';confirmed.value=false;error.value='';}
function restore(){document.body.style.overflow=overflow;if(opener?.isConnected)opener.focus();opener=null;}
watch(()=>props.target,async target=>{
 clear();await nextTick();
 if(target&&dialog.value&&!dialog.value.open){opener=document.activeElement instanceof HTMLElement?document.activeElement:null;overflow=document.body.style.overflow;document.body.style.overflow='hidden';dialog.value.showModal();cancel.value?.focus();}
 else if(!target&&dialog.value?.open){dialog.value.close();restore();}
},{flush:'post'});
function close(){if(!pending.value){clear();emit('close');}}
function trap(event:KeyboardEvent){
 if(event.key!=='Tab')return;
 const controls=Array.from(dialog.value?.querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled)')??[]);
 const first=controls[0],last=controls.at(-1);
 if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
 else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
}
async function submit(){
 if(pending.value||!props.online||!confirmed.value||!props.target)return;
 error.value='';
 if(secret.value.length<12||secret.value.length>200)error.value='Пароль должен содержать от 12 до 200 символов.';
 else if(secret.value!==repeat.value)error.value='Пароли не совпали.';
 if(error.value){await nextTick();alert.value?.focus();return;}
 const target=props.target;let value=secret.value;pending.value=true;
 // Clear form fields on every attempted reset, including an ambiguous lost response.
 secret.value='';repeat.value='';confirmed.value=false;
 try{await props.reset(target.id,value);clear();emit('saved',target.username);}
 catch(e){error.value=(e as Error).message.replace('проверьте историю после восстановления связи','проверьте вход сотрудника или задайте новый пароль явно после восстановления связи');await nextTick();alert.value?.focus();}
 finally{value='';pending.value=false;}
}
onBeforeUnmount(()=>{clear();if(dialog.value?.open){dialog.value.close();restore();}});
</script>
<template>
 <dialog ref="dialog" class="modal password-dialog" aria-labelledby="password-reset-title" aria-describedby="password-reset-description" @cancel.prevent="close" @keydown="trap">
  <form aria-label="Сброс пароля сотрудника" @submit.prevent>
   <h2 id="password-reset-title">Сброс пароля: {{target?.username}}</h2>
   <p id="password-reset-description">Прежний пароль перестанет работать. Все сеансы этого сотрудника завершатся. Роль и доступ не изменятся.</p>
   <label>Новый пароль<input v-model="secret" type="password" autocomplete="new-password" maxlength="200" :disabled="pending" aria-describedby="password-reset-error"></label>
   <label>Повторите новый пароль<input v-model="repeat" type="password" autocomplete="new-password" maxlength="200" :disabled="pending"></label>
   <label class="reset-confirmation"><input v-model="confirmed" type="checkbox" :disabled="pending">Подтверждаю завершение сеансов сотрудника</label>
   <p v-if="error" id="password-reset-error" ref="alert" class="error form-error" role="alert" tabindex="-1">{{error}}</p>
   <p v-if="!online" class="error" role="status">Нет подтверждённой связи с API. Сброс недоступен.</p>
   <p v-if="pending" role="status">Сохранение нового пароля…</p>
   <div class="modal-actions"><button ref="cancel" type="button" :disabled="pending" @click="close">Отмена</button><button type="button" class="primary" :disabled="pending||!online||!confirmed" @click="submit">Сменить пароль</button></div>
  </form>
 </dialog>
</template>
