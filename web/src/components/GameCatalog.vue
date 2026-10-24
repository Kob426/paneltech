<script setup lang="ts">
import { ref } from 'vue';
import type { AdminGame } from '../admin';
import { parseExes, validateName } from '../adminValidation';
import { useAdminActions, type AdminServices } from '../composables/useAdminActions';

const props = defineProps<{ games: AdminGame[]; services: AdminServices; busy: boolean; online: boolean }>();
const { errors, conflicts, run, reloadSaved } = useAdminActions(props.services);
const editId = ref('');
const name = ref('');
const exes = ref('');
const version = ref(1);

function newGame() {
  conflicts.game = false;
  editId.value = '';
  name.value = '';
  exes.value = '';
  errors.game = '';
}

function edit(game: AdminGame) {
  conflicts.game = false;
  editId.value = game.id;
  version.value = game.revision;
  name.value = game.name;
  exes.value = game.exes.join('\n');
  errors.game = '';
}

async function saveGame() {
  await run('game', async () => {
    await props.services.api('/admin/games' + (editId.value ? '/' + editId.value : ''), editId.value ? 'PUT' : 'POST', {
      name: validateName(name.value), exes: parseExes(exes.value), expectedVersion: version.value,
    });
    newGame();
    props.services.notify('Каталог сохранён. Старые задания сохранили свою ревизию.');
    await reloadSaved(props.services.refresh);
  });
}

async function reloadGame() {
  await run('game', async () => {
    const id = editId.value;
    const latest: AdminGame = await props.services.api('/admin/games/' + id);
    if (id === editId.value) edit(latest);
  });
}
</script>

<template>
  <div class="two-columns">
    <section class="panel padded">
      <h2>Каталог игр</h2>
      <p class="muted">Fortnite — стартовый набор пользователя, без аудита актуальных файлов. PUBG — пустая карточка.</p>
      <p v-if="!games.length" class="empty-state">Игр пока нет. Создайте первую карточку в форме «Новая игра».</p>
      <article v-for="game in games" :key="game.id" class="catalog-item">
        <b>{{ game.name }}</b>
        <small>Ревизия {{ game.revision }} · {{ game.exes.length }} exe</small>
        <code v-for="exe in game.exes" :key="exe">{{ exe }}</code>
        <button @click="edit(game)">Редактировать</button>
      </article>
    </section>
    <form class="panel padded" aria-label="Карточка игры" novalidate @submit.prevent="saveGame">
      <h2>{{ editId ? 'Изменить игру' : 'Новая игра' }}</h2>
      <label>Название<input v-model="name" maxlength="100" aria-describedby="game-error" required></label>
      <label>Имена exe, по одному в строке<textarea v-model="exes" rows="9" placeholder="EpicGamesLauncher.exe"></textarea></label>
      <p class="fine">Только имена файлов .exe. Пути, команды, аргументы и PowerShell запрещены. Изменение создаёт новую ревизию.</p>
      <p v-if="errors.game" id="game-error" class="error form-error" role="alert" tabindex="-1">{{ errors.game }}</p>
      <button v-if="conflicts.game" type="button" :disabled="busy || !online" @click="reloadGame">Загрузить актуальную игру (заменить черновик)</button>
      <button class="primary" :disabled="busy || !online">Сохранить игру</button>
      <button type="button" @click="newGame">Новая карточка</button>
    </form>
  </div>
</template>
