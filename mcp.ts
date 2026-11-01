import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type { ToolKind } from "@agentclientprotocol/sdk";
import type { LlmToolDefinition } from "./llm.js";
import type { ToolExecutionResult, ToolContext } from "./tools.js";

const MAX_MCP_OUTPUT_CHARS = 20_000;

export type McpEnvVar = { name: string; value: string };

export type McpServerConfig = {
  type?: "stdio" | "http" | "sse";
  name?: string;
  command?: string;
  args?: string[];
  env?: McpEnvVar[] | Record<string, string>;
  url?: string;
  headers?: Record<string, string> | Array<{ name: string; value: string }>;
};

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

export type McpToolBinding = {
  name: string;
  kind: ToolKind;
  mutating: boolean;
  title: (input: Record<string, unknown>) => string;
  call: (input: Record<string, unknown>) => Promise<ToolExecutionResult>;
};

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

export async function connectMcpServer(config: McpServerConfig): Promise<McpConnection> {
  const serverName = config.name?.trim() || config.command;
  const child = spawn(config.command as string, config.args ?? [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...envToRecord(config.env) },
  });

  const rl = createInterface({ input: child.stdout });
  let nextId = 1;
  const pending = new Map<number, PendingRequest>();

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
      const payload = { jsonrpc: "2.0", id, method, params: params ?? {} };
      try {
        child.stdin.write(JSON.stringify(payload) + "\n");
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
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
        title: (input) => `${serverName}: ${tool.name}`,
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
            return { output: error instanceof Error ? error.message : String(error), isError: true };
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
  } catch (error) {
    // Degrade: a server that fails to initialize must not take down session/new.
    process.stderr.write(
      `${serverName}: MCP connection failed (${error instanceof Error ? error.message : String(error)})\n`,
    );
  }

  process.stderr.write(`${serverName}: connected with ${tools.length} tool(s)\n`);

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

export async function connectHttpMcpServer(config: McpServerConfig): Promise<McpConnection> {
  const serverName = config.name?.trim() || config.url || "mcp-http";
  const url = config.url as string;
  const baseHeaders = headersToRecord(config.headers);

  let sessionId: string | undefined;
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

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
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }),
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
        title: (input) => `${serverName}: ${tool.name}`,
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
                .join("\\n");
            } else if (result && typeof result === "object") {
              text = JSON.stringify(result);
            } else if (typeof result === "string") {
              text = result;
            }
            const output = text || "(no output)";
            const clipped =
              output.length <= MAX_MCP_OUTPUT_CHARS
                ? output
                : `${output.slice(0, MAX_MCP_OUTPUT_CHARS)}\\n… output truncated (${output.length} characters total)`;
            return { output: clipped, isError: result?.isError === true };
          } catch (error) {
            return { output: error instanceof Error ? error.message : String(error), isError: true };
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
  } catch (error) {
    process.stderr.write(
      `${serverName}: MCP HTTP connection failed (${error instanceof Error ? error.message : String(error)})\\n`,
    );
  }

  const close = () => {
    // stateless: nothing to close
  };

  return { name: serverName as string, tools, bindings, toolDefinitions, close };
}

export async function connectSseMcpServer(config: McpServerConfig): Promise<McpConnection> {
  const serverName = config.name?.trim() || config.url || "mcp-sse";
  const url = config.url as string;
  const baseHeaders = headersToRecord(config.headers);

  const controller = new AbortController();
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "text/event-stream", ...baseHeaders },
    signal: controller.signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`MCP SSE connection failed (${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let postUrl: string | null = null;
  let endpointReady: (() => void) | null = null;
  const endpointPromise = new Promise<void>((resolve) => {
    endpointReady = resolve;
  });

  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  const pump = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\\n\\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          let event = "message";
          const dataLines: string[] = [];
          for (const line of frame.split(/\\r?\\n/)) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
          }
          const data = dataLines.join("\\n");

          if (event === "endpoint" && data) {
            postUrl = new URL(data, url).toString();
            if (endpointReady) {
              const ready = endpointReady as () => void;
              endpointReady = null;
              ready();
            }
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
      for (const request of pending.values()) {
        request.reject(error instanceof Error ? error : new Error(String(error)));
      }
      pending.clear();
    }
  })();

  // Wait for the endpoint event (with a timeout).
  const endpointTimeout = setTimeout(() => {
    if (endpointReady) {
      endpointReady = null;
      // reject all pending? none yet
    }
  }, 10_000);
  await endpointPromise;
  clearTimeout(endpointTimeout);

  if (!postUrl) throw new Error("MCP SSE server did not send an endpoint");

  let nextId = 1;

  async function send(method: string, params: Record<string, unknown> | null): Promise<unknown> {
    const id = nextId++;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...baseHeaders,
    };
    const response = await fetch(postUrl as string, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }),
    });
    if (!response.ok) {
      throw new Error(`MCP request "${method}" failed (${response.status})`);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out`));
      }, 30_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
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

    const rawTools: unknown[] = [];
    let cursor: string | undefined;
    do {
      const listed = (await send("tools/list", cursor ? { cursor } : {})) as
        | { tools?: unknown; nextCursor?: unknown }
        | null;
      if (Array.isArray(listed?.tools)) rawTools.push(...(listed.tools as unknown[]));
      cursor = typeof listed?.nextCursor === "string" ? listed.nextCursor : undefined;
    } while (cursor);

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
        title: (input) => `${serverName}: ${tool.name}`,
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
                .join("\\n");
            } else if (result && typeof result === "object") {
              text = JSON.stringify(result);
            } else if (typeof result === "string") {
              text = result;
            }
            const output = text || "(no output)";
            const clipped =
              output.length <= MAX_MCP_OUTPUT_CHARS
                ? output
                : `${output.slice(0, MAX_MCP_OUTPUT_CHARS)}\\n… output truncated (${output.length} characters total)`;
            return { output: clipped, isError: result?.isError === true };
          } catch (error) {
            return { output: error instanceof Error ? error.message : String(error), isError: true };
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
  } catch (error) {
    process.stderr.write(
      `${serverName}: MCP SSE connection failed (${error instanceof Error ? error.message : String(error)})\\n`,
    );
  }

  const close = () => {
    controller.abort();
    for (const request of pending.values()) {
      request.reject(new Error("MCP server closed"));
    }
    pending.clear();
  };

  // Avoid unhandled rejection from the background pump.
  void pump.catch(() => undefined);

  return { name: serverName, tools, bindings, toolDefinitions, close };
}

export function isStdioMcpServer(value: unknown): value is McpServerConfig {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.type === "string" && record.type !== "stdio") return false;
  return typeof record.command === "string" && record.command.length > 0;
}

export function isHttpMcpServer(value: unknown): value is McpServerConfig {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.type === "string" && record.type !== "http" && record.type !== "sse") return false;
  if (record.type !== "http" && record.type !== "sse" && record.type !== undefined) return false;
  // http/sse servers are identified by a url rather than a command
  if (typeof record.url !== "string" || record.url.length === 0) return false;
  return record.type === "http" || record.type === "sse" || record.type === undefined;
}

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
      process.stderr.write(
        `MCP: failed to connect to ${target}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  return connections;
}

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
