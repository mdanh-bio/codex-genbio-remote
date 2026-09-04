# Conversion Plan

## Phase 0: Repository bootstrap

- Package the active Genbio skill and validators.
- Document the safety properties and target architecture.
- Keep remote execution disabled.

Exit criterion: plugin and skill validation pass with no credentials or runtime
state committed.

## Phase 1: Extract the provider-neutral core

- Inventory DSH modules and classify pure logic versus DSH runtime coupling.
- Extract schemas, policy loading, path validation, secure packaging, scheduler
  parsing, resource accounting, run registries, and reconciliation.
- Add fixture-based parity tests against the current DSH behavior.

Exit criterion: core tests run without importing any `@deepseek-ai/dsh-*`
package.

## Phase 2: Build the read-only MCP surface

- Implement the STDIO MCP server and typed tool schemas.
- Add policy status, project discovery, inventory, preflight, and status tools.
- Add output bounds, redaction tests, path-containment tests, and hostile-input
  tests.

Exit criterion: Codex can inspect declared projects and live state, but cannot
allocate resources, write remotely, cancel, or transfer data.

## Phase 3: Add approval-gated execution

- Port immutable plan generation and exact-once execution records.
- Add staging and submission with persisted intent before dispatch.
- Reconcile ambiguous SSH or scheduler outcomes without automatic resubmission.
- Add session-owned cancellation with exact job identity checks.

Exit criterion: local mocked and fixture-based failure-injection tests pass for
submit, timeout, disconnect, restart, duplicate request, and cancellation.

## Phase 4: Verified transfer and finalization

- Add allowlisted fetch operations and SHA-256 verification.
- Port terminal-evidence validation and immutable run finalization.
- Integrate OpenViking publication as a separate, retryable result.

Exit criterion: compute success remains independent from memory publication,
and no unlisted artifact can be fetched.

## Phase 5: Codex packaging and acceptance

- Add `.mcp.json` only when the server command is implemented and tested.
- Update the skill to require the MCP tools for all remote operations.
- Install through a local marketplace and restart Codex.
- Run discovery, policy-refusal, planning-only, and failure-injection acceptance
  tests before any approved live smoke test.

Exit criterion: a separately approved minimal live test produces complete
scheduler/process evidence, checksums, and an immutable run record.
