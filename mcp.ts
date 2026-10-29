import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type { ToolKind } from "@agentclientprotocol/sdk";
import type { LlmToolDefinition } from "./llm.js";
import type { ToolExecutionResult, ToolContext } from "./tools.js";

export type McpEnvVar = { name: string; value: string };

export type McpServerConfig = {
  name?: string;
  command: string;
  args?: string[];
  env?: McpEnvVar[] | Record<string, string>;
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
  const child = spawn(config.command, config.args ?? [], {
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

    const listed = (await send("tools/list", {})) as { tools?: unknown } | null;
    const rawTools = Array.isArray(listed?.tools) ? (listed.tools as unknown[]) : [];
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
            return { output: text || "(no output)", isError: result?.isError === true };
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

  const close = () => {
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

  return { name: serverName, tools, bindings, toolDefinitions, close };
}

export function isStdioMcpServer(value: unknown): value is McpServerConfig {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.type === "string" && record.type !== "stdio") return false;
  return typeof record.command === "string" && record.command.length > 0;
}

export function normalizeMcpServer(value: unknown): McpServerConfig | null {
  if (!isStdioMcpServer(value)) return null;
  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : undefined;
  const command = record.command as string;
  const args = Array.isArray(record.args) ? record.args.map(String) : [];
  const env = record.env as McpServerConfig["env"];
  return { name, command, args, env };
}

export async function connectMcpServers(servers: unknown[]): Promise<McpConnection[]> {
  const connections: McpConnection[] = [];
  for (const server of servers) {
    const config = normalizeMcpServer(server);
    if (!config) continue;
    try {
      const connection = await connectMcpServer(config);
      connections.push(connection);
    } catch (error) {
      process.stderr.write(
        `MCP: failed to connect to ${config.command}: ${error instanceof Error ? error.message : String(error)}\n`,
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
