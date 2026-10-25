---
name: iac-local-cloud
description: Use when a change must run without touching real cloud accounts — Floci emulator lifecycle, endpoint variables for OpenTofu/Pulumi/SDKs, choosing cloud emulation over a container-only lab, and resetting emulator state safely.
---

# Local cloud emulation with Floci

Floci emulates AWS (4566), GCP (4588), Azure (4577) and OCI (4599) on localhost.
No account, no token, no cost. `iac_floci` starts it, reports its health and emits
the endpoint variables that route everything else at it.

## Decide first: do you need an emulator at all?

**No emulator** (use `templates/docker-lab`) when the configuration only creates
containers, networks, images or local files. Adding a cloud emulator to a purely
local lab costs a startup and buys nothing.

**Emulator** when resources declare `aws_*`, `google_*`, `azurerm_*` or
`oci_*`, or when code calls a cloud SDK. Anything else talking to a cloud API
also belongs here.

**Both** when the change has cloud resources and real hosts. Keep them as two
workspaces; they share no state.

## Startup

```
iac_floci action=start product=aws
iac_floci action=status product=aws
iac_floci action=env    product=aws
```

`start` returns the endpoint variables directly, so you can skip `env` unless you
need them again later. Azure and OCI additionally need `floci az setup` /
`floci oci setup`; `start` runs it automatically and reports the result.

## Routing the engines

**OpenTofu / Terraform** — variables scoped to one call:

```
iac_tofu action=plan dir=infra env=["AWS_ENDPOINT_URL=http://localhost.floci.io:4566",
                                   "AWS_ACCESS_KEY_ID=test",
                                   "AWS_SECRET_ACCESS_KEY=test",
                                   "AWS_DEFAULT_REGION=us-east-1"]
```

Older providers ignore `AWS_ENDPOINT_URL`; declare `endpoint` in the provider
block as well (see `templates/floci/aws.tf`).

**Pulumi** — one parameter does it:

```
iac_pulumi action=preview localCloud=floci-aws dir=pulumi-infra
iac_pulumi action=preview localCloud=floci-gcp dir=pulumi-infra
```

**Cloud CLIs and SDKs** — `iac_floci action=env` prints exactly what to export.

## Service coverage

Check before assuming a service exists:

```
iac_floci action=services product=aws
```

Emulator coverage is partial and version-dependent. A provider operation that is
not implemented fails with a 501 or an empty response; that is a coverage gap, not
a bug in your configuration.

## Persistence and reset

- State lives in the container. Without `--persist` it resets when the container
  is recreated — pass `persist=<dir>` for anything that must survive a restart.
- Several isolated instances are profiles: separate container names and ports.
- `iac_floci action=reset confirm=true` deletes every resource inside the running
  emulator. It is destructive; prefer `stop` then `start` unless you specifically
  want the same container back empty.
- Stop with `iac_floci action=stop product=aws` when done. Leaving it running is
  harmless but holds port 4566.

## Failure reading

- `Server: not reachable` — nothing is listening; `iac_floci action=start`.
- `iac_floci action=doctor` reports environment problems (Docker, port conflicts,
  image age) more precisely than any single command's output.
- Provider still reaches real AWS — the endpoint was not applied to that call.
  Re-check `env` or `localCloud`; do not "fix" it by exporting credentials.
- Port already in use — another instance is running; `action=status` or start on
  another port with `port=14566`.
