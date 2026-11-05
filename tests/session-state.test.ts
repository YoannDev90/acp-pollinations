import { describe, expect, it } from "vitest";

import { createSessionState } from "../src/agent/session-state.js";
import type { LlmMessage } from "../src/llm.js";

const base = { id: "sess_1", cwd: "/workspace", roots: ["/workspace"], model: "test-model" };

describe("createSessionState", () => {
  it("starts a fresh session with an empty transcript", () => {
    const state = createSessionState(base);

    expect(state.history).toEqual([]);
    expect(state.mode).toBe("build");
    expect(state.reasoningLevel).toBe("medium");
    expect(state.abort).toBeNull();
    expect(state.lastPromptTokens).toBe(0);
    expect(state.costSoFar).toBe(0);
  });

  it("adopts a restored transcript when one is given", () => {
    const history: LlmMessage[] = [{ role: "user", content: "continue" }];

    expect(createSessionState({ ...base, history }).history).toEqual(history);
  });
});
