---
name: iac
description: Use for Infrastructure as Code work across OpenTofu/Terraform, Ansible and Pulumi — authoring, validating, planning and applying. Choose the right engine, pick local lab versus cloud emulation, and never apply before a dry run passes.
---

# Infrastructure as Code for agents

The agent has first-class `iac_*` tools. Prefer them over shelling out to `tofu`,
`ansible-playbook` or `pulumi`: they enforce pre-flight checks, cap output,
redact credentials and classify destructive calls.

## Engine selection

| Goal | Tool | Why |
| --- | --- | --- |
| Declare infrastructure, keep it reproducible | `iac_tofu` | HCL state files, plan/apply split, `tofu validate` gate |
| Configure existing hosts, run commands, imperative steps | `iac_ansible` | No desired-state store; check mode is the dry run |
| Express infrastructure in a general-purpose language | `iac_pulumi` | Real code, per-stack config, preview/up split |
| Mock a cloud API locally | `iac_floci` | Emulator lifecycle plus the endpoint variables everything else needs |

Two engines can cover the same resource. Pick by what already exists in the
repository — HCL uses `iac_tofu`, an existing Pulumi project uses `iac_pulumi`.
Do not introduce a second engine to solve one problem.

`iac_tofu` runs OpenTofu by default and falls back to Terraform when only that is
installed; pass `engine="terraform"` to force it. Never mix engines inside one
workspace — they write different lock and state files.

## Execution mode: local lab vs cloud emulation

This is the most important decision, and it depends on whether the code calls a
cloud API.

**Local lab** — containers, networks, images, local files only.
Use the Docker provider through `iac_tofu` (see `templates/docker-lab`). No
emulator, no credentials. Pair it with `iac_ansible` when you need to configure
what it created.

**Cloud emulation** — configuration declares `aws_s3_bucket`, `google_*`,
`azurerm_*`, or calls an SDK.
Start Floci first, then route the engine at it:

```
iac_floci action=start product=aws
iac_floci action=env                       # prints AWS_ENDPOINT_URL and friends
iac_tofu  action=plan  dir=infra env=["AWS_ENDPOINT_URL=http://localhost.floci.io:4566",
                                      "AWS_ACCESS_KEY_ID=test",
                                      "AWS_SECRET_ACCESS_KEY=test",
                                      "AWS_DEFAULT_REGION=us-east-1"]
```

For Pulumi, `iac_pulumi` does the override itself with `localCloud="floci-aws"`
(or `"floci-gcp"`), so no `env` list is needed.

**Both** — keep them as separate workspaces. Lab resources go in one directory,
emulated cloud resources in another; they share nothing.

Never target real cloud credentials in a workspace that has an emulator available.
If a run needs real credentials, say so explicitly before starting it.

## Safety rules

These are enforced by the tools, so do not try to route around them:

1. Validate before plan. Plan before apply. The tools run `validate` and a
   speculative `plan` automatically and refuse when either fails.
2. Destructive actions require `confirm=true`. Set it only after reading the dry
   run output, never to satisfy the schema.
3. `destroy` needs a passing destroy plan first. `iac_tofu` and `iac_pulumi`
   generate it for you.
4. Ansible `run` requires both `--syntax-check` and `--check` to pass. Check mode
   is Ansible's plan.
5. Never pass `skipChecks`/`skipPreview` to silence a failing check. Fix the cause.
   Use them only when you already ran the identical check in this turn.
6. Keep per-stack/test state off shared backends. For Pulumi, `iac_pulumi
   action=login backend="file:///tmp/pulumi-<name>"`.

## Typical sequences

**Create a local lab**

```
iac_tofu action=init     dir=labs/docker
iac_tofu action=validate dir=labs/docker
iac_tofu action=plan     dir=labs/docker
iac_tofu action=apply    dir=labs/docker confirm=true
```

**Configure the lab hosts**

```
iac_ansible action=syntax-check playbook=site.yml inventory=inventory.yml
iac_ansible action=check        playbook=site.yml inventory=inventory.yml
iac_ansible action=run          playbook=site.yml inventory=inventory.yml confirm=true
```

**Ship a cloud change against the emulator**

```
iac_floci action=start product=aws
iac_tofu  action=plan  dir=infra env=["AWS_ENDPOINT_URL=http://localhost.floci.io:4566"]
iac_tofu  action=apply dir=infra env=["AWS_ENDPOINT_URL=http://localhost.floci.io:4566"] confirm=true
```

**Tear everything down**

```
iac_tofu  action=destroy dir=labs/docker confirm=true
iac_floci action=stop    product=aws
```

## Common failures

- **"Refusing to apply without confirm=true"** — expected. Run the dry run, read
  it, re-issue with `confirm=true`.
- **Plan fails with "not been initialized"** — run `iac_tofu action=init`. The
  tool auto-inits before `plan` and `apply`, but explicit is faster.
- **Ansible cannot connect to a container** — the target needs `python3` inside
  it, and `ansible_connection=docker` in the inventory.
- **Provider ignores `AWS_ENDPOINT_URL`** — set the endpoint in the provider
  block instead; see `templates/floci/aws.tf`.
- **Pulumi wants a cloud login** — `iac_pulumi action=login backend="file:///tmp/state"`.
- **Emulator unreachable** — `iac_floci action=doctor`, then `action=status`.
