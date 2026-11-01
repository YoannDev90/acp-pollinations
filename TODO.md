# Todo — ACP v1 gaps

Missing features from `COVERAGE.md`, sorted by priority.

## P1 — High (user-facing / Zed UX)

- [x] **Session info update** (`session_info_update`): auto-generate and push a session title after the first meaningful exchange.
- [x] **Slash commands** (`available_commands_update`): advertise available commands.
- [x] **Session notices** (`notice`): surface live warnings/info to the client.
- [x] **Config option updates** (`config_option_update`): notify clients when options change.

## P2 — Medium (session lifecycle)

- [x] **`session/close`**: cancel work and free resources; advertise `sessionCapabilities.close`.
- [x] **`session/resume`**: reconnect without replaying history; advertise `sessionCapabilities.resume`.
- [ ] **Structured plan** (`plan` update): expose the agent's execution plan.
- [x] **Tool call names stabilization**: `name` is always sent on `tool_call`.

## P3 — Low (advanced / optional)

- [ ] **Elicitation** (`elicitation/create`): form and URL modes.
- [ ] **MCP HTTP transport** (`mcpCapabilities.http`).
- [ ] **MCP SSE transport** (`mcpCapabilities.sse`).
- [ ] **Authentication methods** (`authMethods`, `auth/login`, `logout`): only if multi-user/remote use is needed.

## Notes

- Items already implemented: context compaction, usage/cost reporting, modes (Build/Plan/Ask), reasoning selector, model picker, persistence, MCP stdio, terminals, permissions.
- Before tackling P1, verify the corresponding client (Zed) actually renders the related update; several features are already sent but not displayed by the current client version.