// Хранит записанные/загруженные аудио реплик партнёра в IndexedDB браузера,
// чтобы не перезаписывать их после каждого обновления страницы.
const DB = 'chudosufler';
const STORE = 'clips';

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((res, rej) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export const saveClip = (i: number, b: Blob) => tx('readwrite', (s) => s.put(b, i));
export const deleteClip = (i: number) => tx('readwrite', (s) => s.delete(i));

export async function loadClips(indexes: number[]): Promise<Record<number, Blob>> {
  const out: Record<number, Blob> = {};
  for (const i of indexes) {
    try {
      const b = await tx<Blob | undefined>('readonly', (s) => s.get(i));
      if (b) out[i] = b;
    } catch { /* приватный режим и т.п. — просто без кэша */ }
  }
  return out;
}
