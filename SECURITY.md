# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.x | ✅ |

There is no LTS branch: fixes land on the newest published release, and older
versions are not patched separately.

## Reporting a vulnerability

Please report it privately through
[GitHub Security Advisories](https://github.com/YoannDev90/acp-pollinations/security/advisories/new)
rather than in a public issue. A report should include the version, a
reproduction, and what you believe the impact is; a fix or a suggested patch is
welcome but not required. Reports are acknowledged within about a week, and a
fix is developed privately before any disclosure.

If a report turns out to be out of scope (see below), you will be told so
plainly rather than left waiting.

## Trust model

The agent is a child process of the client that launched it, speaking ACP over
stdio. That placement decides most of what follows.

**Who controls the process controls the agent.** Whoever can write to the
agent's stdin is the client: they can create sessions, choose the workspace
roots, approve or deny tool calls, and close the connection. This is the same
trust your editor already has — the agent opens no listening socket and
accepts no connections of its own.

**Where the key goes.** The Pollinations API key is read from
`POLLINATIONS_API_KEY`, a config file under `$POLLINATIONS_HOME`, or the
credentials file, and is sent only as a `Bearer` header to the configured
`baseUrl`. It is never written to the log, to a session file, or to an error
message. Because `baseUrl` comes from configuration, anyone who can edit that
configuration can redirect the key to another host: config files are trusted
exactly as much as the command line they replace.

**The workspace is a boundary.** File tools resolve every path through
`src/paths.ts`, which checks the path twice — lexically against the session's
root set, then again after `realpath`, so a symlink pointing out of the
workspace does not escape it. Paths outside the roots are refused with an
error the model sees, not silently truncated.

**Tool calls are the client's decision.** Mutating tools are flagged and put
to the client through `session/request_permission` before anything happens;
`ACP_PERMISSION_MODE=allow` removes that prompt, which is a deliberate
operator choice for CI and demos, not a default. The `bash` tool can run
anything the agent's user can run: that is its purpose, and it is gated by the
same permission flow.

**MCP servers are code you configured.** Entries in `mcpServers` are spawned
with the `command`, `args`, and `env` they carry, and HTTP servers are called
with the headers they were given. The agent does not second-guess either: an
MCP server runs with the agent's privileges, so only configure servers you
would run yourself.

**What lands on disk.** Transcripts are written to
`$POLLINATIONS_HOME/sessions/*.json` and diagnostics to
`$POLLINATIONS_HOME/logs/`, both created with the process umask. Session ids
from the client are validated against `[A-Za-z0-9_-]{1,128}` before they are
used in a filename, so `session/load` cannot be pointed outside the sessions
directory. If prompts and transcripts are sensitive, restrict the home
directory accordingly; the log rotates at 2 MiB with three kept generations
so it cannot fill the disk.

**Model output is data, not instructions.** Content arriving from the model —
including text it fetched from a page — is untrusted input to be rendered and
checked, never executed on sight. The ACP trust model is written up in the
protocol's own
[Security Considerations](https://agentclientprotocol.com/protocol/v1/security.md).

## Out of scope

- The Pollinations API and service: its availability, its content policy, and
  how it handles prompts sent to it.
- The `@agentclientprotocol/sdk` and other dependencies, which are reported
  upstream (dependency advisories are still checked in CI with
  `npm audit --audit-level=high`).
- The client or editor hosting the agent, including its permission UI.
- MCP servers, prompts, and workspaces the operator chose to configure.
- Social engineering, physical access, and attacks that already require
  control of the agent's account or host.
