# acp-pollinations

> A coding agent for your editor, powered by [Pollinations](https://pollinations.ai).

`acp-pollinations` is an [Agent Client Protocol](https://agentclientprotocol.com) (ACP)
coding agent that drives Pollinations chat completions with a full tool loop over
your session workspace. Point it at a project, pick a model, and let it read,
edit, search, and run commands — all confined to your workspace.

```
npm install
npm run build
node dist/bin/pollinations-acp-server.js
```

The agent speaks ACP v1 over stdio (newline-delimited JSON-RPC). A startup
banner and all diagnostics go to stderr, so the JSON-RPC stream on stdout stays
clean. Diagnostics are also mirrored to
`$POLLINATIONS_HOME/logs/pollinations-acp-server.log`.

## Why

- **One command to a working agent.** No daemon, no database, no config files
  beyond an API key.
- **Native model picker.** An ACP `configOptions` select renders a model
  dropdown in supporting clients, grouped by origin and billing tier, read live
  from the Pollinations catalogue.
- **Real session persistence.** Threads survive agent restarts: atomic writes,
  validated transcripts, `session/load`, `session/list`, `session/delete`.
- **Honest context management.** Compaction triggers on the provider's own
  token report, not a guess, and only when the client opted in.
- **Tools that behave.** File read/write/edit, directory listing, glob, grep,
  and a shell — all path-guarded, with permission gating on anything that
  mutates.
- **MCP-ready.** stdio, HTTP, and SSE MCP servers supplied by the client are
  connected and their tools exposed alongside the built-ins.
- **Cancellation and diffs.** A cancelled turn aborts in-flight work; edits are
  sent as ACP `diff` content, not prose.

## Quick start

```sh
git clone https://github.com/YoannDev90/acp-pollinations.git
cd acp-pollinations
npm install
npm run build
```

Get a Pollinations key (see [Authentication](#authentication)), then:

```sh
npm start
# or
node dist/bin/pollinations-acp-server.js
```

Wire the binary into your editor's ACP agent settings and you are done.

## Authentication

The agent authenticates with a Pollinations secret key (`sk_...`) in an
`Authorization: Bearer` header. The easiest way to provision one is
[`polli`](https://gen.pollinations.ai/docs#tag/cli):

```sh
npm install -g @pollinations/cli
polli auth login
```

`resolveApiKey` checks, in order:

1. `POLLINATIONS_API_KEY`
2. `$POLLINATIONS_HOME/credentials.json` (default `~/.pollinations/credentials.json`)

No key at startup is not fatal: `initialize` and session setup still answer so
the client reports a useful error instead of a dead process. `session/new`
fails with `-32000` until a key is configured.

## Configuration

All configuration is via environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `POLLINATIONS_API_KEY` | — | Pollinations secret key. |
| `POLLINATIONS_BASE_URL` | `https://gen.pollinations.ai` | OpenAI-compatible API base, no trailing slash. |
| `POLLINATIONS_MODEL` | `z-ai/glm-5.3-flash` | Model a session starts on. |
| `POLLINATIONS_HOME` | `~/.pollinations` | Home for credentials, sessions, and logs. |
| `ACP_MAX_TURN_REQUESTS` | `24` | Ceiling on model requests per prompt turn. |
| `ACP_COMPACTION_THRESHOLD_TOKENS` | `0` (auto) | Prompt tokens at/above which a transcript is summarised. `0` = 85% of the model's context window; negative disables. |
| `ACP_PERMISSION_MODE` | `ask` | `ask` prompts before mutating; `allow` skips (CI/demos). |

## Model picker

Each session advertises a native `model` config option, so supporting clients
render a dropdown and the user can switch models mid-session. Choices come from
`GET /v1/models` (refreshed every 5 minutes) and are filtered to text models
with tool calling reachable through chat completions.

Models are grouped by origin and billing tier:

| Group | Meaning |
|---|---|
| `official-paid` | First-party models with `paid_only: true`. |
| `official-quest` | First-party metered models. |
| `community-paid` | Community models with `paid_only: true`. |
| `community-quest` | Community metered models. |
| `community-free` | Community models publishing an explicit 0 in / 0 out, or no price at all (except agent models). |

There is no `official-free` group: a missing price on a first-party model means
the price varies, not that it is free. Hand-written `:free` / `:paid` suffixes
are ignored for the same reason.

Switching to an unlisted model is rejected with `-32602` naming the available
ids. The session's own model is always re-selectable.

## Sessions

Sessions persist to `$POLLINATIONS_HOME/sessions/<id>.json` (atomic
write-then-rename, validated on read). `session/load` restores the context in
front of the model and replays the transcript so the client can render it.

- `session/list` — paged (50 per page), filterable by workspace.
- `session/delete` — aborts any turn in flight and removes the file.
- `session/close` / `session/resume` — free resources or reconnect without replay.
- At most 200 sessions are kept, oldest first.

## Tools

All tools run inside the session workspace root set:

| Tool | Kind | Mutating |
|---|---|---|
| `read_file` | read | no |
| `write_file` | edit | yes |
| `edit_file` | edit | yes |
| `list_dir` | read | no |
| `glob` | search | no |
| `grep` | search | no |
| `bash` | execute | yes |

Mutating tools raise `session/request_permission` in `ask` mode. Read-only tools
run without prompting. Plan mode disables mutations entirely.

Slash commands: `/help`, `/status`, `/model`, `/mode`, `/reasoning`, `/clear`,
`/cost`, `/tools`, `/compact`, `/sessions`, `/delete`.

## Compaction

When a turn's prompt tokens reach `ACP_COMPACTION_THRESHOLD_TOKENS`, the next
turn first summarises the transcript, then keeps the system message plus the
summary. The size comes from the provider's own usage report. Clients that
advertise `session.compaction` receive `in_progress` / `completed` updates.

## Development

```sh
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run watch       # tsc --watch
npm run tck         # conformance suite
```

Tests never touch the network. See `CONTRIBUTING.md` for conventions.

## Library usage

```ts
import { createPollinationsAgent, resolveConfig } from "acp-pollinations";

const config = await resolveConfig();
const agent = createPollinationsAgent({ config });
// agent.connect(ndJsonStream(output, input))
```

## Licence

[MIT](LICENSE) © YoannDev90.