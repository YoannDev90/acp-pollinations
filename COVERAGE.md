# ACP v1 coverage

Status of this agent against the [Agent Client Protocol v1](https://agentclientprotocol.com/protocol/v1/overview.md).

Legend: ✅ implemented, ❌ not implemented (optional in most cases), ⚠️ partial.

## Core lifecycle

| Feature | Status | Notes |
|---|---|---|
| `initialize` / version negotiation | ✅ | `PROTOCOL_VERSION`, capability exchange |
| `authenticate` | ✅ | no-op; the API key lives on the machine |
| `session/new` | ✅ | `cwd`, `additionalDirectories`, `mcpServers` |
| `session/load` | ✅ | restores history and replays it |
| `session/resume` | ❌ | not implemented (optional) |
| `session/list` | ✅ | paged, filterable by `cwd` |
| `session/delete` | ✅ | aborts the turn and removes the file |
| `session/close` | ❌ | not implemented (optional) |
| `session/prompt` | ✅ | tool loop, `maxTurnRequests` ceiling |
| `session/cancel` | ✅ | aborts in-flight work |

## Configuration and modes

| Feature | Status | Notes |
|---|---|---|
| `session/set_mode` | ✅ | Build / Plan / Ask; Plan disables mutations |
| `session/set_config_option` | ✅ | model + reasoning |
| Model picker (`configOptions`) | ✅ | grouped by origin and billing tier |
| Reasoning selector | ✅ | `thought_level` category |
| `config_option_update` notification | ❌ | options are returned in responses only |

## Session updates (`session/update`)

| `sessionUpdate` value | Status | Notes |
|---|---|---|
| `user_message_chunk` | ✅ | |
| `agent_message_chunk` | ✅ | |
| `agent_thought_chunk` | ✅ | |
| `tool_call` | ✅ | with `name`, `kind`, `rawInput` |
| `tool_call_update` | ✅ | with diff / terminal content |
| `plan` | ❌ | no structured plan |
| `available_commands_update` | ❌ | slash commands not implemented |
| `current_mode_update` | ✅ | |
| `session_info_update` | ❌ | no auto title |
| `usage_update` | ✅ | `used` / `size` / `cost` (USD) |
| `notice` | ❌ | not implemented |
| `compaction_update` / `compaction_summary_chunk` | ✅ | when client advertises support |

## Tools

| Tool | Status | Kind | Mutating |
|---|---|---|---|
| `read_file` | ✅ | read | no |
| `write_file` | ✅ | edit | yes |
| `edit_file` | ✅ | edit | yes |
| `list_dir` | ✅ | read | no |
| `glob` | ✅ | search | no |
| `grep` | ✅ | search | no |
| `bash` | ✅ | execute | yes |

All built-in tools are confined to the session workspace root set (symlinks resolved).

## Client capabilities used

| Capability | Status | Notes |
|---|---|---|
| `fs.readTextFile` / `writeTextFile` | ✅ | falls back to local disk |
| `terminal/*` | ✅ | falls back to local spawn |
| `session.compaction` | ✅ | gates compaction lifecycle updates |
| `session.notices` | ❌ | not advertised or sent |

## Permissions

| Feature | Status | Notes |
|---|---|---|
| `session/request_permission` | ✅ | |
| `allow_once` / `allow_always` / `reject_once` | ✅ | `allow_always` remembered per session |
| `ask` / `allow` permission modes | ✅ | via `ACP_PERMISSION_MODE` |

## MCP

| Transport | Status | Notes |
|---|---|---|
| stdio | ✅ | tools exposed to the model |
| HTTP | ✅ | `mcpCapabilities.http = true` |
| SSE | ❌ | `mcpCapabilities.sse = false` |

## Other features

| Feature | Status | Notes |
|---|---|---|
| Context compaction | ✅ | threshold from provider usage report |
| Session persistence | ✅ | atomic writes, validated on read |
| Session listing / deletion | ✅ | |
| Context usage + cost reporting | ✅ | `usage_update` |
| Slash commands | ❌ | not implemented |
| Elicitation | ❌ | not implemented |
| Authentication methods | ❌ | by design: key lives on the machine |
| Additional workspace roots | ✅ | |
| `session/close` / `session/resume` | ❌ | not implemented |

Last updated against the ACP v1 documentation exported in `docs/acp-v1/`.