// Stand-in for the "cloudflare:workers" module in unit tests.
export class DurableObject<Env = unknown> {
  constructor(public ctx: unknown, public env: Env) {}
}
