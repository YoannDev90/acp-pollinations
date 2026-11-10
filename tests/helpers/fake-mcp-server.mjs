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
 *   garbage    answers `initialize`, but first writes lines that are not
 *              messages: blank, unparseable, and parsed-but-not-an-object
 *   error-reply refuses `initialize` with a JSON-RPC error
 *   env-gated  exits unless `ACP_FAKE_ENV` reached the child, so a test can
 *              prove the configured environment was merged in
 *   odd-tools  advertises entries that are not tools and answers calls with
 *              a bare object, a bare string, and a JSON-RPC error
 */
import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "normal";

// A process that exits during `initialize` must degrade to "no tools", not
// leave the agent waiting on a request nobody will ever answer.
if (mode === "exit-early") process.exit(0);

// Same, but only when the configured environment did not reach the child:
// a server that cannot see its variables has nothing to offer.
if (mode === "env-gated" && process.env.ACP_FAKE_ENV !== "on") process.exit(0);

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
    if (mode === "error-reply") {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, error: { message: "initialize refused" } })}\n`,
      );
      return;
    }
    if (mode === "garbage") {
      // Noise on the wire has to be looked past, not fatal: a blank line, a
      // line that is not JSON, and JSON that is not a message at all.
      process.stdout.write("\nnot json at all\n\"just a string\"\nnull\n42\n");
      process.stderr.write("garbage mode reporting for duty\n");
    }
    reply(id, {
      protocolVersion: "2025-06-18",
      capabilities: {},
      serverInfo: { name: "fake-mcp", version: "1.0.0" },
    });
    return;
  }

  if (method === "tools/list") {
    if (mode === "odd-tools") {
      reply(id, {
        tools: [
          "not an object",
          null,
          42,
          { description: "an entry with no name" },
          { name: "" },
          { name: "object-result", description: "Replies with a bare object" },
          { name: "string-result", description: "Replies with a bare string" },
          { name: "throws", description: "Answers with a JSON-RPC error" },
        ],
      });
      return;
    }
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
    if (mode === "odd-tools") {
      if (name === "object-result") {
        reply(id, { ok: true, count: 3 });
        return;
      }
      if (name === "string-result") {
        reply(id, "plain text from the server");
        return;
      }
      if (name === "throws") {
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, error: { message: "tool exploded" } })}\n`,
        );
        return;
      }
    }
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
