// Approvals for external agents. v1 is read-only on purpose: Hermes asks for approval in its own
// UI (CLI, TUI, Desktop, chat platform) and Overtime only shows that it is waiting.
//
// Extension point: a future transport can implement `respond`, e.g. through Hermes' approval
// transport API (`ctx.register_approval_transport(name, present_fn)` with
// `security.approval.transport` selected by the operator), where the plugin long-polls Overtime for
// an authenticated decision and returns `request.respond(choice)`. The UI already asks
// `canRespond()` before it would render buttons, so adding it is a contained change.

export type ApprovalChoice = "once" | "session" | "always" | "deny";

export interface ApprovalTransport {
  readonly name: string;
  canRespond(): boolean;
  respond(requestId: string, choice: ApprovalChoice): Promise<{ ok: boolean; error?: string }>;
}

export const READ_ONLY_APPROVALS: ApprovalTransport = {
  name: "read-only",
  canRespond: () => false,
  respond: async () => ({ ok: false, error: "Overtime v1 does not answer approvals; answer in Hermes." }),
};
