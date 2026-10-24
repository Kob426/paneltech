<script setup lang="ts">
import { nextTick, onActivated, ref } from 'vue';
import type { AdminEmployee } from '../admin';
import { validateUser } from '../adminValidation';
import { ApiError } from '../composables/useApiClient';
import { useAdminActions, type AdminServices } from '../composables/useAdminActions';
import PasswordResetDialog from './PasswordResetDialog.vue';

const props = defineProps<{ userId: string; services: AdminServices; busy: boolean; online: boolean }>();
const { errors, run, reloadSaved } = useAdminActions(props.services);
const users = ref<AdminEmployee[]>([]);
const loading = ref(false);
const loadError = ref('');
const username = ref('');
const password = ref('');
const role = ref<AdminEmployee['role']>('operator');
const resetTarget = ref<{ id: string; username: string; version: number } | null>(null);

async function loadUsers() {
  loading.value = true;
  loadError.value = '';
  try {
    users.value = await props.services.api('/admin/users');
  } catch (cause) {
    loadError.value = (cause as Error).message;
    throw cause;
  } finally {
    loading.value = false;
  }
}

async function addUser() {
  await run('new-user', async () => {
    validateUser(username.value, password.value);
    await props.services.api('/admin/users', 'POST', { username: username.value, password: password.value, role: role.value });
    password.value = '';
    props.services.notify('Пользователь создан.');
    await reloadSaved(loadUsers);
  });
}

async function updateUser(user: AdminEmployee) {
  await run('users', async () => {
    try {
      const saved: AdminEmployee = await props.services.api('/admin/users/' + user.id, 'PUT', {
        role: user.role, disabled: user.disabled, expectedVersion: user.version ?? 1,
      });
      users.value = users.value.map(item => item.id === saved.id ? saved : item);
      props.services.notify('Настройки сотрудника сохранены.');
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'edit_conflict') user.conflict = true;
      throw cause;
    }
  });
}

async function reloadUser(id: string) {
  await run('users', async () => {
    const listed: AdminEmployee[] = await props.services.api('/admin/users');
    const latest = listed.find(user => user.id === id);
    if (latest) users.value = users.value.map(user => user.id === id ? latest : user);
    errors.users = '';
  });
}

async function resetEmployeePassword(id: string, newPassword: string) {
  try {
    await props.services.api('/admin/users/' + id + '/password', 'POST', { password: newPassword, expectedVersion: resetTarget.value?.version });
  } catch (cause) {
    if (cause instanceof ApiError && cause.code === 'edit_conflict') {
      const user = users.value.find(item => item.id === id);
      if (user) user.conflict = true;
      throw new ApiError(cause.message + ' Закройте окно и загрузите актуальные данные сотрудника.', cause.status, cause.code);
    }
    throw cause;
  }
}

async function passwordResetSaved(name: string) {
  const id = resetTarget.value?.id;
  resetTarget.value = null;
  await props.services.act(async () => {
    await reloadSaved(loadUsers);
    props.services.notify(`Пароль сотрудника ${name} изменён. Прежние сеансы завершены.`);
  });
  await nextTick();
  if (id) document.querySelector<HTMLButtonElement>(`button[data-reset-user="${id}"]`)?.focus();
}

// Refresh staff only on entering management; polling must not overwrite role drafts.
onActivated(() => { void props.services.act(loadUsers); });
</script>

<template>
  <section class="panel padded">
    <h2>Сотрудники</h2>
    <p class="muted">Создавайте отдельные аккаунты. Оператор выполняет задания и сохраняет отметки; администратор управляет доступом.</p>
    <p v-if="loading" role="status">Загрузка сотрудников…</p>
    <div v-if="loadError" class="error" role="alert">
      {{ loadError }}
      <button :disabled="busy || !online" @click="run('users', loadUsers)">Повторить загрузку сотрудников</button>
    </div>
    <p v-if="errors.users" id="users-error" class="error form-error" role="alert" tabindex="-1">{{ errors.users }}</p>
    <div v-for="user in users" :key="user.id" class="user-row">
      <b>{{ user.username }}</b>
      <select v-model="user.role" :aria-label="'Роль ' + user.username" :disabled="busy || !online || user.id === userId">
        <option value="admin">Администратор</option><option value="operator">Оператор</option>
      </select>
      <label class="inline"><input v-model="user.disabled" type="checkbox" :disabled="user.id === userId">Отключён</label>
      <button :disabled="busy || !online || user.id === userId" @click="updateUser(user)">Сохранить</button>
      <button v-if="user.conflict" :disabled="busy || !online" @click="reloadUser(user.id)">Загрузить актуальные данные {{ user.username }}</button>
      <button :disabled="busy || !online || user.id === userId" :data-reset-user="user.id" :aria-label="'Сбросить пароль ' + user.username" @click="resetTarget = { id: user.id, username: user.username, version: user.version ?? 1 }">Сбросить пароль</button>
    </div>
    <form aria-label="Новый сотрудник" novalidate @submit.prevent="addUser">
      <h3>Добавить сотрудника</h3>
      <label>Логин<input v-model="username" maxlength="50" aria-describedby="new-user-error" required pattern="[a-zA-Z0-9_.-]{3,50}"></label>
      <label>Пароль, минимум 12 символов<input v-model="password" type="password" minlength="12" maxlength="200" aria-describedby="new-user-error" autocomplete="new-password" required></label>
      <label>Роль<select v-model="role"><option value="operator">Оператор</option><option value="admin">Администратор</option></select></label>
      <p v-if="errors['new-user']" id="new-user-error" class="error form-error" role="alert" tabindex="-1">{{ errors['new-user'] }}</p>
      <button class="primary" :disabled="busy || !online">Создать пользователя</button>
    </form>
    <PasswordResetDialog :target="resetTarget" :online="online" :reset="resetEmployeePassword" @close="resetTarget = null" @saved="passwordResetSaved" />
  </section>
</template>
