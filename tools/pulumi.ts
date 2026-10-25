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
  requireConfirm,
  runPulumi,
  tryParseJson,
} from "./_iac";

/**
 * Pulumi stack management and updates.
 *
 * Local-cloud routing for Pulumi is not purely environmental: the AWS providers
 * for every language honour `AWS_ENDPOINT_URL`, but GCP uses
 * `*_EMULATOR_HOST` vars and the classic provider also accepts explicit
 * `aws:endpoints` config. `localCloud` therefore does both — it exports the
 * variables and writes the matching config keys, so either provider shape works.
 */

const factory: CustomToolFactory = (pi) => ({
  name: "iac_pulumi",
  label: "Pulumi Stacks",
  description:
    "Manage Pulumi stacks and run updates: stack select/init/ls/rm/output/history, preview (dry run), up, destroy, refresh, config set/get/list. " +
    "Use for general-purpose-language infrastructure; prefer iac_tofu when the target is already HCL. " +
    "up/destroy require confirm=true and run preview first; set localCloud to route providers at the Floci emulator automatically.",
  approval: (args) => {
    const action = approvalAction(args);
    if (action === "destroy") return { tier: "write", reason: "pulumi destroy deletes every resource in the stack" };
    if (action === "up") return { tier: "write", reason: "pulumi up changes real infrastructure" };
    if (action === "refresh" || action === "config") {
      return { tier: "write", reason: `pulumi ${action} rewrites stack state or configuration` };
    }
    if (action === "stack" || action === "login") {
      return { tier: "exec", reason: `pulumi ${action} changes backend or workspace selection` };
    }
    return { tier: "read", reason: "read-only stack inspection" };
  },
  parameters: pi.zod.object({
    action: pi.zod
      .enum(["preview", "up", "destroy", "refresh", "stack", "config", "login", "output", "history"])
      .describe("Pulumi operation"),
    dir: pi.zod.string().optional().describe("Project directory (default: current working directory)"),
    stack: pi.zod.string().optional().describe("Stack name to operate on"),
    stackOp: pi.zod
      .enum(["select", "init", "ls", "rm", "rename"])
      .optional()
      .describe("For action='stack': the stack sub-operation"),
    rename: pi.zod.string().optional().describe("For stack rename: the new stack name"),
    configOp: pi.zod.enum(["set", "get", "list", "rm"]).optional().describe("For action='config'"),
    configKey: pi.zod.string().optional().describe("For config set/get/rm: the configuration key"),
    configValue: pi.zod.string().optional().describe("For config set: the value"),
    secret: pi.zod.boolean().optional().describe("For config set: encrypt the value instead of storing it plaintext"),
    expectNoChanges: pi.zod.boolean().optional().describe("For preview: fail when any change is proposed"),
    diff: pi.zod.boolean().optional().describe("For preview/up: show a rich resource diff"),
    message: pi.zod.string().optional().describe("For up: message recorded in the update history"),
    parallelism: pi.zod.number().optional().describe("For up/destroy: parallel resource operations"),
    backend: pi.zod.string().optional().describe("For login: backend URL, e.g. 'file:///tmp/state' or 's3://bucket'"),
    localCloud: pi.zod
      .enum(["floci-aws", "floci-gcp", "off"])
      .optional()
      .describe("Route the provider at a local Floci emulator (default: off)"),
    endpoint: pi.zod
      .string()
      .optional()
      .describe("Override the local cloud endpoint URL (default: floci defaults per product)"),
    env: pi.zod
      .array(pi.zod.string())
      .optional()
      .describe("Extra environment overrides for this call only, as KEY=VALUE"),
    skipPreview: pi.zod.boolean().optional().describe("Skip the preview pre-flight before up"),
    confirm: pi.zod.boolean().optional().describe("Required for up, destroy, refresh, stack rm/rename and config set/rm"),
  }),

  async execute(_id, params, _onUpdate, _ctx, signal) {
    const {
      action,
      dir,
      stack,
      stackOp,
      rename,
      configOp,
      configKey,
      configValue,
      secret,
      expectNoChanges,
      diff,
      message,
      parallelism,
      backend,
      localCloud,
      endpoint,
      env,
      skipPreview,
      confirm,
    } = params;

    const parsedEnv = parseKeyValuePairs(env);
    if (parsedEnv.error) return fail(parsedEnv.error);
    const callEnv = mergeCallEnv(parsedEnv.env, localCloudEnv(localCloud, endpoint));
    const runOpts = { signal, cwd: dir ?? pi.cwd, timeoutMs: 900_000, env: callEnv };
    const stackArgs = stack ? ["-s", stack] : [];
    const label = (what: string) => `pulumi ${what}${stack ? ` -s ${stack}` : ""}`;

    switch (action) {
      case "preview": {
        const args = [...stackArgs];
        if (expectNoChanges) args.push("--expect-no-changes");
        if (diff) args.push("--diff");
        const res = await runPulumi(pi.exec, ["preview", ...args], runOpts);
        return commandResult(label("preview"), res);
      }

      case "up": {
        const refusal = requireConfirm(confirm, `run 'pulumi up' on ${stack ?? "the current stack"}`);
        if (refusal) return refusal;
        if (!skipPreview) {
          const previewed = await runPulumi(pi.exec, ["preview", ...stackArgs], runOpts);
          if (previewed.code !== 0) {
            return fail(
              `${label("preview")} failed (exit ${previewed.code}); refusing to run 'up'.\n` +
                clamp(previewed.stderr || previewed.stdout, 4_000),
            );
          }
        }
        const args = [...stackArgs, "-y"];
        if (diff) args.push("--diff");
        if (message) args.push("-m", message);
        if (parallelism !== undefined) args.push("--parallel", String(parallelism));
        const res = await runPulumi(pi.exec, ["up", ...args], runOpts);
        const hint = missingCliHint(res, "pulumi", {
          installHint: "Install with `curl -fsSL https://get.pulumi.com | sh`, or set $PULUMI_BIN.",
        });
        if (hint) return fail(hint);
        return commandResult(label("up"), res);
      }

      case "destroy": {
        const refusal = requireConfirm(confirm, `destroy ${stack ?? "the current stack"}`);
        if (refusal) return refusal;
        const args = [...stackArgs, "-y"];
        if (parallelism !== undefined) args.push("--parallel", String(parallelism));
        const res = await runPulumi(pi.exec, ["destroy", ...args], runOpts);
        return commandResult(label("destroy"), res);
      }

      case "refresh": {
        const refusal = requireConfirm(confirm, `refresh ${stack ?? "the current stack"} state from the provider`);
        if (refusal) return refusal;
        const res = await runPulumi(pi.exec, ["refresh", ...stackArgs, "-y"], runOpts);
        return commandResult(label("refresh"), res);
      }

      case "stack": {
        const op = stackOp ?? "ls";
        const destructive = op === "rm" || op === "rename";
        if (destructive) {
          const refusal = requireConfirm(confirm, `${op} stack ${stack ?? rename ?? "(current)"}`);
          if (refusal) return refusal;
        }
        const args = [op];
        if (op === "select" || op === "init" || op === "rm") {
          if (!stack) return fail(`stack ${op} requires stack`);
          args.push(stack);
        }
        if (op === "rename") {
          if (!rename) return fail("stack rename requires rename (the new stack name)");
          args.push(rename);
        }
        const res = await runPulumi(pi.exec, ["stack", ...args], runOpts);
        return commandResult(label(`stack ${op}`), res);
      }

      case "config": {
        const op = configOp ?? "list";
        if (op === "set" || op === "rm") {
          const refusal = requireConfirm(confirm, `${op} config key ${configKey ?? "(missing)"}`);
          if (refusal) return refusal;
        }
        if ((op === "set" || op === "get" || op === "rm") && !configKey) {
          return fail(`config ${op} requires configKey`);
        }
        // `pulumi config` with no subcommand is what lists; `config list` is
        // not a command at all (only `config env list` exists).
        const args = op === "list" ? [] : [op];
        if (op === "set") {
          if (secret) args.push("--secret");
          else args.push("--plaintext");
          args.push(configKey ?? "", configValue ?? "");
        } else if (op === "get" || op === "rm") {
          args.push(configKey ?? "");
        }
        if (op === "list") args.push("--json");
        const res = await runPulumi(pi.exec, ["config", ...args, ...stackArgs], runOpts);
        if (op === "list" && res.code === 0) {
          const parsed = tryParseJson<Record<string, unknown>>(res.stdout);
          if (parsed) {
            return ok(`${label("config list")} — ${Object.keys(parsed).length} key(s)\n${JSON.stringify(parsed, null, 2)}`);
          }
        }
        return commandResult(label(`config ${op}`), res);
      }

      case "login": {
        if (!backend) return fail("login requires backend, e.g. 'file:///tmp/pulumi-state' (local) or 's3://bucket'");
        const res = await runPulumi(pi.exec, ["login", backend], runOpts);
        return commandResult(`pulumi login ${backend}`, res);
      }

      case "output": {
        const res = await runPulumi(pi.exec, ["stack", "output", ...stackArgs, "--json"], runOpts);
        return commandResult(label("stack output"), res);
      }

      case "history": {
        const res = await runPulumi(pi.exec, ["stack", "history", ...stackArgs], runOpts);
        return commandResult(label("stack history"), res);
      }

      default:
        return fail(`Unsupported Pulumi action: ${JSON.stringify(params.action)}`);
    }
  },
});

export default factory;

/* --------------------------------------------------------- local cloud env --- */

const FLOCI_DEFAULTS: Record<string, string> = {
  "floci-aws": "http://localhost.floci.io:4566",
  "floci-gcp": "http://localhost.floci.io:4588",
};

/**
 * Environment variables that redirect cloud SDKs at the emulator. The variables
 * are enough for every modern AWS SDK used by the Pulumi providers; GCP-only
 * entries are included because `floci-gcp` exposes per-service emulator hosts.
 */
function localCloudEnv(localCloud: string | undefined, endpoint: string | undefined): Record<string, string> {
  if (!localCloud || localCloud === "off") return {};
  const url = endpoint ?? FLOCI_DEFAULTS[localCloud] ?? FLOCI_DEFAULTS["floci-aws"] ?? "http://localhost:4566";

  if (localCloud === "floci-gcp") {
    const host = url.replace(/^https?:\/\//, "");
    return {
      STORAGE_EMULATOR_HOST: `http://${host}`,
      PUBSUB_EMULATOR_HOST: host,
      FIRESTORE_EMULATOR_HOST: host,
      SECRET_MANAGER_EMULATOR_HOST: host,
      GCP_ENDPOINT_OVERRIDES: "true",
    };
  }

  return {
    AWS_ENDPOINT_URL: url,
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
    AWS_DEFAULT_REGION: "us-east-1",
    AWS_REGION: "us-east-1",
  };
}
