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
  runAnsible,
} from "./_iac";

/**
 * Ansible playbook execution, inventory inspection and lint/syntax checking.
 *
 * Safety model: a real `run` is refused until `--syntax-check` and a dry-run
 * `--check` have both passed in this same call. Ansible has no plan/apply split,
 * so the check mode *is* the plan; skipping it means applying blind.
 */

type Api = Parameters<CustomToolFactory>[0];

const factory: CustomToolFactory = (pi) => ({
  name: "iac_ansible",
  label: "Ansible Playbooks",
  description:
    "Run, dry-run and lint Ansible: playbook execution, --syntax-check and --check dry runs, inventory inspection (hostvars/graph), ad-hoc modules, galaxy installs. " +
    "Prefer this for imperative config on existing hosts; use iac_tofu to create infrastructure declaratively. " +
    "run requires confirm=true and automatically performs --syntax-check and --check first.",
  approval: (args) => {
    const action = approvalAction(args);
    if (action === "run") return { tier: "write", reason: "ansible-playbook changes remote host state" };
    if (action === "ad_hoc") return { tier: "write", reason: "ad-hoc modules change remote host state" };
    if (action === "galaxy") return { tier: "exec", reason: "ansible-galaxy installs collections/roles" };
    return { tier: "read", reason: "read-only Ansible inspection" };
  },
  parameters: pi.zod.object({
    action: pi.zod
      .enum(["run", "syntax-check", "check", "inventory", "lint", "ad_hoc", "galaxy"])
      .describe("Ansible operation"),
    playbook: pi.zod.string().optional().describe("Playbook path (required for run/syntax-check/check/lint)"),
    inventory: pi.zod.string().optional().describe("Inventory path or comma-separated host list"),
    limit: pi.zod.string().optional().describe("Further limit selected hosts to this pattern"),
    extraVars: pi.zod.array(pi.zod.string()).optional().describe("Extra vars as KEY=VALUE"),
    tags: pi.zod.string().optional().describe("Only run plays and tasks tagged with these values"),
    skipTags: pi.zod.string().optional().describe("Only run plays and tasks whose tags do not match these values"),
    forks: pi.zod.number().optional().describe("Number of parallel processes (default 5)"),
    become: pi.zod.boolean().optional().describe("Run operations with become (privilege escalation)"),
    diff: pi.zod.boolean().optional().describe("Show file/template diffs; pair with check"),
    verbose: pi.zod.number().optional().describe("Verbosity 0-4 (equivalent to -v through -vvvv)"),
    host: pi.zod.string().optional().describe("For inventory show / ad_hoc: the host pattern"),
    module: pi.zod.string().optional().describe("For ad_hoc: module name, e.g. 'ping' or 'shell'"),
    moduleArgs: pi.zod.string().optional().describe("For ad_hoc: module arguments, e.g. 'uptime'"),
    galaxyOp: pi.zod
      .enum(["install", "list"])
      .optional()
      .describe("For action='galaxy': install collections/roles or list them"),
    requirement: pi.zod.string().optional().describe("For galaxy install: requirements.yml path or collection name"),
    env: pi.zod
      .array(pi.zod.string())
      .optional()
      .describe("Environment overrides for this call only, e.g. ['ANSIBLE_HOST_KEY_CHECKING=False']"),
    skipChecks: pi.zod.boolean().optional().describe("Skip the syntax-check/check pre-flight for run"),
    confirm: pi.zod.boolean().optional().describe("Required for run, ad_hoc and galaxy install"),
  }),

  async execute(_id, params, _onUpdate, _ctx, signal) {
    const {
      action,
      playbook,
      inventory,
      limit,
      extraVars,
      tags,
      skipTags,
      forks,
      become,
      diff,
      verbose,
      host,
      module,
      moduleArgs,
      galaxyOp,
      requirement,
      env,
      skipChecks,
      confirm,
    } = params;

    const parsedEnv = parseKeyValuePairs(env);
    if (parsedEnv.error) return fail(parsedEnv.error);
    const callEnv = mergeCallEnv(parsedEnv.env);
    const runOpts = { signal, cwd: pi.cwd, timeoutMs: 900_000, env: callEnv };

    /**
     * Shared playbook flags. `-i` is required even for syntax-check because
     * Ansible resolves host patterns while parsing the play.
     */
    const playbookArgs = (extra: string[]): string[] => {
      const args: string[] = [];
      if (inventory) args.push("-i", inventory);
      if (limit) args.push("-l", limit);
      if (tags) args.push("-t", tags);
      if (skipTags) args.push("--skip-tags", skipTags);
      if (forks !== undefined) args.push("-f", String(forks));
      if (become) args.push("-b");
      if (diff) args.push("-D");
      if (verbose !== undefined) args.push(`-${"v".repeat(Math.min(4, Math.max(1, verbose)))}`);
      for (const value of extraVars ?? []) args.push("-e", value);
      // The playbook is the sole positional argument; without it ansible-playbook
      // prints usage and exits 2, which reads like a flag error.
      args.push(...extra, playbook ?? "");
      return args;
    };

    switch (action) {
      case "syntax-check": {
        if (!playbook) return fail("syntax-check requires playbook");
        const res = await runAnsible(pi.exec, "playbook", playbookArgs(["--syntax-check"]), runOpts);
        return commandResult("ansible-playbook --syntax-check", res);
      }

      case "check": {
        if (!playbook) return fail("check requires playbook");
        const res = await runAnsible(pi.exec, "playbook", playbookArgs(["--check"]), runOpts);
        return commandResult("ansible-playbook --check", res);
      }

      case "run": {
        if (!playbook) return fail("run requires playbook");
        const refusal = requireConfirm(confirm, `run ${playbook}`);
        if (refusal) return refusal;
        if (!skipChecks) {
          const syntax = await runAnsible(pi.exec, "playbook", playbookArgs(["--syntax-check"]), runOpts);
          const dryRun = syntax.code === 0
            ? await runAnsible(pi.exec, "playbook", playbookArgs(["--check"]), runOpts)
            : syntax;
          const blocked = requireChecksPassed([
            { name: "ansible-playbook --syntax-check", ok: syntax.code === 0 },
            { name: "ansible-playbook --check", ok: dryRun.code === 0 },
          ]);
          if (blocked) {
            const detail = syntax.code !== 0 ? syntax : dryRun;
            return fail(`${refusalText(blocked)}\n\nFirst failure detail:\n${clamp(detail.stderr || detail.stdout, 4_000)}`);
          }
        }
        const res = await runAnsible(pi.exec, "playbook", playbookArgs([]), runOpts);
        const hint = missingCliHint(res, "ansible-playbook", {
          installHint: "Install with `pip install ansible-core` (plus `pip install ansible-lint` for lint), or set $ANSIBLE_BIN.",
        });
        if (hint) return fail(hint);
        return commandResult("ansible-playbook", res);
      }

      case "inventory": {
        const args: string[] = [];
        if (inventory) args.push("-i", inventory);
        const op = host ? ["--host", host] : ["--graph"];
        const res = await runAnsible(pi.exec, "inventory", [...args, ...op], runOpts);
        return commandResult(`ansible-inventory ${host ? "--host" : "--graph"}`, res);
      }

      case "lint": {
        if (!playbook) return fail("lint requires playbook");
        const res = await runAnsible(pi.exec, "lint", [playbook], runOpts);
        const hint = missingCliHint(res, "ansible-lint", {
          installHint: "Install with `pip install ansible-lint`; lint is the only optional dependency in this plugin.",
        });
        if (hint) return fail(hint);
        return commandResult("ansible-lint", res);
      }

      case "ad_hoc": {
        const refusal = requireConfirm(confirm, `run the ${module ?? "ad-hoc"} module against ${host ?? "all"}`);
        if (refusal) return refusal;
        if (!module) return fail("ad_hoc requires module, e.g. 'ping'");
        const args: string[] = [];
        if (inventory) args.push("-i", inventory);
        args.push(host ?? "all", "-m", module);
        if (moduleArgs) args.push("-a", moduleArgs);
        if (become) args.push("-b");
        const res = await runAnsible(pi.exec, "ad_hoc", args, runOpts);
        return commandResult(`ansible ${host ?? "all"} -m ${module}`, res);
      }

      case "galaxy": {
        const op = galaxyOp ?? "list";
        if (op === "install") {
          const refusal = requireConfirm(confirm, `install ${requirement ?? "galaxy requirements"}`);
          if (refusal) return refusal;
          if (!requirement) return fail("galaxy install requires requirement (collection name or requirements.yml path)");
        }
        const args = [op === "install" ? "collection" : op];
        if (op === "install") {
          if (requirement?.endsWith(".yml") || requirement?.endsWith(".yaml")) args.push("-r", requirement);
          else args.push(requirement ?? "");
        }
        const res = await runAnsible(pi.exec, "galaxy", args, runOpts);
        return commandResult(`ansible-galaxy ${args.join(" ")}`, res);
      }

      default:
        return fail(`Unsupported Ansible action: ${JSON.stringify(params.action)}`);
    }
  },
});

export default factory;

/** Read the text of a refusal result; tool content is a text/image union. */
function refusalText(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  return first && first.type === "text" && typeof first.text === "string" ? first.text : "pre-flight check failed";
}
