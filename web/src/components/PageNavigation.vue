<script setup lang="ts">
defineProps<{page:number;pages:number;total:number;pageSize:number;loading:boolean;snapshot?:number}>();
const emit=defineEmits(['go','size','renew']);
</script>
<template>
 <div class="page-navigation" aria-label="Страницы операций"><span role="status" aria-live="polite">{{total}} операций · страница {{page}} из {{pages}}</span><label>На странице<select aria-label="На странице" :value="pageSize" @change="emit('size',Number(($event.target as HTMLSelectElement).value))"><option :value="10">10</option><option :value="25">25</option><option :value="50">50</option><option :value="100">100</option></select></label><div><button :disabled="loading||page<=1" @click="emit('go',page-1)">Назад</button><button :disabled="loading||page>=pages" @click="emit('go',page+1)">Далее</button><button :disabled="loading" @click="emit('renew')">Обновить выборку</button></div><p class="fine">Новые операции появятся после «Обновить выборку». Статусы уже включённых операций обновляются; состав и счётчики фильтра могут меняться.</p></div>
</template>
