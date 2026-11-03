#!/usr/bin/env node
/**
 * A scriptable MCP server speaking newline-delimited JSON-RPC over stdio.
 *
 * It exists so the stdio transport can be tested without a real server, a
 * network, or a binary installed on the machine. The mode is the first
 * argument:
 *
 *   (none)     normal server: paginated `tools/list`, working `tools/call`
 *   exit-early dies before answering anything, to exercise the failure path
 */
import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "normal";

// A process that exits during `initialize` must degrade to "no tools", not
// leave the agent waiting on a request nobody will ever answer.
if (mode === "exit-early") process.exit(0);

const FIRST_PAGE = [
  {
    name: "echo",
    description: "Echo the given text back, line by line",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "shout",
    description: "Uppercase the given text",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  },
];

const SECOND_PAGE = [
  { name: "ping", description: "Reply pong", inputSchema: { type: "object" } },
  { name: "huge", description: "Return far more text than the agent keeps", inputSchema: { type: "object" } },
];

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  if (!line.trim()) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  // Notifications (`notifications/initialized`) carry no id and get no reply.
  if (message.id === undefined) return;

  const { id, method, params } = message;

  if (method === "initialize") {
    reply(id, {
      protocolVersion: "2025-06-18",
      capabilities: {},
      serverInfo: { name: "fake-mcp", version: "1.0.0" },
    });
    return;
  }

  if (method === "tools/list") {
    reply(
      id,
      params?.cursor === "page-2"
        ? { tools: SECOND_PAGE }
        : { tools: FIRST_PAGE, nextCursor: "page-2" },
    );
    return;
  }

  if (method === "tools/call") {
    const name = params?.name;
    if (name === "shout") {
      reply(id, {
        content: [{ type: "text", text: String(params?.arguments?.text ?? "").toUpperCase() }],
      });
      return;
    }
    if (name === "huge") {
      reply(id, { content: [{ type: "text", text: "x".repeat(50_000) }] });
      return;
    }
    reply(id, { content: [{ type: "text", text: "line one\nline two\nline three" }] });
    return;
  }

  reply(id, {});
});
