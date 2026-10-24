import { computed, onUnmounted, ref } from 'vue';

export type ApiClient = ReturnType<typeof useApiClient>['api'];

export class ApiError extends Error {
  constructor(message: string, public status = 0,public code='') { super(message); }
}

// Only GET polling is retried by the caller. Mutations are never replayed here.
export function useApiClient(csrf: { value: string }, onUnauthorized: () => void) {
  const connection = ref<'connecting' | 'online' | 'offline' | 'reconnecting'>('connecting');
  const lastResponse = ref<number | null>(null);
  const controllers = new Set<AbortController>();
  let sequence = 0;
  let settled = 0;
  let disposed = false;
  const connectionLabel = computed(() => ({
    connecting: 'Проверка связи с API', online: 'API подключён',
    offline: 'API недоступен', reconnecting: 'Восстановление связи с API',
  })[connection.value]);

  async function api(path: string, method = 'GET', body?: unknown) {
    if (method !== 'GET' && path !== '/login' && connection.value !== 'online') {
      throw new ApiError('Нет подтверждённой связи с API. Дождитесь восстановления; действие не отправлено.');
    }
    const id = ++sequence;
    if (connection.value === 'offline') connection.value = 'reconnecting';
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 6000);
    const mark = (available: boolean) => {
      if (disposed || id < settled) return;
      settled = id;
      connection.value = available ? 'online' : 'offline';
      if (available) lastResponse.value = Date.now();
    };
    try {
      const response = await fetch('/api' + path, {
        method, credentials: 'same-origin', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.value },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.status >= 500) throw new Error('API temporarily unavailable');
      const result = await response.json();
      mark(true); // A 400/401/403 is a reachable API, not a transport outage.
      if (!response.ok) {
        if (response.status === 401 && path !== '/login') onUnauthorized();
        throw new ApiError(result.message ?? 'Ошибка запроса', response.status,result.code);
      }
      return result;
    } catch (cause) {
      if (cause instanceof ApiError) throw cause;
      mark(false);
      const message = method === 'GET'
        ? 'Нет ответа API. Показан последний загруженный снимок; актуальность не подтверждена.'
        : 'Ответ API не получен. Действие могло быть выполнено: проверьте историю после восстановления связи, прежде чем повторять.';
      throw new ApiError(message);
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  }

  onUnmounted(() => { disposed = true; controllers.forEach(c => c.abort()); });
  return { api, connection, connectionLabel, lastResponse };
}
