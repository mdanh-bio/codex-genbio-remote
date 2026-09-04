# DSH to Codex Differences (0.4.0 Parity)

This document describes the architectural and operational differences between
the original `dsh-genbio-remote` package (v0.4.0) and the Codex plugin
`codex-genbio-remote` (v0.4.0).

## 1. Runtime Architecture and Protocol

- **DSH**: Integrated into DeepSeek Desktop via Cordis dependency injection
  (`ctx.get`, `ctx.provide`, `ctx.effect`), custom tool wrappers (`defineTool`),
  and custom internal timers.
- **Codex**: Implemented as a provider-neutral MCP (Model Context Protocol)
  STDIO server using `@modelcontextprotocol/sdk` (1.30.0), Zod validation, and
  standardized JSON-RPC.

## 2. Session and Ownership Identity

- **DSH**: Relied on in-memory DSH session objects (`exec.agent.session.id`)
  managed by the host application.
- **Codex**: Exposes an opaque, workspace-bound, persisted `owner_handle`
  (`own_<hex32>`), created deterministically via `genbio_set_envelope`. All
  consequential or stateful execution, fetch, cancellation, and finalization
  tools require this handle.

## 3. Configuration Management

- **DSH**: Configured through `cordis.patch.yml` and DSH profile settings.
- **Codex**: Driven by a single external configuration YAML file referenced
  by the `GENBIO_CONFIG_PATH` environment variable. Credentials, SSH keys,
  and rclone remotes remain strictly external in user configuration.

## 4. User Interaction and Approval Elicitation

- **DSH**: Used the Cordis `userQuestions` service for interactive prompts.
- **Codex**: Implements an MCP elicitation adapter that interacts with Codex
  client elicitation capabilities, failing closed with zero remote side effects
  when elicitation is unavailable or access is rejected.

## 5. Client Projection vs. Tool-Driven Status

- **DSH**: Maintained a proprietary GUI dock panel projecting real-time state.
- **Codex**: Eliminates host-specific GUI projection in favor of bounded,
  read-only MCP tools (`genbio_projects_status`, `genbio_runs`, `genbio_monitor`)
  providing full diagnostic evidence.

## 6. OpenViking Memory Publication

- **DSH**: Injected `openvikingMemory` service dynamically via Cordis plugin
  hooks.
- **Codex**: Implements a decoupled, idempotent publisher adapter. When
  OpenViking is unavailable or unconfigured, compute state and finalized
  records remain completely preserved while publication returns `unavailable`.

## 7. Execution Surface

- **Parity**: All 37 public `genbio_*` tools are preserved with strict schema
  validation, exact-once execution tokens, immutable plan hashing, and
  non-interactive SSH/rclone safety.
