# omp-iac

Infrastructure as Code tools and skills for [`omp`](https://github.com/oh-my-pi/omp):
OpenTofu/Terraform workspaces, Ansible playbooks, Pulumi stacks, and a local
cloud emulator so none of them need to touch a real account.

## What it adds

Four native tools:

| Tool | Covers |
| --- | --- |
| `iac_tofu` | init, validate, fmt, plan, apply, destroy, output, state management, force-unlock — OpenTofu by default, Terraform when only that is installed |
| `iac_ansible` | `--syntax-check`, `--check` dry runs, playbook runs, inventory inspection, lint, ad-hoc modules, galaxy |
| `iac_pulumi` | stack lifecycle, preview, up, destroy, refresh, config, backend login |
| `iac_floci` | Floci emulator lifecycle (AWS/GCP/Azure/OCI) and the endpoint variables the other three need |

And five skills that decide *which* of those to reach for: `iac`, `iac-opentofu`,
`iac-ansible`, `iac-pulumi`, `iac-local-cloud`.

## Why tools instead of shell commands

Each wrapper does four things a shell call does not:

1. **Enforces pre-flight checks.** `apply` runs `validate` and a speculative
   `plan` first and refuses when either fails. Ansible `run` requires
   `--syntax-check` *and* `--check` to pass. Pulumi `up` runs `preview` first.
   Destructive calls additionally need `confirm=true`.
2. **Scopes environment per call.** Endpoint overrides go through `env(1)` for
   one invocation, so local-cloud runs never mutate the agent's shell or leak
   into the next command.
3. **Redacts credentials.** Cloud keys, tokens and `KEY=secret` assignments are
   masked before output reaches the model.
4. **Classifies risk.** Each action declares a tier (`read`/`exec`/`write`), so
   approval prompts reflect what the call actually does.

Output is capped (~16k chars, tail-biased for logs) and every failure includes
exit code plus stderr.

## Execution modes

The mode choice depends on whether your code calls a cloud API.

**Local lab** — containers, networks, images, local files. No emulator, no
credentials. Start from `templates/docker-lab`, which pairs the Docker provider
with an Ansible-ready target.

**Cloud emulation** — anything declaring `aws_s3_bucket`, `google_*`,
`azurerm_*`, or calling an SDK. Start Floci, then route the engine at it:

```
iac_floci action=start product=aws
iac_tofu  action=plan  dir=infra env=["AWS_ENDPOINT_URL=http://localhost.floci.io:4566"]
```

For Pulumi one parameter does it: `iac_pulumi action=preview localCloud=floci-aws`.

Keep the two as separate workspaces; they share no state.

## Requirements

| Binary | Needed for | Install |
| --- | --- | --- |
| `tofu` or `terraform` | `iac_tofu` | `curl -fsSL https://get.opentofu.org/install-opentofu.sh \| sh` |
| `ansible-playbook`, `ansible-inventory` | `iac_ansible` | `pip install ansible-core` |
| `ansible-lint` | `iac_ansible action=lint` (optional) | `pip install ansible-lint` |
| `pulumi` | `iac_pulumi` | `curl -fsSL https://get.pulumi.com \| sh` |
| `floci` | `iac_floci` | `curl -fsSL https://floci.io/install.sh \| sh` |

Missing binaries produce an install hint rather than a stack trace. Override the
binary with `$TOFU_BIN`, `$TERRAFORM_BIN`, `$ANSIBLE_BIN`, `$PULUMI_BIN` or
`$FLOCI_BIN` (each may be a full command line, e.g. `podman compose`).

Docker is required for both modes: the local lab talks to the daemon directly,
and Floci runs as a container.

## Install

```bash
omp plugin install github:<owner>/omp-iac
```

Custom tools are workspace-scoped, so launch `omp` from a directory where the
plugin is active.

## Layout

```
package.json            # "omp.tools" array is the only manifest entry needed
tools/_iac.ts           # exec wrapper, env scoping, redaction, safety gates
tools/tofu.ts           # OpenTofu / Terraform dispatcher
tools/ansible.ts        # playbook, inventory, lint
tools/pulumi.ts         # stacks, preview/up, local-cloud env
tools/floci.ts          # emulator lifecycle + endpoint routing
skills/iac/             # mode selection and safety rules
skills/iac-opentofu/    # HCL workspace practice
skills/iac-ansible/     # playbook and inventory practice
skills/iac-pulumi/      # stack and backend practice
skills/iac-local-cloud/ # emulator routing
templates/docker-lab/   # OpenTofu + Docker provider lab
templates/floci/        # endpoint routing for OpenTofu and Pulumi
test/smoke.ts           # live harness against the real CLIs
test/helpers.test.ts    # unit tests for shared helpers
```

## Verification

```bash
bun test                 # unit tests for the shared helpers
bun run typecheck        # tsc --noEmit
bun run test/smoke.ts    # every tool against the real binaries
```

`test/smoke.ts` builds throwaway workspaces, starts the real Floci container,
plans an S3 bucket against it, and asserts each safety gate actually refuses.
Targets are discovered at runtime, so a machine missing a CLI skips rather than
fails.

## Safety notes

`apply`, `destroy`, `force-unlock`, state writes, playbook runs, ad-hoc modules,
galaxy installs, Pulumi `up`/`destroy`/`refresh`, stack rename/remove and
emulator `reset` all require `confirm=true`. Do not pass `skipChecks` or
`skipPreview` to get past a failing check — fix the cause. Use them only when the
identical check already ran in the same turn.
