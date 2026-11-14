# Feature roadmap

## Priority candidates

### Image support in prompts

Support image attachments in ACP prompts when the selected Pollinations model
accepts multimodal input.

- Translate ACP image content into the provider's expected message format.
- Support local files through the existing workspace path restrictions.
- Support image URLs only when explicitly allowed by the client or configuration.
- Preserve image metadata when sessions are persisted and reloaded.
- Report unsupported formats and oversized images clearly.
- Add focused tests for local images, remote images, invalid input, and
  non-vision models.

### Git integration

Expose safe, read-oriented Git capabilities before adding mutating operations.

- Add tools or commands for status, diff, log, branch, and changed files.
- Keep all repository paths confined to the session workspace roots.
- Return structured output where possible, with bounded output sizes.
- Detect repositories and report a useful error outside a Git worktree.
- Add permission checks for mutating operations such as commit, checkout,
  reset, and push.
- Consider a dedicated Git tool instead of making every Git operation go
  through the generic shell tool.

## Agent safety and reliability

- Add command allowlists, timeouts, output limits, and optional resource
  limits for shell execution.
- Add retries with backoff for Pollinations rate limits, transient server
  errors, and interrupted streams.
- Add configurable model fallback when a provider or model is unavailable.
- Add per-session token, request, time, and cost budgets.
- Add health reporting for Pollinations and connected MCP servers.
- Add session snapshots with restore points before risky operations.
- Add secret masking in prompts, shell output, diagnostics, and persisted
  transcripts.

## MCP and skills

- Persist MCP server definitions in the settings file.
- Add `/mcp`, `/mcp-add`, and `/mcp-remove` commands.
- Reconnect failed MCP servers and expose their health state.
- Support enabling and disabling skills per session.
- Detect skill changes without restarting the agent.
- Validate skill metadata and report duplicate or conflicting skills.
- Expose which skills were loaded or invoked during a turn.
- Add project profiles for repository-specific rules, commands, models, and
  skills.

## Session and client experience

- Add session search, tags, favorites, rename, and export/import.
- Add `/retry`, `/undo`, `/rename`, `/export`, and `/health` commands.
- Add richer elicitation for structured questions from the model.
- Add configurable session retention and cleanup.
- Improve ACP conformance and interoperability testing across clients.
- Add a diagnostic command or report showing effective configuration, client
  capabilities, model, MCP servers, and active skills.

## Observability

- Track tool duration, retry counts, model latency, and error categories.
- Add configurable log levels.
- Provide per-session and per-model usage summaries.
- Optionally export telemetry through JSON or OpenTelemetry.

## Editing and validation

- Add structured editing with unified patch application, before/after
  previews, and per-file rollback.
- Add an automatic validation loop that runs tests, lint, and build after
  changes, then feeds failures back to the model.
- Add a code review mode that emits structured ACP comments for a diff.

## Context and model efficiency

- Add semantic or symbol-based workspace indexing to avoid rereading files.
- Cache files, Git results, and analyses already loaded during a session.
- Route simple tasks to a fast model and complex reasoning or edits to a more
  capable model.
- Add automated evaluations with reproducible scenarios measuring quality,
  cost, latency, and success rate.

## Repository workflows

- Add monorepo detection with package-aware commands and per-project limits.
- Support selecting or creating an isolated Git worktree per session.
- Add a degraded offline mode for navigation, Git, and other local operations
  without a remote model.

## Extensibility

- Add an extension API for third-party tools, commands, and model providers.

## Remote and multimodal expansion

- Support additional multimodal content types when ACP and Pollinations
  capabilities permit them.
- Consider a secure remote transport with authentication and workspace
  isolation.
- Add project hooks before and after prompts or tool calls.
