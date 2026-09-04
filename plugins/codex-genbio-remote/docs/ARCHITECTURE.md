# Architecture

## Components

### Codex plugin package

The plugin manifest advertises bundled skills and, after the enforcement layer
is implemented, a local STDIO MCP server.

### Policy skill

The skill guides Codex through target selection, approvals, preparation,
monitoring, evidence collection, and scientific reporting. It is not the
security boundary.

### MCP enforcement server

The MCP server is the security boundary. It owns policy loading, schema
validation, durable state, command construction, dispatch, reconciliation,
monitoring, cancellation, transfer verification, and finalization.

Proposed public tools:

- `genbio_policy_status`
- `genbio_preflight`
- `genbio_set_envelope`
- `genbio_projects`
- `genbio_project_describe`
- `genbio_project_inventory`
- `genbio_project_plan`
- `genbio_project_execute`
- `genbio_project_status`
- `genbio_project_cancel`
- `genbio_project_fetch`
- `genbio_finalize_run`
- `genbio_publish_run`

Each operation accepts a narrow typed schema. No operation accepts arbitrary
shell text, raw `sbatch` options, or unconstrained filesystem paths.

## Trust boundaries

- Codex chooses and sequences tools but is not trusted to enforce policy.
- The MCP server validates all consequential inputs independently.
- Native OpenSSH and rclone are transport mechanisms, not policy authorities.
- Slurm or direct-process evidence is authoritative for compute state.
- OpenViking publication is separate from compute success.
- Credentials and target configuration remain user-managed external state.

## Source migration

Reusable pure modules from `dsh-genbio-remote` should move into a provider-neutral
core. DSH-specific adapters such as `defineTool`, Cordis injection, system-prompt
registration, user-question APIs, and session projections must not enter the
Codex MCP server unchanged.

The DSH and Codex adapters may share the same core only after parity tests prove
that policy, plan hashes, ownership, reconciliation, and terminal-state behavior
