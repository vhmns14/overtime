// A tiny Durable Object harness for unit tests: real SQLite (node:sqlite) behind the
// ctx.storage.sql API the office uses, plus a namespace that hands out one instance per name.
import { DatabaseSync } from "node:sqlite";

export function fakeCtx() {
  const db = new DatabaseSync(":memory:");
  const sockets: { sent: string[]; send(m: string): void; close(): void }[] = [];
  let alarm: number | null = null;
  const sql = {
    exec<T = Record<string, unknown>>(query: string, ...params: unknown[]) {
      const st = db.prepare(query);
      const isRead = /^\s*(select|(?:insert|update|delete)[\s\S]*returning|with)/i.test(query);
      const rows = (isRead ? st.all(...(params as never[])) : (st.run(...(params as never[])), [])) as T[];
      return { toArray: () => rows, one: () => rows[0] };
    },
  };
  return {
    sockets,
    get alarm() { return alarm; },
    storage: { sql, setAlarm: async (t: number) => { alarm = t; }, deleteAll: async () => { db.exec("PRAGMA writable_schema = 1"); for (const r of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]) db.exec(`DELETE FROM ${r.name}`); } },
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
    getWebSockets: () => sockets,
    acceptWebSocket: () => undefined,
  };
}

export function fakeNamespace<T>(make: (ctx: ReturnType<typeof fakeCtx>) => T) {
  const objs = new Map<string, T>();
  return {
    objs,
    idFromName: (n: string) => n,
    get: (id: string) => { if (!objs.has(id)) objs.set(id, make(fakeCtx())); return objs.get(id)!; },
  };
}
