# OpenTofu + Docker local lab

A container lab the agent can create, plan, apply and destroy without touching a
cloud account. OpenTofu drives the Docker provider directly
(`unix:///var/run/docker.sock`), so there is no emulator, no credentials and no
remote API — this is the **local lab** mode.

Use this when you need real hosts for Ansible to configure, a network topology,
or a throwaway environment for an experiment. Use Floci instead when the
configuration itself targets cloud APIs (`aws_s3_bucket`, `google_storage_bucket`,
`azurerm_*`) — see `templates/floci/README.md`.

`main.tf` intentionally declares an image and a container instead of using
`docker_container` shorthand for the network: it gives you named resources to
target with `-target` and inspect with `tofu state show`.

## Quick start

```bash
cd labs/docker
tofu init
tofu plan
tofu apply
```

Through the plugin, prefer the tools so pre-flight checks apply:

```
iac_tofu action=init    dir=labs/docker
iac_tofu action=validate dir=labs/docker
iac_tofu action=plan    dir=labs/docker
iac_tofu action=apply   dir=labs/docker confirm=true
iac_tofu action=destroy dir=labs/docker confirm=true
```

## What it creates

| Resource | Purpose |
| --- | --- |
| `docker_network.lab` | Isolated bridge network so lab containers can resolve each other by name. |
| `docker_image.nginx` | Pinned image reference; avoids implicit `:latest` drift. |
| `docker_container.web` | A reachable endpoint on `http://localhost:18080`. |
| `docker_container.shell` | A target with SSH-less `ansible_connection=docker` for playbook runs. |

## Ansible integration

```bash
ansible-inventory -i inventory.yml --graph
ansible-playbook -i inventory.yml site.yml --check --diff
ansible-playbook -i inventory.yml site.yml
```

`inventory.yml` uses the `docker` connection plugin against the container name,
so no SSH daemon is needed inside the lab.
