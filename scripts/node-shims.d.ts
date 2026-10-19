// Minimal Node typings for the smoke script and its test (the repo has no @types/node).
declare module "node:fs" {
  export function mkdirSync(p: string, o?: { recursive?: boolean }): void;
  export function writeFileSync(p: string, d: string): void;
  export function readFileSync(p: string, e: "utf8"): string;
  export function readFileSync(p: string): Uint8Array;
  export function mkdtempSync(prefix: string): string;
}
declare module "node:path" {
  export function join(...p: string[]): string;
  export function dirname(p: string): string;
}
declare module "node:zlib" {
  export function inflateSync(d: Uint8Array): Uint8Array;
}
declare module "node:os" {
  export function tmpdir(): string;
}
declare const process: { env: Record<string, string | undefined>; exitCode?: number };
declare module "node:crypto" {
  interface Hmac { update(d: string | Uint8Array): Hmac; digest(enc: "hex"): string }
  export function createHmac(alg: string, key: string | Uint8Array): Hmac;
}
declare const Buffer: { from(s: string, enc?: "utf8"): Uint8Array };
