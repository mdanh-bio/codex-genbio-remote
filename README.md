# Codex Genbio Remote

Private Codex plugin for policy-controlled operation of approved Genbio Slurm
clusters and direct compute hosts.

## Current status

Version `0.4.1` packages the `operate-genbio-hpc-remote` policy skill together
with a local STDIO MCP enforcement server. The server exposes typed,
approval-gated policy, project, workflow, H100, transfer, and finalization
tools; it does not expose arbitrary shell commands or unconstrained remote
paths.

Remote actions remain subject to explicit user approval, strict OpenSSH host
verification, target-specific resource envelopes, and fresh scheduler or
process evidence.

## Architecture

The plugin contains two cooperating layers:

- A skill that explains target selection, approval boundaries, scientific
  workflow, and evidence requirements to Codex.
- A local STDIO MCP server that enforces target policy, typed operations,
  immutable plans, exact-once dispatch, ownership checks, bounded monitoring,
  verified transfers, and durable run records.

The MCP server does not expose arbitrary SSH commands, arbitrary remote paths,
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

Run `python3 plugins/codex-genbio-remote/scripts/preflight.py` from the repository
root first. Python needs PyYAML and the standard-library unittest runner; pytest
is not required. Use an isolated environment if PyYAML is absent, not system pip.

```bash
cd plugins/codex-genbio-remote/server
npm run check
npm run check:release
npm audit --omit=dev --audit-level=high

cd ..
python3 skills/operate-genbio-hpc-remote/scripts/load_policy.py \
  skills/operate-genbio-hpc-remote/references/genbio-compute-policy.yaml
python3 -m unittest discover \
  -s skills/operate-genbio-hpc-remote/tests -p 'test_*.py'

python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
```

## Development rule

No remote smoke test, submission, cancellation, installation, or material
transfer is authorized by cloning or installing this repository. Every such
action requires its own explicit approval and fresh live checks.

## 0.4.1 compatibility and recovery

All consequential actions use `genbio_*` MCP tools. The packaged policy skill
is the only supported copy; remove the duplicate global skill during upgrade.
The tool names and existing argument names remain available, with stricter
validation and explicit elicitation. H100 envelopes require memory; Slurm
envelopes omit it. Approvals bind owner, policy, target, roots, and resources.
The server refreshes policy before operations and transport; changed policy
requires a new approved envelope and never permits replay of outstanding runs.

`genbio_launch` remains a fixed diagnostic entry point. Direct smoke is CPU-only
and requires explicit memory and configured `smokeRoots`; use the specialized
H100 tools for GPU applications. `genbio_monitor` remains local by default;
the additive `reconcile=true` option requires an exact smoke `run_id` and never
dispatches work. A terminal SSH return alone cannot certify success. Legacy
smoke records without bound evidence are not automatically finalized or replayed.

Run `node scripts/check-release.mjs --installed` in the server directory after
reinstall to check that the duplicate global skill is absent. Verify fresh-task
discovery separately. Existing tasks retain their loaded skills and tools.

Limits: no live remote smoke is part of local acceptance; direct diagnostic
completion does not certify CUDA or scientific software. Optional OpenViking
publication stays unavailable unless a publisher is actually supplied; it is
not enabled by installing the memory plugin alone.
