# Codex Genbio Remote

Codex plugin for approved Genbio Slurm clusters (HPC/NHPC) and direct compute
hosts. Includes a policy skill and a local MCP server for planning, submission,
monitoring, cancellation, verified transfers, and durable run recovery.

## Safety

- Explicit approvals and target-specific resource limits.
- Strict SSH host verification and checksum-verified transfers.
- Exact-once dispatch: ambiguous submissions are reconciled, never replayed.
- Scheduler completion and job-owned evidence are required for success.
- Installation does not authorize remote work. Diagnostic completion does not
  certify CUDA execution or scientific results.

## Validation

From the repository root:

```bash
python3 plugins/codex-genbio-remote/scripts/preflight.py
cd plugins/codex-genbio-remote/server
npm run check
npm run check:release
npm audit --omit=dev
```

## Documentation

- [Architecture](plugins/codex-genbio-remote/docs/ARCHITECTURE.md)
- [Operating guide](plugins/codex-genbio-remote/skills/operate-genbio-hpc-remote/SKILL.md)
- [Configuration example](plugins/codex-genbio-remote/config.example.yaml)
- [Security](plugins/codex-genbio-remote/SECURITY.md)
