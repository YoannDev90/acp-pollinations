import type { LlmMessage } from "./llm.js";
import type { SessionState } from "./agent/session-state.js";

/** Asks the model to condense the transcript into a continuation brief. */
export async function summarizeTranscript(params: {
  history: LlmMessage[];
  model: string;
  llm: import("./llm.js").PollinationsLlm;
  signal: AbortSignal;
}): Promise<string> {
  const request: LlmMessage[] = [
    ...params.history,
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
  // No tools: a summarising request must never trigger real work. No
  // reasoning effort either — see the note at the call site in `maybeCompact`.
  const iterator = params.llm.chat({ messages: request, model: params.model, signal: params.signal });
  for (;;) {
    const { done, value } = await iterator.next();
    if (done) break;
    if (value.text) text += value.text;
  }

  return text.trim();
}

export function shouldCompact(params: {
  threshold: number;
  lastPromptTokens: number;
  historyLength: number;
}): boolean {
  if (params.threshold <= 0) return false;
  if (params.lastPromptTokens < params.threshold) return false;
  if (params.historyLength < 3) return false;
  return true;
}