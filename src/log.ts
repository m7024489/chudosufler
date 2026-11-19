import { useSyncExternalStore } from 'react';

export type Level = 'info' | 'warn' | 'error';
export interface LogEntry { t: number; level: Level; msg: string }

const t0 = performance.now();
let entries: LogEntry[] = [];
const listeners = new Set<() => void>();

export function log(msg: string, level: Level = 'info') {
  const e = { t: (performance.now() - t0) / 1000, level, msg };
  entries = [...entries.slice(-499), e];
  (level === 'info' ? console.log : level === 'warn' ? console.warn : console.error)(`[суфлёр] ${msg}`);
  listeners.forEach((f) => f());
}

export function errText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

export function logAsText(): string {
  return entries.map((e) => `${e.t.toFixed(2).padStart(8)}s ${e.level.toUpperCase().padEnd(5)} ${e.msg}`).join('\n');
}

export function useLog(): LogEntry[] {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => entries,
  );
}

window.addEventListener('error', (e) => log(`window.onerror: ${e.message}`, 'error'));
window.addEventListener('unhandledrejection', (e) => log(`unhandledrejection: ${errText(e.reason)}`, 'error'));
window.addEventListener('online', () => log('Сеть: online'));
window.addEventListener('offline', () => log('Сеть: offline (для этапа 1 сеть после загрузки не нужна)', 'warn'));
document.addEventListener('visibilitychange', () => log(`Видимость страницы: ${document.visibilityState}`, document.hidden ? 'warn' : 'info'));
