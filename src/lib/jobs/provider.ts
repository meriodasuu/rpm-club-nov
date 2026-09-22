/** Safe provider errors: never retain response bodies, URLs or credentials. */
export class ProviderError extends Error {
  constructor(public provider: string, public status: number, public retryAfterSeconds?: number) {
    super(`${provider}:${status}`);
  }
  get permanent() { return this.status >= 400 && this.status < 500 && ![401, 408, 409, 429].includes(this.status); }
}
export function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = /^\d+$/.test(value) ? Number(value) : (Date.parse(value) - Date.now()) / 1000;
  return Number.isFinite(seconds) ? Math.max(1, Math.min(seconds, 7 * 86400)) : undefined;
}
export function retryDelay(attempt: number, providerDelay?: number, random = Math.random) {
  if (providerDelay !== undefined) return Math.max(1, providerDelay) * 1000;
  const schedule = [60, 300, 900, 3600, 21600, 86400];
  return Math.round(schedule[Math.min(Math.max(attempt - 1, 0), schedule.length - 1)] * (0.85 + random() * 0.3) * 1000);
}
