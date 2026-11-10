import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** One scripted assistant turn served by the fake Pollinations endpoint. */
export type FakeTurn = {
  /** Text streamed back to the agent, split across several SSE frames. */
  text?: string;
  /** Tool calls streamed back to the agent, with split argument deltas. */
  toolCalls?: Array<{ name: string; arguments: string; id?: string }>;
  /** Reasoning frames emitted before the content. */
  reasoning?: string;
  /** Extra usage numbers reported in the final frame. */
  usage?: { prompt_tokens: number; completion_tokens: number };
  /** Verbatim frames, when a test needs to bypass the normal encoder. */
  rawFrames?: string[];
  /** Delay between frames, so a test can observe or cancel a long turn. */
  stallMs?: number;
};

export type RecordedRequest = {
  model: string;
  messages: Array<Record<string, unknown>>;
  tools?: Array<{ function: { name: string } }>;
  stream: boolean;
  authorization?: string;
  /** Present when the agent asked the model for a reasoning depth. */
  reasoning_effort?: string;
};

export type FakeLlmServer = {
  /** Base URL to pass as `POLLINATIONS_BASE_URL`. */
  baseUrl: string;
  /** Every request the agent made, in order. */
  requests: RecordedRequest[];
  /** Number of chat-completion calls served so far. */
  readonly callCount: number;
  /** Number of `GET /v1/models` requests served so far. */
  readonly modelRequests: number;
  close: () => Promise<void>;
};

export type FakeLlmOptions = {
  /** When set, every chat-completion call fails with this status and body. */
  failWith?: { status: number; body: string };
  /**
   * When set, only the first chat-completion call fails. Used to exercise a
   * client that corrects its request and sends it again.
   */
  failOnceWith?: { status: number; body: string };
  /** Raw body served from `GET /v1/models`. Defaults to a small catalogue. */
  modelsPayload?: unknown;
  /**
   * When set, `GET /v1/models` fails instead, to exercise the offline path.
   * `times` limits the failure to the first N requests, so a client that
   * retries can be seen recovering.
   */
  failModelsWith?: { status: number; body: string; times?: number };
  /**
   * Delay before `GET /v1/models` is answered.
   *
   * The catalogue read is the only thing a turn waits on once the stream has
   * ended, so stretching it widens the window in which a cancel lands after
   * the model has answered but before the turn reports its stop reason.
   */
  modelsDelayMs?: number;
  /**
   * Picks the turn from the request itself, overriding `turns`. Needed when one
   * server has to answer prompts it cannot tell apart in advance: the
   * conformance harness stalls only the cancellation prompt, and has no way to
   * know which slot in a positional script that prompt would land in.
   */
  turnFor?: (request: RecordedRequest, index: number) => FakeTurn;
};

/**
 * A tiny `/v1/models` catalogue: enough to exercise the model picker without a
 * network. Two official quest models — one priced, one with amounts missing —
 * a community model published as explicitly free, plus one tool-less model to
 * prove the filter and one image model to prove the category filter.
 */
export const FAKE_MODELS_PAYLOAD = {
  object: "list",
  data: [
    {
      id: "official/quest-a",
      title: "Quest A",
      category: "text",
      community: false,
      paid_only: false,
      tools: true,
      context_length: 200_000,
      pricing: { currency: "pollen", promptTextTokens: "0.0000001", completionTextTokens: "0.0000004" },
      health: { status: "healthy", success_rate: 99, requests: 100 },
    },
    {
      id: "official/paid-b",
      title: "Paid B",
      category: "text",
      community: false,
      paid_only: true,
      tools: true,
      context_length: 1_000_000,
      pricing: { currency: "pollen", promptTextTokens: "0.000002", completionTextTokens: "0.00001" },
      health: { status: "healthy", success_rate: 100, requests: 50 },
    },
    {
      id: "official/unpriced-d",
      title: "Unpriced D",
      description: "Text prices not published",
      category: "text",
      community: false,
      paid_only: false,
      tools: true,
      context_length: 128_000,
      pricing: { currency: "pollen" },
      health: { status: "healthy", success_rate: 95, requests: 80 },
    },
    {
      id: "community/free-c:free",
      title: "Free C",
      description: "Zero-cost community model",
      category: "text",
      community: true,
      paid_only: false,
      tools: true,
      context_length: 131_072,
      pricing: { currency: "pollen", promptTextTokens: "0", completionTextTokens: "0" },
      health: { status: "degraded", success_rate: 82, requests: 50 },
    },
    {
      id: "official/no-tools",
      title: "No Tools",
      category: "text",
      community: false,
      paid_only: false,
      tools: false,
      pricing: { currency: "pollen" },
    },
    {
      id: "official/an-image-model",
      title: "Image Model",
      category: "image",
      community: false,
      paid_only: false,
      tools: true,
      pricing: { currency: "pollen" },
    },
  ],
};

/**
 * Minimal stand-in for `POST /v1/chat/completions` that streams scripted
 * turns as Server-Sent Events.
 *
 * It exists so the agent can be tested end to end without a network, an API
 * key, or a spend. Turns are consumed one per request, which matches how a
 * prompt turn makes sequential model requests.
 */
export async function startFakeLlmServer(
  turns: FakeTurn[],
  options: FakeLlmOptions = {},
): Promise<FakeLlmServer> {
  const requests: RecordedRequest[] = [];
  let cursor = 0;
  let failedOnce = false;
  let modelRequests = 0;

  const server = createServer((req, res) => {
    // A scripted outage of the catalogue endpoint, independent of `failWith`,
    // which only governs chat completions below.
    if (req.method === "GET" && req.url?.includes("/v1/models")) {
      modelRequests += 1;
      const failure = options.failModelsWith;
      if (failure && (failure.times === undefined || modelRequests <= failure.times)) {
        res.writeHead(failure.status, {
          "Content-Type": "application/json",
        });
        res.end(failure.body);
        return;
      }
      const answer = () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(options.modelsPayload ?? FAKE_MODELS_PAYLOAD));
      };
      if (options.modelsDelayMs) setTimeout(answer, options.modelsDelayMs);
      else answer();
      return;
    }

    if (req.method !== "POST" || !req.url?.includes("/v1/chat/completions")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: `Unexpected request: ${req.method} ${req.url}` } }));
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body: RecordedRequest;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RecordedRequest;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid JSON" } }));
        return;
      }
      body.authorization = req.headers.authorization;
      requests.push(body);

      if (options.failWith) {
        res.writeHead(options.failWith.status, { "Content-Type": "application/json" });
        res.end(options.failWith.body);
        return;
      }

      if (options.failOnceWith && !failedOnce) {
        failedOnce = true;
        res.writeHead(options.failOnceWith.status, { "Content-Type": "application/json" });
        res.end(options.failOnceWith.body);
        return;
      }

      const turn =
        options.turnFor?.(body, cursor) ??
        turns[Math.min(cursor, Math.max(0, turns.length - 1))] ??
        {};
      cursor += 1;

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      // Frames are spread over the event loop so the agent really does receive
      // an incremental stream rather than one buffered blob.
      let index = 0;
      const frames = framesFor(turn);
      const stallMs = turn.stallMs ?? 1;

      const pump = () => {
        if (res.destroyed || res.writableEnded) return;
        if (index >= frames.length) {
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.write(frames[index]);
        index += 1;
        setTimeout(pump, stallMs);
      };
      pump();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    get callCount() {
      return cursor;
    },
    get modelRequests() {
      return modelRequests;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** Turns one scripted response into the SSE frames that carry it. */
function framesFor(turn: FakeTurn): string[] {
  if (turn.rawFrames) return turn.rawFrames;

  const frames: string[] = [];

  const push = (delta: Record<string, unknown>) => {
    frames.push(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
  };

  for (const piece of split(turn.reasoning ?? "", 12)) {
    if (piece) push({ reasoning: piece });
  }

  for (const piece of split(turn.text ?? "", 10)) {
    if (piece) push({ content: piece });
  }

  for (const [callIndex, call] of (turn.toolCalls ?? []).entries()) {
    const id = call.id ?? `call_${callIndex}`;
    push({ tool_calls: [{ index: callIndex, id, function: { name: call.name, arguments: "" } }] });
    // Split the arguments across frames: this is what forces the agent to
    // reassemble deltas instead of reading one complete payload.
    for (const piece of split(call.arguments, 15)) {
      push({ tool_calls: [{ index: callIndex, function: { arguments: piece } }] });
    }
  }

  if (turn.usage) {
    frames.push(`data: ${JSON.stringify({ choices: [], usage: turn.usage })}\n\n`);
  }

  if (frames.length === 0) push({ content: "" });

  return frames;
}

function split(value: string, size: number): string[] {
  const pieces: string[] = [];
  for (let index = 0; index < value.length; index += size) {
    pieces.push(value.slice(index, index + size));
  }
  return pieces;
}
