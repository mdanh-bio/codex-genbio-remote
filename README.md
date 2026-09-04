# Codex Genbio Remote

Private Codex plugin for policy-controlled operation of approved Genbio Slurm
clusters and direct compute hosts.

## Current status

Version `0.1.0` is a skills-first bootstrap. It packages the existing
`operate-genbio-hpc-remote` policy skill and its deterministic validators. It
does not yet register remote execution tools or replace the DSH runtime.

Remote actions remain subject to explicit user approval, strict OpenSSH host
verification, target-specific resource envelopes, and fresh scheduler or
process evidence.

## Intended architecture

The completed plugin will contain two cooperating layers:

- A skill that explains target selection, approval boundaries, scientific
  workflow, and evidence requirements to Codex.
- A local STDIO MCP server that enforces target policy, typed operations,
  immutable plans, exact-once dispatch, ownership checks, bounded monitoring,
  verified transfers, and durable run records.

The MCP server will not expose arbitrary SSH commands, arbitrary remote paths,
or raw scheduler arguments.

## Repository layout

```text
.codex-plugin/plugin.json       Codex plugin manifest
skills/                         Policy, workflow instructions, and Slurm templates
scripts/                        Repository maintenance helpers
docs/ARCHITECTURE.md            Target design and trust boundaries
docs/CONVERSION_PLAN.md         Staged DSH-to-Codex migration
SECURITY.md                     Non-negotiable safety properties
```

## Validation

```bash
python3 skills/operate-genbio-hpc-remote/scripts/load_policy.py \
  skills/operate-genbio-hpc-remote/references/genbio-compute-policy.yaml
python3 -m unittest discover \
  -s skills/operate-genbio-hpc-remote/tests -p 'test_*.py'
```

Plugin-level validation uses the installed Codex `plugin-creator` validator.

## Development rule

No remote smoke test, submission, cancellation, installation, or material
transfer is authorized by cloning or installing this repository. Every such
action requires its own explicit approval and fresh live checks.
