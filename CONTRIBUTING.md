# Contributing

Thanks for considering a contribution. This is a small, focused codebase: an
ACP agent that drives Pollinations chat completions. Small is the point —
changes that grow it beyond a coding agent's needs are usually declined.

## Getting set up

```sh
npm ci
npm run build
```

Node.js 22 or newer is required (`engines` in `package.json`).

## Before you open a pull request

```sh
npm run typecheck   # tsc --noEmit
npm run lint        # eslint .
npm test            # vitest run
```

All three must pass. Tests never touch the network: they run against a fake
Pollinations endpoint in `tests/helpers/fake-llm-server.ts`, which scripts
turns and records what the agent sent. Add a scripted turn there rather than
calling a real API.

CI runs those three on Node 22 and 24, and adds two checks on Node 22 only:
`npm run coverage`, whose thresholds live in `vitest.config.ts` and cover
`src/` alone (the entry point runs as a separate process, so its coverage
never reaches the report), and `npm audit --audit-level=high`. Raise the
thresholds together with the tests that justify the new floor.

`npm run models` is the one command that does hit the network — it prints what
the picker would offer against the live catalogue. It is a diagnostic, not part
of the test run.

### Conformance

```sh
npm run tck
```

The first run clones [acp-tck](https://github.com/EugeneTheDev/acp-tck) into
`.tools/` and pins it to a known commit, so a green verdict means the same thing
next month as it does today. Override with `TCK_REF=<sha-or-branch>`.

Two things the runner refuses to get wrong, both of which otherwise produce a
verdict about something other than your change:

- **It rebuilds first.** The suite launches the built binary, so a stale `dist/`
  would certify yesterday's agent.
- **It does not use your `~/.pollinations`.** `session/list` and
  `session/delete` are conformance requirements, so the suite really does delete
  sessions. `POLLINATIONS_HOME` is redirected at a disposable `.tck/` tree.

The agent is wired to a local fake Pollinations endpoint by default: no API key,
no network, nothing billed. `TCK_LIVE=1` runs against the real API instead, which
is the only way to exercise the actual tool-calling loop — set a real
`POLLINATIONS_API_KEY` first.

Worth running for anything that touches the protocol: new capabilities,
`configOptions`, session lifecycle. The report lands in `.tck/report.json`.

Current state: **CONFORMANT** — 31/31 MANDATORY, 13/13 ADVISORY.

## Conventions worth keeping

**ACP v1 stable, not v2.** The SDK's root export is `dist/v1/stable`. This
matters: v1 calls a select group's key `group`, v2 renamed it `groupId`. Types
imported from a v2 path compile but produce payloads the v1 protocol rejects.

**Doc comments explain why, not what.** The codebase reserves its comments for
rationale a reader cannot recover — why a field is optional, why an operation
runs in a particular order, what breaks if it moves. Prefer that over
restating the signature.

**No `any` in product code.** `unknown` plus a narrowing check is the
established pattern; `tests/` is more relaxed where it documents a shape.

**Failures should degrade, not throw, at the edges.** A corrupt session file
becomes a missing session. An unreachable catalogue falls back to an offline
list. A failed persistence write is reported and the turn continues. Reserve
thrown errors for requests the client must be told about.

## Versioning and releases

The package follows [Semantic Versioning](https://semver.org/). Two values
carry the version, and a release bumps both:

- `version` in `package.json`, which npm and the tag see;
- `AGENT_VERSION` in `src/agent/server.ts`, which the agent reports in
  `initialize` and prints in its startup banner.

Nothing checks that they agree, so that pairing is the release author's to
get right.

**What counts as public API:** everything `src/index.ts` exports, and the ACP
behaviour the binary speaks — its advertised capabilities, config options,
tool names, and error codes. The numbers below are about those.

- **Patch** — a fix that leaves both the exports and the wire behaviour alone.
- **Minor** — a new export, capability, config option, or tool: anything an
  existing client keeps working through.
- **Major** — removing or renaming an export, or changing a wire-visible
  value (a tool name, an error code, the default model) a client may depend
  on.

Every pull request adds its line to `Unreleased` in `CHANGELOG.md`, under
Added, Changed, Fixed, or Security — a change nobody wrote down is a change
the next reader has to reconstruct from the log.

To cut a release:

1. Move the `Unreleased` section to the new version with today's date, and
   set `AGENT_VERSION` to that same version. Commit both.
2. `npm version <patch|minor|major>` — updates `package.json` and creates the
   tag.
3. `npm publish` — the `prepack` script rebuilds `dist/`, so a stale build
   cannot ship.
4. `git push --follow-tags`.

Publishing is a manual step taken from a clean tree with `npm run typecheck`,
`npm run lint`, and `npm test` all green; there is no release workflow in CI
yet.

## Reporting bugs

Open an issue with:

- The client and its version (Zed, VS Code, …).
- What you expected and what happened instead.
- The agent's stderr, which carries the startup banner and every diagnostic.
  The JSON-RPC stream on stdout is deliberately clean and rarely informative.

Security issues are the one thing not to open publicly: report them through
[GitHub Security Advisories](https://github.com/YoannDev90/acp-pollinations/security/advisories/new)
instead, as described in `SECURITY.md`.

## Licence

By contributing you agree your changes are licensed under the MIT License, the
same as the project.
