import { randomBytes } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import {
  PROTOCOL_VERSION,
  RequestError,
  agent,
  methods,
} from "@agentclientprotocol/sdk";
import type {
  AgentApp,
  AgentContext,
  ClientCapabilities,
  ContentBlock,
  SessionConfigOption,
  PromptResponse,
  ToolCallContent,
  ToolKind,
} from "@agentclientprotocol/sdk";

import type { AgentConfig } from "../config.js";
import { LlmError, PollinationsLlm } from "../llm.js";
import type { LlmMessage, LlmToolCall, LlmUsage } from "../llm.js";
import {
  FALLBACK_MODELS,
  MODEL_CONFIG_ID,
  MODEL_CATALOG_TTL_MS,
  buildModelOption,
  fetchModelCatalog,
  isKnownModel,
} from "../models.js";
import type { CatalogModel } from "../models.js";
import { createSessionStore } from "../sessions/index.js";
import type { PersistedSession } from "../sessions/index.js";
import { LLM_TOOLS, TOOL_DEFINITIONS, ToolError, executeTool } from "../tools/index.js";
import { promptToText, rebaseHistory, systemMessage } from "../messages.js";
import { shouldCompact, summarizeTranscript } from "../compaction.js";
import { connectionKey, createNotifier } from "../connection.js";
import type { SessionState } from "./session-state.js";
import { createSessionState } from "./session-state.js";
import type { ToolContext, ToolExecutionResult, ToolName } from "../tools/index.js";
import {
  connectMcpServers,
  mergeMcpBindings,
  type McpConnection,
  type McpToolBinding,
} from "../mcp/index.js";

export const AGENT_NAME = "pollinations";
export const AGENT_TITLE = "Pollinations";
export const AGENT_VERSION = "1.0.0";

export { promptToText } from "../messages.js";

/** Config option id for the reasoning/thought-level selector. */
const REASONING_CONFIG_ID = "reasoning";

const REASONING_LEVELS: ReadonlyArray<{ value: string; name: string }> = [
  { value: "none", name: "None" },
  { value: "low", name: "Low" },
  { value: "medium", name: "Medium" },
  { value: "high", name: "High" },
];

const AVAILABLE_MODES: ReadonlyArray<{ id: string; name: string; description: string }> = [
  { id: "build", name: "Build", description: "Implement changes" },
  { id: "plan", name: "Plan", description: "Plan without editing" },
  { id: "ask", name: "Ask", description: "Answer questions" },
];

const AVAILABLE_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  { name: "help", description: "Show available commands" },
  { name: "status", description: "Show session status" },
  { name: "model", description: "Show or switch the model" },
  { name: "mode", description: "Show or switch Build/Plan/Ask" },
  { name: "reasoning", description: "Show or set reasoning effort" },
  { name: "clear", description: "Clear the conversation" },
  { name: "cost", description: "Show token usage and cost" },
  { name: "tools", description: "List available tools" },
  { name: "compact", description: "Compact the context" },
  { name: "sessions", description: "List persisted sessions" },
  { name: "delete", description: "Delete this session" },
];

export type CreatePollinationsAgentOptions = {
  config: AgentConfig;
  /** Injected LLM, for tests. Defaults to a real Pollinations client. */
  llm?: PollinationsLlm;
  /** Injected `fetch`, used to read the model catalogue. Defaults to global. */
  fetchImpl?: typeof fetch;
  /**
   * How long a fetched model catalogue is reused. `0` refetches every time,
   * which is what the tests want.
   */
  catalogTtlMs?: number;
};


/**
 * Builds the ACP coding agent.
 *
 * The returned app speaks ACP v1 over any SDK stream (stdio in production,
 * in-process in tests) and drives Pollinations chat completions with a tool
 * loop over the session workspace.
 */
export function createPollinationsAgent(options: CreatePollinationsAgentOptions): AgentApp {
  const { config } = options;
  // The LLM client requires a key, but `session/new` rejects before any request
  // is made when one is missing, so the agent can still answer `initialize` and
  // report a useful error instead of dying at startup.
  const llm: PollinationsLlm | null =
    options.llm ??
    (config.apiKey
      ? new PollinationsLlm({
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
          model: config.model,
        })
      : null);

  const sessions = new Map<string, SessionState>();
  const clientCapabilities = new Map<string, ClientCapabilities | null>();
  const store = createSessionStore(config.sessionsDir);

  const catalogTtlMs = options.catalogTtlMs ?? MODEL_CATALOG_TTL_MS;
  let catalog: { at: number; models: CatalogModel[] } | null = null;

  /**
   * Model catalogue backing the picker, refreshed at most every `catalogTtlMs`.
   *
   * A catalogue failure is not fatal: the agent falls back to a small offline
   * list so `session/new` still returns a usable picker, and the session keeps
   * whatever model it already had.
   */
  async function modelCatalog(): Promise<CatalogModel[]> {
    const now = Date.now();
    if (catalog && now - catalog.at < catalogTtlMs) return catalog.models;

    try {
      const models = await fetchModelCatalog({
        baseUrl: config.baseUrl,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
      catalog = { at: now, models };
      return models;
    } catch (error) {
      process.stderr.write(
        `${AGENT_TITLE}: model catalogue unavailable (${(error as Error).message}); ` +
          `offering the offline list\n`,
      );
      // Cache the fallback too, so a dead endpoint is not retried per session.
      const models = catalog?.models ?? [...FALLBACK_MODELS];
      catalog = { at: now, models };
      return models;
    }
  }

  const app = agent({ name: AGENT_NAME });

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  app.onRequest(methods.agent.initialize, (ctx) => {
    clientCapabilities.set(connectionKey(ctx.client), ctx.params.clientCapabilities ?? null);
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
        sessionCapabilities: { list: {}, delete: {}, close: {}, resume: {} },
      },
      agentInfo: { name: AGENT_NAME, title: AGENT_TITLE, version: AGENT_VERSION },
    };
  });

  // The API key comes from the environment, not from an ACP auth flow.
  app.onRequest(methods.agent.authenticate, () => ({}));

  app.onRequest(methods.agent.session.new, async (ctx) => {
    const { cwd } = ctx.params;
    if (typeof cwd !== "string" || cwd.length === 0) {
      throw RequestError.invalidParams({ cwd }, "`cwd` is required and must be an absolute path");
    }
    if (!isAbsolute(cwd)) {
      throw RequestError.invalidParams({ cwd }, "`cwd` must be an absolute path");
    }
    if (!config.apiKey) {
      throw new RequestError(
        -32000,
        "No Pollinations API key configured. Set POLLINATIONS_API_KEY or run `polli auth login`.",
      );
    }

    const roots = [resolve(cwd)];
    for (const directory of ctx.params.additionalDirectories ?? []) {
      if (!isAbsolute(directory)) {
        throw RequestError.invalidParams(
          { additionalDirectories: directory },
          "`additionalDirectories` entries must be absolute paths",
        );
      }
      roots.push(resolve(directory));
    }

    const sessionId = `sess_${randomBytes(9).toString("hex")}`;
    const model = config.model;
    const session = createSessionState({
      id: sessionId,
      cwd: roots[0] as string,
      roots,
      model,
      history: [systemMessage(roots[0] as string)],
    });
    sessions.set(sessionId, session);

    process.stderr.write(
      `${AGENT_TITLE}: session/new id=${sessionId} cwd=${roots[0]} model=${model} ` +
        `mcpServers=${ctx.params.mcpServers?.length ?? 0}\n`,
    );

    // Connect to any MCP servers the client supplied. A failure here degrades
    // to "no tools from that server" rather than failing session setup.
    const connections = await connectMcpServers(ctx.params.mcpServers ?? []);

    const notify = createNotifier(ctx.client, sessionId);
    // Defer so the client has attached its session-update handler before the
    // notification arrives (some clients drop early notifications).
    setTimeout(() => {
      void notify({
        sessionUpdate: "available_commands_update",
        availableCommands: [...AVAILABLE_COMMANDS],
      });
    }, 50);
    session.mcpConnections = connections;
    const merged = mergeMcpBindings(connections);
    session.mcpTools = merged.bindings;
    session.mcpToolDefinitions = merged.definitions;

    await persist(session);

    // The picker is what lets the client switch models mid-session.
    return {
      sessionId,
      modes: {
        currentModeId: "build",
        availableModes: [...AVAILABLE_MODES],
      },
      configOptions: [
        buildModelOption(await modelCatalog(), model),
        buildReasoningOption("medium"),
      ],
    };
  });

  /**
   * Restores a session the client stored before the agent process restarted.
   *
   * The transcript itself is the client's to render — `LoadSessionResponse`
   * carries no messages — so what matters here is putting the conversation
   * history back in front of the model, which only a persistent store can do
   * across a restart.
   */
  app.onRequest(methods.agent.session.load, async (ctx) => {
    const { sessionId, cwd } = ctx.params;
    if (typeof cwd !== "string" || cwd.length === 0 || !isAbsolute(cwd)) {
      throw RequestError.invalidParams({ cwd }, "`cwd` must be an absolute path");
    }
    if (!config.apiKey) {
      throw new RequestError(
        -32000,
        "No Pollinations API key configured. Set POLLINATIONS_API_KEY or run `polli auth login`.",
      );
    }

    // Still warm from an earlier turn in this process: nothing to restore.
    const live = sessions.get(sessionId);
    if (live)
      return {
        modes: {
          currentModeId: live.mode,
          availableModes: [...AVAILABLE_MODES],
        },
        configOptions: [
          buildModelOption(await modelCatalog(), live.model),
          buildReasoningOption(live.reasoningLevel),
        ],
      };

    const stored = await store.load(sessionId);
    if (!stored) throw RequestError.sessionNotFound(sessionId);

    const loadedRoots = [resolve(cwd)];
    for (const directory of ctx.params.additionalDirectories ?? []) {
      if (!isAbsolute(directory)) {
        throw RequestError.invalidParams(
          { additionalDirectories: directory },
          "`additionalDirectories` entries must be absolute paths",
        );
      }
      loadedRoots.push(resolve(directory));
    }

    const root = loadedRoots[0] as string;
    const session = createSessionState({
      id: sessionId,
      cwd: root,
      roots: loadedRoots,
      model: stored.model,
      history: rebaseHistory(stored.history, root, stored.cwd),
    });
    session.title = stored.title;
    session.reasoningLevel = stored.reasoningLevel ?? "medium";
    session.mode = stored.mode ?? "build";
    session.allowedTools = new Set(stored.allowedTools as ToolName[]);
    session.messageCounter = stored.messageCounter;
    session.lastPromptTokens = stored.lastPromptTokens;
    sessions.set(sessionId, session);

    process.stderr.write(
      `${AGENT_TITLE}: session/load id=${sessionId} cwd=${root} ` +
        `restoredMessages=${session.history.length} model=${session.model}\n`,
    );

    const connections = await connectMcpServers(ctx.params.mcpServers ?? []);
    session.mcpConnections = connections;
    const merged = mergeMcpBindings(connections);
    session.mcpTools = merged.bindings;
    session.mcpToolDefinitions = merged.definitions;

    // Replay the restored transcript so the client can render the thread again.
    const notify = createNotifier(ctx.client, sessionId);
    for (const message of session.history) {
      if (message.role === "user") {
        await notify({
          sessionUpdate: "user_message_chunk",
          messageId: nextMessageId(session),
          content: { type: "text", text: message.content ?? "" },
        });
      } else if (message.role === "assistant" && message.content) {
        await notify({
          sessionUpdate: "agent_message_chunk",
          messageId: nextMessageId(session),
          content: { type: "text", text: message.content },
        });
      }
    }

    return {
      modes: {
        currentModeId: session.mode,
        availableModes: [...AVAILABLE_MODES],
      },
      configOptions: [
        buildModelOption(await modelCatalog(), session.model),
        buildReasoningOption(session.reasoningLevel),
      ],
    };
  });

  /* ---------------------------------------------------------------- *
   * Session resume (restore without replay)
   * ---------------------------------------------------------------- */
  app.onRequest(methods.agent.session.resume, async (ctx) => {
    const { sessionId, cwd } = ctx.params;
    if (typeof cwd !== "string" || cwd.length === 0 || !isAbsolute(cwd)) {
      throw RequestError.invalidParams({ cwd }, "`cwd` must be an absolute path");
    }
    if (!config.apiKey) {
      throw new RequestError(
        -32000,
        "No Pollinations API key configured. Set POLLINATIONS_API_KEY or run `polli auth login`.",
      );
    }

    const live = sessions.get(sessionId);
    if (live) {
      return {
        modes: { currentModeId: live.mode, availableModes: [...AVAILABLE_MODES] },
        configOptions: [
          buildModelOption(await modelCatalog(), live.model),
          buildReasoningOption(live.reasoningLevel),
        ],
      };
    }

    const stored = await store.load(sessionId);
    if (!stored) throw RequestError.sessionNotFound(sessionId);

    const loadedRoots = [resolve(cwd)];
    for (const directory of ctx.params.additionalDirectories ?? []) {
      if (!isAbsolute(directory)) {
        throw RequestError.invalidParams(
          { additionalDirectories: directory },
          "`additionalDirectories` entries must be absolute paths",
        );
      }
      loadedRoots.push(resolve(directory));
    }

    const root = loadedRoots[0] as string;
    const session = createSessionState({
      id: sessionId,
      cwd: root,
      roots: loadedRoots,
      model: stored.model,
      history: rebaseHistory(stored.history, root, stored.cwd),
    });
    session.title = stored.title;
    session.reasoningLevel = stored.reasoningLevel ?? "medium";
    session.mode = stored.mode ?? "build";
    session.allowedTools = new Set(stored.allowedTools as ToolName[]);
    session.messageCounter = stored.messageCounter;
    session.lastPromptTokens = stored.lastPromptTokens;
    sessions.set(sessionId, session);

    const connections = await connectMcpServers(ctx.params.mcpServers ?? []);
    session.mcpConnections = connections;
    const merged = mergeMcpBindings(connections);
    session.mcpTools = merged.bindings;
    session.mcpToolDefinitions = merged.definitions;

    process.stderr.write(
      `${AGENT_TITLE}: session/resume id=${sessionId} cwd=${root} restoredMessages=${session.history.length}\n`,
    );

    return {
      modes: { currentModeId: session.mode, availableModes: [...AVAILABLE_MODES] },
      configOptions: [
        buildModelOption(await modelCatalog(), session.model),
        buildReasoningOption(session.reasoningLevel),
      ],
    };
  });

  /* ---------------------------------------------------------------- *
   * Session listing and deletion
   * ---------------------------------------------------------------- */

  app.onRequest(methods.agent.session.list, async (ctx) => {
    const { sessions: page, nextCursor } = await store.list({
      ...(ctx.params.cwd ? { cwd: ctx.params.cwd } : {}),
      ...(ctx.params.cursor ? { cursor: ctx.params.cursor } : {}),
    });

    process.stderr.write(
      `${AGENT_TITLE}: session/list cwd=${ctx.params.cwd ?? "*"} returned=${page.length} ` +
        `nextCursor=${nextCursor ?? "none"}\n`,
    );

    return {
      sessions: page.map((record) => ({
        sessionId: record.id,
        cwd: record.cwd,
        additionalDirectories: record.roots.slice(1),
        updatedAt: record.updatedAt,
      })),
      ...(nextCursor ? { nextCursor } : {}),
    };
  });

  app.onRequest(methods.agent.session.close, async (ctx) => {
    const { sessionId } = ctx.params;
    const live = sessions.get(sessionId);
    live?.abort?.abort();
    for (const connection of live?.mcpConnections ?? []) connection.close();
    sessions.delete(sessionId);
    process.stderr.write(`${AGENT_TITLE}: session/close id=${sessionId}\n`);
    return {};
  });

  app.onRequest(methods.agent.session.delete, async (ctx) => {
    const { sessionId } = ctx.params;
    process.stderr.write(`${AGENT_TITLE}: session/delete id=${sessionId}\n`);
    const live = sessions.get(sessionId);
    // Deleting a session this agent never created succeeds silently. A client
    // clearing its own bookkeeping cannot know whether the agent still holds
    // the thread — a restart forgets every session this process had — so
    // making it tell the two cases apart would demand bookkeeping it has no
    // way to do. `remove` reports whether anything was actually deleted, and
    // the answer only changes the response if we chose to use it.
    await store.remove(sessionId);

    // Aborting first means a turn cannot write the session back after deletion.
    live?.abort?.abort();
    for (const connection of live?.mcpConnections ?? []) connection.close();
    sessions.delete(sessionId);
    return {};
  });

  /* ---------------------------------------------------------------- *
   * Model picker
   * ---------------------------------------------------------------- */

  app.onRequest(methods.agent.session.setConfigOption, async (ctx) => {
    const session = sessions.get(ctx.params.sessionId);
    if (!session) throw RequestError.sessionNotFound(ctx.params.sessionId);

    const { configId, value } = ctx.params;

    if (configId === MODEL_CONFIG_ID) {
      if (typeof value !== "string" || value.length === 0) {
        throw RequestError.invalidParams(
          { configId, value },
          `"${MODEL_CONFIG_ID}" takes a model id string.`,
        );
      }

      const models = await modelCatalog();
      if (!isKnownModel(models, value) && value !== session.model) {
        throw RequestError.invalidParams(
          { configId, value, available: models.map((model) => model.id) },
          `Unknown model "${value}". Pick one of the ${models.length} models offered by "${MODEL_CONFIG_ID}".`,
        );
      }

      session.model = value;
      await persist(session);
      const configOptions = [
        buildModelOption(models, value),
        buildReasoningOption(session.reasoningLevel),
      ];
      const notify = createNotifier(ctx.client, session.id);
      await notify({ sessionUpdate: "config_option_update", configOptions });
      return { configOptions };
    }

    if (configId === REASONING_CONFIG_ID) {
      if (typeof value !== "string" || !REASONING_LEVELS.some((level) => level.value === value)) {
        throw RequestError.invalidParams(
          { configId, value, available: REASONING_LEVELS.map((level) => level.value) },
          `Unknown reasoning level "${value}".`,
        );
      }

      session.reasoningLevel = value;
      await persist(session);
      const models = await modelCatalog();
      const configOptions = [
        buildModelOption(models, session.model),
        buildReasoningOption(value),
      ];
      const notify = createNotifier(ctx.client, session.id);
      await notify({ sessionUpdate: "config_option_update", configOptions });
      return { configOptions };
    }

    throw RequestError.invalidParams(
      { configId, value },
      `Unknown config option "${configId}". This agent only exposes "${MODEL_CONFIG_ID}" and "${REASONING_CONFIG_ID}".`,
    );
  });

  app.onRequest(methods.agent.session.setMode, async (ctx) => {
    const session = sessions.get(ctx.params.sessionId);
    if (!session) throw RequestError.sessionNotFound(ctx.params.sessionId);

    const modeId = ctx.params.modeId;
    if (!AVAILABLE_MODES.some((mode) => mode.id === modeId)) {
      throw RequestError.invalidParams(
        { modeId },
        `Unknown mode "${modeId}". Available: ${AVAILABLE_MODES.map((mode) => mode.id).join(", ")}.`,
      );
    }

    session.mode = modeId;
    await persist(session);

    const notify = createNotifier(ctx.client, session.id);
    await notify({ sessionUpdate: "current_mode_update", currentModeId: modeId });

    return {};
  });

  app.onNotification(methods.agent.session.cancel, (ctx) => {
    sessions.get(ctx.params.sessionId)?.abort?.abort();
  });

  /* ---------------------------------------------------------------- *
   * Prompt turn
   * ---------------------------------------------------------------- */

  app.onRequest(methods.agent.session.prompt, async (ctx) => {
    const session = sessions.get(ctx.params.sessionId);
    if (!session) throw RequestError.sessionNotFound(ctx.params.sessionId);

    const abort = new AbortController();
    const forwardAbort = () => abort.abort();
    ctx.signal.addEventListener("abort", forwardAbort, { once: true });
    session.abort = abort;

    const capabilities = clientCapabilities.get(connectionKey(ctx.client)) ?? null;
    const notify = createNotifier(ctx.client, session.id);

    try {
      process.stderr.write(
        `${AGENT_TITLE}: prompt start session=${session.id} model=${session.model}\n`,
      );

      // Handle slash commands locally so they work even when the client does not
      // render the `available_commands_update` notification.
      const promptText = promptToText(ctx.params.prompt).trim();

      if (promptText === "/status" || promptText.startsWith("/status ")) {
        await replayUserPrompt(ctx.params.prompt, notify, session);
        const statusText =
          `Session: ${session.id}\n` +
          `Model: ${session.model}\n` +
          `Mode: ${session.mode}\n` +
          `Reasoning: ${session.reasoningLevel}\n` +
          `Last prompt tokens: ${session.lastPromptTokens}\n` +
          `Cost so far: ${session.costSoFar.toFixed(6)} pollen`;
        const messageId = nextMessageId(session);
        await notify({
          sessionUpdate: "agent_message_chunk",
          messageId,
          content: { type: "text", text: statusText },
        });
        session.history.push({ role: "assistant", content: statusText, reasoning_content: "" });
        await persist(session);
        return { stopReason: "end_turn" };
      }

      if (promptText === "/model" || promptText.startsWith("/model ")) {
        await replayUserPrompt(ctx.params.prompt, notify, session);
        const parts = promptText.split(/\s+/);
        const requested = parts[1];
        if (!requested) {
          const text = `Current model: ${session.model}`;
          const messageId = nextMessageId(session);
          await notify({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } });
          session.history.push({ role: "assistant", content: text, reasoning_content: "" });
          await persist(session);
          return { stopReason: "end_turn" };
        }

        const models = await modelCatalog();
        if (!isKnownModel(models, requested) && requested !== session.model) {
          const text = `Unknown model "${requested}".`;
          const messageId = nextMessageId(session);
          await notify({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } });
          session.history.push({ role: "assistant", content: text, reasoning_content: "" });
          await persist(session);
          return { stopReason: "end_turn" };
        }

        session.model = requested;
        await persist(session);
        const text = `Switched model to ${session.model}.`;
        const messageId = nextMessageId(session);
        await notify({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } });
        session.history.push({ role: "assistant", content: text, reasoning_content: "" });
        await persist(session);
        return { stopReason: "end_turn" };
      }

      if (promptText === "/mode" || promptText.startsWith("/mode ")) {
        await replayUserPrompt(ctx.params.prompt, notify, session);
        const parts = promptText.split(/\s+/);
        const requested = parts[1];
        if (!requested) {
          const text = `Current mode: ${session.mode}`;
          const messageId = nextMessageId(session);
          await notify({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } });
          session.history.push({ role: "assistant", content: text, reasoning_content: "" });
          await persist(session);
          return { stopReason: "end_turn" };
        }
        if (!AVAILABLE_MODES.some((m) => m.id === requested)) {
          const text = `Unknown mode "${requested}". Available: ${AVAILABLE_MODES.map((m) => m.id).join(", ")}.`;
          const messageId = nextMessageId(session);
          await notify({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } });
          session.history.push({ role: "assistant", content: text, reasoning_content: "" });
          await persist(session);
          return { stopReason: "end_turn" };
        }
        session.mode = requested;
        await persist(session);
        const notifyMode = createNotifier(ctx.client, session.id);
        await notifyMode({ sessionUpdate: "current_mode_update", currentModeId: requested });
        const text = `Switched mode to ${session.mode}.`;
        const messageId = nextMessageId(session);
        await notify({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } });
        session.history.push({ role: "assistant", content: text, reasoning_content: "" });
        await persist(session);
        return { stopReason: "end_turn" };
      }

      if (promptText === "/reasoning" || promptText.startsWith("/reasoning ")) {
        await replayUserPrompt(ctx.params.prompt, notify, session);
        const parts = promptText.split(/\s+/);
        const requested = parts[1];
        if (!requested) {
          const text = `Current reasoning level: ${session.reasoningLevel}`;
          const messageId = nextMessageId(session);
          await notify({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } });
          session.history.push({ role: "assistant", content: text, reasoning_content: "" });
          await persist(session);
          return { stopReason: "end_turn" };
        }
        if (!REASONING_LEVELS.some((l) => l.value === requested)) {
          const text = `Unknown reasoning level "${requested}". Available: ${REASONING_LEVELS.map((l) => l.value).join(", ")}.`;
          const messageId = nextMessageId(session);
          await notify({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } });
          session.history.push({ role: "assistant", content: text, reasoning_content: "" });
          await persist(session);
          return { stopReason: "end_turn" };
        }
        session.reasoningLevel = requested;
        await persist(session);
        const models = await modelCatalog();
        const configOptions = [buildModelOption(models, session.model), buildReasoningOption(requested)];
        const notifyConfig = createNotifier(ctx.client, session.id);
        await notifyConfig({ sessionUpdate: "config_option_update", configOptions });
        const text = `Switched reasoning level to ${session.reasoningLevel}.`;
        const messageId = nextMessageId(session);
        await notify({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } });
        session.history.push({ role: "assistant", content: text, reasoning_content: "" });
        await persist(session);
        return { stopReason: "end_turn" };
      }

      if (promptText === "/clear" || promptText === "/clear") {
        await replayUserPrompt(ctx.params.prompt, notify, session);
        session.history = [systemMessage(session.cwd)];
        session.lastPromptTokens = 0;
        session.costSoFar = 0;
        session.title = undefined;
        await persist(session);
        const text = "Conversation cleared.";
        const messageId = nextMessageId(session);
        await notify({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } });
        session.history.push({ role: "assistant", content: text, reasoning_content: "" });
        await persist(session);
        return { stopReason: "end_turn" };
      }

      if (promptText === "/cost" || promptText === "/cost") {
        await replayUserPrompt(ctx.params.prompt, notify, session);
        const text = `Tokens (last request): ${session.lastPromptTokens}\nCost so far: ${session.costSoFar.toFixed(6)} USD`;
        const messageId = nextMessageId(session);
        await notify({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } });
        session.history.push({ role: "assistant", content: text, reasoning_content: "" });
        await persist(session);
        return { stopReason: "end_turn" };
      }

      if (promptText === "/tools" || promptText === "/tools") {
        await replayUserPrompt(ctx.params.prompt, notify, session);
        const builtin = [
          "read_file", "write_file", "edit_file", "list_dir", "glob", "grep", "bash",
        ];
        const mcp = [...session.mcpTools.keys()];
        const text = `Built-in tools: ${builtin.join(", ")}\nMCP tools: ${mcp.length ? mcp.join(", ") : "(none)"}`;
        const messageId = nextMessageId(session);
        await notify({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } });
        session.history.push({ role: "assistant", content: text, reasoning_content: "" });
        await persist(session);
        return { stopReason: "end_turn" };
      }

      if (promptText === "/compact" || promptText === "/compact") {
        await replayUserPrompt(ctx.params.prompt, notify, session);
        if (session.history.length < 3) {
          const text = "Nothing to compact.";
          const messageId = nextMessageId(session);
          await notify({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } });
          session.history.push({ role: "assistant", content: text, reasoning_content: "" });
          await persist(session);
          return { stopReason: "end_turn" };
        }
        const summary = await summarizeTranscript({
          history: session.history,
          model: session.model,
          llm: llm as import("../llm.js").PollinationsLlm,
          signal: abort.signal,
        });
        if (summary) {
          session.history = [session.history[0] as LlmMessage, { role: "assistant", content: summary }];
          session.lastPromptTokens = 0;
          await persist(session);
        }
        const text = summary ? "Compacted." : "Compaction failed.";
        const messageId = nextMessageId(session);
        await notify({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } });
        session.history.push({ role: "assistant", content: text, reasoning_content: "" });
        await persist(session);
        return { stopReason: "end_turn" };
      }

      if (promptText === "/sessions" || promptText === "/sessions") {
        await replayUserPrompt(ctx.params.prompt, notify, session);
        const { sessions: page } = await store.list({ cwd: session.cwd });
        const text = page.length
          ? page.map((s) => `${s.id}  ${s.updatedAt}`).join("\n")
          : "No persisted sessions.";
        const messageId = nextMessageId(session);
        await notify({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } });
        session.history.push({ role: "assistant", content: text, reasoning_content: "" });
        await persist(session);
        return { stopReason: "end_turn" };
      }

      if (promptText === "/delete" || promptText === "/delete") {
        await replayUserPrompt(ctx.params.prompt, notify, session);
        await store.remove(session.id);
        for (const connection of session.mcpConnections) connection.close();
        session.deleted = true;
        sessions.delete(session.id);
        const text = "Session deleted.";
        const messageId = nextMessageId(session);
        await notify({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } });
        return { stopReason: "end_turn" };
      }

      if (promptText === "/help" || promptText.startsWith("/help ")) {
        await replayUserPrompt(ctx.params.prompt, notify, session);
        const helpText =
          "Available commands:\n" +
          "- /help       Show this help message.\n" +
          "- /status     Show session status.\n" +
          "- /model      Show or switch the model.\n" +
          "- /mode       Show or switch Build/Plan/Ask.\n" +
          "- /reasoning  Show or set reasoning effort.\n" +
          "- /clear      Clear the conversation.\n" +
          "- /cost       Show token usage and cost.\n" +
          "- /tools      List available tools.\n" +
          "- /compact    Compact the context.\n" +
          "- /sessions   List persisted sessions.\n" +
          "- /delete     Delete this session.";
        const messageId = nextMessageId(session);
        await notify({
          sessionUpdate: "agent_message_chunk",
          messageId,
          content: { type: "text", text: helpText },
        });
        session.history.push({ role: "assistant", content: helpText, reasoning_content: "" });
        await persist(session);
        return { stopReason: "end_turn" };
      }

      // Compact before the user's turn, not after it: the expensive request is
      // the one about to happen, so trimming first is what actually pays off.
      await maybeCompact(session, notify, abort.signal, capabilities);

      await replayUserPrompt(ctx.params.prompt, notify, session);

      await notify({
        sessionUpdate: "plan",
        entries: [
          { content: "Handle the user request", priority: "medium", status: "in_progress" },
        ],
      });

      if (!session.title) {
        const firstText = promptToText(ctx.params.prompt);
        session.title = firstText.split("\n")[0]?.slice(0, 80) || "New session";
        await notify({
          sessionUpdate: "session_info_update",
          title: session.title,
        });
      }

      let stopReason: PromptResponse["stopReason"] = "max_turn_requests";

      for (let request = 0; request < config.maxTurnRequests; request += 1) {
        if (abort.signal.aborted) return { stopReason: "cancelled" };

        const outcome = await runModelRequest(session, notify, abort.signal);
        if (outcome.kind === "cancelled") return { stopReason: "cancelled" };
        if (outcome.kind === "text") {
          stopReason = "end_turn";
          break;
        }

        const results = await runToolCalls(
          outcome.calls,
          session,
          notify,
          abort.signal,
          capabilities,
          ctx.client,
        );
        if (results === "cancelled") return { stopReason: "cancelled" };
      }

      if (abort.signal.aborted) return { stopReason: "cancelled" };

      await notify({
        sessionUpdate: "plan",
        entries: [{ content: "Handle the user request", priority: "medium", status: "completed" }],
      });

      return { stopReason };
    } catch (error) {
      process.stderr.write(
        `${AGENT_TITLE}: prompt error session=${session.id}: ${(error as Error).message}\n`,
      );

      await notify({
        sessionUpdate: "plan",
        entries: [
          {
            content: "Handle the user request",
            priority: "medium",
            status: "in_progress",
          },
        ],
      });
      if (capabilities?.session?.notices) {
        await notify({
          sessionUpdate: "notice",
          severity: "error",
          title: "Turn failed",
          description: (error as Error).message,
        });
      }
      if (abort.signal.aborted) return { stopReason: "cancelled" };
      throw toRequestError(error);
    } finally {
      session.abort = null;
      ctx.signal.removeEventListener("abort", forwardAbort);
      process.stderr.write(`${AGENT_TITLE}: prompt finished session=${session.id}\n`);
      // Persist after every turn, including cancelled and failed ones, so a
      // restart never rewinds a thread to an earlier point.
      if (!session.deleted) await persist(session);
    }
  });

  return app;

  /* ---------------------------------------------------------------- *
   * Turn internals
   * ---------------------------------------------------------------- */

  /**
   * Writes a session back to disk.
   *
   * A failure is reported rather than thrown: losing a transcript is bad, but
   * failing a live turn because a cache write did not land is worse.
   */
  async function persist(session: SessionState): Promise<void> {
    const record: PersistedSession = {
      id: session.id,
      cwd: session.cwd,
      roots: session.roots,
      model: session.model,
      title: session.title,
      reasoningLevel: session.reasoningLevel,
      mode: session.mode,
      allowedTools: [...session.allowedTools],
      messageCounter: session.messageCounter,
      lastPromptTokens: session.lastPromptTokens,
      history: session.history,
    };

    try {
      await store.save(record);
    } catch (error) {
      process.stderr.write(
        `${AGENT_TITLE}: could not persist session ${session.id}: ${(error as Error).message}\n`,
      );
    }
  }

  /**
   * Summarises a transcript that has grown past the configured threshold.
   *
   * The replacement keeps the session's system message and adds one assistant
   * message holding the summary. Assistant rather than user so role
   * alternation stays natural for the turn that follows.
   *
   * A failure is never fatal: the turn proceeds with the full history, which
   * is slower but correct.
   */
  async function maybeCompact(
    session: SessionState,
    notify: Notifier,
    signal: AbortSignal,
    capabilities: ClientCapabilities | null,
  ): Promise<void> {
    if (
      !shouldCompact({
        threshold: config.compactionThresholdTokens,
        lastPromptTokens: session.lastPromptTokens,
        historyLength: session.history.length,
      })
    ) {
      return;
    }

    process.stderr.write(
      `${AGENT_TITLE}: compacting session=${session.id} lastPromptTokens=${session.lastPromptTokens} ` +
        `threshold=${config.compactionThresholdTokens}\n`,
    );
    // Below this there is no conversation worth summarising, and a provider
    // reporting an implausible count must not cost a wasted model request.
    if (session.history.length < 3) return;

    // The spec forbids these updates unless the client asked for them.
    const reportable = Boolean(capabilities?.session?.compaction);
    const compactionId = `comp_${session.id}_${session.messageCounter}`;

    if (reportable) {
      await notify({ sessionUpdate: "compaction_update", compactionId, status: "in_progress" });
    }

    try {
      const summary = await summarizeTranscript({
  history: session.history,
  model: session.model,
  llm: llm as import("../llm.js").PollinationsLlm,
  signal,
});
      if (signal.aborted || !summary) throw new Error("compaction produced no summary");

      session.history = [
        session.history[0] as LlmMessage,
        { role: "assistant", content: summary, reasoning_content: "" },
      ];
      session.lastPromptTokens = 0;
      await persist(session);

      if (reportable) {
        await notify({
          sessionUpdate: "compaction_update",
          compactionId,
          status: "completed",
          summary: [{ type: "text", text: summary }],
        });
      }
    } catch (error) {
      process.stderr.write(
        `${AGENT_TITLE}: compaction failed session=${session.id}: ${(error as Error).message}\n`,
      );
      if (capabilities?.session?.notices) {
        await notify({
          sessionUpdate: "notice",
          severity: "warning",
          title: "Compaction failed",
          description: (error as Error).message,
        });
      }
      if (reportable) {
        await notify({
          sessionUpdate: "compaction_update",
          compactionId,
          status: signal.aborted ? "cancelled" : "failed",
          ...(signal.aborted ? {} : { error: (error as Error).message }),
        });
      }
      // Resetting to 0 stops a failed compaction from being retried on every
      // subsequent turn; the current turn's usage report re-arms the threshold.
      session.lastPromptTokens = 0;
    }
  }

    async function replayUserPrompt(
    prompt: ContentBlock[],
    notify: Notifier,
    session: SessionState,
  ): Promise<void> {
    const text = promptToText(prompt);
    const messageId = nextMessageId(session);
    session.history.push({ role: "user", content: text });

    await notify({
      sessionUpdate: "user_message_chunk",
      messageId,
      content: { type: "text", text },
    });
  }

  type ModelOutcome =
    | { kind: "text" }
    | { kind: "cancelled" }
    | { kind: "tools"; calls: Array<{ index: number; call: LlmToolCall }> };

  /** One streaming model request; forwards deltas as ACP session updates. */
  async function runModelRequest(
    session: SessionState,
    notify: Notifier,
    signal: AbortSignal,
  ): Promise<ModelOutcome> {
    const messageId = nextMessageId(session);
    let text = "";
    let reasoning = "";
    let usage: LlmUsage | undefined;

    const pendingCalls = new Map<number, { id: string; name: string; arguments: string }>();
    const tools = [...LLM_TOOLS, ...session.mcpToolDefinitions];
    const iterator = (llm as PollinationsLlm).chat({
      messages: session.history,
      tools,
      model: session.model,
      signal,
    });

    let step = await iterator.next();
    while (!step.done) {
      const chunk = step.value;

      if (chunk.reasoning) {
        reasoning += chunk.reasoning;
        await notify({
          sessionUpdate: "agent_thought_chunk",
          messageId,
          content: { type: "text", text: chunk.reasoning },
        });
      }
      if (chunk.text) {
        text += chunk.text;
        await notify({
          sessionUpdate: "agent_message_chunk",
          messageId,
          content: { type: "text", text: chunk.text },
        });
      }
      for (const delta of chunk.toolCalls ?? []) {
        const accumulated = pendingCalls.get(delta.index) ?? { id: "", name: "", arguments: "" };
        if (delta.id) accumulated.id = delta.id;
        if (delta.name) accumulated.name = delta.name;
        if (delta.arguments) accumulated.arguments += delta.arguments;
        pendingCalls.set(delta.index, accumulated);
      }

      step = await iterator.next();
    }
    usage = step.value;

    // The provider's own token count is what decides when to compact, so the
    // threshold is measured rather than estimated.
    if (usage?.promptTokens) session.lastPromptTokens = usage.promptTokens;

    if (usage) {
      const models = await modelCatalog();
      const info = models.find((model) => model.id === session.model);
      // Free models publish no price (or an explicit 0/0): their cost is 0.
      // Only genuinely unstated prices on non-free models stay "unknown".
      const promptPrice =
        info?.promptPrice ?? (info?.group.endsWith("-free") ? 0 : null);
      const completionPrice =
        info?.completionPrice ?? (info?.group.endsWith("-free") ? 0 : null);
      const incrementalCost =
        promptPrice !== null && completionPrice !== null
          ? usage.promptTokens * promptPrice + usage.completionTokens * completionPrice
          : null;
      if (incrementalCost !== null) session.costSoFar += incrementalCost;

      process.stderr.write(
        `${AGENT_TITLE}: usage session=${session.id} model=${session.model} ` +
          `prompt=${usage.promptTokens} completion=${usage.completionTokens} ` +
          `cost=${incrementalCost === null ? "unknown" : incrementalCost.toFixed(6)} pollen ` +
          `(session total ${session.costSoFar.toFixed(6)})\n`,
      );

      // Report context usage and cumulative cost to clients that render them.
      process.stderr.write(
        `${AGENT_TITLE}: sending usage_update session=${session.id} used=${usage.promptTokens} ` +
          `size=${info?.contextLength ?? 0} cost=${session.costSoFar.toFixed(6)}\n`,
      );

      await notify({
        sessionUpdate: "usage_update",
        used: usage.promptTokens,
        size: info?.contextLength ?? 128_000,
        cost: { amount: session.costSoFar, currency: "USD" },
      });
    }

    process.stderr.write(
      `${AGENT_TITLE}: model request session=${session.id} model=${session.model} ` +
        `toolCalls=${pendingCalls.size} promptTokens=${usage?.promptTokens ?? 0}\n`,
    );

    if (signal.aborted) return { kind: "cancelled" };

    const calls = [...pendingCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, value]) => ({
        index,
        call: {
          id: value.id || `call_${index}_${randomBytes(3).toString("hex")}`,
          type: "function" as const,
          function: { name: value.name, arguments: value.arguments || "{}" },
        },
      }));

    const assistantMessage: LlmMessage = { role: "assistant", content: text || null };
    assistantMessage.reasoning_content = reasoning;
    if (calls.length > 0) assistantMessage.tool_calls = calls.map(({ call }) => call);
    session.history.push(assistantMessage);

    if (calls.length === 0) return { kind: "text" };
    return { kind: "tools", calls };
  }

  /** Executes every tool call the model asked for, in order. */
  async function runToolCalls(
    calls: Array<{ index: number; call: LlmToolCall }>,
    session: SessionState,
    notify: Notifier,
    signal: AbortSignal,
    capabilities: ClientCapabilities | null,
    client: AgentContext,
  ): Promise<"ok" | "cancelled"> {
    for (const { call } of calls) {
      if (signal.aborted) return "cancelled";

      const definition = TOOL_DEFINITIONS[call.function.name as ToolName];
      const mcpBinding = session.mcpTools.get(call.function.name);
      const kind: ToolKind = mcpBinding?.kind ?? definition?.kind ?? "other";

      let input: Record<string, unknown> = {};
      let parseError: string | null = null;
      try {
        const parsed: unknown = JSON.parse(call.function.arguments || "{}");
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          input = parsed as Record<string, unknown>;
        } else {
          parseError = "Tool arguments must be a JSON object";
        }
      } catch (error) {
        parseError = `Invalid tool arguments: ${(error as Error).message}`;
      }

      const title = parseError
        ? `Call ${call.function.name}`
        : (mcpBinding?.title(input) ?? definition?.title(input) ?? call.function.name);

      await notify({
        sessionUpdate: "tool_call",
        toolCallId: call.id,
        title,
        name: call.function.name,
        kind,
        status: "pending",
        rawInput: input,
      });

      let result: ToolExecutionResult;
      if (parseError) {
        result = { output: parseError, isError: true };
      } else {
        await notify({
          sessionUpdate: "tool_call_update",
          toolCallId: call.id,
          status: "in_progress",
        });

        if (signal.aborted) {
          await notify({
            sessionUpdate: "tool_call_update",
            toolCallId: call.id,
            status: "failed",
          });
          return "cancelled";
        }

        // The permission gate lives in `executeTool`, which knows which tools
        // are mutating; `approve` routes its question back to the client.
        const toolContext: ToolContext = {
          sessionId: session.id,
          cwd: session.cwd,
          roots: session.roots,
          mode: session.mode,
          client,
          clientCapabilities: capabilities,
          signal,
          mcpTools: session.mcpTools,
          approve: ({ name, kind, title, rawInput }) =>
            requestPermission({
              client,
              session,
              toolCallId: call.id,
              title,
              name,
              kind,
              input: (rawInput ?? {}) as Record<string, unknown>,
            }),
        };
        result = await executeTool(call.function.name, input, toolContext);
      }

      process.stderr.write(
        `${AGENT_TITLE}: tool ${call.function.name} session=${session.id} ` +
          `status=${result.isError ? "failed" : "completed"}\n`,
      );

      await notify({
        sessionUpdate: "tool_call_update",
        toolCallId: call.id,
        status: result.isError ? "failed" : "completed",
        content: toToolCallContent(result),
        ...(result.locations ? { locations: result.locations } : {}),
        rawOutput: result.output,
      });

      session.history.push({
        role: "tool",
        tool_call_id: call.id,
        content: result.output,
      });
    }

    return signal.aborted ? "cancelled" : "ok";
  }

  /** Asks the client for permission on a mutating tool call. */
  async function requestPermission(params: {
    client: AgentContext;
    session: SessionState;
    toolCallId: string;
    title: string;
    name: string;
    kind: ToolKind;
    input: Record<string, unknown>;
  }): Promise<boolean> {
    const { session, name } = params;
    if (config.permissionMode === "allow") return true;
    if (session.allowedTools.has(name as ToolName)) return true;

    try {
      const response = await params.client.request(methods.client.session.requestPermission, {
        sessionId: session.id,
        toolCall: {
          toolCallId: params.toolCallId,
          title: params.title,
          name: params.name,
          kind: params.kind,
          status: "pending",
          rawInput: params.input,
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow-always", name: `Allow ${name} for this session`, kind: "allow_always" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      });

      if (response.outcome.outcome !== "selected") return false;
      const optionId = response.outcome.optionId;
      const kind = ["allow-once", "allow-always"].includes(optionId);
      if (optionId === "allow-always") session.allowedTools.add(name as ToolName);
      return kind;
    } catch {
      // A client that does not implement the method cannot grant permission.
      return false;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

type Notifier = ReturnType<typeof createNotifier>;

function nextMessageId(session: SessionState): string {
  session.messageCounter += 1;
  return `msg_${session.id}_${session.messageCounter}`;
}

function toToolCallContent(result: ToolExecutionResult): ToolCallContent[] {
  const content: ToolCallContent[] = [];

  if (result.diff) {
    content.push({
      type: "diff",
      path: result.diff.path,
      oldText: result.diff.oldText ?? null,
      newText: result.diff.newText,
    });
  }
  if (result.terminalId) content.push({ type: "terminal", terminalId: result.terminalId });
  content.push({ type: "content", content: { type: "text", text: result.output } });

  return content;
}

function buildReasoningOption(current: string): SessionConfigOption {
  return {
    type: "select",
    id: REASONING_CONFIG_ID,
    name: "Reasoning",
    description: "Reasoning effort used by the model",
    category: "thought_level",
    currentValue: current,
    options: REASONING_LEVELS.map((level) => ({
      value: level.value,
      name: level.name,
    })),
  };
}

function toRequestError(error: unknown): RequestError {
  if (error instanceof RequestError) return error;
  if (error instanceof LlmError) {
    return RequestError.internalError({ status: error.status }, error.message);
  }
  if (error instanceof ToolError) return RequestError.internalError(undefined, (error as ToolError).message);
  if (error instanceof Error && error.name === "AbortError") {
    return RequestError.requestCancelled();
  }
  return RequestError.internalError(
    undefined,
    error instanceof Error ? error.message : String(error),
  );
}
