---
name: iac-pulumi
description: Use for Pulumi stacks — writing programs in a general-purpose language, managing stack config and backends, previewing and applying updates, and routing providers at a local cloud emulator.
---

# Pulumi stacks

Pulumi replaces HCL with a real language. The discipline is unchanged: preview
before update, and keep test state away from shared backends.

## Backend first

Before the first update, decide where state lives. Local file backends are right
for emulator and test work:

```
iac_pulumi action=login backend="file:///tmp/pulumi-floci"
iac_pulumi action=stack stackOp=init stack=dev
```

Without this, Pulumi may prompt for a cloud login and stall the run.

## Update loop

```
iac_pulumi action=preview dir=pulumi-infra stack=dev diff=true
iac_pulumi action=up      dir=pulumi-infra stack=dev confirm=true
```

`up` runs `preview` itself first and refuses when it fails. Set `skipPreview`
only when you already previewed the identical change this turn.

Use `expectNoChanges=true` to assert idempotence in CI — it fails the preview
rather than silently accepting drift.

## Local cloud routing

Two mechanisms, and you normally want the first because nothing is written to
disk:

1. **Environment** — `iac_pulumi localCloud="floci-aws"` exports
   `AWS_ENDPOINT_URL`, test credentials and region for that call. Use
   `"floci-gcp"` for GCP emulator hosts.

2. **Config** — persisted, useful when the provider predates `AWS_ENDPOINT_URL`:

   ```
   iac_pulumi action=config configOp=set configKey=aws:endpoints \
     configValue='[{"s3":"http://localhost.floci.io:4566"}]' confirm=true
   ```

Prefer keeping the endpoint out of the program itself so the same code works
against the real cloud.

## Configuration

- Namespaced keys are the norm: `aws:region`, `<project>:<key>`.
- Secrets: `iac_pulumi action=config configOp=set configKey=dbPassword secret=true`
  writes an encrypted value. Never pass a plaintext secret through `configValue`
  with `secret=false`.
- Read config back with `configOp=list` before assuming what a stack has.

## Program conventions

- Export anything another tool needs as a stack output, then read it with
  `iac_pulumi action=output`.
- Keep resource names stable and meaningful; renaming a resource is a
  create/delete in Pulumi's eyes unless you set explicit aliases.
- Avoid `dependsOn` unless the data flow cannot express the dependency — passing
  one resource's output into another already orders them.

## Stack lifecycle

- `action=stack stackOp=ls` lists stacks and marks the current one.
- `stackOp=select` switches; everything after `-s` is explicit anyway.
- `stackOp=rm` and `stackOp=rename` need `confirm=true`. Removing a stack removes
  its config too; its resources must be destroyed first with `action=destroy`.
- `action=history` is the fastest way to see what actually ran and when.

## Failure reading

- Preview fails with credentials errors against the emulator — the endpoint was
  not applied; re-run with `localCloud` or check `iac_floci action=status`.
- `error: no stack selected` — pass `stack=` or run `stackOp=select`.
- Update hangs on `Type: yes` — `-y` was dropped; use `iac_pulumi`, not raw CLI.
- Resource replaced unexpectedly — a resource name or property changed; check
  the preview diff before confirming an update that deletes anything.
