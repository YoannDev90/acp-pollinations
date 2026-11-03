import { resolve } from "node:path";

import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { LlmMessage } from "./llm.js";

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

export function systemMessage(cwd: string): LlmMessage {
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

export function rebaseHistory(
  history: LlmMessage[],
  cwd: string,
  previousCwd: string,
): LlmMessage[] {
  const hasSystem = history[0]?.role === "system";
  const rebased =
    hasSystem && resolve(previousCwd) === resolve(cwd)
      ? history
      : [systemMessage(cwd), ...(hasSystem ? history.slice(1) : history)];
  // Reasoning models require `reasoning_content` on every earlier assistant
  // message. Older persisted sessions may lack it, so backfill an empty value.
  return rebased.map((message) =>
    message.role === "assistant" && message.reasoning_content === undefined
      ? { ...message, reasoning_content: "" }
      : message,
  );
}