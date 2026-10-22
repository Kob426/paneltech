import { fail } from './core.js';

// Bounded, process-local failed-login windows. Proxy headers cannot bypass
// the account bucket; arbitrary names/addresses cannot grow memory forever.
export class LoginLimiter {
  private windows = new Map<string, { count: number; until: number }>();
  constructor(private limit = 10, private duration = 300_000, private capacity = 2000) {}

  check(keys: string[], now: number) {
    for (const [key, value] of this.windows) if (value.until <= now) this.windows.delete(key);
    if (keys.some(key => (this.windows.get(key)?.count ?? 0) >= this.limit)
      || this.windows.size + keys.filter(key => !this.windows.has(key)).length > this.capacity) {
      fail(429, 'rate_limit', 'Слишком много попыток входа. Подождите 5 минут.');
    }
  }

  failed(keys: string[], now: number) {
    for (const key of keys) {
      const window = this.windows.get(key) ?? { count: 0, until: now + this.duration };
      window.count++;
      this.windows.set(key, window);
    }
  }
}
