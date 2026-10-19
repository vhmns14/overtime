// Approvals for external agents. By default read-only: Hermes asks for approval in its own UI (CLI,
// TUI, Desktop, chat platform) and Overtime only shows that it is waiting.
//
// Remote control (opt-in, src/app/control.ts) provides a transport that answers Hermes *gateway*
// approvals through the office's control API; the Hermes plugin resolves them inside Hermes with
// tools.approval.resolve_gateway_approval after verifying the signed decision (docs/EVENTS.md,
// "Remote control"). The UI asks canRespond() before it renders buttons.

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
