import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type { ToolKind } from "@agentclientprotocol/sdk";
import type { LlmToolDefinition } from "../llm.js";
import type { ToolExecutionResult } from "../tools/index.js";

const MAX_MCP_OUTPUT_CHARS = 20_000;

/**
 * Ceiling on a single JSON-RPC exchange with an MCP server.
 *
 * The stdio transport already had one; HTTP and SSE did not, so a server that
 * accepted a request and never answered held `session/new` open forever.
 */
const MCP_REQUEST_TIMEOUT_MS = 30_000;

/** Ceiling on the HTTP/SSE handshake itself, before any request is sent. */
const MCP_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Deadlines for one MCP connection, overridable per call.
 *
 * Tests shrink them so a server that deliberately never answers fails the
 * assertion in milliseconds instead of holding the suite for the production
 * ceiling.
 */
export type McpTimeouts = {
  /** Milliseconds allowed for the HTTP/SSE handshake. */
  connectMs: number;
  /** Milliseconds allowed for a single JSON-RPC exchange. */
  requestMs: number;
};

const DEFAULT_MCP_TIMEOUTS: McpTimeouts = {
  connectMs: MCP_CONNECT_TIMEOUT_MS,
  requestMs: MCP_REQUEST_TIMEOUT_MS,
};

export type McpEnvVar = { name: string; value: string };

/**
 * One entry of a server's `mcpServers` configuration.
 *
 * Everything is optional because the shape is validated, not trusted: a
 * `command` picks stdio, a `url` picks HTTP or SSE, and anything that fits
 * neither is dropped by {@link normalizeMcpServer} rather than guessed at.
 */
export type McpServerConfig = {
  type?: "stdio" | "http" | "sse";
  name?: string;
  command?: string;
  args?: string[];
  env?: McpEnvVar[] | Record<string, string>;
  url?: string;
  headers?: Record<string, string> | Array<{ name: string; value: string }>;
};

/**
 * A tool a server advertises, kept close to the MCP wire shape.
 *
 * `annotations.readOnlyHint` is the one hint the agent acts on: a tool is
 * treated as read-only only when the server says so explicitly, because a
 * mutating call that slipped through unannounced is the worse mistake.
 */
export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
};

/**
 * One MCP tool wired into the agent's own tool layer: same `kind`,
 * `mutating`, and `title` contract as a built-in, so the prompt loop and the
 * permission flow cannot tell the two apart.
 */
export type McpToolBinding = {
  name: string;
  kind: ToolKind;
  mutating: boolean;
  title: (input: Record<string, unknown>) => string;
  call: (input: Record<string, unknown>) => Promise<ToolExecutionResult>;
};

/**
 * A live MCP server: the tools it advertised, their bindings, and the way to
 * let go of it.
 *
 * `close` is idempotent and called on shutdown; a connection that is never
 * closed leaves a child process behind for the editor to reap.
 */
export type McpConnection = {
  name: string;
  tools: McpTool[];
  bindings: Map<string, McpToolBinding>;
  toolDefinitions: LlmToolDefinition[];
  close: () => void;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

function envToRecord(env: McpServerConfig["env"]): Record<string, string> {
  if (!env) return {};
  if (Array.isArray(env)) {
    const out: Record<string, string> = {};
    for (const entry of env) {
      if (entry && typeof entry.name === "string") out[entry.name] = String(entry.value ?? "");
    }
    return out;
  }
  return { ...env };
}

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * Spawns one stdio MCP server and negotiates `initialize` with it.
 *
 * Throws on failure — the caller ({@link connectMcpServers}) is the layer
 * that decides a missing server is survivable and logs instead of failing
 * the session.
 */
export async function connectMcpServer(config: McpServerConfig): Promise<McpConnection> {
  const serverName = config.name?.trim() || config.command;
  const child = spawn(config.command as string, config.args ?? [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...envToRecord(config.env) },
  });

  const rl = createInterface({ input: child.stdout });
  let nextId = 1;
  const pending = new Map<number, PendingRequest>();

  /**
   * Settles every in-flight request in favour of `error`.
   *
   * A spawn failure (`ENOENT`, EACCES) surfaces as an `error` event on the
   * child, not as a throw from `spawn`, so without a listener it becomes an
   * uncaught exception that kills the agent — one typo in the client's
   * `mcpServers` entry would take every session down with it.
   */
  const failPending = (error: Error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  child.on("error", failPending);
  // The pipes break when a server dies mid-reply. That is the same outcome as
  // it exiting, and an unhandled stream error would be a crash instead. A write
  // after the pipe closed reaches the stdin handler; stdout instead ends
  // cleanly and Node alone decides if it ever errors, so that one cannot be
  // aimed at from a test without fabricating the failure inside the runtime.
  child.stdin?.on("error", () => undefined);
  /* v8 ignore next */
  child.stdout?.on("error", () => undefined);

  rl.on("line", (line) => {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const record = message as { id?: unknown; result?: unknown; error?: { message?: string } };
    if (record.id !== undefined && typeof record.id === "number" && pending.has(record.id)) {
      const request = pending.get(record.id)!;
      pending.delete(record.id);
      clearTimeout(request.timer);
      if (record.error) {
        request.reject(new Error(record.error.message ?? "MCP request failed"));
      } else {
        request.resolve(record.result);
      }
    }
  });

  child.on("exit", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("MCP server exited"));
    }
    pending.clear();
  });

  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    if (text) process.stderr.write(`${serverName}: ${text}\n`);
  });

  function send(method: string, params: Record<string, unknown> | null, timeoutMs = 30_000): Promise<unknown> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      /* v8 ignore start -- every call site passes a params object; the null
         arm of the JSON-RPC shape is never sent */
      const payload = { jsonrpc: "2.0", id, method, params: params ?? {} };
      /* v8 ignore stop */
      try {
        child.stdin.write(JSON.stringify(payload) + "\n");
      } catch (error) {
        /* v8 ignore start -- a broken pipe arrives as a stream `error` event
           (handled above) rather than a throw from `write`, so no
           production-reachable failure lands here */
        pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
        /* v8 ignore stop */
      }
    });
  }

  const tools: McpTool[] = [];
  const bindings = new Map<string, McpToolBinding>();
  const toolDefinitions: LlmToolDefinition[] = [];

  try {
    await send("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "acp-pollinations", version: "1.0.0" },
    });

    try {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    } catch {
      // The server may not need the notification; ignore.
    }

    const rawTools: unknown[] = [];
    let cursor: string | undefined;
    do {
      const listed = (await send("tools/list", cursor ? { cursor } : {})) as
        | { tools?: unknown; nextCursor?: unknown }
        | null;
      if (Array.isArray(listed?.tools)) rawTools.push(...(listed.tools as unknown[]));
      cursor = typeof listed?.nextCursor === "string" ? listed.nextCursor : undefined;
    } while (cursor);

    const built = buildMcpBindings(serverName as string, rawTools, send);
    tools.push(...built.tools);
    for (const [k,v] of built.bindings) bindings.set(k,v);
    toolDefinitions.push(...built.toolDefinitions);
  } catch (error) {
    // Degrade: a server that fails to initialize must not take down session/new.
    /* v8 ignore start -- every rejection on this path is an Error this
       module raised, so the String() arm cannot run */
    process.stderr.write(
      `${serverName}: MCP connection failed (${error instanceof Error ? error.message : String(error)})\n`,
    );
    /* v8 ignore stop */
  }

  process.stderr.write(
    tools.length > 0
      ? `${serverName}: connected with ${tools.length} tool(s)\n`
      : `${serverName}: no tools available\n`,
  );

  const close = () => {
    try {
      rl.close();
    } catch {
      // ignore
    }
    try {
      child.stdin.end();
    } catch {
      // ignore
    }
    try {
      child.kill();
    } catch {
      // ignore
    }
  };

  return { name: serverName as string, tools, bindings, toolDefinitions, close };
}

function headersToRecord(headers: McpServerConfig["headers"]): Record<string, string> {
  if (!headers) return {};
  if (Array.isArray(headers)) {
    const out: Record<string, string> = {};
    for (const entry of headers) {
      if (entry && typeof entry.name === "string") out[entry.name] = String(entry.value ?? "");
    }
    return out;
  }
  return { ...headers };
}

export async function connectHttpMcpServer(
  config: McpServerConfig,
  timeouts: McpTimeouts = DEFAULT_MCP_TIMEOUTS,
): Promise<McpConnection> {
  const serverName = config.name?.trim() || config.url || "mcp-http";
  const url = config.url as string;
  const baseHeaders = headersToRecord(config.headers);

  let sessionId: string | undefined;
  let nextId = 1;

  async function send(method: string, params: Record<string, unknown> | null): Promise<unknown> {
    const id = nextId++;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...baseHeaders,
    };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;

    const response = await fetch(url, {
      method: "POST",
      headers,
      /* v8 ignore start -- every call site passes a params object; the null
         arm of the JSON-RPC shape is never sent */
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }),
      signal: AbortSignal.timeout(timeouts.requestMs),
      /* v8 ignore stop */
    });

    const sid = response.headers.get("mcp-session-id");
    if (sid) sessionId = sid;

    if (!response.ok) {
      throw new Error(`MCP request "${method}" failed (${response.status})`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    let result: { id?: number; result?: unknown; error?: { message?: string } } | null = null;

    if (contentType.includes("text/event-stream")) {
      const text = await response.text();
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data) as { id?: number; result?: unknown; error?: { message?: string } };
          if (parsed.id === id) {
            result = parsed;
            break;
          }
        } catch {
          // ignore non-JSON frames
        }
      }
    } else {
      result = (await response.json()) as { id?: number; result?: unknown; error?: { message?: string } };
    }

    if (!result) throw new Error(`MCP request "${method}" returned no response`);
    if (result.error) throw new Error(result.error.message ?? "MCP request failed");
    return result.result;
  }

  const tools: McpTool[] = [];
  const bindings = new Map<string, McpToolBinding>();
  const toolDefinitions: LlmToolDefinition[] = [];

  try {
    await send("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "acp-pollinations", version: "1.0.0" },
    });
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...baseHeaders, ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
        signal: AbortSignal.timeout(timeouts.connectMs),
      });
    } catch {
      // ignore
    }

    const rawTools: unknown[] = [];
    let cursor: string | undefined;
    do {
      const listed = (await send("tools/list", cursor ? { cursor } : {})) as
        | { tools?: unknown; nextCursor?: unknown }
        | null;
      if (Array.isArray(listed?.tools)) rawTools.push(...(listed.tools as unknown[]));
      cursor = typeof listed?.nextCursor === "string" ? listed.nextCursor : undefined;
    } while (cursor);

    const built = buildMcpBindings(serverName, rawTools, send);
    tools.push(...built.tools);
    for (const [k,v] of built.bindings) bindings.set(k,v);
    toolDefinitions.push(...built.toolDefinitions);
  } catch (error) {
    /* v8 ignore start -- send() only throws Errors it raised itself, so the
       String() arm cannot run */
    process.stderr.write(
      `${serverName}: MCP HTTP connection failed (${error instanceof Error ? error.message : String(error)})\n`,
    );
    /* v8 ignore stop */
  }

  const close = () => {
    // stateless: nothing to close
  };

  return { name: serverName, tools, bindings, toolDefinitions, close };
}

export async function connectSseMcpServer(
  config: McpServerConfig,
  timeouts: McpTimeouts = DEFAULT_MCP_TIMEOUTS,
): Promise<McpConnection> {
  const serverName = config.name?.trim() || config.url || "mcp-sse";
  const url = config.url as string;
  const baseHeaders = headersToRecord(config.headers);

  const controller = new AbortController();
  const connectTimer = setTimeout(() => controller.abort(), timeouts.connectMs);
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "text/event-stream", ...baseHeaders },
    signal: controller.signal,
  }).finally(() => clearTimeout(connectTimer));

  if (!response.ok || !response.body) {
    throw new Error(`MCP SSE connection failed (${response.status})`);
  }

  // `undici-types` declares `Response.body` without its element type, which
  // makes every chunk `any`; naming the reader's type keeps the decoder honest.
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  /**
   * Settles the endpoint handshake.
   *
   * Held in an object rather than in `let` bindings because the executor of
   * the promise runs synchronously but TypeScript cannot see that, and
   * because every exit path — timeout, stream end, transport error — has to
   * settle it exactly once. Before, only the happy path did, so an SSE server
   * that never sent `endpoint` left `session/new` waiting forever.
   */
  const endpoint: {
    settled: boolean;
    ready: (target: string) => void;
    failed: (error: Error) => void;
  } = {
    settled: false,
    /* v8 ignore start -- placeholders: the executor below replaces both
       before anything can call them, and the literals only exist so the
       object is typed as complete */
    ready: () => undefined,
    failed: () => undefined,
    /* v8 ignore stop */
  };
  const endpointPromise = new Promise<string>((resolve, reject) => {
    endpoint.ready = resolve;
    endpoint.failed = reject;
  });

  const settleEndpoint = (action: () => void) => {
    if (endpoint.settled) return;
    endpoint.settled = true;
    action();
  };

  const failPending = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };

  const pump = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        // Frames are delimited by a blank line; the literals below are real
        // newlines, not the two-character sequence.
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          let event = "message";
          const dataLines: string[] = [];
          for (const line of frame.split(/\r?\n/)) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
          }
          const data = dataLines.join("\n");

          if (event === "endpoint" && data) {
            const endpointUrl = new URL(data, url).toString();
            settleEndpoint(() => endpoint.ready(endpointUrl));
            continue;
          }

          if (!data) continue;
          try {
            const parsed = JSON.parse(data) as { id?: number; result?: unknown; error?: { message?: string } };
            if (parsed.id !== undefined && pending.has(parsed.id)) {
              const request = pending.get(parsed.id)!;
              pending.delete(parsed.id);
              if (parsed.error) request.reject(new Error(parsed.error.message ?? "MCP request failed"));
              else request.resolve(parsed.result);
            }
          } catch {
            // ignore non-JSON frames
          }
        }
      }
    } catch (error) {
      /* v8 ignore start -- the stream reader rejects with an Error, so the
         String() arm cannot run */
      failPending(error instanceof Error ? error : new Error(String(error)));
      /* v8 ignore stop */
    }

    // Whatever ended the stream, no reply can arrive on it any more. The map
    // is already empty on the error path, so this is a no-op there.
    failPending(new Error("MCP SSE stream closed"));
    // The stream is over: either it ended before the endpoint arrived or the
    // server hung up on us, and neither leaves a usable connection behind.
    settleEndpoint(() =>
      endpoint.failed(new Error("MCP SSE stream ended before the endpoint event")),
    );
  })();

  const endpointTimeout = setTimeout(() => {
    settleEndpoint(() =>
      endpoint.failed(new Error("MCP SSE server did not send an endpoint event")),
    );
  }, timeouts.connectMs);

  let target: string;
  try {
    target = await endpointPromise;
  } finally {
    clearTimeout(endpointTimeout);
  }

  let nextId = 1;

  async function send(method: string, params: Record<string, unknown> | null): Promise<unknown> {
    const id = nextId++;

    // Registered before the POST leaves: the server pushes replies on the GET
    // stream, so one that answers as soon as it has the request could reply
    // before a registration made after `await fetch(...)` landed.
    const slot: { resolve: (value: unknown) => void; reject: (error: Error) => void } = {
      /* v8 ignore start -- same placeholder pattern as the endpoint above */
      resolve: () => undefined,
      reject: () => undefined,
      /* v8 ignore stop */
    };
    const reply = new Promise<unknown>((resolve, reject) => {
      slot.resolve = resolve;
      slot.reject = reject;
    });
    // `close()` can settle this while the POST is still in flight, before the
    // function returns and adopts it. A rejection with no handler attached is
    // reported as unhandled and, in production, would take the process down.
    void reply.catch(() => undefined);
    const timer = setTimeout(() => {
      pending.delete(id);
      slot.reject(new Error(`MCP request "${method}" timed out`));
    }, timeouts.requestMs);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        slot.resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        slot.reject(error);
      },
    });

    try {
      const response = await fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...baseHeaders },
        /* v8 ignore start -- every call site passes a params object; the null
           arm of the JSON-RPC shape is never sent */
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }),
        signal: AbortSignal.timeout(timeouts.requestMs),
        /* v8 ignore stop */
      });
      if (!response.ok) throw new Error(`MCP request "${method}" failed (${response.status})`);
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      /* v8 ignore start -- fetch rejects with an Error, so the String() arm
         cannot run */
      slot.reject(error instanceof Error ? error : new Error(String(error)));
      /* v8 ignore stop */
    }

    return reply;
  }

  const tools: McpTool[] = [];
  const bindings = new Map<string, McpToolBinding>();
  const toolDefinitions: LlmToolDefinition[] = [];

  try {
    await send("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "acp-pollinations", version: "1.0.0" },
    });

    const rawTools: unknown[] = [];
    let cursor: string | undefined;
    do {
      const listed = (await send("tools/list", cursor ? { cursor } : {})) as
        | { tools?: unknown; nextCursor?: unknown }
        | null;
      if (Array.isArray(listed?.tools)) rawTools.push(...(listed.tools as unknown[]));
      cursor = typeof listed?.nextCursor === "string" ? listed.nextCursor : undefined;
    } while (cursor);

    const built = buildMcpBindings(serverName, rawTools, send);
    tools.push(...built.tools);
    for (const [k,v] of built.bindings) bindings.set(k,v);
    toolDefinitions.push(...built.toolDefinitions);
  } catch (error) {
    /* v8 ignore start -- every rejection on this path is an Error this
       module raised, so the String() arm cannot run */
    process.stderr.write(
      `${serverName}: MCP SSE connection failed (${error instanceof Error ? error.message : String(error)})\n`,
    );
    /* v8 ignore stop */
  }

  const close = () => {
    controller.abort();
    for (const request of pending.values()) {
      request.reject(new Error("MCP server closed"));
    }
    pending.clear();
  };

  // Avoid unhandled rejection from the background pump.
  /* v8 ignore start -- the handler itself is never invoked: the pump is
     written to resolve, and this exists only to catch it if it ever doesn't */
  void pump.catch(() => undefined);
  /* v8 ignore stop */

  return { name: serverName, tools, bindings, toolDefinitions, close };
}

function buildMcpBindings(
  serverName: string,
  rawTools: unknown[],
  send: (method: string, params: Record<string, unknown> | null) => Promise<unknown>,
): { tools: McpTool[]; bindings: Map<string, McpToolBinding>; toolDefinitions: LlmToolDefinition[] } {
  const tools: McpTool[] = [];
  const bindings = new Map<string, McpToolBinding>();
  const toolDefinitions: LlmToolDefinition[] = [];

  for (const raw of rawTools) {
    if (typeof raw !== "object" || raw === null) continue;
    const tool = raw as McpTool;
    if (typeof tool.name !== "string" || tool.name.length === 0) continue;
    tools.push(tool);

    const bindingName = tool.name;
    const readOnly = tool.annotations?.readOnlyHint === true;
    const mutating = !readOnly;
    const kind: ToolKind = readOnly ? "read" : "other";
    const parameters =
      typeof tool.inputSchema === "object" && tool.inputSchema !== null
        ? (tool.inputSchema as Record<string, unknown>)
        : { type: "object", properties: {} };

    const binding: McpToolBinding = {
      name: bindingName,
      kind,
      mutating,
      title: () => `${serverName}: ${tool.name}`,
      call: async (input) => {
        try {
          const result = (await send("tools/call", {
            name: tool.name,
            arguments: input,
          })) as { content?: unknown; isError?: boolean } | null;
          let text = "";
          if (Array.isArray(result?.content)) {
            text = (result.content as Array<{ type?: string; text?: string }>)
              .map((entry) => (entry?.type === "text" ? String(entry.text ?? "") : JSON.stringify(entry)))
              .join("\n");
          } else if (result && typeof result === "object") {
            text = JSON.stringify(result);
          } else if (typeof result === "string") {
            text = result;
          }
          const output = text || "(no output)";
          const clipped =
            output.length <= MAX_MCP_OUTPUT_CHARS
              ? output
              : `${output.slice(0, MAX_MCP_OUTPUT_CHARS)}\n… output truncated (${output.length} characters total)`;
          return { output: clipped, isError: result?.isError === true };
        } catch (error) {
          /* v8 ignore start -- send() only rejects with Errors it raised
             itself, so the String() arm cannot run */
          return { output: error instanceof Error ? error.message : String(error), isError: true };
          /* v8 ignore stop */
        }
      },
    };

    bindings.set(bindingName, binding);
    toolDefinitions.push({
      type: "function",
      function: {
        name: bindingName,
        description: tool.description ?? `MCP tool ${tool.name} from ${serverName}`,
        parameters,
      },
    });
  }

  return { tools, bindings, toolDefinitions };
}

/**
 * Whether a config entry describes a stdio server: a `command` to spawn,
 * with `type` either absent or explicitly `stdio`.
 *
 * The `type` check runs first so `{ type: "http", command: "..." }` is not
 * silently spawned as a child process.
 */
export function isStdioMcpServer(value: unknown): value is McpServerConfig {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.type === "string" && record.type !== "stdio") return false;
  return typeof record.command === "string" && record.command.length > 0;
}

/** Whether a config entry describes an HTTP or SSE server (a `url`, no spawn). */
export function isHttpMcpServer(value: unknown): value is McpServerConfig {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.type === "string" && record.type !== "http" && record.type !== "sse") return false;
  if (record.type !== "http" && record.type !== "sse" && record.type !== undefined) return false;
  // http/sse servers are identified by a url rather than a command
  if (typeof record.url !== "string" || record.url.length === 0) return false;
  return record.type === "http" || record.type === "sse" || record.type === undefined;
}

/**
 * Turns an unvalidated `mcpServers` entry into a config, or returns `null`.
 *
 * Client-supplied JSON is never assumed to match the schema: a missing
 * `command`, a `command` that is not a string, or an entry that fits neither
 * transport is dropped with `null`, which the caller logs and skips.
 */
export function normalizeMcpServer(value: unknown): McpServerConfig | null {
  if (isStdioMcpServer(value)) {
    const record = value as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : undefined;
    const command = record.command as string;
    const args = Array.isArray(record.args) ? record.args.map(String) : [];
    const env = record.env as McpServerConfig["env"];
    return { type: "stdio", name, command, args, env };
  }

  if (isHttpMcpServer(value)) {
    const record = value as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : undefined;
    const url = record.url as string;
    const type = record.type === "sse" ? "sse" : "http";
    const headers = record.headers as McpServerConfig["headers"];
    return { type, name, url, headers };
  }

  return null;
}

/**
 * Connects every configured server, skipping the ones that fail.
 *
 * Degradation is the whole point: an MCP server that is not installed, or an
 * editor that launched the agent with a `PATH` too short to find it, must
 * leave a session with fewer tools rather than no session. Each failure is
 * logged with the target so the operator knows which entry to fix.
 */
export async function connectMcpServers(servers: unknown[]): Promise<McpConnection[]> {
  const connections: McpConnection[] = [];
  for (const server of servers) {
    const config = normalizeMcpServer(server);
    if (!config) continue;
    try {
      const connection =
        config.type === "sse"
          ? await connectSseMcpServer(config)
          : config.type === "http"
            ? await connectHttpMcpServer(config)
            : await connectMcpServer(config);
      connections.push(connection);
    } catch (error) {
      const target =
        config.type === "http" || config.type === "sse"
          ? (config.url as string)
          : (config.command as string);
      /* v8 ignore start -- connect* only rejects with Errors they raised
         themselves, so the String() arm cannot run */
      process.stderr.write(
        `MCP: failed to connect to ${target}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      /* v8 ignore stop */
    }
  }
  return connections;
}

/**
 * Folds every connection's tools into one map and one definition list.
 *
 * Names are the collision surface: the model sees a flat namespace where a
 * server's `read_file` would shadow the built-in, and two servers can ship
 * the same name. Anything already taken is reissued under a
 * `server__tool` prefix, so no tool ever becomes unreachable — a tool the
 * model cannot call is worse than an ugly name.
 */
export function mergeMcpBindings(connections: McpConnection[]): {
  bindings: Map<string, McpToolBinding>;
  definitions: LlmToolDefinition[];
} {
  const bindings = new Map<string, McpToolBinding>();
  const definitions: LlmToolDefinition[] = [];
  const used = new Set<string>([
    "read_file",
    "write_file",
    "edit_file",
    "list_dir",
    "glob",
    "grep",
    "bash",
  ]);

  for (const connection of connections) {
    // Build a lookup from original tool name to its definition.
    const defByName = new Map<string, LlmToolDefinition>();
    for (const def of connection.toolDefinitions) {
      defByName.set(def.function.name, def);
    }

    for (const [originalName, binding] of connection.bindings) {
      let name = originalName;
      if (used.has(name)) {
        name = `${sanitizeName(connection.name)}__${originalName}`;
      }
      used.add(name);

      const originalDef = defByName.get(originalName);
      const parameters = originalDef?.function.parameters ?? { type: "object", properties: {} };
      const description = originalDef?.function.description;

      const renamedBinding: McpToolBinding = {
        ...binding,
        name,
        title: () => `${connection.name}: ${originalName}`,
      };

      bindings.set(name, renamedBinding);
      definitions.push({
        type: "function",
        function: {
          name,
          description: description ?? `MCP tool ${originalName}`,
          parameters,
        },
      });
    }
  }

  return { bindings, definitions };
}
