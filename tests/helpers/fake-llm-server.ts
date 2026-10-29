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
};

export type FakeLlmServer = {
  /** Base URL to pass as `POLLINATIONS_BASE_URL`. */
  baseUrl: string;
  /** Every request the agent made, in order. */
  requests: RecordedRequest[];
  /** Number of chat-completion calls served so far. */
  readonly callCount: number;
  close: () => Promise<void>;
};

export type FakeLlmOptions = {
  /** When set, every chat-completion call fails with this status and body. */
  failWith?: { status: number; body: string };
  /** Raw body served from `GET /v1/models`. Defaults to a small catalogue. */
  modelsPayload?: unknown;
  /** When set, `GET /v1/models` fails instead, to exercise the offline path. */
  failModelsWith?: { status: number; body: string };
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
 * network. Two official quest models and one community-free one, one tool-less
 * model to prove the filter, and one image model to prove the category filter.
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
      id: "community/free-c:free",
      title: "Free C",
      description: "Zero-cost community model",
      category: "text",
      community: true,
      paid_only: false,
      tools: true,
      context_length: 131_072,
      pricing: { currency: "pollen" },
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

  const server = createServer((req, res) => {
    // A scripted outage of the catalogue endpoint, independent of `failWith`,
    // which only governs chat completions below.
    if (req.method === "GET" && req.url?.includes("/v1/models")) {
      if (options.failModelsWith) {
        res.writeHead(options.failModelsWith.status, {
          "Content-Type": "application/json",
        });
        res.end(options.failModelsWith.body);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(options.modelsPayload ?? FAKE_MODELS_PAYLOAD));
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
        res.write(frames[index] as string);
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
