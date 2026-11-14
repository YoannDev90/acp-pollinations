import type { LlmMessage } from "../llm.js";
import type { McpConnection, McpToolBinding } from "../mcp/index.js";
import type { Skill } from "../skills.js";
import type { ToolName } from "../tools/index.js";

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
  mcpToolDefinitions: import("../llm.js").LlmToolDefinition[];
  /** Skills discovered when the session was opened; see `src/skills.ts`. */
  skills: Skill[];
};

export function createSessionState(params: {
  id: string;
  cwd: string;
  roots: string[];
  model: string;
  /** Mode the session opens in; `build` when the caller has no preference. */
  mode?: string;
  /** Reasoning effort the session opens at; `medium` by default. */
  reasoningLevel?: string;
  history?: LlmMessage[];
  skills?: Skill[];
}): SessionState {
  return {
    id: params.id,
    cwd: params.cwd,
    roots: params.roots,
    history: params.history ?? [],
    model: params.model,
    title: undefined,
    reasoningLevel: params.reasoningLevel ?? "medium",
    mode: params.mode ?? "build",
    deleted: false,
    allowedTools: new Set(),
    abort: null,
    messageCounter: 0,
    lastPromptTokens: 0,
    costSoFar: 0,
    mcpConnections: [],
    mcpTools: new Map(),
    mcpToolDefinitions: [],
    skills: params.skills ?? [],
  };
}