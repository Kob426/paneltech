<script setup lang="ts">
import {computed,ref,watch} from 'vue';
import type {Job} from '../../../shared/contracts';
import {filterDevices,fmt,operations,reasons,scenarioNames,statusNames,unresolved,type VisibleDevice} from '../workspace';
const props=defineProps<{devices:VisibleDevice[];jobs:Job[];clubId:string;clubName:string;games:any[];gameId:string;variant:number;variants:any[];selected:string[];busy:boolean;online:boolean;admin:boolean}>();
const emit=defineEmits(['update:gameId','update:variant','update:selected','operation','scenario','reboot','open-job','open-active','history','catalog']);
const query=ref(''),filter=ref('all');
const focusedId=defineModel<string>('focusedId',{default:''});
const game=computed(()=>props.games.find(g=>g.id===props.gameId));
const visible=computed(()=>filterDevices(props.devices,props.jobs,query.value,filter.value));
const focused=computed(()=>props.devices.find(d=>d.id===focusedId.value));
const active=computed(()=>props.jobs.filter(unresolved));
const focusedActive=computed(()=>active.value.filter(j=>j.deviceId===focusedId.value));
const lastGameJob=computed(()=>props.jobs.find(j=>j.deviceId===focusedId.value&&j.gameId===props.gameId));
const lastApplied=computed(()=>props.jobs.find(j=>j.deviceId===focusedId.value&&j.gameId===props.gameId&&j.operation==='apply_marking'&&j.state==='succeeded'));
const rules=computed(()=>focused.value?.rules.filter(r=>r.gameId===props.gameId&&r.owned)??[]);
const visibleSelected=computed(()=>visible.value.filter(d=>props.selected.includes(d.id)).length);
const allVisibleSelected=computed(()=>!!visible.value.length&&visibleSelected.value===visible.value.length);
function snapshotFresh(d:VisibleDevice){return d.fresh&&props.online&&!props.jobs.some(j=>j.deviceId===d.id&&j.state==='unknown');}
const validVariant=computed(()=>props.variants.some(v=>v.id===props.variant));
const cardBlocked=computed(()=>!props.online||props.busy||!focused.value?.online||!!focusedActive.value.length);
function recommendation(d:VisibleDevice){
 const j=props.jobs.filter(j=>j.deviceId===d.id&&j.gameId===props.gameId&&j.operation==='apply_marking'&&j.state==='succeeded'&&j.feedback?.outcome==='helped').sort((a,b)=>b.feedback!.at-a.feedback!.at)[0];
 return j?`${j.variantName??j.variant} · ${fmt(j.feedback!.at)} · ${reasons[j.feedback!.reason]}${j.revision===game.value?.revision?'':` · ревизия изменилась: r${j.revision} → r${game.value?.revision}; проверьте exe`}${props.variants.some(v=>v.id===j.variant)?'':' · сейчас недоступен'}`:'Нет отметки «помогло»';
}
function toggle(id:string){emit('update:selected',props.selected.includes(id)?props.selected.filter(x=>x!==id):[...props.selected,id]);}
function toggleVisible(){emit('update:selected',allVisibleSelected.value?props.selected.filter(id=>!visible.value.some(d=>d.id===id)):[...new Set([...props.selected,...visible.value.map(d=>d.id)])]);}
function operation(op:string,ids=props.selected){emit('operation',op,ids);}
function lastJob(d:VisibleDevice){return props.jobs.find(j=>j.deviceId===d.id&&j.gameId===props.gameId);}
watch(()=>props.clubId,()=>{query.value='';filter.value='all';focusedId.value='';});
watch(()=>props.devices,()=>{if(focusedId.value&&!props.devices.some(d=>d.id===focusedId.value))focusedId.value='';});
</script>

<template>
 <section class="action-panel" aria-label="Параметры операции">
  <div class="workspace-title"><div><p class="eyebrow">РАБОЧЕЕ МЕСТО</p><h2>Найдите ПК и выберите вариант</h2></div><span class="muted">{{devices.length}} ПК · {{devices.filter(d=>d.online).length}} в сети</span></div>
  <div class="action-fields"><label>Игра<select aria-label="Игра" :value="gameId" :disabled="!games.length" @change="emit('update:gameId',($event.target as HTMLSelectElement).value)"><option v-if="!games.length" value="">Нет игр в каталоге</option><option v-for="g in games" :key="g.id" :value="g.id">{{g.name}}</option></select></label><label>Вариант клуба<select aria-label="Вариант клуба" :value="variant" @change="emit('update:variant',Number(($event.target as HTMLSelectElement).value))"><option v-for="v in variants" :key="v.id" :value="v.id">{{v.name}} · {{v.id}}</option></select></label><div class="game-meta">{{game?.exes.length??0}} exe <span>Ревизия {{game?.revision??'—'}}</span></div></div>
  <div v-if="!games.length" class="empty-state" role="status"><b>Каталог игр пуст</b><p>{{admin?'Добавьте игру и её exe в каталоге, чтобы создавать задания.':'Попросите администратора добавить игру и её exe.'}}</p><button v-if="admin" @click="emit('catalog')">Добавить игру</button></div>
  <p v-else-if="!game?.exes.length" class="error">Для игры не заполнен список exe. Применение и удаление заблокированы.</p>
  <p v-else-if="!validVariant" class="connection-warning">Выберите доступный вариант клуба. Ранее выбранный вариант больше не разрешён.</p>
  <p class="fine">Варианты принадлежат клубу. Их выбор не подтверждает маршрут или улучшение связи.</p>
 </section>
 <div v-if="active.length" class="active-strip" role="status"><b>Незавершённых операций: {{active.length}}</b><span>Включая {{active.filter(j=>j.state==='unknown').length}} с неизвестным результатом.</span><button @click="emit('open-active')">Открыть незавершённые</button></div>
 <div class="workspace-grid">
  <section class="panel computer-list" aria-label="Список компьютеров">
   <div class="section-heading"><h2>Компьютеры <span class="count">{{devices.length}}</span></h2><span class="muted">Нажмите имя, чтобы открыть карточку</span></div>
   <div class="device-filters"><label>Поиск ПК<input v-model="query" type="search" placeholder="Имя или ID, например pubg1-pc1"></label><label>Состояние ПК<select v-model="filter"><option value="all">Все состояния</option><option value="online">В сети</option><option value="offline">Недоступны</option><option value="busy">Есть незавершённое</option><option value="unknown">Нужна сверка</option></select></label></div>
   <div class="selection-bar"><span>Показано {{visible.length}} из {{devices.length}} · выбрано <b>{{selected.length}}</b><template v-if="selected.length-visibleSelected"> · скрыто выбором фильтра: {{selected.length-visibleSelected}}</template></span><div><button @click="toggleVisible" :disabled="!visible.length">{{allVisibleSelected?'Снять видимых':'Выбрать видимых'}}</button><button v-if="selected.length" @click="emit('update:selected',[])">Снять весь выбор</button></div></div>
   <div class="table-scroll device-table"><table><thead><tr><th><input type="checkbox" aria-label="Выбрать все ПК" :checked="allVisibleSelected" :indeterminate="visibleSelected>0&&!allVisibleSelected" @change="toggleVisible"></th><th>Компьютер / доступность</th><th>Операция для игры</th><th>Помогло для этой игры</th></tr></thead><tbody>
    <tr v-for="d in visible" :key="d.id" :data-device-id="d.id" :class="{selected:selected.includes(d.id),focused:focusedId===d.id}"><td><input type="checkbox" :checked="selected.includes(d.id)" :aria-label="'Выбрать '+d.name" @change="toggle(d.id)"></td><td><button class="pc-name" :aria-label="'Открыть ПК '+d.name" :aria-pressed="focusedId===d.id" @click="focusedId=d.id">{{d.name}}</button><small class="availability" :class="{online:d.online}">{{d.revoked?'Доступ отозван':d.online?'В сети':'Недоступен'}}</small><small>{{snapshotFresh(d)?'Правил':'Кэш правил'}}: {{d.rules.length}}</small></td><td><span v-if="lastJob(d)" class="badge" :class="lastJob(d)!.state">{{statusNames[lastJob(d)!.state]}}</span><span v-else class="muted">Нет операций</span><button v-if="active.some(j=>j.deviceId===d.id)" class="text-button" @click="focusedId=d.id">Есть незавершённое</button></td><td class="recommendation">{{recommendation(d)}}</td></tr>
    <tr v-if="!visible.length"><td colspan="4" class="empty">{{devices.length?'ПК не найдены. Измените поиск или фильтр.':'В клубе нет зарегистрированных ПК.'}}</td></tr>
   </tbody></table></div>
   <div class="bulk-bar"><div><b>Групповая операция · {{selected.length}} ПК</b><small>Состав будет показан перед применением и удалением.</small></div><button class="primary" :disabled="busy||!online||!selected.length||!game?.exes.length||!validVariant" @click="operation('apply_marking')">Применить к {{selected.length}} ПК</button><button :disabled="busy||!online||!selected.length||!game?.exes.length" @click="operation('remove_marking')">Удалить правила игры</button><button :disabled="busy||!online||!selected.length||!game" @click="operation('inspect_rules')">Инспекция</button><button :disabled="busy||!online||!selected.length||!game" @click="operation('health')">Проверка агента</button></div>
  </section>
  <aside class="panel pc-card" aria-label="Карточка ПК">
   <template v-if="focused"><div class="pc-card-heading"><p class="eyebrow">ОДИН КОМПЬЮТЕР</p><h2>{{focused.name}}</h2><span class="availability" :class="{online:focused.online}">{{focused.online?'В сети':'Недоступен'}}</span></div><p class="muted">{{clubName}}</p><dl class="facts"><dt>ID устройства</dt><dd class="mono">{{focused.id}}</dd><dt>Последняя связь</dt><dd>{{fmt(focused.lastSeen)}}</dd><dt>Игра</dt><dd>{{game?.name??'Не выбрана'}}</dd></dl>
    <div class="card-actions"><button class="primary" :disabled="cardBlocked||!game?.exes.length||!validVariant" @click="operation('apply_marking',[focused.id])">Применить к {{focused.name}}</button><button :disabled="cardBlocked||!game?.exes.length" @click="operation('remove_marking',[focused.id])">Удалить для {{focused.name}}</button><button :disabled="cardBlocked||!game" @click="operation('inspect_rules',[focused.id])">Проверить правила {{focused.name}}</button></div><p v-if="!focused.online" class="fine">ПК недоступен. Дождитесь связи.</p>
    <section class="card-section"><h3>Наблюдаемые правила</h3><p :class="snapshotFresh(focused)?'muted':'stale-note'">{{snapshotFresh(focused)?'Свежий снимок':'Снимок устарел / отсутствует — это не текущее подтверждение'}} · {{fmt(focused.inspectedAt)}}</p><p><b>{{rules.length}}</b> собственных правил выбранной игры<span v-if="rules.length"> · DSCP {{[...new Set(rules.map(r=>r.dscp))].join(', ')}}</span></p><p class="fine">{{focused.demo?'Состояние симулятора. Windows не проверялась.':'Наблюдение агента. Маршрут и сетевой эффект не проверяются.'}}</p></section>
    <section class="card-section"><h3>История подбора</h3><p>{{lastApplied?`Последнее успешное применение: ${lastApplied.variantName??lastApplied.variant} · ${fmt(lastApplied.finished)}`:'Успешного применения для этой игры ещё нет.'}}</p><p class="recommendation-note">{{recommendation(focused)}}</p><p class="fine">Историческая отметка сотрудника. После перезагрузки правила автоматически не восстанавливаются.</p></section>
    <section v-if="focusedActive.length" class="card-section pending-card"><h3>Требуется завершение или сверка</h3><div v-for="j in focusedActive" :key="j.id"><span class="badge" :class="j.state">{{statusNames[j.state]}}</span><p>{{j.gameName}} · {{operations[j.operation]}}</p><button @click="emit('open-job',j)">Открыть операцию {{j.id.slice(0,8)}}</button></div><p class="fine">Новая команда этому ПК заблокирована. Unknown не означает, что изменение не произошло.</p></section>

    <div v-if="lastGameJob" class="card-section"><h3>Последняя операция этой игры</h3><span class="badge" :class="lastGameJob.state">{{statusNames[lastGameJob.state]}}</span><p>{{lastGameJob.message??'Ожидание агента…'}}</p><button @click="emit('open-job',lastGameJob)">Открыть результат</button></div>
    <button class="text-button" @click="emit('history',focused.id)">История этого ПК и игры →</button>
    <details class="technical-details"><summary>Технические данные{{focused.demo?' и сценарий DEMO':''}}</summary><dl class="facts"><dt>Boot ID</dt><dd class="mono">{{focused.bootId}}</dd></dl><pre>{{JSON.stringify(focused.rules,null,2)}}</pre><template v-if="focused.demo"><label>Сценарий {{focused.name}}<select :aria-label="'Сценарий '+focused.name" :value="focused.scenario" :disabled="busy||!online" @change="emit('scenario',focused,$event)"><option v-for="(name,id) in scenarioNames" :key="id" :value="id">{{name}}</option></select></label><button :disabled="busy||!online" @click="emit('reboot',focused)">Имитировать перезагрузку</button></template></details>
   </template>
   <div v-else class="pc-placeholder"><span class="placeholder-symbol" aria-hidden="true">⌘</span><h2>Выберите компьютер</h2><p>Нажмите имя ПК в списке. Здесь появятся правила выбранной игры, история подбора и действия для одного компьютера.</p><p class="fine">Флажки в таблице служат для групповых операций.</p></div>
  </aside>
 </div>
</template>
