# Agent notes

## Language

All code, comments, documentation, commit messages, and log output **MUST** be
written in English. User-facing strings and error messages are English too.

## Project

`acp-pollinations` is an ACP v1 coding agent backed by Pollinations.
Read `README.md` for setup and `COVERAGE.md` for what is already implemented.

## Commands

```sh
npm run typecheck   # tsc --noEmit
npm test            # vitest run (builds first)
npm run build       # compile to dist/
npm run models      # inspect the live model catalogue
npm run tck         # conformance suite
```

Both `npm run typecheck` and `npm test` must pass before opening a PR.

## Conventions

- ACP v1 stable only. The SDK root export is `dist/v1/stable`. v2 is experimental
  and must not be used.
- v1 calls a select group's key `group`; v2 renamed it `groupId`. Mixing them
  produces payloads the v1 protocol rejects.
- No `any` in product code. Use `unknown` plus a narrowing check.
- Failures degrade at the edges: corrupt sessions become missing sessions,
  unreachable catalogues fall back to the offline list, failed persistence is
  reported and the turn continues. Reserve thrown errors for requests the
  client must be told about.
- Doc comments explain *why*, not *what*.

## Documentation references

- `README.md` — setup, configuration, features.
- `COVERAGE.md` — ACP v1 feature coverage (all items implemented).
- `CONTRIBUTING.md` — setup, checks, conventions.
- `docs/acp-v1/` — exported ACP v1 protocol documentation.
- `docs/acp-v1/prompt-turn.md` — prompt lifecycle, `usage_update`, compaction.
- `docs/acp-v1/session-modes.md` — Build/Plan/Ask modes.
- `docs/acp-v1/session-config-options.md` — model and reasoning selectors.
- `docs/acp-v1/tool-calls.md` — tool call reporting and permissions.

## Logging

Diagnostics go to stderr and are mirrored to
`$POLLINATIONS_HOME/logs/pollinations-acp-server.log`. Keep log messages in
English and include the session id when the log is session-scoped.