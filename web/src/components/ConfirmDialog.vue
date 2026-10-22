<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
const props = defineProps<{ open: boolean; disabled?: boolean; confirmText: string }>();
const emit = defineEmits<{ close: []; confirm: [] }>();
const dialog = ref<HTMLDialogElement | null>(null);
const cancel = ref<HTMLButtonElement | null>(null);
let opener: HTMLElement | null = null;
let previousOverflow = '';

function restore() {
  document.body.style.overflow = previousOverflow;
  if (opener?.isConnected) opener.focus();
  opener = null;
}
watch(() => props.open, async open => {
  await nextTick();
  if (!dialog.value || open !== props.open) return;
  if (open && !dialog.value.open) {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    previousOverflow = document.body.style.overflow;
    dialog.value.showModal();
    document.body.style.overflow = 'hidden';
    cancel.value?.focus(); // Starting on Cancel prevents an accidental Enter from executing.
  } else if (!open && dialog.value.open) {
    dialog.value.close();
    restore();
  }
}, { immediate: true, flush: 'post' });
function keydown(event: KeyboardEvent) {
  if (event.key !== 'Tab') return;
  const buttons = Array.from(dialog.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
  const first = buttons[0], last = buttons.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
function submit() {
  if (props.disabled) return;
  dialog.value?.close();
  restore();
  emit('confirm');
}
function backdrop(event: MouseEvent) {
  const element = dialog.value;
  if (!element || event.target !== element) return;
  const rect = element.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) emit('close');
}
onBeforeUnmount(() => { if (dialog.value?.open) { dialog.value.close(); restore(); } });
</script>

<template>
  <dialog ref="dialog" class="modal" aria-labelledby="confirm-title" aria-describedby="confirm-description"
    @cancel.prevent="emit('close')" @keydown="keydown" @click="backdrop">
    <slot />
    <div class="modal-actions">
      <button ref="cancel" type="button" @click="emit('close')">Отмена</button>
      <button type="button" class="primary" :disabled="disabled" @click="submit">{{ confirmText }}</button>
    </div>
  </dialog>
</template>
