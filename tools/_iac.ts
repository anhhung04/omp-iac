/**
 * Shared plumbing for the Infrastructure-as-Code (IaC) plugin tools.
 *
 * Every tool shells out to the real CLI (`tofu`, `ansible-*`, `pulumi`, `floci`)
 * instead of re-implementing their APIs: the CLIs already own provider
 * negotiation, credential helpers, plugin caches and stack backends.
 *
 * Two things every tool here needs and the raw `pi.exec` does not give it:
 *
 * 1. **Per-call environment variables.** `ExecOptions` carries only
 *    `signal`/`timeout`/`cwd`, so a tool cannot pass `env`. Endpoint overrides
 *    for local cloud emulation must therefore be prepended to the command line
 *    through `env(1)`: `env AWS_ENDPOINT_URL=... tofu plan`. Nothing leaks into
 *    the parent process, and nothing has to be restored afterwards.
 *
 * 2. **Secret redaction.** IaC CLIs echo cloud tokens, backend credentials and
 *    emulator endpoint values back on failure. Everything returned to the model
 *    goes through `redact()`.
 *
 * Binary resolution honours `$TOFU_BIN`, `$ANSIBLE_BIN`, `$PULUMI_BIN` and
 * `$FLOCI_BIN` (each may be a full command line, e.g. `"podman compose"`).
 */

import type { AgentToolResult, ExecOptions, ExecResult } from "@oh-my-pi/pi-coding-agent";

export type ExecFn = (
  command: string,
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

export interface RunResult extends ExecResult {
  /** Human-readable command that was executed, with env assignments shown. */
  command: string;
  /** True when killed by our own timeout rather than the caller's abort signal. */
  timedOut: boolean;
}

export interface RunOptions {
  signal?: AbortSignal;
  cwd?: string;
  timeoutMs?: number;
  /** Extra `KEY=VALUE` environment entries applied to this call only. */
  env?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_CHARS = 16_000;

/**
 * Split `$NAME_BIN` into a command plus leading arguments so a user can point
 * the plugin at `podman`, `terraform`, or a wrapper script.
 */
export function resolveBin(name: string, fallback: string): { cmd: string; baseArgs: string[] } {
  const raw = process.env[name]?.trim();
  if (raw) {
    const [cmd, ...baseArgs] = raw.split(/\s+/);
    if (cmd) return { cmd, baseArgs };
  }
  return { cmd: fallback, baseArgs: [] };
}

function displayArg(arg: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

/** Render `KEY=VALUE cmd args` for the transcript, redacting secret values. */
export function formatCommand(cmd: string, args: string[], env?: Record<string, string>): string {
  const assignments = Object.entries(env ?? {}).map(
    ([key, value]) => `${key}=${displayArg(redactValue(key, value))}`,
  );
  return [...assignments, cmd, ...args].map(displayArg).join(" ");
}

/**
 * Resolve the workspace CLI to invoke. OpenTofu and Terraform share one command
 * grammar (both descend from Terraform 1.5.6), so the plugin can drive either:
 * explicit engine choice wins when both are installed.
 */
export function resolveEngineBin(engine: "tofu" | "terraform"): { cmd: string; baseArgs: string[] } {
  if (engine === "terraform") return resolveBin("TERRAFORM_BIN", "terraform");
  return resolveBin("TOFU_BIN", "tofu");
}

/**
 * Run one IaC CLI. `env` entries are applied by prefixing the invocation with
 * `env(1)` because `pi.exec` has no environment option; this keeps the override
 * scoped to this call.
 */
export async function run(
  exec: ExecFn,
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const envEntries = Object.entries(opts.env ?? {}).filter(([, v]) => v !== undefined && v !== "");
  const preamble = envEntries.length > 0 ? ["env", ...envEntries.map(([k, v]) => `${k}=${v}`)] : [];
  const argv = [...preamble, cmd, ...args];
  // returning a non-zero result. Treat that as exit 127 so every tool's
  // missingCliHint() turns it into an install instruction instead of a crash.
  let res: ExecResult;
  try {
    res = await exec(argv[0] ?? cmd, argv.slice(1), {
      signal: opts.signal,
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  } catch (error) {
    res = {
      stdout: "",
      stderr: `${cmd}: command not found (${(error as Error).message})`,
      code: 127,
      killed: false,
    };
  }
  return {
    ...res,
    command: formatCommand(cmd, args, Object.fromEntries(envEntries)),
    timedOut: res.killed && !opts.signal?.aborted,
    stdout: redact(res.stdout),
    stderr: redact(res.stderr),
  };
}

export async function runTofu(exec: ExecFn, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const { cmd, baseArgs } = resolveBin("TOFU_BIN", "tofu");
  return run(exec, cmd, [...baseArgs, ...args], opts);
}

export async function runPulumi(exec: ExecFn, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const { cmd, baseArgs } = resolveBin("PULUMI_BIN", "pulumi");
  return run(exec, cmd, [...baseArgs, ...args], opts);
}

export async function runFloci(exec: ExecFn, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const { cmd, baseArgs } = resolveBin("FLOCI_BIN", "floci");
  return run(exec, cmd, [...baseArgs, ...args], opts);
}

/** `ansible`, `ansible-playbook`, `ansible-inventory`, `ansible-lint`, … */
export async function runAnsible(
  exec: ExecFn,
  tool: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const { cmd, baseArgs } = resolveBin("ANSIBLE_BIN", "");
  if (cmd) return run(exec, cmd, [...baseArgs, tool, ...args], opts);
  return run(exec, sanitizeAnsibleBin(tool), args, opts);
}

const ANSIBLE_BINS: Record<string, string> = {
  playbook: "ansible-playbook",
  inventory: "ansible-inventory",
  config: "ansible-config",
  lint: "ansible-lint",
  galaxy: "ansible-galaxy",
  vault: "ansible-vault",
  ad_hoc: "ansible",
};

export function sanitizeAnsibleBin(tool: string): string {
  return ANSIBLE_BINS[tool] ?? `ansible-${tool}`;
}

export function ok(body: string, details?: unknown): AgentToolResult {
  return { content: [{ type: "text", text: body }], details };
}

export function fail(body: string): AgentToolResult {
  return { content: [{ type: "text", text: body }], isError: true };
}

/** Truncate long output while keeping the start and the end. */
export function clamp(value: string, max = DEFAULT_MAX_CHARS, mode: "middle" | "tail" = "middle"): string {
  if (value.length <= max) return value;
  if (mode === "tail") {
    return `... [${value.length - max} chars truncated] ...\n${value.slice(-max)}`;
  }
  const head = value.slice(0, Math.floor(max * 0.4));
  const tail = value.slice(-Math.floor(max * 0.55));
  const notice = `\n... [${value.length - head.length - tail.length} chars truncated] ...\n`;
  return `${head}${notice}${tail}`;
}

/** Merge stdout and stderr without pretending the interleaving is preserved. */
export function streams(res: { stdout: string; stderr: string }): string {
  const out = res.stdout.replace(/\s+$/, "");
  const err = res.stderr.replace(/\s+$/, "");
  if (out && err) return `${out}\n--- stderr ---\n${err}`;
  return out || err;
}

/** Result for a command whose exit code matters. Output is always included. */
export function commandResult(
  action: string,
  res: RunResult,
  opts: { maxChars?: number; mode?: "middle" | "tail"; note?: string } = {},
): AgentToolResult {
  const body = clamp(streams(res), opts.maxChars ?? DEFAULT_MAX_CHARS, opts.mode ?? "middle");
  const status = `exit ${res.code}${res.timedOut ? ", timed out" : ""}`;
  if (res.code !== 0) return fail(`${action} (${status})\n${body || "(no output)"}`);
  return ok(`${action} (${status})${opts.note ? ` — ${opts.note}` : ""}\n${body || "(no output)"}`);
}

/* ---------------------------------------------------------------- secrets --- */

/**
 * Environment keys whose values must never reach the transcript, keyed so the
 * matcher is a static lookup rather than a rebuilt regex.
 */
const SECRET_KEY_PATTERN =
  /^(?:.*_)?(?:SECRET|TOKEN|PASSWORD|PASSWD|ACCESS_KEY|API_KEY|CREDENTIALS?|SESSION_TOKEN|PRIVATE_KEY|AUTH)(?:_.*)?$/;

const VALUE_PATTERNS: RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bpul-[a-f0-9]{40}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

export function redactValue(key: string, value: string): string {
  if (SECRET_KEY_PATTERN.test(key)) return "***redacted***";
  let out = value;
  for (const pattern of VALUE_PATTERNS) out = out.replace(pattern, "***redacted***");
  return out;
}

/** Strip credential-looking tokens from CLI output before returning it. */
export function redact(text: string): string {
  if (!text) return text;
  let out = text;
  for (const pattern of VALUE_PATTERNS) out = out.replace(pattern, "***redacted***");
  return out.replace(
    /\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|ACCESS_KEY|API_KEY|CREDENTIALS?)[A-Z0-9_]*)=(\S+)/g,
    (_match, key: string, _value: string) => `${key}=***redacted***`,
  );
}

/* ------------------------------------------------------------ small utils --- */

export function tryParseJson<T = unknown>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

/** Markdown table with per-column truncation; keeps agent context small. */
export function table(
  headers: string[],
  rows: Array<Array<string | number | undefined | null>>,
  opts: { maxColumnWidth?: number } = {},
): string {
  const width = opts.maxColumnWidth ?? 48;
  const cells = rows.map((row) =>
    headers.map((_, i) => {
      const raw = row[i];
      const value = raw === undefined || raw === null ? "" : String(raw);
      const flat = value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
      return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
    }),
  );
  const widths = headers.map((h, i) =>
    Math.min(width, Math.max(h.length, ...cells.map((row) => row[i]?.length ?? 0))),
  );
  const render = (row: string[]) =>
    row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join(" | ").trimEnd();
  const lines = [render(headers), widths.map((w) => "-".repeat(w)).join(" | ")];
  for (const row of cells) lines.push(render(row));
  return lines.join("\n");
}

/** `["a=1","b=2"]` → `{a:"1",b:"2"}`; malformed entries are reported, not dropped. */
export function parseKeyValuePairs(
  values: string[] | undefined,
): { env: Record<string, string>; error?: string } {
  const env: Record<string, string> = {};
  for (const value of values ?? []) {
    const index = value.indexOf("=");
    if (index <= 0) {
      return { env, error: `environment entry ${JSON.stringify(value)} must be KEY=VALUE` };
    }
    env[value.slice(0, index)] = value.slice(index + 1);
  }
  return { env };
}

/** Combine environment layers for one call; later layers win. */
export function mergeCallEnv(...layers: Array<Record<string, string>>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const layer of layers) Object.assign(merged, layer);
  return merged;
}

export interface MissingCliOptions {
  /** Concrete install hint shown to the agent. */
  installHint: string;
}

/**
 * Turn "command not found" into an actionable next step. `pi.exec` reports a
 * missing binary through the shell's exit code and message, not a typed error.
 */
export function missingCliHint(res: RunResult, bin: string, hint: MissingCliOptions): string {
  const combined = `${res.stderr}\n${res.stdout}`;
  if (!/command not found|No such file or directory|not found/i.test(combined)) return "";
  return `\n\n\`${bin}\` is not installed or not on PATH. ${hint.installHint}`;
}

/**
 * Gate for destructive operations (apply, destroy, force-unlock, taint removal).
 * Returns a refusal result when `confirm` is falsy.
 */
export function requireConfirm(confirm: boolean | undefined, action: string): AgentToolResult | undefined {
  if (confirm) return undefined;
  return fail(
    `Refusing to ${action} without confirm=true. ` +
      "Run the read-only equivalent first (plan / validate / --check / preview), inspect it, " +
      "then re-run with confirm=true.",
  );
}

/** Refuse the whole run when a required pre-flight check did not pass. */
export function requireChecksPassed(checks: Array<{ name: string; ok: boolean }>): AgentToolResult | undefined {
  const failed = checks.filter((check) => !check.ok);
  if (failed.length === 0) return undefined;
  return fail(
    `Refusing to continue: pre-flight check(s) failed — ${failed.map((c) => c.name).join(", ")}. ` +
      "Fix those first, or set skipChecks=true only for the already-verified check to override.",
  );
}

/**
 * Narrow the `unknown` args an approval callback receives to the tool's
 * `action`. The harness types the callback as `unknown`, so every dispatcher
 * reads it through this guard instead of an inline cast.
 */
export function approvalAction(args: unknown): string | undefined {
  if (args === null || typeof args !== "object" || !("action" in args)) return undefined;
  const action: unknown = args.action;
  return typeof action === "string" ? action : undefined;
}
