// Minimal Node typings for the smoke script and its test (the repo has no @types/node).
declare module "node:fs" {
  export function mkdirSync(p: string, o?: { recursive?: boolean }): void;
  export function writeFileSync(p: string, d: string): void;
  export function readFileSync(p: string, e: "utf8"): string;
  export function mkdtempSync(prefix: string): string;
}
declare module "node:path" {
  export function join(...p: string[]): string;
  export function dirname(p: string): string;
}
declare module "node:os" {
  export function tmpdir(): string;
}
declare const process: { env: Record<string, string | undefined>; exitCode?: number };
