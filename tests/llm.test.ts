import { describe, expect, it } from "vitest";

import { LlmError, PollinationsLlm } from "../llm.js";
import type { LlmChunk, LlmChatParams, LlmMessage, LlmUsage } from "../llm.js";
import { startFakeLlmServer } from "./helpers/fake-llm-server.js";

function llmFor(baseUrl: string): PollinationsLlm {
  return new PollinationsLlm({ apiKey: "sk_test", baseUrl, model: "test-model" });
}

/** Consumes a `chat()` generator to completion, collecting every delta. */
async function runChat(
  baseUrl: string,
  params: Partial<LlmChatParams> & { messages?: LlmMessage[] } = {},
): Promise<{ chunks: LlmChunk[]; usage: LlmUsage }> {
  const generator = llmFor(baseUrl).chat({
    messages: params.messages ?? [{ role: "user", content: "hi" }],
    ...(params.tools ? { tools: params.tools } : {}),
    ...(params.model ? { model: params.model } : {}),
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
});
