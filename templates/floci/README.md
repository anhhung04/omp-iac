# Floci local-cloud routing for OpenTofu and Pulumi

Floci emulates AWS (4566), GCP (4588), Azure (4577) and OCI (4599) locally. This
is the **cloud emulation** mode: use it when your configuration or program calls
cloud APIs, and use the Docker lab when it does not.

## Choose the mode

| Situation | Mode | Tooling |
| --- | --- | --- |
| Containers, networks, images, local config only | local lab | `iac_tofu` + Docker provider (`templates/docker-lab`) |
| `aws_*` / `google_*` / `azurerm_*` resources, cloud SDK calls | cloud emulation | `iac_floci` + `iac_tofu`/`iac_pulumi` with endpoint overrides |
| Both — cloud resources plus real hosts | both | Start the emulator, then run the lab as a second workspace |

## Endpoint overrides

`floci env` prints exactly the variables your SDK needs. Two ways to apply them
to a run, and the plugin prefers the first because nothing is persisted:

1. **Per-call environment** — pass them to the tool, scoped to one invocation:

   ```
   iac_floci action=env
   iac_tofu action=plan dir=infra env=["AWS_ENDPOINT_URL=http://localhost.floci.io:4566",
                                        "AWS_ACCESS_KEY_ID=test",
                                        "AWS_SECRET_ACCESS_KEY=test",
                                        "AWS_DEFAULT_REGION=us-east-1"]
   ```

2. **Provider configuration in the code** — shown in the templates below, and
   required for Terraform providers that ignore `AWS_ENDPOINT_URL` (older AWS
   provider releases) and for Pulumi's classic `endpoints` block.

## OpenTofu

`aws.tf` in this directory configures the AWS provider with a parameterized
endpoint and the switches emulators need: forced path-style S3, no credential
chain lookups, no region validation. See the inline comments.

```bash
cd infra
tofu init
AWS_ENDPOINT_URL=http://localhost.floci.io:4566 tofu plan
```

## Pulumi

Every language SDK for `pulumi-aws` reads `AWS_ENDPOINT_URL`, so normally the
environment is enough:

```bash
export AWS_ENDPOINT_URL=http://localhost.floci.io:4566
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1
pulumi login file:///tmp/pulumi-floci     # keep test state off Pulumi Cloud
pulumi stack init dev
pulumi preview
```

`iac_pulumi` also supports `localCloud="floci-aws"`, which exports those
variables for the call:

```
iac_pulumi action=localCloud=floci-aws action=preview dir=pulumi-infra stack=dev
```

For GCP, use `localCloud=floci-gcp`; `STORAGE_EMULATOR_HOST` and friends are set
for you.

## Azure and OCI

Both need a one-time `floci az setup` / `floci oci setup` before the CLI and SDK
trust the emulator. `iac_floci action=start product=az` runs setup automatically
and reports the endpoint variables it emitted.
