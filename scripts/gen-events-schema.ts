// Writes docs/events.schema.json (JSON Schema 2020-12) from the validator's own field spec, so the
// published schema can never drift from what the Worker accepts. Run: npx vite-node scripts/gen-events-schema.ts
import { writeFileSync } from "node:fs";
import { DATA_SPEC, EVENT_TYPES, LIMITS, SCHEMA_ID } from "../src/ext/schema";

const DESCRIBE: Record<string, string> = {
  "session.start": "A conversation/session began (Hermes: on_session_start). Offices are long-lived; each session is listed separately.",
  "session.end": "A turn or session ended. final=true when the session identity is torn down (Hermes: on_session_finalize).",
  "agent.thinking": "The agent is thinking or about to call its model. Shown at the PM's desk.",
  "llm.call": "One model API call with token usage and, when known, its cost in USD. Feeds the cost meter.",
  "tool.start": "A tool call began. args_summary/target are already trimmed to the sender's privacy level.",
  "tool.end": "A tool call finished (ok or not), with its duration.",
  "file.write": "A file was written, edited, patched or deleted.",
  "plan.update": "The agent's current plan / todo list. Shown as stickies on the whiteboard.",
  "subagent.start": "A delegated child agent started. It borrows a free desk; events with agent=<id> (or session=child_session) are shown there.",
  "subagent.stop": "A delegated child agent finished or failed.",
  "approval.request": "The agent is waiting for a human to approve something in its own UI. Overtime shows it read-only.",
  "approval.response": "The approval was answered (once, session, always, deny, timeout, cancelled).",
  "human_input.request": "The agent is blocked on a person (clarify question, sudo password, approval).",
  "human_input.resolved": "The wait for a person ended.",
  message: "A user or assistant message (only sent at the 'full' privacy level).",
  error: "Something went wrong (provider error, crash).",
  "skill.update": "A skill changed (created, patched, edited, loaded, viewed, installed, archived, restored, deleted). Name only. The office bookshelf gains a book per skill; improvements add versions.",
  "memory.write": "The agent wrote to its memory (add, replace, remove). Never the content. The filing cabinet glows.",
  "memory.recall": "The agent recalled memory or past sessions. The filing cabinet glows.",
};

const fieldSchema = (f: (typeof DATA_SPEC)[keyof typeof DATA_SPEC][string]) => {
  switch (f.t) {
    case "string": return { type: "string", maxLength: f.max ?? LIMITS.str };
    case "number": return { type: "number", minimum: 0 };
    case "boolean": return { type: "boolean" };
    case "enum": return { type: "string", enum: f.values };
    case "items": return {
      type: "array", maxItems: LIMITS.planItems,
      items: { type: "object", required: ["text"], properties: { id: { type: "string", maxLength: 64 }, text: { type: "string", maxLength: 200 }, status: { type: "string", enum: ["todo", "doing", "done", "cancelled"] } } },
    };
  }
};

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: `https://github.com/vhmns14/overtime/docs/events.schema.json#${SCHEMA_ID}`,
  title: "Overtime external-agent event (v1)",
  description: "One event an agent sends to an Overtime office. POST one, an array, or {\"events\": [...]} (max 200, 256 KB per request) to /api/ext/runs/<office>/events with Authorization: Bearer <ingest token>. Unknown data fields are dropped; strings are clipped; secrets are redacted before storage.",
  type: "object",
  required: ["type", "data"],
  additionalProperties: false,
  properties: {
    v: { const: 1, description: "Schema version. Optional; 1 if omitted." },
    type: { enum: [...EVENT_TYPES] },
    ts: { description: "Epoch milliseconds, epoch seconds, or an ISO-8601 string. Defaults to the time the server received it.", oneOf: [{ type: "number", minimum: 0 }, { type: "string", format: "date-time" }] },
    session: { type: "string", pattern: "^[\\w.:@/-]{1,128}$", description: "The agent's session/conversation id. Default 'default'." },
    agent: { type: "string", pattern: "^[\\w.:@/-]{1,128}$", description: "'main' (default) or a subagent id from subagent.start." },
    id: { type: "string", pattern: "^[\\w.:@/-]{1,128}$", description: "Optional idempotency key; a repeated id is ignored." },
    data: { type: "object" },
  },
  allOf: EVENT_TYPES.map((t) => {
    const spec = DATA_SPEC[t];
    const required = Object.entries(spec).filter(([, f]) => f.req).map(([k]) => k);
    return {
      if: { properties: { type: { const: t } } },
      then: {
        description: DESCRIBE[t],
        properties: { data: { type: "object", properties: Object.fromEntries(Object.entries(spec).map(([k, f]) => [k, fieldSchema(f)])), ...(required.length ? { required } : {}) } },
      },
    };
  }),
};

writeFileSync("docs/events.schema.json", JSON.stringify(schema, null, 2) + "\n");
console.log(`docs/events.schema.json: ${EVENT_TYPES.length} event types`);
