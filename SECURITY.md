# Security Policy

## Safety boundary

This plugin controls consequential remote scientific-compute operations. A
successful local test or plugin installation does not authorize remote access.

The runtime must fail closed when policy, identity, state, ownership, resource,
or scheduler evidence is missing or ambiguous.

## Non-negotiable properties

- Use only declared targets and strict known-host verification.
- Never accept passwords, private-key contents, arbitrary SSH options, or agent
  forwarding through an MCP tool argument.
- Never expose a generic remote-shell tool.
- Validate target, node, partition, CPUs, GPUs, concurrency, and remote roots in
  executable code before dispatch.
- Require a fresh explicit approval for submission, cancellation, installation,
  material transfer, destructive cleanup, or envelope expansion.
- Persist intent before dispatch and reconcile ambiguous transport outcomes
  before any retry.
- Cancel only an exact active job or process owned by the current run record.
- Treat an empty queue as inconclusive; require terminal scheduler or process
  evidence and exit status.
- Verify staged and fetched artifacts with SHA-256 checksums.
- Keep credentials, SSH configuration, cluster policy overrides, run registries,
  and project-private manifests outside the repository.

## Reporting

Report security defects privately to the repository owner. Do not demonstrate a
defect against a live remote target without separate authorization.
