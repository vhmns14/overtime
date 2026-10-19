// localStorage that degrades to memory: sandboxed iframes (the single-file preview) throw on access.
const mem = new Map<string, string>();
let available: boolean | null = null;

function ls(): Storage | null {
  if (available === false) return null;
  try {
    const s = globalThis.localStorage;
    const k = "__ot_probe";
    s.setItem(k, "1");
    s.removeItem(k);
    available = true;
    return s;
  } catch {
    available = false;
    return null;
  }
}

export const store = {
  get persistent() {
    return ls() !== null;
  },
  get(key: string): string | null {
    const s = ls();
    try {
      return s ? s.getItem(key) : mem.get(key) ?? null;
    } catch {
      return mem.get(key) ?? null;
    }
  },
  set(key: string, value: string) {
    const s = ls();
    try {
      if (s) s.setItem(key, value);
      else mem.set(key, value);
    } catch {
      mem.set(key, value); // quota exceeded: keep in memory for this session
    }
  },
  remove(key: string) {
    const s = ls();
    try {
      s?.removeItem(key);
    } catch {
      /* ignore */
    }
    mem.delete(key);
  },
  getJSON<T>(key: string, fallback: T): T {
    const v = this.get(key);
    if (!v) return fallback;
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  },
  setJSON(key: string, value: unknown) {
    this.set(key, JSON.stringify(value));
  },
};

/** Session-only store for secrets (API key, GitHub token): sessionStorage, else memory. Never localStorage unless the user opts in. */
export const secretStore = {
  get(key: string, remember: boolean): string {
    try {
      return (remember ? globalThis.localStorage : globalThis.sessionStorage).getItem(key) ?? mem.get("s:" + key) ?? "";
    } catch {
      return mem.get("s:" + key) ?? "";
    }
  },
  set(key: string, value: string, remember: boolean) {
    mem.set("s:" + key, value);
    try {
      globalThis.sessionStorage.setItem(key, value);
      if (remember) globalThis.localStorage.setItem(key, value);
      else globalThis.localStorage.removeItem(key);
    } catch {
      /* memory only */
    }
  },
  clear(key: string) {
    mem.delete("s:" + key);
    try {
      globalThis.sessionStorage.removeItem(key);
      globalThis.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};
