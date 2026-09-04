# Codex Genbio Remote

Repository-local marketplace for the private Codex Genbio Remote plugin.

## Current status

The marketplace currently packages the skills-first `0.1.0` bootstrap. The
migration source is installed `dsh-genbio-remote` version `0.4.0`.

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
.agents/plugins/marketplace.json       Repository marketplace
plugins/codex-genbio-remote/           Installable plugin root
```

## Validation

```bash
python3 plugins/codex-genbio-remote/skills/operate-genbio-hpc-remote/scripts/load_policy.py \
  plugins/codex-genbio-remote/skills/operate-genbio-hpc-remote/references/genbio-compute-policy.yaml
python3 -m unittest discover \
  -s plugins/codex-genbio-remote/skills/operate-genbio-hpc-remote/tests -p 'test_*.py'
```

Plugin-level validation uses the installed Codex `plugin-creator` validator.

## Development rule

No remote smoke test, submission, cancellation, installation, or material
transfer is authorized by cloning or installing this repository. Every such
action requires its own explicit approval and fresh live checks.
