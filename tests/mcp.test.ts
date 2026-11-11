import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  connectHttpMcpServer,
  connectMcpServer,
  connectMcpServers,
  connectSseMcpServer,
  isHttpMcpServer,
  isStdioMcpServer,
  mergeMcpBindings,
  normalizeMcpServer,
} from "../src/mcp/index.js";
import type {
  McpConnection,
  McpServerConfig,
  McpTimeouts,
  McpTool,
  McpToolBinding,
} from "../src/mcp/index.js";
import type { LlmToolDefinition } from "../src/llm.js";

const helpers = join(dirname(fileURLToPath(import.meta.url)), "helpers");
const fakeServer = join(helpers, "fake-mcp-server.mjs");

/** Handshakes that would otherwise take the production ceilings to fail. */
const FAST: McpTimeouts = { connectMs: 500, requestMs: 2_000 };

/** Runs the fake stdio server in the given mode and connects to it. */
async function connectStdio(mode?: string): Promise<McpConnection[]> {
  return connectMcpServers([
    {
      type: "stdio",
      command: process.execPath,
      args: mode ? [fakeServer, mode] : [fakeServer],
      name: "fake",
    },
  ]);
}

type Recorded = {
  method: string;
  sessionId: string | null;
  probe: string | null;
  /** Cursor the client asked `tools/list` with, when it asked with one. */
  cursor: string | null;
  body: { id?: number; method?: string; params?: { cursor?: string } };
};

/**
 * A minimal MCP server over HTTP.
 *
 * Records what it was asked, so a test can assert on the session id the
 * transport carries forward, and can answer in plain JSON or framed as
 * server-sent events to cover both response shapes the transport accepts.
 */
async function startHttpServer(options: {
  framing?: "json" | "sse" | "sse-noise" | "sse-empty";
  sessionId?: string;
  status?: number;
  /** Answers with a JSON-RPC `error` instead of a `result`. */
  errorReply?: boolean;
  /** Answers with a JSON-RPC `error` that carries no `message` field. */
  errorReplyNoMessage?: boolean;
  /** Leaves the `Content-Type` header off the reply. */
  omitContentType?: boolean;
  /** Gives `tools/list` a second page behind a `nextCursor`. */
  paginated?: boolean;
  /** Answers `tools/list` with a payload that has no tools array. */
  listWithoutTools?: boolean;
} = {}): Promise<{ url: string; requests: Recorded[]; close: () => Promise<void> }> {
  const requests: Recorded[] = [];

  /** The `tools/list` answer the current option set calls for. */
  function listReply(params: { cursor?: string } | undefined): unknown {
    if (options.listWithoutTools) return { pageCount: 1 };
    const first = [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }];
    if (!options.paginated) return { tools: first };
    return params?.cursor === "page-2"
      ? { tools: [{ name: "page-two", description: "Second page", inputSchema: { type: "object" } }] }
      : { tools: first, nextCursor: "page-2" };
  }

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      let body: { id?: number; method?: string; params?: { cursor?: string } } = {};
      try {
        body = JSON.parse(raw) as { id?: number; method?: string; params?: { cursor?: string } };
      } catch {
        // A malformed body still deserves an answer, just not a parsed one.
      }
      requests.push({
        method: req.method ?? "",
        sessionId: (req.headers["mcp-session-id"] as string | undefined) ?? null,
        probe: (req.headers["x-probe"] as string | undefined) ?? null,
        cursor: body.params?.cursor ?? null,
        body,
      });

      const status = options.status ?? 200;
      if (status !== 200) {
        res.writeHead(status, { "Content-Type": "text/plain" }).end("nope");
        return;
      }
      // Notifications get an acknowledgement, never a JSON-RPC reply.
      if (body.id === undefined) {
        res.writeHead(204).end();
        return;
      }

      const result =
        body.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "http-fake", version: "1" } }
          : body.method === "tools/list"
            ? listReply(body.params)
            : { content: [{ type: "text", text: "from http" }] };

      const payload = JSON.stringify(
        options.errorReply
          ? { jsonrpc: "2.0", id: body.id, error: { message: "server refused the handshake" } }
          : options.errorReplyNoMessage
            ? { jsonrpc: "2.0", id: body.id, error: { code: -32000 } }
            : { jsonrpc: "2.0", id: body.id, result },
      );
      const framing = options.framing ?? "json";
      if (framing.startsWith("sse")) {
        // Keep-alive frames, an end marker, and a reply to a request this
        // client never sent all travel the same way as the real answer, so
        // the parser has to skip them without mistaking one for its own.
        const noise =
          framing === "sse-noise"
            ? `data:\n\ndata: [DONE]\n\ndata: ${JSON.stringify({
                jsonrpc: "2.0",
                id: 999,
                result: { stale: true },
              })}\n\n`
            : "";
        const reply = framing === "sse-empty" ? "data: [DONE]\n\n" : `event: message\ndata: ${payload}\n\n`;
        res.writeHead(200, { "Content-Type": "text/event-stream" }).end(noise + reply);
        return;
      }
      const headers: Record<string, string> = {};
      if (!options.omitContentType) headers["Content-Type"] = "application/json";
      if (options.sessionId) headers["mcp-session-id"] = options.sessionId;
      res.writeHead(200, headers).end(payload);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * An SSE MCP server: the GET stream carries the `endpoint` event and every
 * reply, while the POST endpoint only acknowledges the request — which is how
 * the transport actually works, and the shape the old parser could never read.
 */
async function startSseServer(
  options: {
    sendEndpoint?: boolean;
    /** The GET never answers at all, so only the connect deadline can fire. */
    stall?: boolean;
    /** Status the GET answers with instead of an event stream. */
    status?: number;
    /** Status the POST answers with instead of acknowledging. */
    postStatus?: number;
    /** Answers every request but never pushes a reply for a `tools/call`. */
    ignoreCalls?: boolean;
    /** Ends the GET stream while a `tools/call` is still in flight. */
    dropOnCall?: boolean;
    /** Pushes a JSON-RPC error for a `tools/call` instead of a result. */
    errorOnCall?: boolean;
    /** Pushes a JSON-RPC error with no `message` field for a `tools/call`. */
    errorOnCallNoMessage?: boolean;
    /** Pushes a frame addressed to an id this client never issued. */
    strayFrame?: boolean;
    /** Gives `tools/list` a second page behind a `nextCursor`. */
    paginated?: boolean;
    /** Answers `tools/list` with a payload that has no tools array. */
    listWithoutTools?: boolean;
  } = {},
): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const sendEndpoint = options.sendEndpoint ?? true;
  let stream: import("node:http").ServerResponse | null = null;

  /** The `tools/list` answer the current option set calls for. */
  function listReply(params: { cursor?: string } | undefined): unknown {
    if (options.listWithoutTools) return { pageCount: 1 };
    const first = [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }];
    if (!options.paginated) return { tools: first };
    return params?.cursor === "page-2"
      ? { tools: [{ name: "pong", description: "Pong", inputSchema: { type: "object" } }] }
      : { tools: first, nextCursor: "page-2" };
  }

  const server = createServer((req, res) => {
    if (req.method === "GET") {
      if (options.stall) return;
      if (options.status) {
        res.writeHead(options.status, { "Content-Type": "text/plain" }).end("not an event stream");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      // Headers have to leave now: with nothing else to write, Node would
      // hold them until the first frame and the client's connect deadline
      // would fire first.
      res.flushHeaders();
      stream = res;
      if (sendEndpoint) res.write("event: endpoint\ndata: /mcp\n\n");
      else res.write(": keep-alive\n\n");
      // A frame aimed at an id this client never issued travels on the same
      // stream as the real replies, so the parser has to skip it.
      if (options.strayFrame) {
        res.write(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 999, result: { stale: true } })}\n\n`,
        );
      }
      req.on("close", () => {
        stream = null;
      });
      return;
    }

    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      if (options.postStatus) {
        res.writeHead(options.postStatus, { "Content-Type": "text/plain" }).end("no");
        return;
      }
      res.writeHead(202).end();
      let body: { id?: number; method?: string; params?: { cursor?: string } } = {};
      try {
        body = JSON.parse(raw) as { id?: number; method?: string; params?: { cursor?: string } };
      } catch {
        return;
      }
      if (body.id === undefined) return;

      // The push transport fails three ways once the handshake is over: the
      // reply never comes, the stream is cut with a call in flight, or what
      // arrives is an error instead of a result.
      if (body.method === "tools/call" && options.ignoreCalls) return;
      if (body.method === "tools/call" && options.dropOnCall) {
        stream?.end();
        return;
      }
      if (body.method === "tools/call" && options.errorOnCall) {
        stream?.write(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: { message: "push side refused the call" },
          })}\n\n`,
        );
        return;
      }
      if (body.method === "tools/call" && options.errorOnCallNoMessage) {
        stream?.write(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32000 },
          })}\n\n`,
        );
        return;
      }

      const result =
        body.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "sse-fake", version: "1" } }
          : body.method === "tools/list"
            ? listReply(body.params)
            : { content: [{ type: "text", text: "from sse" }] };

      stream?.write(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`,
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/sse`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

describe("MCP stdio transport", () => {
  it("paginates tools/list and calls a tool with real newlines", async () => {
    const [connection] = await connectStdio();
    expect(connection).toBeDefined();

    // Both pages made it through, so pagination is not dropping the second one.
    expect(connection?.tools.map((tool) => tool.name)).toEqual(["echo", "shout", "ping", "huge"]);
    expect(connection?.bindings.get("ping")).toBeDefined();

    const result = await connection?.bindings.get("echo")?.call({});
    expect(result?.isError).toBe(false);
    // The transport used to join content with a literal `\n` two-character
    // sequence, which the model then read as punctuation.
    expect(result?.output).toBe("line one\nline two\nline three");

    // The title the prompt loop shows next to a call names the server it
    // came from, or two servers offering `echo` would be indistinguishable.
    expect(connection?.bindings.get("echo")?.title({})).toBe("fake: echo");

    connection?.close();
  });

  it("drops malformed tool entries and renders every result shape", async () => {
    const [connection] = await connectStdio("odd-tools");

    // Entries that are not tools at all are dropped rather than offered to
    // the model under a missing or empty name.
    expect(connection?.tools.map((tool) => tool.name)).toEqual([
      "object-result",
      "string-result",
      "throws",
    ]);

    expect((await connection?.bindings.get("object-result")?.call({}))?.output).toBe(
      JSON.stringify({ ok: true, count: 3 }),
    );
    expect((await connection?.bindings.get("string-result")?.call({}))?.output).toBe(
      "plain text from the server",
    );

    // A JSON-RPC error is a failed tool call, not a failed turn.
    const failed = await connection?.bindings.get("throws")?.call({});
    expect(failed?.isError).toBe(true);
    expect(failed?.output).toBe("tool exploded");

    connection?.close();
  });

  it("renders odd result shapes and a tool with no description", async () => {
    const [connection] = await connectStdio("odd-results");

    expect(connection?.tools.map((tool) => tool.name)).toEqual([
      "mixed",
      "primitive",
      "bare",
      "silent-throw",
    ]);

    // A text entry without text contributes nothing, and an entry of another
    // type is rendered as JSON: the array has to render either way.
    expect((await connection?.bindings.get("mixed")?.call({}))?.output).toBe(
      `\n${JSON.stringify({ type: "image", data: "abc" })}`,
    );
    // A result that carries no content at all still answers the model.
    expect((await connection?.bindings.get("primitive")?.call({}))?.output).toBe("(no output)");

    // A tool without a description is described from its name rather than
    // shipping an empty one to the model.
    expect(
      connection?.toolDefinitions.find((definition) => definition.function.name === "bare")
        ?.function.description,
    ).toBe("MCP tool bare from fake");

    // An error carrying no message must not reject with `undefined`.
    expect(await connection?.bindings.get("silent-throw")?.call({})).toEqual({
      output: "MCP request failed",
      isError: true,
    });

    connection?.close();
  });

  it("stops the walk when tools/list answers without a tools array", async () => {
    const [connection] = await connectStdio("odd-list");

    // The payload parses but carries no list: the walk has to end with no
    // tools instead of spreading something that is not an array.
    expect(connection?.tools).toEqual([]);
    expect(connection?.bindings.size).toBe(0);
    connection?.close();
  });

  it("defaults the name and arguments of a bare config entry", async () => {
    // `env` with no operands prints the environment and exits at once, so
    // the child starts with the defaulted empty argument list and the
    // handshake fails by exit instead of hanging on a script that never runs.
    const connection = await connectMcpServer({ type: "stdio", command: "/usr/bin/env" });

    expect(connection.name).toBe("/usr/bin/env");
    expect(connection.tools).toEqual([]);
    connection.close();
  });

  it("skips malformed entries in a configured env array", async () => {
    const [connection] = await connectMcpServers([
      {
        type: "stdio",
        command: process.execPath,
        args: [fakeServer, "env-gated"],
        name: "fake",
        // Client JSON may carry nulls and valueless entries: only the named
        // variable has to reach the child for the server to stay up.
        env: [
          null,
          { value: "orphan" },
          { name: "ACP_FAKE_ENV", value: undefined },
          { name: "ACP_FAKE_ENV", value: "on" },
        ] as unknown as McpServerConfig["env"],
      },
    ]);

    expect(connection?.tools.length).toBeGreaterThan(0);
    connection?.close();
  });

  it("gives up on a call the server never answers", async () => {
    const [connection] = await connectStdio("silent-call");
    // Only the request deadline is moved: faking every timer would also
    // freeze the handshake the connection just completed.
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const pending = connection?.bindings.get("echo")?.call({});
      await vi.advanceTimersByTimeAsync(30_000);
      // Silence is not success: without the deadline this call would hold
      // the turn open forever.
      expect(await pending).toEqual({
        output: 'MCP request "tools/call" timed out',
        isError: true,
      });
    } finally {
      vi.useRealTimers();
      connection?.close();
    }
  });

  it("fails a call made after the server's pipe is gone", async () => {
    const [connection] = await connectStdio();
    connection?.close();

    // The child is dead, so the write hits a broken pipe. Node reports that
    // as a stream error rather than a throw, and swallowing it is what keeps
    // the rejection attached to this call instead of crashing the process.
    const result = await connection?.bindings.get("echo")?.call({});
    expect(result?.isError).toBe(true);
  });

  it("degrades to no tools when the command does not exist", async () => {
    const connections = await connectMcpServers([
      { type: "stdio", command: "definitely-not-a-real-binary", args: [], name: "typo" },
    ]);

    // The agent must survive a typo in the client's `mcpServers`: `spawn`
    // reports ENOENT through an event, which used to become an uncaught
    // exception and took the whole process down.
    expect(connections).toHaveLength(1);
    expect(connections[0]?.tools).toEqual([]);
  });

  it("degrades when the server exits before answering", async () => {
    const [connection] = await connectStdio("exit-early");
    expect(connection?.tools).toEqual([]);
    // The connection is still closable: session teardown must not throw.
    expect(() => connection?.close()).not.toThrow();
  });

  it("looks past lines on the wire that are not messages", async () => {
    const [connection] = await connectStdio("garbage");

    // A blank line, a line that will not parse, and JSON that parses into
    // something that is not a message all arrive before the handshake does;
    // none of them may end the connection or stall the reply.
    expect(connection?.tools.map((tool) => tool.name)).toEqual(["echo", "shout", "ping", "huge"]);
    connection?.close();
  });

  it("degrades when the server refuses to initialize", async () => {
    const [connection] = await connectStdio("error-reply");

    // A JSON-RPC error is an answer, not a hang: the session gets no tools
    // from this server rather than waiting on a handshake that failed.
    expect(connection?.tools).toEqual([]);
    expect(() => connection?.close()).not.toThrow();
  });

  it("merges a configured environment into the child", async () => {
    // The server exits unless its variable arrives, so a listed tool is the
    // proof that both configuration shapes reach the spawned process.
    for (const env of [
      [{ name: "ACP_FAKE_ENV", value: "on" }],
      { ACP_FAKE_ENV: "on" },
    ]) {
      const [connection] = await connectMcpServers([
        {
          type: "stdio",
          command: process.execPath,
          args: [fakeServer, "env-gated"],
          name: "fake",
          env,
        },
      ]);

      expect(connection?.tools.length).toBeGreaterThan(0);
      connection?.close();
    }
  });

  it("clips tool output past the size ceiling", async () => {
    const [connection] = await connectStdio();
    const result = await connection?.bindings.get("huge")?.call({});

    expect(result?.output.startsWith("x".repeat(20_000))).toBe(true);
    expect(result?.output).toContain("truncated (50000 characters total)");
    connection?.close();
  });

  it("ignores a server whose command is not a string", async () => {
    expect(await connectMcpServers([{ args: ["--version"] }])).toEqual([]);
  });

  it("reports a stdio server whose command spawn refuses outright", async () => {
    // A null byte makes `spawn` throw synchronously instead of emitting an
    // error event, so the shared connect path — not the child's error
    // handler — has to catch it and skip the entry.
    const connections = await connectMcpServers([
      {
        type: "stdio",
        command: ["acp", "pollinations"].join(String.fromCharCode(0)),
        name: "bad-command",
      },
    ]);

    expect(connections).toEqual([]);
  });
});

describe("MCP HTTP transport", () => {
  it("completes the handshake and carries the session id forward", async () => {
    const server = await startHttpServer({ sessionId: "sess-42" });
    try {
      const connection = await connectHttpMcpServer({ type: "http", url: server.url }, FAST);

      expect(connection.tools.map((tool) => tool.name)).toEqual(["echo"]);
      const result = await connection.bindings.get("echo")?.call({});
      expect(result?.output).toBe("from http");

      const methods = server.requests.map((request) => request.body.method);
      expect(methods).toContain("initialize");
      expect(methods).toContain("tools/list");
      // The id handed out by `initialize` must be echoed on later requests,
      // or the server treats every call as an orphaned session.
      expect(server.requests.some((request) => request.sessionId === "sess-42")).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("reads replies framed as server-sent events", async () => {
    const server = await startHttpServer({ framing: "sse" });
    try {
      const connection = await connectHttpMcpServer({ type: "http", url: server.url }, FAST);
      expect(connection.tools.map((tool) => tool.name)).toEqual(["echo"]);
    } finally {
      await server.close();
    }
  });

  it("skips keep-alive frames and replies aimed at another request", async () => {
    const server = await startHttpServer({ framing: "sse-noise" });
    try {
      const connection = await connectHttpMcpServer({ type: "http", url: server.url }, FAST);

      // Empty data, a `[DONE]` marker, and a frame for a different id all
      // precede the answer; none of them may be mistaken for it.
      expect(connection.tools.map((tool) => tool.name)).toEqual(["echo"]);
      const result = await connection.bindings.get("echo")?.call({});
      expect(result?.output).toBe("from http");
    } finally {
      await server.close();
    }
  });

  it("degrades when a stream reply never carries a result", async () => {
    const server = await startHttpServer({ framing: "sse-empty" });
    try {
      const connection = await connectHttpMcpServer({ type: "http", url: server.url }, FAST);
      expect(connection.tools).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("degrades when the handshake is refused with a JSON-RPC error", async () => {
    const server = await startHttpServer({ errorReply: true });
    try {
      const connection = await connectHttpMcpServer({ type: "http", url: server.url }, FAST);
      expect(connection.tools).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("degrades when the server answers with an error status", async () => {
    const server = await startHttpServer({ status: 500 });
    try {
      const connection = await connectHttpMcpServer({ type: "http", url: server.url }, FAST);
      expect(connection.tools).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("forwards configured headers in either shape", async () => {
    const server = await startHttpServer();
    try {
      const asArray = await connectHttpMcpServer(
        {
          type: "http",
          url: server.url,
          // The array form may also carry entries with no name or no value;
          // they are dropped on the way out, never forwarded as headers.
          headers: [
            { name: "x-probe", value: "array-form" },
            { value: "orphan" },
            { name: "x-blank" },
            null,
          ] as unknown as McpServerConfig["headers"],
        },
        FAST,
      );
      asArray.close();

      const asObject = await connectHttpMcpServer(
        { type: "http", url: server.url, headers: { "x-probe": "object-form" } },
        FAST,
      );
      asObject.close();

      // Editors spell headers both ways; the wire must not care which.
      expect(server.requests[0]?.probe).toBe("array-form");
      expect(server.requests.some((request) => request.probe === "object-form")).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("routes an http entry through the shared connect path", async () => {
    const server = await startHttpServer();
    try {
      // `connectMcpServers` picks the transport from the normalized type:
      // an http entry must reach the HTTP client, not the stdio spawn.
      const connections = await connectMcpServers([{ type: "http", url: server.url }]);

      expect(connections).toHaveLength(1);
      expect(connections[0]?.tools.map((tool) => tool.name)).toEqual(["echo"]);
      connections[0]?.close();
    } finally {
      await server.close();
    }
  });

  it("reads a reply that carries no content-type header", async () => {
    const server = await startHttpServer({ omitContentType: true });
    try {
      const connection = await connectHttpMcpServer({ type: "http", url: server.url }, FAST);

      // A missing header must not be mistaken for an event stream: the body
      // is plain JSON and parses the same way with or without the header.
      expect(connection.tools.map((tool) => tool.name)).toEqual(["echo"]);
      expect((await connection.bindings.get("echo")?.call({}))?.output).toBe("from http");
      connection.close();
    } finally {
      await server.close();
    }
  });

  it("maps a JSON-RPC error that carries no message", async () => {
    const server = await startHttpServer({ errorReplyNoMessage: true });
    try {
      const connection = await connectHttpMcpServer({ type: "http", url: server.url }, FAST);

      // An error with no `message` still fails the handshake, with generic
      // text rather than `undefined` in the log line.
      expect(connection.tools).toEqual([]);
      connection.close();
    } finally {
      await server.close();
    }
  });

  it("follows nextCursor across tools/list pages", async () => {
    const server = await startHttpServer({ paginated: true });
    try {
      const connection = await connectHttpMcpServer({ type: "http", url: server.url }, FAST);

      expect(connection.tools.map((tool) => tool.name)).toEqual(["echo", "page-two"]);
      // The cursor the first page handed out has to travel back as
      // `params.cursor`, or the second page is fetched as the first forever.
      expect(
        server.requests
          .filter((request) => request.body.method === "tools/list")
          .map((request) => request.cursor),
      ).toEqual([null, "page-2"]);
      connection.close();
    } finally {
      await server.close();
    }
  });

  it("stops the HTTP walk when tools/list answers without a tools array", async () => {
    const server = await startHttpServer({ listWithoutTools: true });
    try {
      const connection = await connectHttpMcpServer({ type: "http", url: server.url }, FAST);

      expect(connection.tools).toEqual([]);
      connection.close();
    } finally {
      await server.close();
    }
  });

  it("falls back to a generic name when no url is configured", async () => {
    // Without a url the request cannot even be built, but the failure still
    // has to be reported under a name the operator can recognise.
    const connection = await connectHttpMcpServer({ type: "http" }, FAST);

    expect(connection.name).toBe("mcp-http");
    expect(connection.tools).toEqual([]);
    connection.close();
  });
});

describe("MCP SSE transport", () => {
  it("connects through the endpoint event and round-trips a call", async () => {
    const server = await startSseServer();
    try {
      const connection = await connectSseMcpServer({ type: "sse", url: server.url }, FAST);

      expect(connection.tools.map((tool) => tool.name)).toEqual(["ping"]);
      const result = await connection.bindings.get("ping")?.call({});
      expect(result?.output).toBe("from sse");

      connection.close();
    } finally {
      await server.close();
    }
  });

  it("rejects instead of hanging when no endpoint event arrives", async () => {
    const server = await startSseServer({ sendEndpoint: false });
    try {
      await expect(
        connectSseMcpServer({ type: "sse", url: server.url, name: "silent" }, FAST),
      ).rejects.toThrow(/endpoint event/);
    } finally {
      await server.close();
    }
  });

  it("rejects when the stream ends before the endpoint arrives", async () => {
    const server = await startSseServer({ sendEndpoint: false });
    // Closing the GET stream immediately: the transport has to notice rather
    // than wait for a deadline that would never be reached.
    const url = server.url;
    const connection = connectSseMcpServer({ type: "sse", url, name: "shortlived" }, FAST);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await server.close();

    await expect(connection).rejects.toThrow(/endpoint|closed/);
  });

  it("reports a failing server through the shared connect path", async () => {
    const server = await startSseServer({ sendEndpoint: false });
    // `connectMcpServers` is the layer that decides a broken entry is
    // survivable, and it names the target it gave up on. The stream is cut
    // short rather than left to the handshake deadline, so the failure is
    // the server going away, not the clock.
    const pending = connectMcpServers([{ type: "sse", url: server.url, name: "sse-fake" }]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await server.close();

    expect(await pending).toEqual([]);
  });

  it("aborts the handshake when the stream never answers", async () => {
    const server = await startSseServer({ stall: true });
    try {
      // Nothing is written on the GET, so the connect deadline is the only
      // thing that can end this: the abort has to reach the fetch itself.
      await expect(
        connectSseMcpServer({ type: "sse", url: server.url, name: "stalled" }, FAST),
      ).rejects.toThrow(/abort/i);
    } finally {
      await server.close();
    }
  });

  it("rejects when the stream answers with a failure status", async () => {
    const server = await startSseServer({ status: 500 });
    try {
      await expect(
        connectSseMcpServer({ type: "sse", url: server.url, name: "refused" }, FAST),
      ).rejects.toThrow(/MCP SSE connection failed \(500\)/);
    } finally {
      await server.close();
    }
  });

  it("degrades when the request endpoint refuses to answer", async () => {
    const server = await startSseServer({ postStatus: 503 });
    try {
      // The stream is fine but the POST side is not; the connection must come
      // back empty with a log line rather than throw at the caller.
      const connection = await connectSseMcpServer({ type: "sse", url: server.url }, FAST);
      expect(connection.tools).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("fails a call that was in flight when the stream ended", async () => {
    const server = await startSseServer({ dropOnCall: true });
    try {
      const connection = await connectSseMcpServer({ type: "sse", url: server.url }, FAST);
      expect(connection.tools.map((tool) => tool.name)).toEqual(["ping"]);

      // The POST was acknowledged, so only the GET stream can tell us the
      // answer is never coming; every waiting call has to hear about it.
      const result = await connection.bindings.get("ping")?.call({});
      expect(result?.isError).toBe(true);
      expect(result?.output).toMatch(/stream closed/i);

      connection.close();
    } finally {
      await server.close();
    }
  });

  it("reports a JSON-RPC error pushed on the stream", async () => {
    const server = await startSseServer({ errorOnCall: true });
    try {
      const connection = await connectSseMcpServer({ type: "sse", url: server.url }, FAST);
      const result = await connection.bindings.get("ping")?.call({});
      expect(result?.isError).toBe(true);
      expect(result?.output).toBe("push side refused the call");

      connection.close();
    } finally {
      await server.close();
    }
  });

  it("times out a call whose reply is never pushed", async () => {
    const server = await startSseServer({ ignoreCalls: true });
    try {
      const connection = await connectSseMcpServer(
        { type: "sse", url: server.url },
        { connectMs: 500, requestMs: 150 },
      );
      const result = await connection.bindings.get("ping")?.call({});
      expect(result).toEqual({
        output: 'MCP request "tools/call" timed out',
        isError: true,
      });

      connection.close();
    } finally {
      await server.close();
    }
  });

  it("fails in-flight calls when the connection is closed", async () => {
    const server = await startSseServer({ ignoreCalls: true });
    try {
      const connection = await connectSseMcpServer(
        { type: "sse", url: server.url },
        { connectMs: 500, requestMs: 5_000 },
      );
      const pending = connection.bindings.get("ping")?.call({});
      connection.close();

      const result = await pending;
      expect(result?.isError).toBe(true);
      // Whichever side settles it first — the close or the stream it cuts —
      // the caller gets a closed-connection failure rather than a hang.
      expect(result?.output).toMatch(/closed/i);
    } finally {
      await server.close();
    }
  });

  it("ignores a pushed frame aimed at an id it never issued", async () => {
    const server = await startSseServer({ strayFrame: true });
    try {
      const connection = await connectSseMcpServer({ type: "sse", url: server.url }, FAST);

      // The stray frame settles nothing; the real replies still arrive on
      // the same stream and in the same order.
      expect((await connection.bindings.get("ping")?.call({}))?.output).toBe("from sse");
      connection.close();
    } finally {
      await server.close();
    }
  });

  it("maps a pushed error that carries no message", async () => {
    const server = await startSseServer({ errorOnCallNoMessage: true });
    try {
      const connection = await connectSseMcpServer({ type: "sse", url: server.url }, FAST);

      expect(await connection.bindings.get("ping")?.call({})).toEqual({
        output: "MCP request failed",
        isError: true,
      });
      connection.close();
    } finally {
      await server.close();
    }
  });

  it("follows nextCursor across pushed tools/list pages", async () => {
    const server = await startSseServer({ paginated: true });
    try {
      const connection = await connectSseMcpServer({ type: "sse", url: server.url }, FAST);
      expect(connection.tools.map((tool) => tool.name)).toEqual(["ping", "pong"]);
      connection.close();
    } finally {
      await server.close();
    }
  });

  it("stops the SSE walk when tools/list answers without a tools array", async () => {
    const server = await startSseServer({ listWithoutTools: true });
    try {
      const connection = await connectSseMcpServer({ type: "sse", url: server.url }, FAST);
      expect(connection.tools).toEqual([]);
      connection.close();
    } finally {
      await server.close();
    }
  });

  it("rejects a handshake attempted without a url", async () => {
    // The GET cannot be built without a url; the caller has to see the
    // failure rather than a connection that silently never got a stream.
    await expect(connectSseMcpServer({ type: "sse" }, FAST)).rejects.toThrow();
  });
});

describe("normalizeMcpServer", () => {
  it("recognises a stdio server by its command", () => {
    expect(isStdioMcpServer({ command: "node" })).toBe(true);
    expect(isStdioMcpServer({ type: "http", command: "node" })).toBe(false);
    expect(isStdioMcpServer({})).toBe(false);
    expect(isStdioMcpServer(null)).toBe(false);
  });

  it("recognises an HTTP or SSE server by its url", () => {
    expect(isHttpMcpServer({ type: "http", url: "http://localhost:1" })).toBe(true);
    expect(isHttpMcpServer({ type: "sse", url: "http://localhost:1" })).toBe(true);
    expect(isHttpMcpServer({ url: "http://localhost:1" })).toBe(true);
    expect(isHttpMcpServer({ type: "stdio", url: "http://localhost:1" })).toBe(false);
    expect(isHttpMcpServer({ type: "http" })).toBe(false);
    // A `type` that is not a string at all is still not one of the two.
    expect(isHttpMcpServer({ type: 42, url: "http://localhost:1" })).toBe(false);
  });

  it("normalises both shapes and rejects anything else", () => {
    expect(normalizeMcpServer({ command: "node", args: ["a"], env: { K: "V" } })).toEqual({
      type: "stdio",
      name: undefined,
      command: "node",
      args: ["a"],
      env: { K: "V" },
    });
    expect(normalizeMcpServer({ type: "sse", url: "http://localhost:1", name: "s" })).toEqual({
      type: "sse",
      name: "s",
      url: "http://localhost:1",
      headers: undefined,
    });
    expect(normalizeMcpServer({ url: "http://localhost:1" })).toMatchObject({ type: "http" });
    // A non-array `args` would be spread into `spawn` as a non-list; it is
    // normalized to an empty list instead.
    expect(normalizeMcpServer({ command: "node", args: "oops" })?.args).toEqual([]);
    expect(normalizeMcpServer({ type: "http" })).toBeNull();
    expect(normalizeMcpServer("node")).toBeNull();
  });
});

describe("mergeMcpBindings", () => {
  /** Builds a connection holding exactly the named tools. */
  function connectionWith(name: string, tools: McpTool[]): McpConnection {
    const bindings = new Map<string, McpToolBinding>();
    const definitions: LlmToolDefinition[] = [];
    for (const tool of tools) {
      bindings.set(tool.name, {
        name: tool.name,
        kind: "other" as const,
        mutating: true,
        title: () => `${name}: ${tool.name}`,
        call: async () => ({ output: `called ${tool.name}` }),
      });
      definitions.push({
        type: "function" as const,
        function: { name: tool.name, description: tool.description ?? "", parameters: { type: "object" } },
      });
    }
    return { name, tools, bindings, toolDefinitions: definitions, close: () => undefined };
  }

  it("keeps names that collide with nothing", () => {
    const merged = mergeMcpBindings([connectionWith("srv", [{ name: "lookup" }])]);
    expect([...merged.bindings.keys()]).toEqual(["lookup"]);
    expect(merged.definitions[0]?.function.name).toBe("lookup");
    expect(merged.definitions[0]?.function.description).toBe("");
  });

  it("renames a tool that would shadow a built-in", async () => {
    const merged = mergeMcpBindings([connectionWith("srv", [{ name: "bash", description: "remote shell" }])]);

    expect([...merged.bindings.keys()]).toEqual(["srv__bash"]);
    // The definition has to follow the binding, or the model would be offered
    // `bash` twice with only one of them routable.
    expect(merged.definitions[0]?.function.name).toBe("srv__bash");
    expect(merged.definitions[0]?.function.description).toBe("remote shell");
    expect(merged.bindings.get("srv__bash")?.title({})).toBe("srv: bash");
    expect(await merged.bindings.get("srv__bash")?.call({})).toEqual({ output: "called bash" });
  });

  it("renames a tool repeated by a second server", () => {
    const merged = mergeMcpBindings([
      connectionWith("one", [{ name: "search" }]),
      connectionWith("two", [{ name: "search" }]),
    ]);

    expect([...merged.bindings.keys()]).toEqual(["search", "two__search"]);
  });

  it("sanitises server names that are not identifier-safe", () => {
    const merged = mergeMcpBindings([connectionWith("my-server.v2", [{ name: "read_file" }])]);
    expect([...merged.bindings.keys()]).toEqual(["my_server_v2__read_file"]);
  });

  it("merges a binding whose definition never arrived", async () => {
    // A connection can expose a binding without a matching definition; the
    // merge still ships it, with a fallback description and empty params,
    // because a tool the model cannot call is worse than an ugly one.
    const orphan: McpConnection = {
      name: "orphan-server",
      tools: [],
      bindings: new Map([
        [
          "lookup",
          {
            name: "lookup",
            kind: "other",
            mutating: true,
            title: () => "orphan-server: lookup",
            call: async () => ({ output: "found" }),
          },
        ],
      ]),
      toolDefinitions: [],
      close: () => undefined,
    };

    const merged = mergeMcpBindings([orphan]);
    expect(merged.definitions).toEqual([
      {
        type: "function",
        function: {
          name: "lookup",
          description: "MCP tool lookup",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
    expect(await merged.bindings.get("lookup")?.call({})).toEqual({ output: "found" });
  });
});
