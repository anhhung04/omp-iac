/**
 * Live smoke run for the IaC plugin tools: loads every tool factory with a stub
 * `pi` (real Bun.spawn exec + omptype zod shim) and calls it against the actual
 * CLIs and, where cheap, the real emulator.
 *
 * Nothing here assumes a target already exists: the lab workspace is created
 * under a temp directory, and cloud-dependent steps report SKIP when the
 * emulator is unreachable.
 *
 * Usage: bun run test/smoke.ts [tool-name]
 */

import { spawn } from "bun";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zod from "@oh-my-pi/omptype/zod";
import type {
  CustomTool,
  CustomToolAPI,
  CustomToolFactory,
  CustomToolResult,
  ExecOptions,
  ExecResult,
} from "@oh-my-pi/pi-coding-agent";

const exec = async (command: string, args: string[], options?: ExecOptions): Promise<ExecResult> => {
  const proc = spawn([command, ...args], {
    cwd: options?.cwd,
    stdout: "pipe",
    stderr: "pipe",
    signal: options?.signal,
  });
  const timer = options?.timeout ? setTimeout(() => proc.kill(), options.timeout) : undefined;
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { stdout, stderr, code, killed: false };
};

const pi = {
  cwd: process.cwd(),
  exec,
  zod,
  ui: {},
  hasUI: false,
  logger: { error() {}, warn() {}, debug() {}, info() {} },
  pushPendingAction() {},
} as unknown as CustomToolAPI;

const tools = new Map<string, CustomTool>();
for (const name of ["tofu", "ansible", "pulumi", "floci"]) {
  const factory = (await import(`../tools/${name}.ts`)).default as CustomToolFactory;
  for (const tool of [factory(pi)].flat() as CustomTool[]) tools.set(tool.name, tool);
}

let errors = 0;
let skipped = 0;

async function call(
  toolName: string,
  params: Record<string, unknown>,
  label: string,
): Promise<string | undefined> {
  const tool = tools.get(toolName);
  if (!tool) return skip(label, `${toolName} not loaded`);
  const result: CustomToolResult = await tool.execute("smoke", params, undefined, {} as never);
  const text = result.content.map((block) => ("text" in block ? block.text : "")).join("\n");
  if (result.isError) errors += 1;
  console.log(`\n### ${label} — ${toolName} ${result.isError ? "ERROR" : "ok"}`);
  console.log(text.slice(0, 900));
  return text;
}

function skip(label: string, reason: string): undefined {
  console.log(`\n### ${label} — SKIP (${reason})`);
  skipped += 1;
  return undefined;
}

/** A gated action without `confirm` must be refused; failing to refuse is a bug. */
async function callExpectingRefusal(
  toolName: string,
  params: Record<string, unknown>,
  label: string,
): Promise<void> {
  const tool = tools.get(toolName);
  if (!tool) {
    skip(label, `${toolName} not loaded`);
    return;
  }
  const result: CustomToolResult = await tool.execute("smoke", params, undefined, {} as never);
  const text = result.content.map((block) => ("text" in block ? block.text : "")).join("\n");
  const refused = result.isError === true && text.includes("confirm=true");
  if (!refused) errors += 1;
  console.log(`\n### ${label} — ${toolName} ${refused ? "ok (refused as expected)" : "FAIL (gate did not hold)"}`);
  console.log(text.slice(0, 300));
}

const only = process.argv[2];
const wanted = (name: string) => !only || name === only;

/** Which CLIs this machine actually has, so missing ones skip instead of fail. */
async function hasBin(bin: string): Promise<boolean> {
  const res = await exec("sh", ["-c", `command -v ${bin}`], { timeout: 10_000 });
  return res.code === 0;
}

const haveTofu = await hasBin("tofu");
const haveTerraform = await hasBin("terraform");
const haveAnsible = await hasBin("ansible-playbook");
const havePulumi = await hasBin("pulumi");
const haveFloci = await hasBin("floci");

console.log(
  `available: tofu=${haveTofu} terraform=${haveTerraform} ansible=${haveAnsible} ` +
    `pulumi=${havePulumi} floci=${haveFloci}`,
);

/* --------------------------------------------------------------- OpenTofu --- */

// A one-resource workspace that needs no credentials: `null_resource` ships in
// the built-in provider, so init succeeds offline after the initial install.
const labDir = mkdtempSync(join(tmpdir(), "omp-iac-smoke-"));
writeFileSync(
  join(labDir, "main.tf"),
  `terraform {
  required_providers {
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }
  }
}

resource "null_resource" "smoke" {
  triggers = { run = "once" }
}

output "created" {
  value = null_resource.smoke.id
}
`,
);

if (wanted("iac_tofu")) {
  if (haveTofu || haveTerraform) {
    await call("iac_tofu", { action: "version" }, "engine version");
    await call("iac_tofu", { action: "init", dir: labDir }, "init");
    await call("iac_tofu", { action: "validate", dir: labDir }, "validate");
    await call("iac_tofu", { action: "fmt", dir: labDir, check: true }, "fmt check");
    await call("iac_tofu", { action: "plan", dir: labDir }, "plan");
    // No confirm: this must be refused, which proves the gate works.
    await callExpectingRefusal("iac_tofu", { action: "apply", dir: labDir }, "apply WITHOUT confirm");
    await call("iac_tofu", { action: "apply", dir: labDir, confirm: true }, "apply");
    await call("iac_tofu", { action: "output", dir: labDir }, "output");
    await call("iac_tofu", { action: "state", dir: labDir, stateOp: "list" }, "state list");
    await call("iac_tofu", { action: "destroy", dir: labDir, confirm: true }, "destroy");
  } else {
    skip("opentofu", "neither tofu nor terraform on PATH");
  }
}

/* ---------------------------------------------------------------- Ansible --- */

const playDir = mkdtempSync(join(tmpdir(), "omp-iac-ansible-"));
writeFileSync(
  join(playDir, "site.yml"),
  // Names are capitalized because ansible-lint enforces name[casing]; the smoke
  // run should prove a clean lint, not reproduce a known-bad playbook.
  `- name: Smoke
  hosts: localhost
  gather_facts: false
  tasks:
    - name: Report
      ansible.builtin.debug:
        msg: iac smoke
`,
);
writeFileSync(join(playDir, "inventory.ini"), "localhost ansible_connection=local\n");

if (wanted("iac_ansible")) {
  if (haveAnsible) {
    await call(
      "iac_ansible",
      { action: "syntax-check", playbook: join(playDir, "site.yml"), inventory: join(playDir, "inventory.ini") },
      "syntax-check",
    );
    await call(
      "iac_ansible",
      { action: "check", playbook: join(playDir, "site.yml"), inventory: join(playDir, "inventory.ini") },
      "check dry run",
    );
    await callExpectingRefusal(
      "iac_ansible",
      { action: "run", playbook: join(playDir, "site.yml"), inventory: join(playDir, "inventory.ini") },
      "run WITHOUT confirm",
    );
    await call(
      "iac_ansible",
      { action: "run", playbook: join(playDir, "site.yml"), inventory: join(playDir, "inventory.ini"), confirm: true },
      "run",
    );
    await call("iac_ansible", { action: "inventory", inventory: join(playDir, "inventory.ini") }, "inventory graph");
    await call("iac_ansible", { action: "lint", playbook: join(playDir, "site.yml") }, "lint");
  } else {
    skip("ansible", "ansible-playbook not on PATH");
  }
}

/**
 * A real Pulumi stack, so preview/up/config actually exercise the CLI. An empty
 * resource set needs no provider or credentials but still proves the tool drives
 * stack selection, config and previews correctly.
 */
const pulumiDir = mkdtempSync(join(tmpdir(), "omp-iac-pulumi-"));
const backendDir = mkdtempSync(join(tmpdir(), "omp-iac-pulumi-state-"));
writeFileSync(join(pulumiDir, "Pulumi.yaml"), "name: smoke\nruntime: yaml\ndescription: smoke\n");
writeFileSync(join(pulumiDir, "Pulumi.dev.yaml"), "config: {}\n");
writeFileSync(join(pulumiDir, "Main.yaml"), "resources: {}\n");
// A file backend still needs a passphrase to encrypt stack config.

/** Copied from templates/floci/aws.tf so the plan runs against real resources. */
const awsLabDir = mkdtempSync(join(tmpdir(), "omp-iac-floci-lab-"));
writeFileSync(join(awsLabDir, "main.tf"), await Bun.file("templates/floci/aws.tf").text());
const pulumiEnv = ["PULUMI_CONFIG_PASSPHRASE=smoke-passphrase", "PULUMI_SKIP_UPDATE_CHECK=true"];

if (wanted("iac_pulumi")) {
  if (havePulumi) {
    await call("iac_pulumi", { action: "login", backend: `file://${backendDir}` }, "login local backend");
    await call("iac_pulumi", { action: "stack", stackOp: "init", stack: "dev", dir: pulumiDir, env: pulumiEnv }, "stack init");
    await call("iac_pulumi", { action: "stack", stackOp: "ls", dir: pulumiDir, env: pulumiEnv }, "stack ls");
    await call("iac_pulumi", { action: "config", configOp: "list", stack: "dev", dir: pulumiDir, env: pulumiEnv }, "config list");
    await call("iac_pulumi", { action: "preview", stack: "dev", dir: pulumiDir, env: pulumiEnv }, "preview");
    await callExpectingRefusal("iac_pulumi", { action: "up", stack: "dev", dir: pulumiDir, env: pulumiEnv }, "up WITHOUT confirm");
    await call("iac_pulumi", { action: "up", stack: "dev", dir: pulumiDir, env: pulumiEnv, confirm: true }, "up");
    await call("iac_pulumi", { action: "output", stack: "dev", dir: pulumiDir, env: pulumiEnv }, "stack output");
    await call("iac_pulumi", { action: "history", stack: "dev", dir: pulumiDir, env: pulumiEnv }, "stack history");
    await call("iac_pulumi", { action: "destroy", stack: "dev", dir: pulumiDir, env: pulumiEnv, confirm: true }, "destroy");
  } else {
    skip("pulumi", "pulumi not on PATH");
  }
}

/* ------------------------------------------------------------------ Floci --- */

if (haveFloci) {
  // Start the real emulator so status/services/doctor have something to talk to.
  // The first run pulls floci/floci; that cost is the point of a live smoke test.
  const started = await call("iac_floci", { action: "start", product: "aws" }, "start emulator");
  const emulatorUp = started !== undefined && !started.includes("not reachable");

  await call("iac_floci", { action: "status", product: "aws" }, "emulator status");
  await call("iac_floci", { action: "env", product: "aws" }, "endpoint overrides");
  await call("iac_floci", { action: "services", product: "aws" }, "services");
  await callExpectingRefusal("iac_floci", { action: "reset", product: "aws" }, "reset WITHOUT confirm");
  await call("iac_floci", { action: "doctor", product: "aws" }, "doctor");
  await call("iac_floci", { action: "logs", product: "aws", tail: 20 }, "logs");

  if (emulatorUp && haveTofu) {
    // Endpoint routing is the integration this plugin exists for: plan an S3
    // bucket against the emulator using the variables floci just printed.
    await call(
      "iac_tofu",
      {
        action: "plan",
        dir: awsLabDir,
        env: [
          "AWS_ENDPOINT_URL=http://localhost.floci.io:4566",
          "AWS_ACCESS_KEY_ID=test",
          "AWS_SECRET_ACCESS_KEY=test",
          "AWS_DEFAULT_REGION=us-east-1",
        ],
      },
      "tofu plan against the emulator",
    );
  }

  await call("iac_floci", { action: "stop", product: "aws" }, "stop emulator");
} else {
  skip("floci", "floci not on PATH");
}
rmSync(labDir, { recursive: true, force: true });
rmSync(playDir, { recursive: true, force: true });
rmSync(pulumiDir, { recursive: true, force: true });
rmSync(backendDir, { recursive: true, force: true });
rmSync(awsLabDir, { recursive: true, force: true });

console.log(`\n=== smoke complete: ${errors} error(s), ${skipped} skipped ===`);
process.exit(errors > 0 ? 1 : 0);
