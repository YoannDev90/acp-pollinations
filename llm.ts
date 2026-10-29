import { DEFAULT_MODEL } from "./config.js";
import { createSseParser } from "./sse.js";

export type LlmRole = "system" | "user" | "assistant" | "tool";

/** A tool call requested by the model, in OpenAI Chat Completions shape. */
export type LlmToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

/** One message of the conversation sent to the model. */
export type LlmMessage = {
  role: LlmRole;
  content: string | null;
  tool_calls?: LlmToolCall[];
  /** Required on `tool` messages so the model can match results to calls. */
  tool_call_id?: string;
};

/** OpenAI-style function tool definition. */
export type LlmToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type LlmUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

/** One incremental piece of a streamed assistant response. */
export type LlmChunk = {
  /** Assistant text delta. */
  text?: string;
  /** Reasoning/thinking delta, when the model emits one. */
  reasoning?: string;
  /** Tool call deltas, keyed by their `index` as sent by the provider. */
  toolCalls?: Array<{ index: number; id?: string; name?: string; arguments?: string }>;
  usage?: LlmUsage;
};

export type LlmChatParams = {
  messages: LlmMessage[];
  tools?: LlmToolDefinition[];
  /**
   * Model for this request only, overriding the client's default. The agent
   * uses it to honour per-session model switches from the ACP model picker.
   */
  model?: string;
  signal?: AbortSignal;
};

export type PollinationsLlmOptions = {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /** Injected for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. Defaults to 10 minutes (tool turns can be slow). */
  timeoutMs?: number;
};

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/**
 * Streaming client for the Pollinations OpenAI-compatible chat completions
 * endpoint (`POST /v1/chat/completions`).
 */
export class PollinationsLlm {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: PollinationsLlmOptions) {
    if (!options.apiKey) throw new LlmError("A Pollinations API key is required");
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://gen.pollinations.ai").replace(/\/+$/, "");
    this.model = options.model ?? DEFAULT_MODEL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 600_000;
  }

  /** Model used for requests, useful for logging and `agentInfo`. */
  get modelName(): string {
    return this.model;
  }

  /**
   * Streams one assistant turn. Yields text, reasoning, and tool-call deltas;
   * resolves with the accumulated usage once the stream ends.
   */
  async *chat(params: LlmChatParams): AsyncGenerator<LlmChunk, LlmUsage> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    params.signal?.addEventListener("abort", onAbort, { once: true });

    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const body: Record<string, unknown> = {
        model: params.model ?? this.model,
        messages: params.messages,
        stream: true,
      };
      if (params.tools && params.tools.length > 0) body.tools = params.tools;

      const response = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw new LlmError(
          `Pollinations request failed (${response.status} ${response.statusText})${describePollinationsError(errorBody)}`,
          response.status,
          errorBody,
        );
      }
      if (!response.body) throw new LlmError("Pollinations returned an empty response body");

      let usage: LlmUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      const parser = createSseParser();
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;

        for (const event of parser.push(value)) {
          if (event.data.trim() === "[DONE]") continue;

          let payload: StreamPayload;
          try {
            payload = JSON.parse(event.data) as StreamPayload;
          } catch {
            // Tolerate keep-alives and non-JSON frames from proxies.
            continue;
          }

          if (payload.usage) usage = normalizeUsage(payload.usage);

          const delta = payload.choices?.[0]?.delta;
          if (!delta) continue;

          const chunk: LlmChunk = {};
          if (delta.content) chunk.text = delta.content;
          if (delta.reasoning) chunk.reasoning = delta.reasoning;
          if (delta.tool_calls) {
            chunk.toolCalls = delta.tool_calls.map((call) => ({
              index: call.index ?? 0,
              ...(call.id !== undefined ? { id: call.id } : {}),
              ...(call.function?.name !== undefined ? { name: call.function.name } : {}),
              ...(call.function?.arguments !== undefined ? { arguments: call.function.arguments } : {}),
            }));
          }
          if (chunk.text || chunk.reasoning || chunk.toolCalls) yield chunk;
        }
      }

      for (const event of parser.flush()) {
        if (event.data.trim() === "[DONE]") continue;
        try {
          const payload = JSON.parse(event.data) as StreamPayload;
          if (payload.usage) usage = normalizeUsage(payload.usage);
          const delta = payload.choices?.[0]?.delta;
          if (delta?.content) yield { text: delta.content };
        } catch {
          // Ignore an unparsable trailing frame.
        }
      }

      return usage;
    } finally {
      clearTimeout(timeout);
      params.signal?.removeEventListener("abort", onAbort);
    }
  }
}

type StreamPayload = {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
};

function normalizeUsage(raw: NonNullable<StreamPayload["usage"]>): LlmUsage {
  const promptTokens = raw.prompt_tokens ?? 0;
  const completionTokens = raw.completion_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: raw.total_tokens ?? promptTokens + completionTokens,
  };
}

/** Turns an error response body into a human-readable suffix. */
function describePollinationsError(body: string): string {
  if (!body) return "";
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string };
    const message = typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
    return message ? `: ${message}` : "";
  } catch {
    const trimmed = body.trim().slice(0, 200);
    return trimmed ? `: ${trimmed}` : "";
  }
}
