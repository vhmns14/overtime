// Core types shared by the orchestrator, the office scene and the UI.

export type Role = "pm" | "research" | "coder" | "reviewer" | "ops";
export const ROLES: Role[] = ["pm", "research", "coder", "reviewer", "ops"];

export const ROLE_INFO: Record<Role, { name: string; title: string }> = {
  pm: { name: "PM", title: "Project manager" },
  research: { name: "Research", title: "Researcher" },
  coder: { name: "Coder", title: "Engineer" },
  reviewer: { name: "Reviewer", title: "Code reviewer" },
  ops: { name: "Ops", title: "Ops engineer" },
};

export type StepId = "plan" | "research" | "code" | "review" | "deploy";
export const STEPS: { id: StepId; label: string; role: Role }[] = [
  { id: "plan", label: "Plan", role: "pm" },
  { id: "research", label: "Research", role: "research" },
  { id: "code", label: "Code", role: "coder" },
  { id: "review", label: "Review", role: "reviewer" },
  { id: "deploy", label: "Deploy", role: "ops" },
];
export type StepState = "pending" | "active" | "done" | "failed" | "skipped";

export type ToolName = "write_file" | "read_file" | "list_files" | "run_checks" | "ask_user" | "handoff" | "finish";

export interface ToolCall {
  thought: string;
  tool: ToolName;
  args: Record<string, unknown>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Usage {
  prompt: number;
  completion: number;
}

export interface CompletionRequest {
  agent: Role;
  messages: ChatMessage[];
  signal?: AbortSignal;
}

export interface CompletionResult {
  text: string;
  usage: Usage;
}

/** Anything that turns a chat into text: a real OpenAI-compatible endpoint, the demo script, or a test mock. */
export interface LLM {
  readonly label: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export interface Ticket {
  id: string;
  title: string;
  owner: Role;
  status: "todo" | "doing" | "done";
}

export type CheckStatus = "pass" | "fail" | "warn";
export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  details: string[];
}
export interface CheckReport {
  ok: boolean;
  failures: number;
  warnings: number;
  results: CheckResult[];
  totalBytes: number;
}

export type GateKind = "plan" | "review" | "deploy" | "question";
export interface GateRequest {
  id: string;
  kind: GateKind;
  agent: Role;
  title: string;
  body: string;
  /** optional list (tickets, failing checks) */
  items?: string[];
  /** optional unified-diff-ish snippet for the approval card */
  diff?: DiffLine[];
}
export type GateDecision = { action: "approve" | "reject" | "comment"; comment?: string };

export interface DiffLine {
  type: "add" | "del" | "ctx";
  text: string;
}

export interface FileVersion {
  path: string;
  content: string;
}

export interface Snapshot {
  label: string;
  files: Record<string, string>;
}

export interface AgentState {
  role: Role;
  activity: "idle" | "working" | "meeting" | "whiteboard" | "coffee" | "waiting";
  thought: string;
  log: string[];
  filesTouched: string[];
  tokens: number;
  cost: number;
}

export interface LogEntry {
  t: number;
  agent: Role | "system";
  text: string;
  level?: "info" | "warn" | "error";
}

export type RunStatus = "idle" | "running" | "paused" | "waiting" | "done" | "failed" | "cancelled" | "budget";

export interface Pricing {
  /** USD per 1M tokens */
  input: number;
  output: number;
}

export interface Gates {
  plan: boolean;
  deploy: boolean;
  review: boolean;
}

export interface RunConfig {
  task: string;
  notes?: string;
  refUrl?: string;
  gates: Gates;
  budgetUsd: number;
  pricing: Pricing;
  maxReviewRounds: number;
  maxStepsPerAgent: number;
  sizeBudgetBytes: number;
}

export type RunEvent =
  | { type: "status"; status: RunStatus }
  | { type: "log"; entry: LogEntry }
  | { type: "agent"; role: Role; state: AgentState }
  | { type: "step"; id: StepId; state: StepState; pct?: number }
  | { type: "tickets"; tickets: Ticket[] }
  | { type: "handoff"; from: Role; to: Role; summary: string }
  | { type: "files"; files: Record<string, string>; changed: string[]; by: Role }
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "checks"; report: CheckReport; round: number }
  | { type: "cost"; tokens: number; usd: number; byAgent: Record<Role, { tokens: number; usd: number }> }
  | { type: "gate"; gate: GateRequest }
  | { type: "gate-closed"; id: string; decision: GateDecision }
  | { type: "deployed"; url: string; local: boolean }
  | { type: "pushed"; url: string }
  | { type: "done"; summary: string };
