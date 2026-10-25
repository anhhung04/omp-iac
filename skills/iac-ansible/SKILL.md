---
name: iac-ansible
description: Use when writing or running Ansible playbooks and inventories — syntax checking, check-mode dry runs, linting, and configuring hosts created by an IaC tool. Emphasizes that check mode is the only dry run and that every real run is gated on it.
---

# Ansible playbooks and inventories

Ansible has no plan/apply split. Check mode (`--check`) is the dry run, and
`--syntax-check` is the parse. `iac_ansible` requires both to pass before a real
`run`, so you get a dry run whether or not you asked for one.

## Order of operations

```
iac_ansible action=syntax-check playbook=site.yml inventory=inventory.yml
iac_ansible action=check        playbook=site.yml inventory=inventory.yml diff=true
iac_ansible action=run          playbook=site.yml inventory=inventory.yml confirm=true
```

Read the `--check` output before setting `confirm=true`. Check mode reports
`changed` for tasks whose modules cannot predict the result — for those, add
`check_mode: false` guarded by a `when: not ansible_check_mode` condition, or
accept that the task is genuinely un-previewable.

## Playbook conventions

- Every task gets a `name`; every mutable task gets `changed_when` when its
  module cannot decide on its own (especially `command` and `shell`).
- Prefer modules over `command`/`shell`. Modules are idempotent and most support
  check mode; raw commands do neither.
- Make plays idempotent: run twice, second run must report zero changes.
- Use `become` deliberately, only where escalation is needed.
- Keep secrets out of the repository — use Ansible Vault and pass the password at
  run time.

## Inventories

Group hosts by role, not by environment, and put shared values in group vars:

```yaml
lab:
  hosts:
    iac-lab-shell:
      ansible_connection: docker
      ansible_python_interpreter: /usr/bin/python3
  vars:
    iac_mode: local-lab
```

Verify what Ansible actually resolved before running anything:

```
iac_ansible action=inventory inventory=inventory.yml
iac_ansible action=inventory inventory=inventory.yml host=iac-lab-shell
```

## Targeting hosts created by another tool

OpenTofu makes stable container names, so the inventory can reference them
directly. `ansible_connection: docker` attaches over the Docker socket — the
target needs `python3` inside it, and nothing else. No SSH daemon required.

Use `--limit` rather than maintaining a parallel inventory when you only want a
subset:

```
iac_ansible action=run playbook=site.yml inventory=inventory.yml limit=iac-lab-shell confirm=true
```

## Lint

```
iac_ansible action=lint playbook=site.yml
```

`ansible-lint` is an optional dependency; if it is missing the tool tells you how
to install it instead of failing cryptically. Treat its `production`, `risky-file`
and `fqcn` findings as real: fully-qualified collection names avoid module
resolution surprises.

## Failure reading

- `Failed to connect to the host via docker` — target needs `python3`; add it during
  provisioning, as `templates/docker-lab/main.tf` does.
- Check mode reports changes that never appear on a real run — the module cannot
  preview accurately; this is expected for some file modules, not a bug.
- `[WARNING]: provided hosts list is empty` — inventory path or group is wrong;
  confirm with `action=inventory`.
- Galaxy collection missing — `action=galaxy galaxyOp=install requirement=community.docker confirm=true`.
