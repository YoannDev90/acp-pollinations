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
  PromptResponse,
  ToolCallContent,
  ToolKind,
} from "@agentclientprotocol/sdk";

import type { AgentConfig } from "./config.js";
import { LlmError, PollinationsLlm } from "./llm.js";
import type { LlmMessage, LlmToolCall, LlmUsage } from "./llm.js";
import {
  FALLBACK_MODELS,
  MODEL_CONFIG_ID,
  MODEL_CATALOG_TTL_MS,
  buildModelOption,
  fetchModelCatalog,
  isKnownModel,
} from "./models.js";
import type { CatalogModel } from "./models.js";
import { createSessionStore } from "./sessions.js";
import type { PersistedSession } from "./sessions.js";
import { LLM_TOOLS, TOOL_DEFINITIONS, ToolError, executeTool } from "./tools.js";
import type { ToolContext, ToolExecutionResult, ToolName } from "./tools.js";
import {
  connectMcpServers,
  mergeMcpBindings,
  type McpConnection,
  type McpToolBinding,
} from "./mcp.js";

export const AGENT_NAME = "pollinations";
export const AGENT_TITLE = "Pollinations";
export const AGENT_VERSION = "1.0.0";

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

type SessionState = {
  id: string;
  cwd: string;
  roots: string[];
  history: LlmMessage[];
  /** Model chosen through the ACP model picker, or the configured default. */
  model: string;
  /** Tools permanently allowed via an `allow_always` permission outcome. */
  allowedTools: Set<ToolName>;
  /** Aborts the in-flight prompt turn when the client cancels. */
  abort: AbortController | null;
  messageCounter: number;
  /** Prompt tokens of the last model request, as reported by the provider. */
  lastPromptTokens: number;
  /** Live MCP connections for this session. */
  mcpConnections: McpConnection[];
  /** MCP tool bindings keyed by the name exposed to the model. */
  mcpTools: Map<string, McpToolBinding>;
  /** OpenAI tool definitions for the MCP tools, appended to the builtin set. */
  mcpToolDefinitions: import("./llm.js").LlmToolDefinition[];
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
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities: { list: {}, delete: {} },
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
    const session: SessionState = {
      id: sessionId,
      cwd: roots[0] as string,
      roots,
      history: [systemMessage(roots[0] as string)],
      model,
      allowedTools: new Set(),
      abort: null,
      messageCounter: 0,
      lastPromptTokens: 0,
      mcpConnections: [],
      mcpTools: new Map(),
      mcpToolDefinitions: [],
    };
    sessions.set(sessionId, session);

    // Connect to any MCP servers the client supplied. A failure here degrades
    // to "no tools from that server" rather than failing session setup.
    const connections = await connectMcpServers(ctx.params.mcpServers ?? []);
    session.mcpConnections = connections;
    const merged = mergeMcpBindings(connections);
    session.mcpTools = merged.bindings;
    session.mcpToolDefinitions = merged.definitions;

    await persist(session);

    // The picker is what lets the client switch models mid-session.
    return { sessionId, configOptions: [buildModelOption(await modelCatalog(), model)] };
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
    if (live) return { configOptions: [buildModelOption(await modelCatalog(), live.model)] };

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
    const session: SessionState = {
      id: sessionId,
      cwd: root,
      roots: loadedRoots,
      history: rebaseHistory(stored.history, root, stored.cwd),
      model: stored.model,
      allowedTools: new Set(stored.allowedTools as ToolName[]),
      abort: null,
      messageCounter: stored.messageCounter,
      lastPromptTokens: stored.lastPromptTokens,
      mcpConnections: [],
      mcpTools: new Map(),
      mcpToolDefinitions: [],
    };
    sessions.set(sessionId, session);

    const connections = await connectMcpServers(ctx.params.mcpServers ?? []);
    session.mcpConnections = connections;
    const merged = mergeMcpBindings(connections);
    session.mcpTools = merged.bindings;
    session.mcpToolDefinitions = merged.definitions;

    return { configOptions: [buildModelOption(await modelCatalog(), session.model)] };
  });

  /* ---------------------------------------------------------------- *
   * Session listing and deletion
   * ---------------------------------------------------------------- */

  app.onRequest(methods.agent.session.list, async (ctx) => {
    const { sessions: page, nextCursor } = await store.list({
      ...(ctx.params.cwd ? { cwd: ctx.params.cwd } : {}),
      ...(ctx.params.cursor ? { cursor: ctx.params.cursor } : {}),
    });

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

  app.onRequest(methods.agent.session.delete, async (ctx) => {
    const { sessionId } = ctx.params;
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
    if (configId !== MODEL_CONFIG_ID) {
      throw RequestError.invalidParams(
        { configId, value },
        `Unknown config option "${configId}". This agent only exposes "${MODEL_CONFIG_ID}".`,
      );
    }
    if (typeof value !== "string" || value.length === 0) {
      throw RequestError.invalidParams(
        { configId, value },
        `"${MODEL_CONFIG_ID}" takes a model id string.`,
      );
    }

    const models = await modelCatalog();
    // The session's own model is always rendered in the picker — `buildModelOption`
    // injects it when the catalogue does not list it — so it stays re-selectable.
    if (!isKnownModel(models, value) && value !== session.model) {
      throw RequestError.invalidParams(
        { configId, value, available: models.map((model) => model.id) },
        `Unknown model "${value}". Pick one of the ${models.length} models offered by "${MODEL_CONFIG_ID}".`,
      );
    }

    session.model = value;
    await persist(session);
    // The response must carry the full, current option set.
    return { configOptions: [buildModelOption(models, value)] };
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
      // Compact before the user's turn, not after it: the expensive request is
      // the one about to happen, so trimming first is what actually pays off.
      await maybeCompact(session, notify, abort.signal, capabilities);

      await replayUserPrompt(ctx.params.prompt, notify, session);

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
      return { stopReason };
    } catch (error) {
      if (abort.signal.aborted) return { stopReason: "cancelled" };
      throw toRequestError(error);
    } finally {
      session.abort = null;
      ctx.signal.removeEventListener("abort", forwardAbort);
      // Persist after every turn, including cancelled and failed ones, so a
      // restart never rewinds a thread to an earlier point.
      await persist(session);
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
   * Rebuilds the leading system message when the workspace changed.
   *
   * That message names the working directory, so a thread reopened from a
   * moved project would otherwise keep telling the model it works somewhere it
   * does not, and the path guard would reject everything it tries to touch.
   */
  function rebaseHistory(
    history: LlmMessage[],
    cwd: string,
    previousCwd: string,
  ): LlmMessage[] {
    const hasSystem = history[0]?.role === "system";
    if (hasSystem && previousCwd === cwd) return history;
    return [systemMessage(cwd), ...(hasSystem ? history.slice(1) : history)];
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
    if (config.compactionThresholdTokens <= 0) return;
    if (session.lastPromptTokens < config.compactionThresholdTokens) return;
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
      const summary = await summarize(session, signal);
      if (signal.aborted || !summary) throw new Error("compaction produced no summary");

      session.history = [
        session.history[0] as LlmMessage,
        { role: "assistant", content: summary },
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

  /** Asks the model to condense the transcript into a continuation brief. */
  async function summarize(session: SessionState, signal: AbortSignal): Promise<string> {
    const request: LlmMessage[] = [
      ...session.history,
      {
        role: "user",
        content: [
          "Summarise the conversation above so the work can continue without it.",
          "Cover the goal, the decisions taken, the files changed, the results",
          "observed, and anything left unfinished. Stay under 300 words, and do",
          "not mention this instruction.",
        ].join("\n"),
      },
    ];

    let text = "";
    // No tools: a summarising request must never trigger real work.
    const iterator = (llm as PollinationsLlm).chat({ messages: request, model: session.model, signal });
    for (;;) {
      const { done, value } = await iterator.next();
      if (done) break;
      if (value.text) text += value.text;
    }

    return text.trim();
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

type Notifier = (update: import("@agentclientprotocol/sdk").SessionUpdate) => Promise<void>;

/** Fire-and-forget `session/update` sender that never fails the turn. */
function createNotifier(client: AgentContext, sessionId: string): Notifier {
  return async (update) => {
    try {
      await client.notify(methods.client.session.update, { sessionId, update });
    } catch {
      // The client disappeared mid-turn; the abort signal handles the rest.
    }
  };
}

function nextMessageId(session: SessionState): string {
  session.messageCounter += 1;
  return `msg_${session.id}_${session.messageCounter}`;
}

/** Renders the prompt's content blocks as one text message for the model. */
export function promptToText(blocks: ContentBlock[]): string {
  const parts: string[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "resource":
        parts.push(
          `--- ${block.resource.uri} ---\n` +
            ("text" in block.resource ? block.resource.text : "(binary resource)"),
        );
        break;
      case "resource_link":
        parts.push(`--- ${block.uri} (${block.name}) ---`);
        break;
      default:
        parts.push(`[${block.type} content is not supported by this agent]`);
    }
  }

  return parts.join("\n\n").trim() || "(empty prompt)";
}

function systemMessage(cwd: string): LlmMessage {
  return {
    role: "system",
    content: [
      "You are Pollinations, a coding agent running inside the user's editor over the Agent Client Protocol.",
      `The session workspace is \`${cwd}\`. Every path you touch must stay inside it.`,
      "",
      "How to work:",
      "- Explore before you edit: list the directory or read a file instead of guessing its contents.",
      "- Prefer `edit_file` for small changes and `write_file` for new or fully rewritten files.",
      "- Use `bash` to build, lint, and test; check the exit code before claiming success.",
      "- Keep answers short and in the user's language. Use Markdown for anything longer than two sentences.",
      "- Never invent file paths, APIs, or results you did not observe.",
    ].join("\n"),
  };
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

function toRequestError(error: unknown): RequestError {
  if (error instanceof RequestError) return error;
  if (error instanceof LlmError) {
    return RequestError.internalError({ status: error.status }, error.message);
  }
  if (error instanceof ToolError) return RequestError.internalError(undefined, error.message);
  if (error instanceof Error && error.name === "AbortError") {
    return RequestError.requestCancelled();
  }
  return RequestError.internalError(
    undefined,
    error instanceof Error ? error.message : String(error),
  );
}

/** Identifies the connection a request arrived on, for per-connection state. */
const connectionIds = new WeakMap<object, string>();
let connectionCounter = 0;

/**
 * Keys state that `initialize` supplies and later requests must read back.
 *
 * The client capabilities are one example: they are sent once per connection,
 * but every request handler that needs them receives a *different*
 * `AgentContext` instance, so object identity on the context itself never
 * matches. What is stable for a connection is its internal connection context —
 * the same value the SDK's own `AcpContext[connectionContextOf]()` returns,
 * which is documented as identifying the connection. That helper is not
 * exported, so the field it wraps is read directly.
 *
 * If a future SDK stops exposing it, `cx` is absent, the key degrades to the
 * context object itself and never matches — the capabilities come back `null`,
 * which is the behaviour this function exists to move away from, rather than a
 * crash.
 */
function connectionKey(client: AgentContext): string {
  // Identify the connection behind an ACP context. The SDK keeps it behind a
  // symbol-keyed method; find that symbol instead of hard-coding `cx`, so a
  // renamed field does not silently break capability lookup.
  let identity: object = client as object;
  try {
    const symbol = [
      ...Object.getOwnPropertySymbols(client),
      ...Object.getOwnPropertySymbols(Object.getPrototypeOf(client) ?? {}),
    ].find((candidate) => candidate.toString().includes("connectionContextOf"));
    if (symbol) {
      const context = (client as unknown as Record<symbol, () => unknown>)[symbol];
      if (typeof context === "function") identity = context.call(client) as object;
    } else {
      identity = ((client as unknown as { cx?: unknown }).cx ?? client) as object;
    }
  } catch {
    identity = ((client as unknown as { cx?: unknown }).cx ?? client) as object;
  }

  let key = connectionIds.get(identity);
  if (!key) {
    key = `conn_${(connectionCounter += 1)}`;
    connectionIds.set(identity, key);
  }
  return key;
}
