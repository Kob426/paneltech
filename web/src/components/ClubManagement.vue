<script setup lang="ts">
import { ref, watch } from 'vue';
import type { AdminClub, AdminDevice } from '../admin';
import { parseVariants, validateName } from '../adminValidation';
import { useAdminActions, type AdminServices } from '../composables/useAdminActions';
import DeviceAccessPanel from './DeviceAccessPanel.vue';

const props = defineProps<{
  clubs: AdminClub[];
  club?: AdminClub;
  devices: AdminDevice[];
  realAgents: boolean;
  services: AdminServices;
  busy: boolean;
  online: boolean;
}>();
const { errors, conflicts, run, reloadSaved } = useAdminActions(props.services);
const defaultVariants = '36:Вариант 36\n40:Вариант 40';
const editId = ref('');
const name = ref('');
const variants = ref(defaultVariants);
const version = ref(1);
const enrollment = ref('');

function newClub() {
  conflicts.club = false;
  editId.value = '';
  name.value = '';
  variants.value = defaultVariants;
  errors.club = '';
}

function editClub(club: AdminClub) {
  conflicts.club = false;
  editId.value = club.id;
  version.value = club.version ?? 1;
  name.value = club.name;
  variants.value = club.variants.map(variant => `${variant.id}:${variant.name}`).join('\n');
  errors.club = '';
}

async function saveClub() {
  await run('club', async () => {
    const saved: AdminClub = await props.services.api('/admin/clubs' + (editId.value ? '/' + editId.value : ''), editId.value ? 'PUT' : 'POST', {
      name: validateName(name.value), variants: parseVariants(variants.value), expectedVersion: version.value,
    });
    if (saved.id) {
      editId.value = saved.id;
      version.value = saved.version ?? 1;
    }
    conflicts.club = false;
    props.services.notify('Клуб сохранён.');
    await reloadSaved(props.services.refresh);
  });
}

async function reloadClub() {
  await run('club', async () => {
    const id = editId.value;
    const latest: AdminClub = await props.services.api('/admin/clubs/' + id);
    if (id === editId.value) editClub(latest);
  });
}

async function issueEnrollment() {
  enrollment.value = '';
  await props.services.act(async () => {
    const issued = await props.services.api('/admin/enrollments', 'POST', { clubId: props.club?.id });
    enrollment.value = issued.token;
    props.services.notify('Одноразовый токен действует 10 минут. Передайте его через защищённый локальный файл; не публикуйте.');
  });
}

// Track the shell selection even while this component is cached on another tab.
watch(props.services.selectedClubId, () => { enrollment.value = ''; });
</script>

<template>
  <section class="panel padded">
    <h2>Клубы и варианты</h2>
    <article v-for="item in clubs" :key="item.id" class="catalog-item">
      <b>{{ item.name }}</b>
      <small>{{ item.variants.map(variant => variant.id + ' ' + variant.name).join(' / ') }}</small>
      <button @click="editClub(item)">Редактировать</button>
    </article>
    <form aria-label="Клуб и варианты" novalidate @submit.prevent="saveClub">
      <h3>{{ editId ? 'Изменить клуб' : 'Новый клуб' }}</h3>
      <label>Название<input v-model="name" maxlength="100" aria-describedby="club-error" required></label>
      <label>Варианты, ID:название<textarea v-model="variants" rows="4" aria-describedby="club-error" required></textarea></label>
      <p v-if="errors.club" id="club-error" class="error form-error" role="alert" tabindex="-1">{{ errors.club }}</p>
      <button v-if="conflicts.club" type="button" :disabled="busy || !online" @click="reloadClub">Загрузить актуальный клуб (заменить черновик)</button>
      <button :disabled="busy || !online" class="primary">Сохранить клуб</button>
      <button type="button" @click="newClub">Новый</button>
    </form>
    <hr>
    <h3>Регистрация агента</h3>
    <p class="fine">{{ realAgents ? 'Разрешена явно на сервере. Выберите отдельный реальный клуб.' : 'Реальные агенты отключены. DEMO не подключает настоящие ПК.' }}</p>
    <button :disabled="busy || !online || !realAgents || !club || club.demo" @click="issueEnrollment">Выдать токен для {{ club?.name }}</button>
    <code v-if="enrollment" class="secret">{{ enrollment }}</code>
    <DeviceAccessPanel :devices="devices" :real-agents="realAgents" :busy="busy" :online="online" :services="services" />
  </section>
</template>
