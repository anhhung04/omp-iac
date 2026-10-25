import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import {
  approvalAction,
  clamp,
  commandResult,
  fail,
  formatCommand,
  missingCliHint,
  ok,
  runFloci,
  tryParseJson,
} from "./_iac";

/**
 * Floci local-cloud lifecycle and endpoint routing. The emulator is what makes
 * every other tool here safe to run offline, so it owns two jobs: start/stop
 * the container, and hand out the endpoint overrides OpenTofu and Pulumi need.
 */


type FlociAction =
  | "start"
  | "stop"
  | "status"
  | "env"
  | "services"
  | "doctor"
  | "logs"
  | "config-profile"
  | "reset";

type Product = "aws" | "gcp" | "az" | "oci";

const PRODUCT_TREE: Record<Product, string[]> = {
  aws: [],
  gcp: ["gcp"],
  az: ["az"],
  oci: ["oci"],
};

const DEFAULT_PORTS: Record<Product, number> = {
  aws: 4566,
  gcp: 4588,
  az: 4577,
  oci: 4599,
};

const DEFAULT_IMAGES: Record<Product, string> = {
  aws: "floci/floci:latest",
  gcp: "floci/floci-gcp:latest",
  az: "floci/floci-az:latest",
  oci: "floci/floci-oci:latest",
};

const SETUP_REQUIRED: Product[] = ["az", "oci"];

const factory: CustomToolFactory = (pi) => ({
  name: "iac_floci",
  label: "Local Cloud Emulator (Floci)",
  description:
    "Start, stop, diagnose and reset the Floci local cloud emulator (AWS, GCP, Azure, OCI) and emit the endpoint environment variables that point OpenTofu, Pulumi and cloud CLIs at it. " +
    "Use iac_floci action='env' when you need AWS_ENDPOINT_URL / STORAGE_EMULATOR_HOST overrides to feed iac_tofu or iac_pulumi. " +
    "This is the local-cloud emulation mode; use iac_tofu with the Docker provider for container-only labs that need no cloud API.",
  approval: (args) => {
    const action = approvalAction(args);
    // reset wipes emulator state; stop tears the instance down.
    if (action === "reset" || action === "stop") {
      return { tier: "write", reason: `floci ${action} discards the local cloud instance's resources` };
    }
    if (action === "start") return { tier: "exec", reason: "floci start launches a local container" };
    return { tier: "read", reason: "read-only emulator inspection" };
  },
  parameters: pi.zod.object({
    action: pi.zod
      .enum(["start", "stop", "status", "env", "services", "doctor", "logs", "config-profile", "reset"])
      .describe("Emulator operation"),
    product: pi.zod
      .enum(["aws", "gcp", "az", "oci"])
      .optional()
      .describe("Cloud emulator to target (default: aws)"),
    profile: pi.zod.string().optional().describe("Floci profile name from ~/.floci/profiles/"),
    port: pi.zod.number().optional().describe("Host port for start (defaults to the product default)"),
    persist: pi.zod.string().optional().describe("Host directory for persistent state across restarts"),
    services: pi.zod.string().optional().describe("Comma-separated services to enable, e.g. 's3,dynamodb'"),
    setup: pi.zod
      .boolean()
      .optional()
      .describe("For start on az/oci: also run 'floci <product> setup' to register the CLI profile"),
    tail: pi.zod.number().optional().describe("For logs: number of lines (default 100)"),
    confirm: pi.zod.boolean().optional().describe("Required for reset"),
  }),

  async execute(_id, params, _onUpdate, _ctx, signal) {
    const action: FlociAction = params.action;
    const product: Product = params.product ?? "aws";
    const { profile, port, persist, services, setup, tail, confirm } = params;
    const tree = PRODUCT_TREE[product];
    const args = [...tree, action];

    switch (action) {
      case "start": {
        if (port !== undefined) args.push("--port", String(port));
        if (persist) args.push("--persist", persist);
        if (services) args.push("--services", services);
        const res = await runFloci(pi.exec, args, { signal, cwd: pi.cwd, timeoutMs: 240_000 });
        const alreadyRunning = /already running/i.test(`${res.stderr}\n${res.stdout}`);
        // `start` on a running instance is an error, but reaching a ready
        // emulator is the caller's actual goal, so report it as success.
        if (res.code !== 0 && !alreadyRunning) return commandResult(`floci ${product} start`, res);
        const hint = missingCliHint(res, "floci", {
          installHint: "Install with `curl -fsSL https://floci.io/install.sh | sh`, or set $FLOCI_BIN.",
        });
        if (hint) return fail(`${hint}\n${clamp(res.stderr, 2_000)}`);

        let setupNote = "";
        if (setup || SETUP_REQUIRED.includes(product)) {
          const setupRes = await runFloci(pi.exec, [...tree, "setup"], {
            signal,
            cwd: pi.cwd,
            timeoutMs: 240_000,
          });
          setupNote = setupRes.code === 0
            ? `\n\nsetup: registered the ${product} CLI profile against the emulator.`
            : `\n\nsetup: FAILED (exit ${setupRes.code}) — ${clamp(setupRes.stderr || setupRes.stdout, 800)}`;
        }
        const envRes = await runFloci(pi.exec, [...tree, "env", "--json"], {
          signal,
          cwd: pi.cwd,
          timeoutMs: 30_000,
        });
        const vars = tryParseJson<Record<string, string>>(envRes.stdout);
        const exported = vars
          ? Object.entries(vars)
              .map(([k, v]) => `${k}=${v}`)
              .join("\n")
          : envRes.stdout.trim();
        const state = alreadyRunning ? "already running" : "started";
        return ok(
          `floci ${product} start (exit 0) — emulator ${state} on port ${port ?? DEFAULT_PORTS[product]}.${setupNote}\n\n` +
            `Endpoint overrides for iac_tofu env / iac_pulumi env:\n${exported || "(none returned)"}`,
        );
      }

      case "stop": {
        args.push("--remove");
        const res = await runFloci(pi.exec, args, { signal, cwd: pi.cwd, timeoutMs: 120_000 });
        return commandResult(`floci ${product} stop`, res);
      }

      case "status": {
        const res = await runFloci(pi.exec, [...args, "--json"], { signal, cwd: pi.cwd, timeoutMs: 60_000 });
        return commandResult(`floci ${product} status`, res);
      }

      case "env": {
        const res = await runFloci(pi.exec, [...args, "--json"], { signal, cwd: pi.cwd, timeoutMs: 60_000 });
        const vars = tryParseJson<Record<string, string>>(res.stdout);
        if (res.code !== 0 || !vars) return commandResult(`floci ${product} env`, res);
        const rows = Object.entries(vars).map(([key, value]) => `${key}=${value}`);
        return ok(
          `floci ${product} env (exit 0) — pass these through the \`env\` parameter of iac_tofu / iac_pulumi:\n\n` +
            rows.join("\n"),
        );
      }

      case "services": {
        const res = await runFloci(pi.exec, args, { signal, cwd: pi.cwd, timeoutMs: 60_000 });
        return commandResult(`floci ${product} services`, res);
      }

      case "doctor": {
        const res = await runFloci(pi.exec, args, { signal, cwd: pi.cwd, timeoutMs: 120_000 });
        return commandResult(`floci ${product} doctor`, res);
      }

      case "logs": {
        const res = await runFloci(pi.exec, [...args, "--tail", String(tail ?? 100)], {
          signal,
          cwd: pi.cwd,
          timeoutMs: 60_000,
        });
        return commandResult(`floci ${product} logs`, res, { mode: "tail" });
      }

      case "config-profile": {
        // 'floci <tree> config show --profile NAME' surfaces resolved image/port.
        const res = await runFloci(pi.exec, [...tree, "config", "show", ...(profile ? ["--profile", profile] : [])], {
          signal,
          cwd: pi.cwd,
          timeoutMs: 60_000,
        });
        return commandResult(`floci ${product} config show`, res);
      }

      case "reset": {
        if (!confirm) {
          return fail(
            `Refusing to reset the ${product} emulator without confirm=true. ` +
              "`reset` deletes every resource inside the running emulator; use stop+start for a clean slate you can re-verify.",
          );
        }
        const res = await runFloci(pi.exec, args, { signal, cwd: pi.cwd, timeoutMs: 120_000 });
        return commandResult(`floci ${product} reset`, res);
      }

      default:
        return fail(
          `Unsupported action. Received ${JSON.stringify(params.action)} for the ${product} tree ` +
            `(image ${DEFAULT_IMAGES[product]}, default port ${DEFAULT_PORTS[product]}). ` +
            `Command preview: ${formatCommand("floci", [...tree, String(params.action)])}`,
        );
    }
  },
});

export default factory;
