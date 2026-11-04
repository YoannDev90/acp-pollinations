# Changelog

Notable changes to this project, newest first.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
how versions are chosen and releases are cut is in
[CONTRIBUTING.md](CONTRIBUTING.md#versioning-and-releases). Feature-by-feature
protocol status lives in [COVERAGE.md](COVERAGE.md) rather than here.

## [Unreleased]

Nothing has been published to npm yet, so every entry below ships for the
first time in 1.0.0.

### Added

- **ACP v1 agent over stdio** — `initialize`, the full session lifecycle,
  streamed prompt turns, tool calls with permission requests, session modes,
  `configOptions` pickers, `usage_update`, compaction reporting, and the
  client-side filesystem and terminal handlers. The itemised list is in
  [COVERAGE.md](COVERAGE.md).
- **Model picker** built from the live `/v1/models` catalogue and grouped by
  origin and price tier, with an offline fallback when the catalogue cannot be
  read.
- **Tools** to read and edit files, glob and grep the workspace, and run shell
  commands — every path confined to the session's workspace roots.
- **MCP servers** over stdio, HTTP, and SSE, their tools merged into the
  picker and the permission flow.
- **Session persistence** under `$POLLINATIONS_HOME/sessions`, reloadable
  across restarts through `session/load` and `session/list`.
- **Graceful shutdown**: SIGINT and SIGTERM abort in-flight turns, close MCP
  children, and write every transcript back before the process leaves.
- **Retries with exponential backoff** on the chat stream and on the model
  catalogue, honouring `Retry-After`, each attempt with its own timeout.
- **Diagnostics** mirrored to `$POLLINATIONS_HOME/logs` and rotated at 2 MiB
  with three kept generations.
- **Library entry point**: `createPollinationsAgent`, `resolveConfig`, the LLM
  client, the catalogue helpers, and the tool definitions are importable from
  `acp-pollinations`.
- **CI on Node 22 and 24**: typecheck, type-aware lint, tests with coverage
  thresholds, `npm audit --audit-level=high`, and a separate acp-tck
  conformance job.

### Security

- Workspace confinement checks every path lexically and again after `realpath`
  so a symlink cannot escape the session roots; client-supplied session ids
  are validated before they reach a filename; mutating tools require a client
  permission grant unless the operator set `ACP_PERMISSION_MODE=allow`. The
  trust model is documented in [SECURITY.md](SECURITY.md).
