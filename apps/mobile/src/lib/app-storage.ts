/**
 * The client's key/value store.
 *
 * Everywhere the app runs there is a `localStorage`; the one exception is the
 * test runner, where the DOM shim may hand back an environment without one.
 * Rather than sprinkle try/catch around that, callers get one store that is
 * real storage when it works and an in-memory map when it does not — the app
 * behaves the same for a session, tests get deterministic behaviour.
 */

export type KeyValueStore = {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
};

let resolved: KeyValueStore | null = null;

function memoryStore(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => {
      map.set(key, value);
    },
    remove: (key) => {
      map.delete(key);
    },
  };
}

export function appStorage(): KeyValueStore {
  if (resolved) return resolved;

  const candidate = (globalThis as { localStorage?: Storage }).localStorage;
  if (candidate) {
    try {
      const probe = "qn.storage.probe";
      candidate.setItem(probe, "1");
      candidate.removeItem(probe);
      resolved = {
        get: (key) => candidate.getItem(key),
        set: (key, value) => candidate.setItem(key, value),
        remove: (key) => candidate.removeItem(key),
      };
      return resolved;
    } catch {
      // Private mode, quota, or a shim without storage: fall through.
    }
  }

  resolved = memoryStore();
  return resolved;
}

/** Test seam: drop the resolved store so the next call re-probes. */
export function resetAppStorageForTests(): void {
  resolved = null;
}
