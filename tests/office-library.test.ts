// Hermes skills & memory: hook/tool mapping (names only), the bookshelf model, the office reducer.
import { describe, expect, it } from "vitest";
import { mapHermes, type HermesEnvelope } from "../src/ext/hermes";
import { validateEvent, type ExtEvent } from "../src/ext/schema";
import { applyLibrary, bookLabel, newLibrary, shelf, skillKind, spineFor } from "../src/ext/library";
import { applyEvent, newOffice, type Effect } from "../src/ext/office-state";
import { hermesDemoScript, stampEnvelope } from "../src/demo/hermes-session";

const T0 = 1_792_000_000_000;
let seq = 0;
const env = (hook: string, extra: Record<string, unknown> = {}, tool?: string, input?: Record<string, unknown>): HermesEnvelope => ({ hook_event_name: hook, session_id: "s1", tool_name: tool ?? null, tool_input: input ?? null, extra });
function events(e: HermesEnvelope, ts = T0, privacy: "metadata" | "args" | "full" = "metadata"): ExtEvent[] {
  return mapHermes({ ...e, timestamp: new Date(ts).toISOString() }, privacy).map((raw) => {
    const v = validateEvent(raw, ts);
    if (!v.ok) throw new Error(v.error);
    return { ...v.event, seq: ++seq } as ExtEvent;
  });
}

describe("Hermes → skill and memory events", () => {
  it("maps on_skill_lifecycle (newer Hermes) to skill.update with the name only", () => {
    const [e] = events(env("on_skill_lifecycle", { action: "patched", skill_name: "deploy-checklist", provenance: "agent_created", use_count: 3, reused: true, task_id: "t" }));
    expect(e).toMatchObject({ type: "skill.update", data: { name: "deploy-checklist", action: "patched", source: "lifecycle", use_count: 3, provenance: "agent_created" } });
  });

  it("maps skill_manage tool calls (Hermes 0.19) to skill.update, never the skill's content", () => {
    const out = [
      ...events(env("post_tool_call", { status: "ok", tool_call_id: "c1" }, "skill_manage", { action: "create", name: "pytest-fixer", content: "SECRET BODY", category: "dev" })),
      ...events(env("post_tool_call", { status: "ok" }, "skill_manage", { action: "patch", name: "pytest-fixer", old_string: "a", new_string: "b" })),
      ...events(env("post_tool_call", { status: "ok" }, "skill_manage", { action: "edit", name: "pytest-fixer", content: "x" })),
      ...events(env("post_tool_call", { status: "ok" }, "skill_manage", { action: "delete", name: "old-skill" })),
      ...events(env("post_tool_call", { status: "ok" }, "skill_view", { name: "pytest-fixer" })),
    ].filter((e) => e.type === "skill.update");
    expect(out.map((e) => [(e.data as { name: string }).name, (e.data as { action: string }).action])).toEqual([
      ["pytest-fixer", "created"], ["pytest-fixer", "patched"], ["pytest-fixer", "edited"], ["old-skill", "deleted"], ["pytest-fixer", "viewed"],
    ]);
    expect(JSON.stringify(out)).not.toContain("SECRET BODY");
  });

  it("a failed skill_manage call changes nothing", () => {
    const out = events(env("post_tool_call", { status: "error", error_type: "ToolError" }, "skill_manage", { action: "create", name: "nope" }));
    expect(out.some((e) => e.type === "skill.update")).toBe(false);
  });

  it("maps memory writes and session_search recalls, never what was remembered", () => {
    const w = events(env("post_tool_call", { status: "ok" }, "memory", { action: "replace", target: "user", content: "User's bank PIN is 1234", old_text: "x" }), T0, "full");
    const r = events(env("post_tool_call", { status: "ok" }, "session_search", { query: "what did we do last week" }));
    expect(w.find((e) => e.type === "memory.write")).toMatchObject({ data: { action: "replace", target: "user" } });
    expect(r.find((e) => e.type === "memory.recall")).toMatchObject({ data: { source: "session_search" } });
    expect(JSON.stringify([...w, ...r].filter((e) => e.type.startsWith("memory")))).not.toMatch(/PIN|1234|last week/);
  });
});

describe("the bookshelf", () => {
  const ev = (name: string, action: string, source = "tool", ts = T0, use_count?: number) => ({ type: "skill.update" as const, ts, data: { name, action, source, ...(use_count !== undefined ? { use_count } : {}) } });

  it("a new skill is a new book at v1; each improvement adds a version; uses are counted", () => {
    const lib = newLibrary();
    expect(applyLibrary(lib, ev("deploy-checklist", "created"))).toEqual({ k: "book", name: "deploy-checklist", change: "added", versions: 1 });
    expect(applyLibrary(lib, ev("deploy-checklist", "patched", "tool", T0 + 60_000))).toMatchObject({ change: "improved", versions: 2 });
    expect(applyLibrary(lib, ev("deploy-checklist", "edited", "tool", T0 + 120_000))).toMatchObject({ change: "improved", versions: 3 });
    expect(applyLibrary(lib, ev("deploy-checklist", "loaded", "lifecycle", T0 + 180_000, 7))).toMatchObject({ change: "used" });
    expect(lib.skills["deploy-checklist"]).toMatchObject({ versions: 3, uses: 7 });
    expect(bookLabel(lib.skills["deploy-checklist"])).toBe("deploy-checklist · 3 versions · used 7×");
  });

  it("merges the tool report and the lifecycle report of the same change (either order)", () => {
    const lib = newLibrary();
    applyLibrary(lib, ev("csv-cleanup", "create", "tool"));
    expect(applyLibrary(lib, ev("csv-cleanup", "created", "lifecycle", T0 + 300))).toBeNull();
    applyLibrary(lib, ev("csv-cleanup", "patched", "lifecycle", T0 + 90_000));
    expect(applyLibrary(lib, ev("csv-cleanup", "patch", "tool", T0 + 90_400))).toBeNull();
    expect(lib.skills["csv-cleanup"].versions).toBe(2);
    // a second, later improvement from the same source still counts
    applyLibrary(lib, ev("csv-cleanup", "patched", "lifecycle", T0 + 95_000));
    expect(lib.skills["csv-cleanup"].versions).toBe(3);
  });

  it("removed skills leave the shelf; a re-created one starts over at v1", () => {
    const lib = newLibrary();
    applyLibrary(lib, ev("a", "created"));
    applyLibrary(lib, ev("b", "created"));
    applyLibrary(lib, ev("a", "patched", "tool", T0 + 50_000));
    expect(applyLibrary(lib, ev("a", "archived", "lifecycle", T0 + 100_000))).toMatchObject({ change: "removed" });
    expect(shelf(lib).map((x) => x.name)).toEqual(["b"]);
    applyLibrary(lib, ev("a", "created", "tool", T0 + 200_000));
    expect(shelf(lib).map((x) => [x.name, x.versions])).toEqual([["a", 1], ["b", 1]]);
  });

  it("a skill first seen being improved already existed (v2); unknown verbs are ignored", () => {
    const lib = newLibrary();
    expect(applyLibrary(lib, ev("legacy", "patched"))).toMatchObject({ change: "added", versions: 2 });
    expect(applyLibrary(lib, ev("legacy", "frobnicated"))).toBeNull();
    expect(skillKind("installed")).toBe("create");
    expect(skillKind("restored")).toBe("restore");
  });

  it("memory writes and recalls make the cabinet glow and are counted", () => {
    const lib = newLibrary();
    expect(applyLibrary(lib, { type: "memory.write", ts: T0, data: { action: "add", target: "memory" } })).toEqual({ k: "cabinet", op: "write" });
    expect(applyLibrary(lib, { type: "memory.recall", ts: T0 + 1, data: {} })).toEqual({ k: "cabinet", op: "recall" });
    expect(lib.memory).toMatchObject({ writes: 1, recalls: 1, lastTarget: "memory" });
  });

  it("spine colours are stable per name", () => {
    expect(spineFor("deploy-checklist")).toBe(spineFor("deploy-checklist"));
    expect(new Set(["a", "b", "c", "d", "e", "f", "g"].map((n) => spineFor(n))).size).toBeGreaterThan(2);
  });
});

describe("office reducer: library, scoreboard and reactions", () => {
  it("skill and memory events become office-wide effects and land in the library", () => {
    const st = newOffice();
    const fx: Effect[] = [];
    for (const e of [
      ...events(env("on_session_start", { model: "m", platform: "cli" })),
      ...events(env("post_tool_call", { status: "ok" }, "skill_manage", { action: "create", name: "deploy-checklist" }), T0 + 1000),
      ...events(env("post_tool_call", { status: "ok" }, "memory", { action: "add", target: "memory" }), T0 + 2000),
      ...events(env("on_session_end", { completed: true }), T0 + 3000),
    ]) fx.push(...applyEvent(st, e).effects);
    expect(fx).toContainEqual({ k: "skill", name: "deploy-checklist", change: "added", versions: 1 });
    expect(fx).toContainEqual({ k: "memory", op: "write" });
    expect(fx).toContainEqual({ k: "outcome", ok: true });
    expect(shelf(st.library).map((b) => b.name)).toEqual(["deploy-checklist"]);
    const s = st.sessions.s1;
    expect(s.log.some((l) => /new book on the shelf/.test(l.text))).toBe(true);
  });

  it("the recorded demo ends with a new skill on the shelf, a memory write and one success", () => {
    const st = newOffice();
    let clock = T0, n = 0;
    for (const [delay, e] of hermesDemoScript()) {
      clock += delay;
      for (const raw of mapHermes(stampEnvelope(e, clock, n++), "full")) {
        const v = validateEvent(raw, clock);
        if (v.ok) applyEvent(st, { ...v.event, seq: ++seq } as ExtEvent);
      }
    }
    expect(shelf(st.library).map((b) => b.name)).toEqual(["fastapi-health-endpoint"]);
    expect(st.library.memory.writes).toBe(1);
    const days = Object.values(st.board.days);
    expect(days).toHaveLength(1);
    expect(Object.values(days[0])).toEqual(["ok"]);
  });
});
