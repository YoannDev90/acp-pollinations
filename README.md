<p align="center">
  <img src="banner.svg" alt="acp-pollinations" width="100%">
</p>

# acp-pollinations

<p align="center">
  <a href="https://github.com/YoannDev90/acp-pollinations/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/YoannDev90/acp-pollinations/ci.yml?branch=main&style=for-the-badge&label=CI" alt="CI"></a>
  <a href="https://codecov.io/gh/YoannDev90/acp-pollinations"><img src="https://img.shields.io/codecov/c/github/YoannDev90/acp-pollinations?branch=main&style=for-the-badge&label=coverage" alt="coverage"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=for-the-badge" alt="license"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="node"></a>
  <a href="https://agentclientprotocol.com"><img src="https://img.shields.io/badge/ACP-v1-ff6b4a?style=for-the-badge&logoColor=white" alt="ACP v1"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript"></a>
</p>

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
2. the config file: `$POLLINATIONS_HOME/config-acp` (or `config-acp.json`,
   `config.json`), key `api_key` — `apiKey` and `pollinations_api_key` are
   accepted too
3. `$POLLINATIONS_HOME/credentials.json` (default
   `~/.pollinations/credentials.json`, written by `polli auth login`)

No key at startup is not fatal: `initialize` and session setup still answer so
the client reports a useful error instead of a dead process. `session/new`
fails with `-32000` until a key is configured.

## Configuration

Configuration is read from environment variables first, then from an editable
file `$POLLINATIONS_HOME/config-acp` (JSON, also tried as `config-acp.json`
then `config.json`). Keys: `model`, `base_url`, `permission_mode`,
`max_turn_requests`, `compaction_threshold_tokens`, `api_key`. Environment
variables take precedence; only the key falls back to `credentials.json`.

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

## Architecture

One process, no daemon: the client spawns the binary and speaks ACP over stdio,
and behind the request handlers everything is a module with one job.

```
src/
├── agent/server.ts        request handlers, prompt loop, permissions, shutdown
├── agent/session-state.ts the in-memory shape of one session
├── llm.ts                 chat-completion stream, tool-call deltas, retries
├── net.ts                 backoff and sleep, shared with the catalogue
├── tools/index.ts         tool schemas and execution
├── paths.ts               workspace root confinement (lexical, then realpath)
├── mcp/index.ts           stdio / HTTP / SSE MCP clients
├── sessions/index.ts      one JSON file per session, written atomically
├── models.ts              /v1/models catalogue and the picker option
├── compaction.ts          transcript summarisation
├── messages.ts            prompt-to-text, system prompt, history rebasing
├── connection.ts          per-connection identity and update delivery
├── errors.ts              the `ToolError` the tools throw
├── config.ts, logger.ts   env + file configuration, stderr mirror
└── index.ts               the public library surface
```

A prompt turn runs in `agent/server.ts`: replay the user message, compact first
if the threshold was reached, stream `agent_message_chunk` and
`agent_thought_chunk` updates while `llm.ts` reads the SSE stream, execute
requested tools through the permission flow, then persist the transcript.
Everything the client sees rides the same connection the prompt arrived on.

State is deliberately small. Sessions live in memory and are written to
`$POLLINATIONS_HOME/sessions` after every turn and once more on shutdown; the
model catalogue is cached for five minutes; diagnostics are appended under
`$POLLINATIONS_HOME/logs`. Nothing else survives the process.

## Development

```sh
npm run typecheck   # tsc --noEmit
npm run lint        # eslint .
npm test            # vitest run
npm run coverage    # tests with coverage thresholds
npm run watch       # tsc --watch
npm run tck         # conformance suite
```

Tests never touch the network. See `CONTRIBUTING.md` for conventions and
`CHANGELOG.md` for what has changed.

## Library usage

```ts
import { createPollinationsAgent, resolveConfig } from "acp-pollinations";

const config = await resolveConfig();
const agent = createPollinationsAgent({ config });

// Speaks ACP over any SDK stream — stdio in production, an in-process
// stream in tests. Returns the SDK connection, so `connectWith(...)` and
// the rest of its surface are available unchanged.
const connection = agent.connect(ndJsonStream(output, input));

// Before the process leaves: abort in-flight turns, close MCP children,
// write every transcript back. Memoised, so calling it twice is safe.
// `bin/pollinations-acp-server.ts` wires this to SIGINT, SIGTERM, and
// stdin EOF; a library consumer owns that wiring instead.
process.once("SIGTERM", () => {
  void agent.shutdown().then(() => connection.close());
});
```

## Troubleshooting

**The agent exits the moment my editor starts it.** Run it by hand —
`node dist/bin/pollinations-acp-server.js` — and read stderr: the startup
banner comes first, then whatever went wrong. The usual causes are a missing
build (`npm run build`) and Node older than 22. Stdout carries the JSON-RPC
stream and nothing else, so a silent terminal means the process never
started.

**`session/new` fails with `-32000`.** No key reached the agent. See
[Authentication](#authentication): `POLLINATIONS_API_KEY`, the config file, or
`polli auth login`.

**The model dropdown is empty, or only offers the fallback list.** The
catalogue could not be read. It is retried three times with backoff, and the
log then says `model catalogue unavailable (...); offering the offline list`.
That usually means no network from the editor's environment, a proxy in the
way, or a wrong `POLLINATIONS_BASE_URL`. `npm run models` prints exactly what
the live endpoint returns.

**Tools run without asking, or never ask.** `ACP_PERMISSION_MODE` (or
`permission_mode` in the config file) is set to `allow`. Plan mode also
disables mutations, so a tool that declines to act is often a mode question —
`/status` shows which one is active.

**My MCP server's tools are missing.** The connection failed and the session
carried on without them; stderr says which (`MCP connection failed …`,
`MCP: failed to connect to …`). The usual cause is an editor launching the
agent with a minimal `PATH`, so the server's `command` is not on it.

**An edit is refused as "outside the session workspace".** File tools are
confined to the session's root set, symlinks included. The roots come from
the client: the directory it passed to `session/new`, plus any
`additionalDirectories` it offered.

**Something happened and I want the details.** stderr is mirrored to
`$POLLINATIONS_HOME/logs/pollinations-acp-server.log`, one timestamped line
per message, rotated at 2 MiB with three kept generations.

## Security

The trust model — who controls the process, where the API key goes, what the
workspace boundary enforces, and what lands on disk — is written down in
[SECURITY.md](SECURITY.md), together with how to report a vulnerability
privately.

## Licence

[MIT](LICENSE) © YoannDev90.