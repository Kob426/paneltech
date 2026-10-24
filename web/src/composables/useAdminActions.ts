import { nextTick, reactive } from 'vue';
import { ApiError, type ApiClient } from './useApiClient';

// Shared shell services; form drafts belong to their component, not polling data.
export interface AdminServices {
  api: ApiClient;
  act: (action: () => Promise<void>) => Promise<void>;
  refresh: () => Promise<void>;
  selectedClubId: () => string;
  isAuthenticated: () => boolean;
  notify: (message: string) => void;
  reportError: (message: string) => void;
}

export function useAdminActions(services: AdminServices) {
  const errors = reactive<Record<string, string>>({});
  const conflicts = reactive<Record<string, boolean>>({});

  async function run(section: string, action: () => Promise<void>) {
    errors[section] = '';
    await services.act(async () => {
      try {
        await action();
      } catch (cause) {
        // The shell handles an expired session; don't leave its error in a hidden form.
        if (!services.isAuthenticated()) throw cause;
        if (cause instanceof ApiError && cause.code === 'edit_conflict') conflicts[section] = true;
        errors[section] = (cause as Error).message.replace(
          'проверьте историю после восстановления связи',
          'проверьте список после восстановления связи',
        );
        await nextTick();
        document.getElementById(section + '-error')?.focus();
      }
    });
  }

  // A committed write and a failed subsequent GET must not suggest resending the write.
  async function reloadSaved(load: () => Promise<void>) {
    try {
      await load();
    } catch {
      services.reportError('Изменения сохранены, но обновить список не удалось. Дождитесь связи и обновите список; повторно отправлять форму не нужно.');
    }
  }

  return { errors, conflicts, run, reloadSaved };
}
