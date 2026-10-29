// ACP coding agent backed by Pollinations.
//
// The ACP wire protocol (JSON-RPC framing, method dispatch, schema validation,
// error mapping, terminal handles) comes from `@agentclientprotocol/sdk`;
// everything exported here is the Pollinations-specific agent behaviour.

export {
  AGENT_NAME,
  AGENT_TITLE,
  AGENT_VERSION,
  createPollinationsAgent,
  promptToText,
} from "./server.js";
export type { CreatePollinationsAgentOptions } from "./server.js";

export {
  DEFAULT_BASE_URL,
  DEFAULT_COMPACTION_THRESHOLD_TOKENS,
  DEFAULT_MAX_TURN_REQUESTS,
  DEFAULT_MODEL,
  resolveApiKey,
  resolveConfig,
} from "./config.js";
export type { AgentConfig, ResolveConfigOptions } from "./config.js";

export { LlmError, PollinationsLlm } from "./llm.js";
export type {
  LlmChatParams,
  LlmChunk,
  LlmMessage,
  LlmRole,
  LlmToolCall,
  LlmToolDefinition,
  LlmUsage,
  PollinationsLlmOptions,
} from "./llm.js";

export { createSseParser } from "./sse.js";
export type { SseEvent } from "./sse.js";

export {
  FALLBACK_MODELS,
  MODEL_CATALOG_TTL_MS,
  MODEL_CONFIG_ID,
  MODEL_GROUP_ORDER,
  buildModelOption,
  classifyTier,
  fetchModelCatalog,
  inferGroup,
  isKnownModel,
  parseModelCatalog,
} from "./models.js";
export type { CatalogModel, FetchModelCatalogOptions, ModelGroup, PricingTier } from "./models.js";

export { LLM_TOOLS, TOOL_DEFINITIONS, ToolError, executeTool, globToRegExp } from "./tools.js";
export {
  connectMcpServer,
  connectMcpServers,
  isStdioMcpServer,
  mergeMcpBindings,
  normalizeMcpServer,
} from "./mcp.js";
export type { McpConnection, McpServerConfig, McpTool, McpToolBinding } from "./mcp.js";
export type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
  ToolLocation,
  ToolName,
} from "./tools.js";

export {
  LIST_PAGE_SIZE,
  MAX_PERSISTED_SESSIONS,
  SESSION_RECORD_VERSION,
  createSessionStore,
} from "./sessions.js";
export type {
  ListSessionsOptions,
  ListSessionsResult,
  PersistedSession,
  SessionStore,
  StoredSession,
} from "./sessions.js";

// Re-exported for consumers that build ACP messages against the same schema.
export { PROTOCOL_VERSION, methods } from "@agentclientprotocol/sdk";
