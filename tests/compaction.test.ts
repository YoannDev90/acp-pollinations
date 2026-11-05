import { describe, expect, it } from "vitest";

import { shouldCompact, summarizeTranscript } from "../src/compaction.js";
import type { LlmMessage, PollinationsLlm } from "../src/llm.js";

describe("shouldCompact", () => {
  it("asks for a summary once the transcript is both long and large", () => {
    expect(shouldCompact({ threshold: 1000, lastPromptTokens: 4000, historyLength: 8 })).toBe(true);
  });

  it("stays off when compaction is disabled", () => {
    expect(shouldCompact({ threshold: 0, lastPromptTokens: 900_000, historyLength: 50 })).toBe(false);
  });

  it("waits until the last request actually reached the threshold", () => {
    expect(shouldCompact({ threshold: 4000, lastPromptTokens: 3999, historyLength: 50 })).toBe(false);
  });

  it("leaves a short conversation alone even when it is large", () => {
    expect(shouldCompact({ threshold: 1000, lastPromptTokens: 900_000, historyLength: 2 })).toBe(
      false,
    );
  });
});

describe("summarizeTranscript", () => {
  it("collects the model's text and trims it", async () => {
    const history: LlmMessage[] = [{ role: "user", content: "do the thing" }];
    const llm = {
      chat: async function* () {
        yield { text: "  work continued  " };
        return 0;
      },
    } as unknown as PollinationsLlm;

    const summary = await summarizeTranscript({
      history,
      model: "test-model",
      llm,
      signal: new AbortController().signal,
    });

    expect(summary).toBe("work continued");
  });

  it("ignores frames that carry no text", async () => {
    const llm = {
      chat: async function* () {
        yield { reasoning: "thinking only" };
        yield { text: "kept" };
        return 0;
      },
    } as unknown as PollinationsLlm;

    const summary = await summarizeTranscript({
      history: [],
      model: "test-model",
      llm,
      signal: new AbortController().signal,
    });

    expect(summary).toBe("kept");
  });
});
