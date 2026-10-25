import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import {
  approvalAction,
  clamp,
  commandResult,
  fail,
  mergeCallEnv,
  missingCliHint,
  ok,
  parseKeyValuePairs,
  requireChecksPassed,
  requireConfirm,
  resolveEngineBin,
  run,
  tryParseJson,
} from "./_iac";

/**
 * OpenTofu / Terraform workspace operations.
 *
 * `tofu` and `terraform` share one CLI grammar (both descended from Terraform
 * 1.5.6), so this dispatcher runs either engine: `$TOFU_BIN` decides, defaulting
 * to `tofu` and falling back to `terraform` when only that is installed. Every
 * flag used here exists in both engines.
 *
 * Two things make this more than a shell wrapper:
 *
 * - **Pre-flight enforcement.** `apply` and `destroy` run `validate` (and a
 *   speculative `plan`) first and refuse to continue when either fails. That is
 *   the "never apply what you have not planned" rule, applied by the tool rather
 *   than trusted to the agent's discipline.
 * - **Call-scoped environment.** `env` feeds provider endpoint overrides and
 *   `TF_VAR_*` values through `env(1)`, so local-cloud runs never mutate the
 *   user's shell or the plugin process.
 */

/** Destructive state sub-operations needing confirm=true. */
const WRITE_STATE_OPS: Record<string, true> = { push: true, rm: true, mv: true };

type Api = Parameters<CustomToolFactory>[0];

/** The two engines this dispatcher can drive; they share one CLI grammar. */
type Engine = "tofu" | "terraform";

interface CallOpts {
  bin: Engine;
  env: Record<string, string>;
  timeoutMs?: number;
}

const factory: CustomToolFactory = (pi) => ({
  name: "iac_tofu",
  label: "OpenTofu / Terraform Workspace",
  description:
    "Run OpenTofu (or Terraform) in a workspace: init, validate, fmt, plan, apply, destroy, output, state management, force-unlock. " +
    "Defaults to OpenTofu and falls back to Terraform automatically; set engine='terraform' to force it. " +
    "Use for declarative infrastructure, including local container labs through the Docker provider. " +
    "apply/destroy require confirm=true and automatically run validate+plan first; pass local cloud endpoint overrides " +
    "(AWS_ENDPOINT_URL, ...) through the env parameter.",
  approval: (args) => {
    const action = approvalAction(args);
    if (action === "destroy") {
      return { tier: "write", reason: "destroy tears down every resource in the workspace" };
    }
    if (action === "apply") return { tier: "write", reason: "apply changes real infrastructure" };
    if (action === "force-unlock" || action === "state") {
      return { tier: "write", reason: `${action} rewrites state outside the normal plan/apply flow` };
    }
    if (action === "init") return { tier: "exec", reason: "init downloads providers and writes .terraform" };
    return { tier: "read", reason: "read-only workspace inspection" };
  },
  parameters: pi.zod.object({
    action: pi.zod
      .enum(["init", "validate", "fmt", "plan", "apply", "destroy", "output", "state", "force-unlock", "version"])
      .describe("Workspace operation"),
    engine: pi.zod
      .enum(["tofu", "terraform"])
      .optional()
      .describe("Force a specific engine (default: $TOFU_BIN, else tofu, else terraform)"),
    dir: pi.zod.string().optional().describe("Workspace directory (default: current working directory)"),
    planFile: pi.zod
      .string()
      .optional()
      .describe("For plan: write the plan here. For apply: apply exactly this saved plan."),
    varFile: pi.zod.string().optional().describe("Path to a .tfvars file"),
    vars: pi.zod.array(pi.zod.string()).optional().describe("Variables as KEY=VALUE; sent as TF_VAR_*"),
    target: pi.zod.array(pi.zod.string()).optional().describe("Resource addresses to limit the operation to"),
    refresh: pi.zod.boolean().optional().describe("For plan: refresh state before planning (default true)"),
    parallelism: pi.zod.number().optional().describe("Limit concurrent resource operations"),
    env: pi.zod
      .array(pi.zod.string())
      .optional()
      .describe("Environment overrides for this call only, e.g. ['AWS_ENDPOINT_URL=http://localhost:4566']"),
    stateOp: pi.zod
      .enum(["list", "show", "pull", "push", "rm", "mv"])
      .optional()
      .describe("For action='state': the state sub-operation"),
    address: pi.zod.string().optional().describe("For state show/rm: resource address. For state mv: source"),
    destination: pi.zod.string().optional().describe("For state mv: destination address"),
    lockId: pi.zod.string().optional().describe("For force-unlock: the lock ID from the failed operation"),
    check: pi.zod.boolean().optional().describe("For fmt: report diffs without writing (default true)"),
    skipChecks: pi.zod.boolean().optional().describe("Skip the validate/plan pre-flight (only when already verified)"),
    confirm: pi.zod.boolean().optional().describe("Required for apply, destroy, force-unlock and write state ops"),
  }),

  async execute(_id, params, _onUpdate, _ctx, signal) {
    const {
      action,
      engine,
      dir,
      planFile,
      varFile,
      vars,
      target,
      refresh,
      parallelism,
      env,
      stateOp,
      address,
      destination,
      lockId,
      check,
      skipChecks,
      confirm,
    } = params;

    const parsedEnv = parseKeyValuePairs(env);
    if (parsedEnv.error) return fail(parsedEnv.error);
    const varEnv: Record<string, string> = {};
    for (const value of vars ?? []) {
      const index = value.indexOf("=");
      if (index <= 0) return fail(`variable ${JSON.stringify(value)} must be KEY=VALUE`);
      // TF_VAR_* is the engine-neutral way to pass variables; both engines read it.
      varEnv[`TF_VAR_${value.slice(0, index)}`] = value.slice(index + 1);
    }
    const callEnv = mergeCallEnv(parsedEnv.env, varEnv);

    const bin = await pickEngine(pi, engine);
    const opts: CallOpts = { bin, env: callEnv, timeoutMs: 600_000 };
    const target_ = dir ?? pi.cwd;
    const label = (what: string) => `${bin} ${what} (${target_})`;

    switch (action) {
      /* ---------------------------------------------------------- read-only */

      case "version": {
        const res = await invoke(pi, opts, ["version", "--json"], { signal, timeoutMs: 30_000 });
        const hint = missingCliHint(res, bin, {
          installHint:
            "Install OpenTofu (`curl -fsSL https://get.opentofu.org/install-opentofu.sh | sh -- --install-method standalone`) " +
            "or Terraform, or set $TOFU_BIN.",
        });
        if (hint) return fail(hint);
        return commandResult(`${bin} version`, res);
      }

      case "fmt": {
        const wantCheck = check ?? true;
        const res = await invoke(pi, opts, globalArgs(target_, ["fmt", "-no-color", wantCheck ? "-check" : "-list", "-recursive"]), { signal });
        return commandResult(label("fmt"), res);
      }

      case "validate": {
        const res = await invoke(pi, opts, globalArgs(target_, ["validate", "-no-color", "-json"]), { signal, timeoutMs: 180_000 });
        if (res.code !== 0) return commandResult(label("validate"), res);
        const report = tryParseJson<{ valid?: boolean; diagnostics?: Array<{ severity: string; summary: string }> }>(
          res.stdout,
        );
        if (!report) return commandResult(label("validate"), res);
        const errors = (report.diagnostics ?? []).filter((d) => d.severity === "error");
        return ok(
          `${label("validate")} — ${report.valid ? "configuration is valid" : "configuration is INVALID"}\n` +
            (errors.length > 0 ? errors.map((d) => `error: ${d.summary}`).join("\n") : "(no errors)"),
        );
      }

      case "plan": {
        if (!skipChecks) await ensureInit(pi, opts, target_, signal);
        const args = ["-input=false"];
        if (planFile) args.push("-out", planFile);
        if (varFile) args.push("-var-file", varFile);
        if (refresh === false) args.push("-refresh=false");
        const res = await invoke(pi, opts, globalArgs(target_, ["plan", "-no-color", ...args]), { signal });
        return commandResult(label("plan"), res);
      }

      case "output": {
        const res = await invoke(pi, opts, globalArgs(target_, ["output", "-no-color", "-json"]), { signal });
        return commandResult(label("output"), res);
      }

      /* -------------------------------------------------------- state layer */

      case "state": {
        if (!stateOp) return fail("action='state' requires stateOp (list, show, pull, push, rm, mv).");
        if (WRITE_STATE_OPS[stateOp]) {
          const refusal = requireConfirm(confirm, `run '${bin} state ${stateOp}'`);
          if (refusal) return refusal;
        }
        const args = [stateOp];
        if (stateOp === "show" || stateOp === "rm") {
          if (!address) return fail(`state ${stateOp} requires address`);
          args.push(address);
        }
        if (stateOp === "mv") {
          if (!address || !destination) return fail("state mv requires address (source) and destination");
          args.push(address, destination);
        }
        const res = await invoke(pi, opts, globalArgs(target_, ["state", ...args, "-no-color"]), { signal });
        return commandResult(label(`state ${stateOp}`), res);
      }

      /* ----------------------------------------------------- setup + writes */

      case "init": {
        const res = await invoke(pi, opts, globalArgs(target_, ["init", "-input=false", "-no-color"]), { signal });
        const hint = missingCliHint(res, bin, {
          installHint:
            "Install OpenTofu (`curl -fsSL https://get.opentofu.org/install-opentofu.sh | sh -- --install-method standalone`) " +
            "or Terraform, or set $TOFU_BIN.",
        });
        if (hint) return fail(hint);
        return commandResult(label("init"), res);
      }

      case "apply": {
        const refusal = requireConfirm(confirm, `apply this workspace with ${bin}`);
        if (refusal) return refusal;
        if (!skipChecks) {
          await ensureInit(pi, opts, target_, signal);
          const checks = [await checkValidate(pi, opts, target_, signal)];
          // A saved plan was already validated+planned, so re-planning would be redundant.
          if (!planFile) checks.push(await checkPlan(pi, opts, target_, varFile, signal));
          const blocked = requireChecksPassed(checks);
          if (blocked) return blocked;
        }
        const args = planFile ? [planFile] : ["-input=false", "-auto-approve"];
        if (parallelism !== undefined) args.push("-parallelism", String(parallelism));
        const res = await invoke(pi, opts, globalArgs(target_, ["apply", "-no-color", ...args]), { signal });
        return commandResult(label("apply"), res);
      }

      case "destroy": {
        const refusal = requireConfirm(confirm, `destroy every resource in this workspace with ${bin}`);
        if (refusal) return refusal;
        if (!skipChecks) {
          const planned = await invoke(pi, opts, globalArgs(target_, ["plan", "-no-color", "-destroy", "-input=false"]), { signal });
          if (planned.code !== 0) {
            return fail(
              `${label("plan -destroy")} failed (exit ${planned.code}); refusing to destroy.\n` +
                clamp(planned.stderr || planned.stdout, 4_000),
            );
          }
        }
        const args = ["-input=false", "-auto-approve"];
        for (const addr of target ?? []) args.push("-target", addr);
        if (parallelism !== undefined) args.push("-parallelism", String(parallelism));
        const res = await invoke(pi, opts, globalArgs(target_, ["destroy", "-no-color", ...args]), { signal });
        return commandResult(label("destroy"), res);
      }

      case "force-unlock": {
        const refusal = requireConfirm(confirm, "force-unlock the workspace state");
        if (refusal) return refusal;
        if (!lockId) return fail("force-unlock requires lockId (printed by the operation that failed to lock).");
        const res = await invoke(pi, opts, globalArgs(target_, ["force-unlock", "-force", lockId, "-no-color"]), { signal });
        return commandResult(label("force-unlock"), res);
      }

      default:
        return fail(`Unsupported workspace action: ${JSON.stringify(params.action)}`);
    }
  },
});

export default factory;

/* -------------------------------------------------------------- plumbing --- */

/**
 * `-chdir` is one of the few true global flags. `-no-color` is *not*: `tofu
 * -no-color <subcommand>` fails with "flag provided but not defined", so every
 * subcommand lists it explicitly instead.
 */
function globalArgs(dir: string, rest: string[]): string[] {
  return ["-chdir", dir, ...rest];
}

async function invoke(
  pi: Api,
  opts: CallOpts,
  args: string[],
  extra: { signal?: AbortSignal; timeoutMs?: number },
) {
  const { cmd, baseArgs } = resolveEngineBin(opts.bin);
  return run(pi.exec, cmd, [...baseArgs, ...args], {
    signal: extra.signal,
    cwd: pi.cwd,
    timeoutMs: extra.timeoutMs ?? opts.timeoutMs ?? 600_000,
    env: opts.env,
  });
}

/**
 * Both engines share the same flags, so the only decision is which binary to
 * run: explicit `engine` > `$TOFU_BIN` > installed `tofu` > installed `terraform`.
 * Resolving once per call keeps every subsequent command consistent.
 */
async function pickEngine(pi: Api, engine?: Engine): Promise<Engine> {
  if (engine) return engine;
  const forced = process.env.TOFU_BIN?.trim().split(/\s+/)[0];
  if (forced) return forced.includes("terraform") ? "terraform" : "tofu";
  const probeTofu = await invoke(pi, { bin: "tofu", env: {} }, ["version"], { timeoutMs: 20_000 });
  if (probeTofu.code === 0) return "tofu";
  return "terraform";
}

/** `plan`/`apply` fail cryptically on an uninitialized workspace; init once. */
async function ensureInit(pi: Api, opts: CallOpts, dir: string, signal?: AbortSignal): Promise<void> {
  const probe = await invoke(pi, opts, globalArgs(dir, ["validate", "-no-color", "-json"]), { signal, timeoutMs: 60_000 });
  const uninitialized = /tofu init|terraform init|has not been initialized|Module not installed/i.test(
    `${probe.stderr}\n${probe.stdout}`,
  );
  if (uninitialized) {
    await invoke(pi, opts, globalArgs(dir, ["init", "-input=false", "-no-color"]), { signal });
  }
}

async function checkValidate(
  pi: Api,
  opts: CallOpts,
  dir: string,
  signal?: AbortSignal,
): Promise<{ name: string; ok: boolean }> {
  const res = await invoke(pi, opts, globalArgs(dir, ["validate", "-no-color", "-json"]), { signal, timeoutMs: 180_000 });
  const report = tryParseJson<{ valid?: boolean }>(res.stdout);
  const valid = res.code === 0 && report?.valid === true;
  if (!valid) pi.logger.warn?.(`${opts.bin} validate failed before apply: ${clamp(res.stderr || res.stdout, 500)}`);
  return { name: `${opts.bin} validate`, ok: valid };
}

async function checkPlan(
  pi: Api,
  opts: CallOpts,
  dir: string,
  varFile: string | undefined,
  signal?: AbortSignal,
): Promise<{ name: string; ok: boolean }> {
  const args = ["-input=false"];
  if (varFile) args.push("-var-file", varFile);
  const res = await invoke(pi, opts, globalArgs(dir, ["plan", "-no-color", ...args]), { signal });
  if (res.code !== 0) pi.logger.warn?.(`${opts.bin} plan failed before apply: ${clamp(res.stderr || res.stdout, 500)}`);
  return { name: `${opts.bin} plan`, ok: res.code === 0 };
}
