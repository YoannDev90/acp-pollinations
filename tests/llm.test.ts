import { describe, expect, it } from "vitest";

import { LlmError, PollinationsLlm } from "../src/llm.js";
import type { LlmChunk, LlmChatParams, LlmMessage, LlmUsage } from "../src/llm.js";
import { startFakeLlmServer } from "./helpers/fake-llm-server.js";

function llmFor(baseUrl: string): PollinationsLlm {
  return new PollinationsLlm({ apiKey: "sk_test", baseUrl, model: "test-model" });
}

/** Consumes a `chat()` generator to completion, collecting every delta. */
async function runChat(
  baseUrl: string,
  params: Partial<LlmChatParams> & { messages?: LlmMessage[] } = {},
): Promise<{ chunks: LlmChunk[]; usage: LlmUsage }> {
  return runChatWith(llmFor(baseUrl), params);
}

/** Same as {@link runChat} but on an already-built client (injected fetch). */
async function runChatWith(
  llm: PollinationsLlm,
  params: Partial<LlmChatParams> & { messages?: LlmMessage[] } = {},
): Promise<{ chunks: LlmChunk[]; usage: LlmUsage }> {
  const generator = llm.chat({
    messages: params.messages ?? [{ role: "user", content: "hi" }],
    ...(params.tools ? { tools: params.tools } : {}),
    ...(params.model ? { model: params.model } : {}),
    ...(params.reasoningEffort !== undefined ? { reasoningEffort: params.reasoningEffort } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });

  const chunks: LlmChunk[] = [];
  for (;;) {
    const { value, done } = await generator.next();
    if (done) return { chunks, usage: value };
    chunks.push(value);
  }
}

function textOf(chunks: LlmChunk[]): string {
  return chunks.map((chunk) => chunk.text ?? "").join("");
}

/** Reassembles tool-call deltas the way the agent's model loop does. */
function assembleToolCalls(chunks: LlmChunk[]): Array<{
  id: string;
  name: string;
  arguments: string;
}> {
  const byIndex = new Map<number, { id: string; name: string; arguments: string }>();

  for (const chunk of chunks) {
    for (const delta of chunk.toolCalls ?? []) {
      const call = byIndex.get(delta.index) ?? { id: "", name: "", arguments: "" };
      if (delta.id !== undefined) call.id = delta.id;
      if (delta.name !== undefined) call.name = delta.name;
      if (delta.arguments !== undefined) call.arguments += delta.arguments;
      byIndex.set(delta.index, call);
    }
  }

  return [...byIndex.values()];
}

describe("PollinationsLlm", () => {
  it("streams assistant text deltas and reports usage", async () => {
    const server = await startFakeLlmServer([
      { text: "hello world", usage: { prompt_tokens: 5, completion_tokens: 3 } },
    ]);

    const { chunks, usage } = await runChat(server.baseUrl);

    // The fake server splits the answer across several frames.
    expect(chunks.filter((chunk) => chunk.text).length).toBeGreaterThan(1);
    expect(textOf(chunks)).toBe("hello world");
    expect(usage).toEqual({ promptTokens: 5, completionTokens: 3, totalTokens: 8 });
    await server.close();
  });

  it("reassembles tool calls whose arguments arrive in pieces", async () => {
    const server = await startFakeLlmServer([
      { toolCalls: [{ name: "write_file", arguments: '{"path":"/tmp/x.txt","content":"abc"}' }] },
    ]);

    const { chunks } = await runChat(server.baseUrl);
    const calls = assembleToolCalls(chunks);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("write_file");
    expect(calls[0]?.id).toMatch(/^call_/);
    // The arguments were spread over several frames and must have been joined.
    expect(JSON.parse(calls[0]?.arguments ?? "{}")).toEqual({
      path: "/tmp/x.txt",
      content: "abc",
    });
    await server.close();
  });

  it("streams reasoning deltas ahead of the answer", async () => {
    const server = await startFakeLlmServer([{ reasoning: "thinking...", text: "done" }]);

    const { chunks } = await runChat(server.baseUrl);

    expect(chunks.map((chunk) => chunk.reasoning).filter(Boolean).join("")).toBe("thinking...");
    expect(textOf(chunks)).toBe("done");
    await server.close();
  });

  it("sends the model, stream flag, tools and API key", async () => {
    const server = await startFakeLlmServer([{ text: "ok" }]);

    await runChat(server.baseUrl, {
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Read a file",
            parameters: { type: "object", properties: {}, required: [] },
          },
        },
      ],
    });

    const request = server.requests[0];
    expect(request?.model).toBe("test-model");
    expect(request?.stream).toBe(true);
    expect(request?.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(request?.tools?.[0]?.function.name).toBe("read_file");
    expect(request?.authorization).toBe("Bearer sk_test");
    await server.close();
  });

  it("omits the tools key when no tools are offered", async () => {
    const server = await startFakeLlmServer([{ text: "ok" }]);

    await runChat(server.baseUrl);

    expect(server.requests[0]).not.toHaveProperty("tools");
    await server.close();
  });

  it("sends the reasoning effort when one is asked for", async () => {
    const server = await startFakeLlmServer([{ text: "ok" }]);

    await runChat(server.baseUrl, { reasoningEffort: "high" });

    expect(server.requests[0]?.reasoning_effort).toBe("high");
    await server.close();
  });

  it("omits the reasoning key when no effort is asked for", async () => {
    const server = await startFakeLlmServer([{ text: "ok" }]);

    await runChat(server.baseUrl);

    expect(server.requests[0]).not.toHaveProperty("reasoning_effort");
    await server.close();
  });

  it("retries once without the reasoning effort when the model refuses it", async () => {
    const server = await startFakeLlmServer([{ text: "ok" }], {
      failOnceWith: {
        status: 500,
        body: JSON.stringify({
          error: { message: "reasoning_effort is not supported by this model" },
        }),
      },
    });

    const { chunks } = await runChat(server.baseUrl, { reasoningEffort: "high" });

    // The turn survives a model that will not take the parameter: the first
    // request carries it, the corrected one does not.
    expect(textOf(chunks)).toBe("ok");
    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]?.reasoning_effort).toBe("high");
    expect(server.requests[1]).not.toHaveProperty("reasoning_effort");
    await server.close();
  });

  it("lets a request override the client's default model", async () => {
    const server = await startFakeLlmServer([{ text: "ok" }]);

    await runChat(server.baseUrl, { model: "switched/model" });
    await runChat(server.baseUrl);

    // The override is per-request: the client's own model stays put.
    expect(server.requests[0]?.model).toBe("switched/model");
    expect(server.requests[1]?.model).toBe("test-model");
    await server.close();
  });

  it("surfaces a non-2xx response as an LlmError", async () => {
    const server = await startFakeLlmServer([], {
      failWith: { status: 401, body: JSON.stringify({ error: { message: "Invalid API key" } }) },
    });

    await expect(runChat(server.baseUrl)).rejects.toThrow(
      expect.objectContaining({ name: "LlmError", status: 401 }),
    );
    await expect(runChat(server.baseUrl)).rejects.toThrow(/Invalid API key/);
    await server.close();
  });

  it("tolerates unparsable frames from proxies", async () => {
    const server = await startFakeLlmServer([
      {
        rawFrames: [
          ": keep-alive\n\n",
          "data: not json at all\n\n",
          'data: {"choices":[{"delta":{"content":"kept"}}]}\n\n',
        ],
      },
    ]);

    const { chunks } = await runChat(server.baseUrl);

    expect(textOf(chunks)).toBe("kept");
    await server.close();
  });

  it("stops the request when the caller aborts mid-stream", async () => {
    // A stalling response keeps the stream open so the abort has something to
    // interrupt; otherwise the turn could finish before abort is observed.
    const server = await startFakeLlmServer([{ text: "never mind", stallMs: 30 }]);
    const controller = new AbortController();
    const pending = runChat(server.baseUrl, { signal: controller.signal });

    setTimeout(() => controller.abort(), 15);

    await expect(pending).rejects.toThrow(/aborted|abort/i);
    await server.close();
  });

  it("requires an API key", () => {
    expect(() => new PollinationsLlm({ apiKey: "" })).toThrow(LlmError);
  });

  it("reports the model it is configured with", () => {
    // The prompt handler logs it and `agentInfo` shows it, so a client that
    // never sends a per-request model must still be able to name it.
    expect(llmFor("http://llm.invalid").modelName).toBe("test-model");
    expect(new PollinationsLlm({ apiKey: "sk_test" }).modelName).not.toBe("");
  });

  it("suffixes an empty error body with nothing", async () => {
    const llm = new PollinationsLlm({
      apiKey: "sk_test",
      baseUrl: "http://llm.invalid",
      // A 500 with no body at all: there is nothing to quote back to the user.
      fetchImpl: () => Promise.resolve(new Response(null, { status: 500 })),
    });

    await expect(runChatWith(llm)).rejects.toThrow(/500/);
    await expect(runChatWith(llm)).rejects.not.toThrow(/: $/);
  });

  it("quotes a non-JSON error body, trimmed to a readable length", async () => {
    const llm = new PollinationsLlm({
      apiKey: "sk_test",
      baseUrl: "http://llm.invalid",
      // Proxies answer plain text when the upstream is unhappy; a 403 is
      // final, so the message is raised without a retry round-trip.
      fetchImpl: () => Promise.resolve(new Response("  upstream exploded  ", { status: 403 })),
    });

    await expect(runChatWith(llm)).rejects.toThrow(/upstream exploded/);
  });

  it("drops a whitespace-only error body instead of quoting blanks", async () => {
    const llm = new PollinationsLlm({
      apiKey: "sk_test",
      baseUrl: "http://llm.invalid",
      fetchImpl: () => Promise.resolve(new Response("\n\t ", { status: 400 })),
    });

    // The message must not end in a dangling ": " with nothing after it.
    await expect(runChatWith(llm)).rejects.not.toThrow(/:\s*$/);
  });

  it("rejects a 200 that carries no body", async () => {
    const llm = new PollinationsLlm({
      apiKey: "sk_test",
      baseUrl: "http://llm.invalid",
      // A 200 with a null body would otherwise fail later, inside the stream
      // reader, with a far less diagnosable message.
      fetchImpl: () => Promise.resolve(new Response(null, { status: 200 })),
    });

    await expect(runChatWith(llm)).rejects.toThrow(/empty response body/);
  });

  it("times out a request that never answers", async () => {
    const llm = new PollinationsLlm({
      apiKey: "sk_test",
      baseUrl: "http://llm.invalid",
      // The per-request budget is the only thing that can end this fetch:
      // no caller signal is involved, so the timeout callback must fire.
      timeoutMs: 5,
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("timed out", "TimeoutError")),
          );
        }),
    });

    await expect(runChatWith(llm)).rejects.toThrow();
  });

  it("retries a rate-limited request and streams the recovered turn", async () => {
    const stream = new Response(
      'data: {"choices":[{"delta":{"content":"recovered"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
    let calls = 0;
    const llm = new PollinationsLlm({
      apiKey: "sk_test",
      baseUrl: "http://llm.invalid",
      fetchImpl: () => {
        calls += 1;
        // Retry-After zeroes the backoff, so the retry path runs at full
        // speed instead of sleeping a second for nothing.
        if (calls === 1) {
          return Promise.resolve(
            new Response("rate limit", { status: 429, headers: { "Retry-After": "0" } }),
          );
        }
        return Promise.resolve(stream);
      },
    });

    const { chunks } = await runChatWith(llm);

    expect(calls).toBe(2);
    expect(textOf(chunks)).toBe("recovered");
  });

  it("retries once when the transport itself fails", async () => {
    const stream = new Response(
      'data: {"choices":[{"delta":{"content":"after the drop"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
    let calls = 0;
    const llm = new PollinationsLlm({
      apiKey: "sk_test",
      baseUrl: "http://llm.invalid",
      fetchImpl: () => {
        calls += 1;
        // A socket-level failure carries no response, so the retry delay
        // falls back to the exponential backoff rather than Retry-After.
        if (calls === 1) return Promise.reject(new TypeError("fetch failed"));
        return Promise.resolve(stream);
      },
    });

    const { chunks } = await runChatWith(llm);

    expect(calls).toBe(2);
    expect(textOf(chunks)).toBe("after the drop");
  }, 10_000);

  it("salvages a trailing frame when the stream ends without [DONE]", async () => {
    const stream = new Response(
      // A proxy that cuts the connection before the frame's blank line: the
      // payload only arrives through the parser's flush, not the read loop.
      'data: {"choices":[{"delta":{"content":"cut off"}}]}',
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
    const llm = new PollinationsLlm({
      apiKey: "sk_test",
      baseUrl: "http://llm.invalid",
      fetchImpl: () => Promise.resolve(stream),
    });

    const { chunks, usage } = await runChatWith(llm);

    expect(textOf(chunks)).toBe("cut off");
    expect(usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });

  it("does not drop the reasoning effort for an unrelated status", async () => {
    const llm = new PollinationsLlm({
      apiKey: "sk_test",
      baseUrl: "http://llm.invalid",
      // 403 naming "reasoning" is a permissions problem, not the model
      // refusing the knob, so the effort must survive and the error surface.
      fetchImpl: () =>
        Promise.resolve(new Response('{"error":"reasoning is forbidden"}', { status: 403 })),
    });

    await expect(runChatWith(llm, { reasoningEffort: "high" })).rejects.toThrow(
      /reasoning is forbidden/,
    );
  });

  it("retries an LlmError that carries a retryable status but no body", async () => {
    const stream = new Response(
      'data: {"choices":[{"delta":{"content":"second try"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
    let calls = 0;
    const llm = new PollinationsLlm({
      apiKey: "sk_test",
      baseUrl: "http://llm.invalid",
      fetchImpl: () => {
        calls += 1;
        // A transport wrapper can raise an LlmError with a status and no
        // body at all; the classifier must still read the status.
        if (calls === 1) return Promise.reject(new LlmError("upstream said 429", 429));
        return Promise.resolve(stream);
      },
    });

    const { chunks } = await runChatWith(llm);

    expect(calls).toBe(2);
    expect(textOf(chunks)).toBe("second try");
  }, 10_000);

  it("gives up on a thrown value that is not an error", async () => {
    const llm = new PollinationsLlm({
      apiKey: "sk_test",
      baseUrl: "http://llm.invalid",
      // Nothing to inspect and nothing to match, so retrying would only
      // repeat the same opaque failure. The non-Error rejection is the point
      // of the test, hence the disable.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      fetchImpl: () => Promise.reject("socket exploded"),
    });

    await expect(runChatWith(llm)).rejects.toBe("socket exploded");
  });

  it("quotes nothing when the error body cannot be read", async () => {
    // The connection dies between the status line and the body: reading it
    // rejects, and the empty fallback keeps the failure raising anyway.
    const broken = new ReadableStream({
      start(controller) {
        controller.error(new Error("body gone"));
      },
    });
    const llm = new PollinationsLlm({
      apiKey: "sk_test",
      baseUrl: "http://llm.invalid",
      fetchImpl: () => Promise.resolve(new Response(broken, { status: 400 })),
    });

    await expect(runChatWith(llm)).rejects.toThrow(/400/);
  });

  it("adds no suffix when the JSON error carries no message", async () => {
    const llm = new PollinationsLlm({
      apiKey: "sk_test",
      baseUrl: "http://llm.invalid",
      fetchImpl: () =>
        Promise.resolve(new Response('{"error":{}}', { status: 400 })),
    });

    // Well-formed JSON with nothing to say: the raw body is not quoted
    // either, so the user sees only the status.
    await expect(runChatWith(llm)).rejects.toThrow(/^Pollinations request failed \(400/);
    await expect(runChatWith(llm)).rejects.not.toThrow(/\{$/);
  });

  it("reads a bare string error field the same as a message object", async () => {
    const llm = new PollinationsLlm({
      apiKey: "sk_test",
      baseUrl: "http://llm.invalid",
      // Some upstreams send `{"error": "..."}` instead of the OpenAI shape.
      fetchImpl: () =>
        Promise.resolve(new Response('{"error":"quota exhausted"}', { status: 400 })),
    });

    await expect(runChatWith(llm)).rejects.toThrow(/quota exhausted/);
  });

  it("fills in missing usage counters with zeros", async () => {
    const stream = new Response(
      // A final frame that reports usage without the token breakdown: the
      // totals must still add up instead of becoming NaN.
      'data: {"usage":{"total_tokens":9},"choices":[{"delta":{"content":"counted"}}]}\n\n' +
        "data: [DONE]\n\n",
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
    const llm = new PollinationsLlm({
      apiKey: "sk_test",
      baseUrl: "http://llm.invalid",
      fetchImpl: () => Promise.resolve(stream),
    });

    const { usage } = await runChatWith(llm);

    expect(usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 9 });
  });

  it("keeps tool-call deltas that omit the optional fields", async () => {
    const stream = new Response(
      // Index-only call: no id and no function block, so both spreads stay
      // empty rather than injecting undefined keys into the chunk.
      'data: {"choices":[{"delta":{"tool_calls":[{"index":3}]}}]}\n\n' +
        // And a call with no index at all: it defaults to 0 so the assembler
        // still groups it instead of keying on undefined.
        'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_x","function":{"name":"f"}}]}}]}\n\n' +
        "data: [DONE]\n\n",
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
    const llm = new PollinationsLlm({
      apiKey: "sk_test",
      baseUrl: "http://llm.invalid",
      fetchImpl: () => Promise.resolve(stream),
    });

    const { chunks } = await runChatWith(llm);

    expect(chunks[0]?.toolCalls).toEqual([{ index: 3 }]);
    expect(chunks[1]?.toolCalls).toEqual([{ index: 0, id: "call_x", name: "f" }]);
  });

  it("skips a delta that carries nothing to surface", async () => {
    const stream = new Response(
      // A role-only delta yields no chunk: the agent must not see an empty
      // assistant message.
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"now"} }]}\n\n' +
        "data: [DONE]\n\n",
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
    const llm = new PollinationsLlm({
      apiKey: "sk_test",
      baseUrl: "http://llm.invalid",
      fetchImpl: () => Promise.resolve(stream),
    });

    const { chunks } = await runChatWith(llm);

    expect(textOf(chunks)).toBe("now");
    expect(chunks).toHaveLength(1);
  });

  it("drains the sentinel from the flush as well", async () => {
    const stream = new Response(
      // Nothing is frame-terminated at the end: [DONE] sits in the parser's
      // trailing buffer when the connection closes.
      'data: {"choices":[{"delta":{"content":"tail"}}]}\n\n' +
        "data: [DONE]",
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
    const llm = new PollinationsLlm({
      apiKey: "sk_test",
      baseUrl: "http://llm.invalid",
      fetchImpl: () => Promise.resolve(stream),
    });

    const { chunks, usage } = await runChatWith(llm);

    expect(textOf(chunks)).toBe("tail");
    expect(usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });

  it("drains a trailing usage frame that never saw its blank line", async () => {
    const stream = new Response(
      'data: {"choices":[{"delta":{"content":"tail"}}]}\n\n' +
        'data: {"usage":{"prompt_tokens":4,"completion_tokens":2}}',
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
    const llm = new PollinationsLlm({
      apiKey: "sk_test",
      baseUrl: "http://llm.invalid",
      fetchImpl: () => Promise.resolve(stream),
    });

    const { chunks, usage } = await runChatWith(llm);

    expect(textOf(chunks)).toBe("tail");
    expect(usage).toEqual({ promptTokens: 4, completionTokens: 2, totalTokens: 6 });
  });
});
