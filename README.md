# acp-pollinations

An [Agent Client Protocol](https://agentclientprotocol.com) (ACP) coding agent
backed by [Pollinations](https://pollinations.ai).

The agent speaks ACP v1 over stdio (newline-delimited JSON-RPC) and drives
Pollinations chat completions with a tool loop over the session workspace. It is
a coding agent only — no image, audio, or video generation.

The ACP wire protocol (framing, method dispatch, schema validation, error
mapping) comes from the official `@agentclientprotocol/sdk`. This package only
supplies the Pollinations-specific behaviour on top of it.

## Features

- **Native model picker** — an ACP `configOptions` select, so a client that
  supports it renders a model dropdown. The choices are read live from
  `GET /v1/models` and grouped by origin and billing tier; an offline list
  keeps `session/new` working when that endpoint is unreachable.
- **Session persistence** — sessions are stored on disk, so `session/load`
  restores a thread after the agent process restarts. Writes are atomic and
  the transcript is validated on read.
- **Session listing and deletion** — `session/list` (paged, filterable by
  workspace) and `session/delete`, so a client can drive the store instead of
  tracking it.
- **Context compaction** — once a session's last request crosses a token
  threshold, the transcript is summarised and replaced. The size comes from the
  provider's own usage report rather than an estimate.
- **Tool loop** — file reads and writes, directory listing, glob, grep, and a
  shell, all confined to the session workspace, with ACP permission gating on
  anything that mutates.
- **Cancellation and cleanup** — a cancelled turn aborts in-flight work, and
  diffs are sent to the client as ACP `diff` content rather than as prose.

Not implemented yet: MCP servers (the agent advertises no MCP capability),
elicitation, and slash commands.

## Requirements

- Node.js >= 22
- A Pollinations API key (`sk_...`)

## Install and build

```sh
npm install
npm run build
```

`npm run build` emits to `dist/` and marks the entry point executable.

## Running

```sh
npm start
# or
node dist/bin/pollinations-acp-server.js
```

The agent reads ACP requests from stdin and writes responses to stdout. A
startup banner and any diagnostics go to stderr, so the JSON-RPC stream on
stdout stays clean.

## Authentication

The API key is resolved in this order (see `resolveApiKey`):

1. The `POLLINATIONS_API_KEY` environment variable.
2. The `apiKey` field of `$POLLINATIONS_HOME/credentials.json`
   (default `~/.pollinations/credentials.json`), as written by `polli auth login`.

If neither yields a key, the agent still answers `initialize` and session setup
so clients get a useful error rather than a dead process; generation fails at
`session/new`.

## Configuration

All configuration is via environment variables (see `resolveConfig`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `POLLINATIONS_API_KEY` | — | Pollinations secret key. |
| `POLLINATIONS_BASE_URL` | `https://gen.pollinations.ai` | OpenAI-compatible API base, no trailing slash. |
| `POLLINATIONS_MODEL` | `community/YoannDev90/vercel-nemotron-3.5-lightning:free` | Model a session starts on; the picker can switch it later. |
| `ACP_MAX_TURN_REQUESTS` | `24` | Ceiling on model requests within one prompt turn. |
| `ACP_COMPACTION_THRESHOLD_TOKENS` | `50000` | Prompt tokens at or above which a transcript is summarised; `0` disables compaction. |
| `ACP_PERMISSION_MODE` | `ask` | `ask` prompts before mutating the workspace; `allow` skips permission requests (CI/demos). |
| `POLLINATIONS_HOME` | `~/.pollinations` | Directory holding `credentials.json` and the persisted sessions. |

## Model picker

Each session advertises a `model` config option (ACP's native
`session/set_config_option`), so a client that supports it renders a model
dropdown and the user can switch models mid-session. Every request in a turn
uses the session's current model.

The choices come from `GET /v1/models`, read once per agent and reused for five
minutes. Only models a coding agent can actually drive are offered: **text**
models with **tool calling**, reachable through chat completions. Image, audio,
realtime, embedding, and tool-less models are dropped rather than shown.

Models are grouped by origin and how they are billed:

| Group | Meaning |
| --- | --- |
| `official-paid` | First-party models with `paid_only: true`. |
| `official-quest` | First-party models metered in pollen, open to everyone. |
| `official-free` | First-party models priced at 0 in / 0 out. |
| `community-paid` | Community models with `paid_only: true`. |
| `community-quest` | Community models metered in pollen. |
| `community-free` | Community models priced at 0 in / 0 out. |

Switching to a model outside that list is rejected with a `-32602` error naming
the available ids, so a typo fails loudly instead of mid-turn. The session's own
model is always re-selectable, even when the catalogue does not list it — a
freshly published model must never leave the picker without a valid choice.

If `GET /v1/models` is unreachable, the agent logs to stderr and falls back to a
small offline list, so a flaky network never blocks `session/new`. The configured
`POLLINATIONS_MODEL` is always offered, whatever the catalogue says.

To inspect what the picker would offer against the live catalogue:

```sh
npm run models
```

## Session persistence

The agent advertises `loadSession`, so a client that stored a thread can
reconnect to it with `session/load` instead of starting over. This is what lets
an editor restore its threads after the agent process restarts.

Each session is written to `$POLLINATIONS_HOME/sessions/<sessionId>.json` —
the transcript, the picked model, and the tools allowed for the session. Writes
are atomic (write, then rename) so a process killed mid-save leaves the previous
record readable rather than truncated, and the transcript is validated on read:
a corrupt or unknown-version file degrades to a missing session, never to a
malformed transcript reaching the model. At most 200 sessions are kept, oldest
first.

Note that `LoadSessionResponse` carries no transcript. Clients render the
conversation from their own storage; what the agent restores is the context in
front of the model, so a reloaded thread continues where it left off.

Two details worth knowing:

- A session id from `session/load` becomes a filename, so ids are restricted to
  `[A-Za-z0-9_-]` to keep a client from reaching outside the store directory.
- If the request's `cwd` differs from the recorded one, the leading system
  message is rebuilt. That message names the working directory, so a thread
  reopened from a moved project must not go on claiming paths it cannot touch.

Tests can pass `sessionsDir` on the agent config to point somewhere else; omit
it and sessions stay in memory only.

### Listing and deleting

The agent advertises `sessionCapabilities.list` and `sessionCapabilities.delete`,
so a client can drive the store rather than track it:

- `session/list` returns stored sessions newest first, narrowed by `cwd` when
  given, and paged with an opaque cursor (50 per page). `updatedAt` is the last
  write, which is what orders the list.
- `session/delete` aborts any turn in flight, forgets the session, and removes
  its file. Deleting an id the agent never had is not an error — a client cannot
  know whether the agent still holds the thread, least of all across a restart,
  so the call succeeds silently either way.

Deleting first and aborting second matters: the other order lets a running turn
write the session straight back to disk after it was removed.

## Compaction

A long session pays for its entire transcript on every model request, so the
agent summarises and replaces it once the last request's prompt tokens reach a
threshold. The size comes from the provider's own usage report rather than an
estimate.

Above the threshold, the next turn first asks the model for a summary of the
transcript, then keeps the session's system message plus that summary — as an
`assistant` message, so role alternation stays natural for the turn that
follows. The summarisation request carries no tools: condensing a conversation
must never trigger real work.

Clients that advertise `session.compaction` additionally receive the lifecycle
as session updates, `in_progress` then `completed` with the summary. The spec
forbids sending those updates otherwise, so a client that said nothing hears
nothing while the compaction still happens.

A failed compaction is never fatal — the turn runs on the full transcript,
which is slower but correct. The threshold is `ACP_COMPACTION_THRESHOLD_TOKENS`,
and `0` turns the whole mechanism off.

## Tools

The model can call these tools, all confined to the session workspace root:

| Tool | Kind | Mutating |
| --- | --- | --- |
| `read_file` | read | no |
| `list_dir` | read | no |
| `glob` | search | no |
| `grep` | search | no |
| `write_file` | edit | yes |
| `edit_file` | edit | yes |
| `bash` | execute | yes |

In `ask` mode, mutating tools raise an ACP `session/request_permission` and wait
for the client's decision. Read-only tools run without prompting.

## Development

```sh
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run watch       # tsc --watch
```

Tests live in `tests/` and cover the SSE parser, tool belt, config resolution,
model catalogue and picker, LLM client, agent behaviour, and an end-to-end
subprocess run against a fake LLM server.

### Conformance

```sh
npm run tck
```

Runs the official [acp-tck](https://github.com/EugeneTheDev/acp-tck) suite
against the built agent. The first run clones it into `.tools/` at a pinned
commit; the agent is pointed at a local fake Pollinations endpoint, so the run
needs no API key and bills nothing. Set `TCK_LIVE=1` to exercise the real API
and its tool-calling loop instead.

The runner rebuilds `dist/` if it is stale — the suite launches the built
binary, so certifying an old one would be worse than not running it — and
isolates `POLLINATIONS_HOME`, because `session/list` and `session/delete` are
themselves conformance requirements and the suite will really delete sessions.

Current verdict: **CONFORMANT** — 31/31 MANDATORY, 9/9 exercised CAPABILITY,
12/13 ADVISORY. The one remaining failure is `ACP-SESSION-004`: the agent does
not connect to MCP servers supplied by the client, which is the known MCP gap.
The report lands in `.tck/report.json`.

## Library usage

Besides the server binary, the package exports the agent and its parts for
embedding:

```ts
import { createPollinationsAgent, resolveConfig } from "acp-pollinations";

const config = await resolveConfig();
const agent = createPollinationsAgent({ config });
// agent.connect(ndJsonStream(output, input))
```

See `index.ts` for the full export surface.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the checks that must pass,
and the conventions this codebase follows.

## Licence

[MIT](LICENSE) © YoannDev90.
