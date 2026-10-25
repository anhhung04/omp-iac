---
name: iac-opentofu
description: Use when working in OpenTofu or Terraform workspaces — writing HCL, planning, applying, inspecting or repairing state. Covers the plan/apply discipline, workspace layout, provider endpoint overrides and local container labs.
---

# OpenTofu and Terraform workspaces

`iac_tofu` drives either engine: same CLI grammar, same flags. It prefers
`tofu` and falls back to `terraform`; pass `engine` to force one.

## Workspace layout

Keep one workspace per environment boundary, not per resource type. Each
directory owns its own state:

```
infra/
  main.tf        # resources
  variables.tf   # inputs, with descriptions
  outputs.tf     # values other workspaces or Ansible consume
  versions.tf    # required_version + provider pins
labs/docker/     # local container lab, separate state
```

Pin provider versions with `~>`. Unpinned providers make plans drift between
runs even when nothing changed.

## HCL conventions

- Declare every variable with a `type` and a `description`; `default` only where
  a sensible fallback exists.
- Prefer explicit resources over count-based shorthand when a resource will be
  targeted with `-target` or inspected by name.
- Keep credentials out of `.tf` files. Pass them through `iac_tofu`'s `env`
  parameter as `TF_VAR_*` or cloud environment variables; nothing secret lands in
  the plan file that way.
- Use output values for anything another tool needs — Ansible inventories, lab
  URLs, generated names.

## Workflow

```
iac_tofu action=fmt      dir=infra check=true
iac_tofu action=init     dir=infra
iac_tofu action=validate dir=infra
iac_tofu action=plan     dir=infra planFile=tfplan
iac_tofu action=apply    dir=infra planFile=tfplan confirm=true
```

Saving a plan and applying the file guarantees the applied change is exactly the
reviewed one. `iac_tofu` skips the redundant second plan when `planFile` is set
for `apply`.

## Local lab pattern

The Docker provider turns OpenTofu into a lab builder: no credentials, no
emulator, no cost.

```hcl
provider "docker" {
  # host defaults to unix:///var/run/docker.sock
}

resource "docker_container" "shell" {
  name    = "iac-lab-shell"
  image   = docker_image.shell.image_id
  command = ["sleep", "infinity"]
}
```

A container that sleeps forever is the cleanest Ansible target: pair it with
`ansible_connection=docker`. Full example in `templates/docker-lab`.

## Cloud emulation pattern

Providers that talk to a cloud API need both the endpoint and the emulator
switches. Keep the endpoint a variable so the same code targets real AWS later:

```hcl
provider "aws" {
  region                      = var.aws_region
  endpoint                    = var.aws_endpoint
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  s3_use_path_style           = true
}
```

Then run with the endpoint scoped to that call:

```
iac_tofu action=plan dir=infra env=["AWS_ENDPOINT_URL=http://localhost.floci.io:4566"]
```

## State operations

- Inspect, never hand-edit: `iac_tofu action=state stateOp=list`, then
  `stateOp=show` with an address.
- Write operations (`push`, `rm`, `mv`) require `confirm=true`.
- A stuck lock after a cancelled run is cleared with
  `action=force-unlock lockId=<id> confirm=true`. Only do this when sure no other
  apply is running.
- Use `stateOp=mv` rather than delete-and-recreate when renaming a resource; it
  keeps the real object.

## Failure reading

- `Error: Inconsistent dependency lock file` after adding a provider — `iac_tofu
  action=init` regenerates `.terraform.lock.hcl`; commit it.
- `No such file or directory` for a module — modules resolve relative to the
  workspace root; check the `source` path.
- Plan succeeds, apply fails at the provider — the emulator may be down; run
  `iac_floci action=status`.
