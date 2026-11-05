import { describe, expect, it } from "vitest";

import { rebaseHistory, systemMessage } from "../src/messages.js";
import type { LlmMessage } from "../src/llm.js";

describe("systemMessage", () => {
  it("names the workspace it was built for", () => {
    expect(systemMessage("/workspace").content).toContain("/workspace");
  });
});

describe("rebaseHistory", () => {
  const assistant: LlmMessage = { role: "assistant", content: "hello" };

  it("keeps a history whose system prompt already matches the cwd", () => {
    const history: LlmMessage[] = [systemMessage("/workspace"), assistant];

    expect(rebaseHistory(history, "/workspace", "/workspace")[0]?.content).toBe(
      history[0]?.content,
    );
  });

  it("replaces a stale system prompt when the session moved workspace", () => {
    const history: LlmMessage[] = [systemMessage("/old"), assistant];
    const rebased = rebaseHistory(history, "/new", "/old");

    expect(rebased).toHaveLength(2);
    expect(rebased[0]?.content).toContain("/new");
    // The assistant turn survives: only the preamble is regenerated.
    expect(rebased[1]?.content).toBe("hello");
  });

  it("prepends a system prompt to a history that has none", () => {
    const rebased = rebaseHistory([assistant], "/workspace", "/workspace");

    expect(rebased).toHaveLength(2);
    expect(rebased[0]?.role).toBe("system");
    expect(rebased[1]?.content).toBe("hello");
  });

  it("backfills reasoning on older assistant turns that predate it", () => {
    // Reasoning models reject a transcript where an earlier assistant message
    // has no `reasoning_content`, so persisted sessions must be repaired.
    const rebased = rebaseHistory([assistant], "/workspace", "/other");

    expect(rebased.at(-1)?.reasoning_content).toBe("");
    // A message that already carries reasoning is left untouched.
    const reasoned: LlmMessage = { ...assistant, reasoning_content: "thought" };
    expect(rebaseHistory([reasoned], "/workspace", "/workspace").at(-1)).toEqual(reasoned);
  });
});
