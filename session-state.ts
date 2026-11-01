import type { LlmMessage } from "./llm.js";
import type { McpConnection, McpToolBinding } from "./mcp.js";
import type { ToolName } from "./tools.js";

export type SessionState = {
  id: string;
  cwd: string;
  roots: string[];
  history: LlmMessage[];
  model: string;
  title?: string;
  reasoningLevel: string;
  mode: string;
  deleted?: boolean;
  allowedTools: Set<ToolName>;
  abort: AbortController | null;
  messageCounter: number;
  lastPromptTokens: number;
  costSoFar: number;
  mcpConnections: McpConnection[];
  mcpTools: Map<string, McpToolBinding>;
  mcpToolDefinitions: import("./llm.js").LlmToolDefinition[];
};

export function createSessionState(params: {
  id: string;
  cwd: string;
  roots: string[];
  model: string;
  history?: LlmMessage[];
}): SessionState {
  return {
    id: params.id,
    cwd: params.cwd,
    roots: params.roots,
    history: params.history ?? [],
    model: params.model,
    title: undefined,
    reasoningLevel: "medium",
    mode: "build",
    deleted: false,
    allowedTools: new Set(),
    abort: null,
    messageCounter: 0,
    lastPromptTokens: 0,
    costSoFar: 0,
    mcpConnections: [],
    mcpTools: new Map(),
    mcpToolDefinitions: [],
  };
}