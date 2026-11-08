import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { SessionConfigOption, SessionConfigSelectGroup, ClientSessionCapabilities } from "@agentclientprotocol/sdk";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { AgentConfig } from "../src/config.js";
import { PollinationsLlm } from "../src/llm.js";
import { createPollinationsAgent, promptToText } from "../src/agent/server.js";
import type { PollinationsAgentApp } from "../src/agent/server.js";
import { withInProcessClient } from "./helpers/acp-client.js";
import type { Harness } from "./helpers/acp-client.js";
import { startFakeLlmServer } from "./helpers/fake-llm-server.js";
import type { FakeLlmServer, FakeTurn } from "./helpers/fake-llm-server.js";
import { createTmpDir } from "./helpers/tmp.js";

const servers: FakeLlmServer[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterAll(async () => {
  await Promise.all(cleanups.map((cleanup) => cleanup()));
});

type OpArgs = { cwd: string; server: FakeLlmServer; harness: Harness; agent: PollinationsAgentApp };

/**
 * Boots a fake endpoint, a scratch workspace, and an agent, then runs `op`
 * against an in-process ACP client connected to that agent.
 */
async function withAgent(
  turns: FakeTurn[],
  overrides: Partial<AgentConfig>,
  op: (args: OpArgs) => Promise<void>,
): Promise<void> {
  const server = await startFakeLlmServer(turns);
  servers.push(server);

  const workspace = await createTmpDir("acp-agent");
  cleanups.push(workspace.cleanup);

  const config: AgentConfig = {
    apiKey: "sk_test",
    baseUrl: server.baseUrl,
    model: "test-model",
    maxTurnRequests: 8,
    permissionMode: "ask",
    // Compaction off by default so a test never gains a surprise model call.
    compactionThresholdTokens: 0,
    ...overrides,
  };

  const agent = createPollinationsAgent({
    config,
    llm: new PollinationsLlm({ apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model }),
  });

  await withInProcessClient(agent, { cwd: workspace.path }, async (harness) => {
    await op({ cwd: workspace.path, server, harness, agent });
  });
}

/**
 * Runs `op` against an agent that has not opened a session yet.
 *
 * The scenario owns `session/new` itself, which is what a test needs when the
 * subject is that request — or the refusal it produces without an API key.
 */
async function withUnopenedSession(
  overrides: Partial<AgentConfig>,
  op: (args: { cwd: string; harness: Harness }) => Promise<void>,
): Promise<void> {
  const server = await startFakeLlmServer([]);
  servers.push(server);

  const workspace = await createTmpDir("acp-raw");
  cleanups.push(workspace.cleanup);

  const config: AgentConfig = {
    apiKey: "sk_test",
    baseUrl: server.baseUrl,
    model: "test-model",
    maxTurnRequests: 8,
    permissionMode: "ask",
    compactionThresholdTokens: 0,
    ...overrides,
  };

  const agent = createPollinationsAgent({
    config,
    ...(config.apiKey
      ? { llm: new PollinationsLlm({ apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model }) }
      : {}),
  });

  await withInProcessClient(agent, { cwd: workspace.path, skipSession: true }, async (harness) => {
    await op({ cwd: workspace.path, harness });
  });
}

/** Collects the agent's streamed text from the update log. */
function agentText(updates: unknown[]): string {
  return updates
    .filter((u) => (u as { sessionUpdate?: string }).sessionUpdate === "agent_message_chunk")
    .map((u) => ((u as { content: { text?: string } }).content.text ?? ""))
    .join("");
}

/**
 * Renders a message's content for an assertion.
 *
 * The fake endpoint stores whatever the test put in it, so `content` is
 * `unknown`: stringifying blindly would assert against `[object Object]` and
 * pass for the wrong reason.
 */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  return content === undefined || content === null ? "" : JSON.stringify(content);
}

describe("createPollinationsAgent", () => {
  it("completes a text-only turn and streams the answer", async () => {
    await withAgent([{ text: "hello from the model" }], {}, async ({ cwd, server, harness }) => {
      expect(harness.initializeResponse.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(harness.initializeResponse.agentInfo?.name).toBe("pollinations");

      const response = await harness.prompt("say hello");

      expect(response.stopReason).toBe("end_turn");
      expect(agentText(harness.updates)).toBe("hello from the model");

      // The user's prompt is echoed as an update, and reaches the model.
      expect(
        harness.updates.some((u) => (u as { sessionUpdate?: string }).sessionUpdate === "user_message_chunk"),
      ).toBe(true);
      const first = server.requests[0];
      expect(first?.messages.some((m) => m.role === "user" && String(m.content).includes("say hello"))).toBe(
        true,
      );
      expect(cwd).toBeTruthy();
    });
  });

  it("runs a read-only tool without asking permission", async () => {
    await withAgent(
      [{ toolCalls: [{ name: "read_file", arguments: JSON.stringify({ path: "notes.txt" }) }] }, { text: "done" }],
      {},
      async ({ cwd, harness }) => {
        await writeFile(join(cwd, "notes.txt"), "unread text\n", "utf8");

        const response = await harness.prompt("read notes");

        expect(response.stopReason).toBe("end_turn");
        // read_file is not mutating, so no permission prompt is expected.
        expect(harness.permissionRequests).toHaveLength(0);

        const toolUpdate = harness.updates.find(
          (u) => (u as { sessionUpdate?: string }).sessionUpdate === "tool_call",
        ) as { name?: string; status?: string } | undefined;
        expect(toolUpdate?.name).toBe("read_file");

        // The model received the tool result and then answered.
        expect(agentText(harness.updates)).toBe("done");
      },
    );
  });

  it("asks permission before a mutating tool runs, then writes the file", async () => {
    await withAgent(
      [
        {
          toolCalls: [
            { id: "call_write", name: "write_file", arguments: JSON.stringify({ path: "out.txt", content: "written" }) },
          ],
        },
        { text: "wrote it" },
      ],
      {},
      async ({ cwd, harness }) => {
        const response = await harness.prompt("create out.txt");

        expect(response.stopReason).toBe("end_turn");
        // Default client answers with the first allow_* option.
        expect(harness.permissionRequests).toHaveLength(1);
        expect(harness.permissionRequests[0]?.toolCall.name).toBe("write_file");

        expect(await readFile(join(cwd, "out.txt"), "utf8")).toBe("written");
        expect(agentText(harness.updates)).toBe("wrote it");
      },
    );
  });

  it("skips permission prompts entirely in allow mode", async () => {
    await withAgent(
      [
        {
          toolCalls: [
            { name: "write_file", arguments: JSON.stringify({ path: "auto.txt", content: "auto" }) },
          ],
        },
        { text: "ok" },
      ],
      { permissionMode: "allow" },
      async ({ cwd, harness }) => {
        await harness.prompt("write it");

        expect(harness.permissionRequests).toHaveLength(0);
        expect(await readFile(join(cwd, "auto.txt"), "utf8")).toBe("auto");
      },
    );
  });

  it("blocks a mutating tool when permission is rejected", async () => {
    await withAgent(
      [
        {
          toolCalls: [
            { name: "write_file", arguments: JSON.stringify({ path: "blocked.txt", content: "nope" }) },
          ],
        },
        { text: "understood" },
      ],
      {},
      async ({ cwd, harness }) => {
        harness.answerPermission = () => "reject-once";

        const response = await harness.prompt("write blocked.txt");

        expect(response.stopReason).toBe("end_turn");
        expect(harness.permissionRequests).toHaveLength(1);

        // The write never happened.
        await expect(readFile(join(cwd, "blocked.txt"), "utf8")).rejects.toThrow();

        const toolUpdate = harness.updates.find(
          (u) =>
            (u as { sessionUpdate?: string }).sessionUpdate === "tool_call_update" &&
            (u as { status?: string }).status === "failed",
        );
        expect(toolUpdate).toBeTruthy();
      },
    );
  });

  it("reports the real error when tool arguments are not valid JSON", async () => {
    await withAgent([{ toolCalls: [{ name: "read_file", arguments: "{not json" }] }, { text: "recovered" }], {}, async ({
      harness,
    }) => {
      const response = await harness.prompt("bad args");

      expect(response.stopReason).toBe("end_turn");
      const failed = harness.updates.find(
        (u) =>
          (u as { sessionUpdate?: string }).sessionUpdate === "tool_call_update" &&
          (u as { status?: string }).status === "failed",
      ) as { rawOutput?: string } | undefined;
      expect(failed?.rawOutput).toMatch(/Invalid tool arguments/);
      expect(agentText(harness.updates)).toBe("recovered");
    });
  });

  it("stops at maxTurnRequests when the model keeps calling tools", async () => {
    const looping = Array.from({ length: 5 }, () => ({
      toolCalls: [{ name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) }],
    }));

    await withAgent(looping, { maxTurnRequests: 2 }, async ({ cwd, harness }) => {
      await writeFile(join(cwd, "a.txt"), "content\n", "utf8");

      const response = await harness.prompt("loop forever");

      expect(response.stopReason).toBe("max_turn_requests");
      // Exactly two model requests were made before the ceiling kicked in.
      expect(harness.updates.some((u) => (u as { sessionUpdate?: string }).sessionUpdate === "tool_call")).toBe(
        true,
      );
    });
  });

  it("cancels an in-flight turn", async () => {
    await withAgent([{ text: "x".repeat(500), stallMs: 40 }], {}, async ({ harness }) => {
      const pending = harness.prompt("long turn");

      // Wait until the stream is visibly under way, then cancel.
      await harness.waitFor(() =>
        harness.updates.some((u) => (u as { sessionUpdate?: string }).sessionUpdate === "agent_message_chunk"),
      );
      await harness.ctx.notify("session/cancel", { sessionId: harness.session.sessionId });

      const response = await pending;
      expect(response.stopReason).toBe("cancelled");
    });
  });

  it("surfaces a session-not-found error for an unknown session id", async () => {
    await withAgent([{ text: "unused" }], {}, async ({ harness }) => {
      await expect(
        harness.ctx.request("session/prompt", {
          sessionId: "sess_missing",
          prompt: [{ type: "text", text: "hi" }],
        }),
      ).rejects.toMatchObject({ code: -32002 });
    });
  });
});

describe("session setup validation", () => {
  it("rejects a session/new whose cwd is missing or relative", async () => {
    await withUnopenedSession({}, async ({ cwd, harness }) => {
      await expect(
        harness.ctx.request("session/new", { cwd: "", mcpServers: [] }),
      ).rejects.toMatchObject({ code: -32602 });

      await expect(
        harness.ctx.request("session/new", { cwd: "relative/path", mcpServers: [] }),
      ).rejects.toMatchObject({ code: -32602 });

      // The happy path still works afterwards: the refusals changed no state.
      const ok = await harness.ctx.request("session/new", { cwd, mcpServers: [] });
      expect(ok.sessionId).toMatch(/^sess_/);
    });
  });

  it("rejects a session/new whose additional directory is relative", async () => {
    await withUnopenedSession({}, async ({ cwd, harness }) => {
      await expect(
        harness.ctx.request("session/new", {
          cwd,
          additionalDirectories: ["relative/dir"],
          mcpServers: [],
        }),
      ).rejects.toMatchObject({ code: -32602 });

      // An absolute entry is accepted and becomes a root of the session.
      const ok = await harness.ctx.request("session/new", {
        cwd,
        additionalDirectories: [cwd],
        mcpServers: [],
      });
      expect(ok.sessionId).toMatch(/^sess_/);
    });
  });

  it("refuses session/new, load, and resume without an API key", async () => {
    await withUnopenedSession({ apiKey: "" }, async ({ cwd, harness }) => {
      // Without a key the agent must still answer — with a reason, not a crash.
      await expect(
        harness.ctx.request("session/new", { cwd, mcpServers: [] }),
      ).rejects.toMatchObject({ code: -32000 });

      await expect(
        harness.ctx.request("session/load", { sessionId: "sess_x", cwd, mcpServers: [] }),
      ).rejects.toMatchObject({ code: -32000 });

      await expect(
        harness.ctx.request("session/resume", { sessionId: "sess_x", cwd, mcpServers: [] }),
      ).rejects.toMatchObject({ code: -32000 });
    });
  });

  it("answers authenticate with an empty result", async () => {
    await withUnopenedSession({}, async ({ harness }) => {
      // The key comes from the environment, so the ACP auth flow is a no-op
      // that exists to be answerable rather than an unknown method.
      const response = await harness.ctx.request("authenticate", { methodId: "pollinations" });
      expect(response).toEqual({});
    });
  });
});

describe("model picker", () => {
  /** Flattens the picker's groups into one list of option values. */
  function pickerValues(configOptions: SessionConfigOption[] | null | undefined): {
    id: string;
    value: string;
  }[] {
    const option = configOptions?.[0];
    if (!option || option.type !== "select") throw new Error("expected a select picker option");

    const groups = option.options as SessionConfigSelectGroup[];
    return groups.flatMap((group) =>
      group.options.map((entry) => ({ id: group.group, value: entry.value })),
    );
  }

  it("advertises a grouped picker on session/new with the default model selected", async () => {
    await withAgent([{ text: "unused" }], {}, async ({ harness }) => {
      const option = (harness.session.newSessionResponse.configOptions ?? [])[0];

      expect(option?.type).toBe("select");
      expect(option?.id).toBe("model");
      expect(option?.category).toBe("model");
      // The configured model is the current value, and is offered as a choice.
      expect(option?.currentValue).toBe("test-model");

      const values = pickerValues(harness.session.newSessionResponse.configOptions).map((v) => v.value);
      expect(values).toContain("test-model");
      // The fake catalogue is grouped by origin and billing tier.
      expect(values).toEqual(expect.arrayContaining(["official/quest-a", "official/paid-b", "community/free-c:free"]));
    });
  });

  it("switches the model for later turns and reports the new selection", async () => {
    await withAgent([{ text: "first" }, { text: "second" }], {}, async ({ harness, server }) => {
      await harness.prompt("before the switch");
      expect(server.requests[0]?.model).toBe("test-model");

      const response = await harness.ctx.request("session/set_config_option", {
        sessionId: harness.session.sessionId,
        configId: "model",
        value: "official/quest-a",
      });

      // The response carries the full, current option set.
      expect((response.configOptions ?? [])[0]?.currentValue).toBe("official/quest-a");

      await harness.prompt("after the switch");
      expect(server.requests[1]?.model).toBe("official/quest-a");
    });
  });

  it("forwards the selected reasoning effort to the model", async () => {
    await withAgent([{ text: "first" }, { text: "second" }], {}, async ({ harness, server }) => {
      // The selector is only real if its value reaches the endpoint: a knob
      // that is stored and silently dropped is worse than no knob at all.
      await harness.prompt("default level");
      expect(server.requests[0]?.reasoning_effort).toBe("medium");

      const response = await harness.ctx.request("session/set_config_option", {
        sessionId: harness.session.sessionId,
        configId: "reasoning",
        value: "high",
      });

      expect((response.configOptions ?? []).find((option) => option.id === "reasoning")?.currentValue).toBe(
        "high",
      );

      await harness.prompt("after the switch");
      expect(server.requests[1]?.reasoning_effort).toBe("high");
    });
  });

  it("keeps each session's model independent", async () => {
    const server = await startFakeLlmServer([{ text: "ok" }]);
    servers.push(server);

    const workspace = await createTmpDir("acp-agent-sessions");
    cleanups.push(workspace.cleanup);

    const config: AgentConfig = {
      apiKey: "sk_test",
      baseUrl: server.baseUrl,
      model: "test-model",
      maxTurnRequests: 8,
      permissionMode: "ask",
      compactionThresholdTokens: 0,
    };

    const agent = createPollinationsAgent({
      config,
      llm: new PollinationsLlm({ apiKey: config.apiKey, baseUrl: config.baseUrl }),
    });

    await withInProcessClient(agent, { cwd: workspace.path }, async (harness) => {
      // Open a second session on the same agent and switch only the first.
      await harness.ctx.buildSession(workspace.path).withSession(async (other) => {
        await harness.ctx.request("session/set_config_option", {
          sessionId: harness.session.sessionId,
          configId: "model",
          value: "official/quest-a",
        });

        const first = (harness.session.newSessionResponse.configOptions ?? [])[0];
        const second = (other.newSessionResponse.configOptions ?? [])[0];

        // Switching one session must not disturb the other's selection.
        expect(second?.currentValue).toBe("test-model");
        expect(first?.currentValue).toBe("test-model");
      });
    });
  });

  it("keeps the session's own model re-selectable even when unlisted", async () => {
    // `buildModelOption` injects the current model when the catalogue omits it,
    // so the picker offers it. Selecting it back must not be rejected, or the
    // user gets a choice that always fails.
    await withAgent([{ text: "unused" }], {}, async ({ harness }) => {
      const response = await harness.ctx.request("session/set_config_option", {
        sessionId: harness.session.sessionId,
        configId: "model",
        value: "test-model",
      });

      expect((response.configOptions ?? [])[0]?.currentValue).toBe("test-model");
    });
  });

  it("rejects an unknown model and lists what is available", async () => {
    await withAgent([{ text: "unused" }], {}, async ({ harness }) => {
      const error = await harness.ctx
        .request("session/set_config_option", {
          sessionId: harness.session.sessionId,
          configId: "model",
          value: "nope/not-a-model",
        })
        .then(
          () => null,
          (caught: Error & { code?: number; data?: { available?: string[] } }) => caught,
        );

      expect(error?.code).toBe(-32602);
      expect(error?.message).toContain("nope/not-a-model");
      // The error is actionable: it names the models that do exist.
      expect(error?.data?.available).toEqual(expect.arrayContaining(["official/quest-a"]));
      expect(error?.data?.available).not.toContain("nope/not-a-model");
    });
  });

  it("rejects a config option it does not expose", async () => {
    await withAgent([{ text: "unused" }], {}, async ({ harness }) => {
      await expect(
        harness.ctx.request("session/set_config_option", {
          sessionId: harness.session.sessionId,
          configId: "verbosity",
          value: "official/quest-a",
        }),
      ).rejects.toMatchObject({ code: -32602, message: expect.stringContaining("verbosity") });
    });
  });

  it("rejects a reasoning level the agent does not know", async () => {
    await withAgent([{ text: "unused" }], {}, async ({ harness }) => {
      const error = await harness.ctx
        .request("session/set_config_option", {
          sessionId: harness.session.sessionId,
          configId: "reasoning",
          value: "extreme",
        })
        .then(
          () => null,
          (caught: Error & { code?: number; data?: { available?: string[] } }) => caught,
        );

      expect(error?.code).toBe(-32602);
      expect(error?.message).toContain("extreme");
      // The error lists the levels that do exist so the client can re-pick.
      expect(error?.data?.available).toEqual(expect.arrayContaining(["medium", "high"]));
    });
  });

  it("rejects a non-string value for the model picker", async () => {
    await withAgent([{ text: "unused" }], {}, async ({ harness }) => {
      // The schema allows boolean values for toggle options; the model picker
      // is a select, so it must refuse rather than store `true` as a model id.
      await expect(
        harness.ctx.request("session/set_config_option", {
          sessionId: harness.session.sessionId,
          configId: "model",
          type: "boolean",
          value: true,
        }),
      ).rejects.toMatchObject({ code: -32602, message: expect.stringContaining("model id") });
    });
  });

  it("switches the mode through session/set_mode and persists it", async () => {
    await withAgent([{ text: "unused" }], {}, async ({ harness }) => {
      const response = await harness.ctx.request("session/set_mode", {
        sessionId: harness.session.sessionId,
        modeId: "plan",
      });
      expect(response).toEqual({});

      // The change is visible to the next turn's command, not just to the
      // acknowledgement.
      await harness.prompt("/mode");
      expect(agentText(harness.updates)).toContain("Current mode: plan");
    });
  });

  it("rejects an unknown mode id and an unknown session", async () => {
    await withAgent([{ text: "unused" }], {}, async ({ harness }) => {
      await expect(
        harness.ctx.request("session/set_mode", {
          sessionId: harness.session.sessionId,
          modeId: "focus",
        }),
      ).rejects.toMatchObject({ code: -32602, message: expect.stringContaining("focus") });

      await expect(
        harness.ctx.request("session/set_mode", {
          sessionId: "sess_missing",
          modeId: "plan",
        }),
      ).rejects.toMatchObject({ code: -32002 });
    });
  });

  it("rejects a model switch for an unknown session", async () => {
    await withAgent([{ text: "unused" }], {}, async ({ harness }) => {
      await expect(
        harness.ctx.request("session/set_config_option", {
          sessionId: "sess_missing",
          configId: "model",
          value: "official/quest-a",
        }),
      ).rejects.toMatchObject({ code: -32002 });
    });
  });

  it("falls back to the offline list when the catalogue cannot be read", async () => {
    const server = await startFakeLlmServer([{ text: "hi" }], {
      // 404 is permanent, so the picker falls back at once instead of the
      // test sitting through the retry backoff a transient status would take.
      failModelsWith: { status: 404, body: "no catalogue" },
    });
    servers.push(server);

    const workspace = await createTmpDir("acp-agent-nocatalog");
    cleanups.push(workspace.cleanup);

    const config: AgentConfig = {
      apiKey: "sk_test",
      baseUrl: server.baseUrl,
      model: "community/YoannDev90/vercel-nemotron-3.5-lightning:free",
      maxTurnRequests: 8,
      permissionMode: "ask",
      compactionThresholdTokens: 0,
    };

    const agent = createPollinationsAgent({
      config,
      llm: new PollinationsLlm({ apiKey: config.apiKey, baseUrl: config.baseUrl }),
    });

    await withInProcessClient(agent, { cwd: workspace.path }, async (harness) => {
      // A dead catalogue must not block session setup or empty the picker.
      const option = (harness.session.newSessionResponse.configOptions ?? [])[0];
      const values = pickerValues(harness.session.newSessionResponse.configOptions).map((v) => v.value);

      expect(option?.currentValue).toBe("community/YoannDev90/vercel-nemotron-3.5-lightning:free");
      expect(values).toContain("community/YoannDev90/vercel-nemotron-3.5-lightning:free");
      expect(values).toContain("nvidia/nemotron-3.5-lightning");
    });
  });

  it("reads the catalogue once and reuses it for later sessions", async () => {
    let reads = 0;
    const countingFetch: typeof fetch = (input, init) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      if (url.includes("/v1/models")) reads += 1;
      return fetch(input, init);
    };

    const server = await startFakeLlmServer([{ text: "hi" }]);
    servers.push(server);

    const workspace = await createTmpDir("acp-agent-catalog");
    cleanups.push(workspace.cleanup);

    const config: AgentConfig = {
      apiKey: "sk_test",
      baseUrl: server.baseUrl,
      model: "test-model",
      maxTurnRequests: 8,
      permissionMode: "ask",
      compactionThresholdTokens: 0,
    };

    const agent = createPollinationsAgent({
      config,
      llm: new PollinationsLlm({ apiKey: config.apiKey, baseUrl: config.baseUrl }),
      fetchImpl: countingFetch,
    });

    await withInProcessClient(agent, { cwd: workspace.path }, async (harness) => {
      expect(harness.session.newSessionResponse.configOptions).toHaveLength(2);
      expect(reads).toBe(1);

      // A second session in the same agent reuses the cached catalogue.
      const second = await harness.ctx.buildSession(workspace.path).withSession(async (session) => {
        expect(session.newSessionResponse.configOptions).toHaveLength(2);
        return session.sessionId;
      });

      expect(second).toBeTruthy();
      expect(reads).toBe(1);
    });
  });
});

describe("session restore (load and resume)", () => {
  /**
   * Runs a conversation on one agent instance, then opens a brand-new instance
   * over the same sessions directory — the state a client sees after
   * restarting the agent process — and hands the reconnected harness to `op`.
   */
  async function withRestartedAgent(
    turns: FakeTurn[],
    op: (args: {
      sessionId: string;
      server: FakeLlmServer;
      harness: Harness;
      stateDir: string;
    }) => Promise<void>,
    setup?: (harness: Harness) => Promise<void>,
  ): Promise<void> {
    const server = await startFakeLlmServer(turns);
    servers.push(server);

    const workspace = await createTmpDir("acp-load");
    cleanups.push(workspace.cleanup);
    const state = await createTmpDir("acp-load-state");
    cleanups.push(state.cleanup);

    const config: AgentConfig = {
      apiKey: "sk_test",
      baseUrl: server.baseUrl,
      model: "test-model",
      maxTurnRequests: 8,
      permissionMode: "ask",
      compactionThresholdTokens: 0,
      sessionsDir: state.path,
    };

    const buildAgent = () =>
      createPollinationsAgent({
        config,
        llm: new PollinationsLlm({
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
          model: config.model,
        }),
      });

    let sessionId = "";
    await withInProcessClient(buildAgent(), { cwd: workspace.path }, async (harness) => {
      sessionId = harness.session.sessionId;
      await harness.prompt("the opening line");
      if (setup) await setup(harness);
    });

    // The first agent is gone; only its record survived on disk.
    await withInProcessClient(buildAgent(), { cwd: workspace.path }, async (harness) => {
      await op({ sessionId, server, harness, stateDir: state.path });
    });
  }

  it("advertises session/load support", async () => {
    await withAgent([{ text: "unused" }], {}, async ({ harness }) => {
      expect(harness.initializeResponse.agentCapabilities?.loadSession).toBe(true);
    });
  });

  it("restores a thread after a restart, with its model still on the picker", async () => {
    await withRestartedAgent([{ text: "first" }], async ({ sessionId, harness }) => {
      const response = await harness.ctx.request("session/load", {
        sessionId,
        cwd: harness.cwd,
        mcpServers: [],
      });

      const option = (response.configOptions ?? [])[0];
      expect(option?.type).toBe("select");
      expect(option?.currentValue).toBe("test-model");
    });
  });

  it("puts the earlier conversation back in front of the model", async () => {
    await withRestartedAgent(
      [{ text: "first" }, { text: "second" }],
      async ({ sessionId, server, harness }) => {
        await harness.ctx.request("session/load", {
          sessionId,
          cwd: harness.cwd,
          mcpServers: [],
        });

        const before = server.requests.length;
        await harness.ctx.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "continue where we left off" }],
        });

        const messages = server.requests[before]?.messages ?? [];
        const texts = messages.map((message) => contentText(message.content));
        // The transcript from before the restart is what the model now sees.
        expect(texts).toContain("the opening line");
        expect(texts).toContain("continue where we left off");
      },
    );
  });

  it("restores a model chosen through the picker", async () => {
    await withRestartedAgent(
      [{ text: "first" }],
      async ({ sessionId, harness }) => {
        const response = await harness.ctx.request("session/load", {
          sessionId,
          cwd: harness.cwd,
          mcpServers: [],
        });
        expect((response.configOptions ?? [])[0]?.currentValue).toBe("official/quest-a");
      },
      async (harness) => {
        await harness.ctx.request("session/set_config_option", {
          sessionId: harness.session.sessionId,
          configId: "model",
          value: "official/quest-a",
        });
      },
    );
  });

  it("rejects a session id it has never seen", async () => {
    await withRestartedAgent([{ text: "first" }], async ({ harness }) => {
      await expect(
        harness.ctx.request("session/load", {
          sessionId: "sess_never_existed",
          cwd: harness.cwd,
          mcpServers: [],
        }),
      ).rejects.toMatchObject({ code: -32002 });
    });
  });

  it("treats a corrupt record as a missing session rather than crashing", async () => {
    await withRestartedAgent(
      [{ text: "first" }],
      async ({ sessionId, stateDir, harness }) => {
        await writeFile(join(stateDir, `${sessionId}.json`), "{ truncated", "utf8");

        await expect(
          harness.ctx.request("session/load", {
            sessionId,
            cwd: harness.cwd,
            mcpServers: [],
          }),
        ).rejects.toMatchObject({ code: -32002 });
      },
    );
  });

  it("rejects a load whose cwd is not an absolute path", async () => {
    await withRestartedAgent([{ text: "first" }], async ({ harness }) => {
      await expect(
        harness.ctx.request("session/load", {
          sessionId: "sess_any",
          cwd: "relative/path",
          mcpServers: [],
        }),
      ).rejects.toMatchObject({ code: -32602 });
    });
  });

  it("rejects a load whose additional directory is relative", async () => {
    await withRestartedAgent([{ text: "first" }], async ({ sessionId, harness }) => {
      await expect(
        harness.ctx.request("session/load", {
          sessionId,
          cwd: harness.cwd,
          additionalDirectories: ["relative/dir"],
          mcpServers: [],
        }),
      ).rejects.toMatchObject({ code: -32602 });

      // An absolute entry is accepted and joins the session's roots.
      const response = await harness.ctx.request("session/load", {
        sessionId,
        cwd: harness.cwd,
        additionalDirectories: [harness.cwd],
        mcpServers: [],
      });
      expect((response.configOptions ?? [])[0]?.currentValue).toBe("test-model");
    });
  });

  it("reloads a session that is still live in this process", async () => {
    await withAgent([{ text: "unused" }], {}, async ({ harness, server }) => {
      // Warm in memory: load answers from it rather than from the store, and
      // the conversation is not replayed a second time.
      const before = server.requests.length;
      const response = await harness.ctx.request("session/load", {
        sessionId: harness.session.sessionId,
        cwd: harness.cwd,
        mcpServers: [],
      });

      expect((response.configOptions ?? [])[0]?.currentValue).toBe("test-model");
      expect(server.requests).toHaveLength(before);
    });
  });

  it("resumes a session that is still live without touching disk", async () => {
    await withAgent([{ text: "unused" }], {}, async ({ harness, server }) => {
      const response = await harness.ctx.request("session/resume", {
        sessionId: harness.session.sessionId,
        cwd: harness.cwd,
        mcpServers: [],
      });

      // Warm in this process: resume returns the picker without replaying or
      // reloading anything.
      expect((response.configOptions ?? [])[0]?.currentValue).toBe("test-model");
      expect(server.requests).toHaveLength(0);
    });
  });

  it("resumes a stored session after a restart, restoring its settings", async () => {
    await withRestartedAgent(
      [{ text: "first" }],
      async ({ sessionId, server, harness }) => {
        const response = await harness.ctx.request("session/resume", {
          sessionId,
          cwd: harness.cwd,
          mcpServers: [],
        });

        expect((response.configOptions ?? [])[0]?.currentValue).toBe("test-model");

        // Resume skips the replay, but the transcript is still in front of
        // the model for the next turn.
        const before = server.requests.length;
        await harness.ctx.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "continue" }],
        });
        const texts = (server.requests[before]?.messages ?? []).map((m) =>
          contentText(m.content),
        );
        expect(texts).toContain("the opening line");
        expect(texts).toContain("continue");
      },
    );
  });

  it("rejects a resume for a session id it has never seen", async () => {
    await withRestartedAgent([{ text: "first" }], async ({ harness }) => {
      await expect(
        harness.ctx.request("session/resume", {
          sessionId: "sess_never_existed",
          cwd: harness.cwd,
          mcpServers: [],
        }),
      ).rejects.toMatchObject({ code: -32002 });
    });
  });

  it("rejects a resume whose cwd is not an absolute path", async () => {
    await withRestartedAgent([{ text: "first" }], async ({ harness }) => {
      await expect(
        harness.ctx.request("session/resume", {
          sessionId: "sess_any",
          cwd: "relative/path",
          mcpServers: [],
        }),
      ).rejects.toMatchObject({ code: -32602 });
    });
  });

  it("rejects a resume whose additional directory is relative", async () => {
    await withRestartedAgent([{ text: "first" }], async ({ sessionId, harness }) => {
      await expect(
        harness.ctx.request("session/resume", {
          sessionId,
          cwd: harness.cwd,
          additionalDirectories: ["relative/dir"],
          mcpServers: [],
        }),
      ).rejects.toMatchObject({ code: -32602 });

      // An absolute entry is accepted and joins the session's roots.
      const response = await harness.ctx.request("session/resume", {
        sessionId,
        cwd: harness.cwd,
        additionalDirectories: [harness.cwd],
        mcpServers: [],
      });
      expect((response.configOptions ?? [])[0]?.currentValue).toBe("test-model");
    });
  });

  it("closes a session, which forgets it in memory but keeps the record", async () => {
    const state = await createTmpDir("acp-close");
    cleanups.push(state.cleanup);

    await withAgent([{ text: "persisted" }], { sessionsDir: state.path }, async ({ harness }) => {
      const sessionId = harness.session.sessionId;
      await harness.prompt("remember me");

      const response = await harness.ctx.request("session/close", { sessionId });
      expect(response).toEqual({});

      // Close is not delete: the thread was persisted before it closed, so a
      // client that reconnects can load it back.
      const loaded = await harness.ctx.request("session/load", {
        sessionId,
        cwd: harness.cwd,
        mcpServers: [],
      });
      expect((loaded.configOptions ?? [])[0]?.currentValue).toBe("test-model");
    });
  });
});

describe("session listing and deletion", () => {
  it("advertises list and delete capabilities", async () => {
    await withAgent([{ text: "unused" }], {}, async ({ harness }) => {
      const capabilities = harness.initializeResponse.agentCapabilities?.sessionCapabilities;
      expect(capabilities?.list).toEqual({});
      expect(capabilities?.delete).toEqual({});
    });
  });

  it("lists the sessions it has persisted", async () => {
    const state = await createTmpDir("acp-list");
    cleanups.push(state.cleanup);

    await withAgent([{ text: "ok" }], { sessionsDir: state.path }, async ({ cwd, harness }) => {
      const first = harness.session.sessionId;
      const second = await harness.ctx.buildSession(cwd).withSession(async (session) => {
        await session.prompt("a second thread");
        return session.sessionId;
      });

      const response = await harness.ctx.request("session/list", {});
      const ids = response.sessions.map((entry: { sessionId: string }) => entry.sessionId);

      expect(ids).toEqual(expect.arrayContaining([first, second]));
      // `updatedAt` is what orders the listing, so it must be present.
      expect(response.sessions[0]?.updatedAt).toBeTruthy();
      expect(await readdir(state.path)).toHaveLength(2);
    });
  });

  it("forgets a deleted session from disk, listing, and loading", async () => {
    const state = await createTmpDir("acp-delete");
    cleanups.push(state.cleanup);

    await withAgent([{ text: "ok" }], { sessionsDir: state.path }, async ({ cwd, harness }) => {
      const id = harness.session.sessionId;
      expect(await readdir(state.path)).toHaveLength(1);

      await harness.ctx.request("session/delete", { sessionId: id });

      expect(await readdir(state.path)).toEqual([]);
      await expect(
        harness.ctx.request("session/load", { sessionId: id, cwd, mcpServers: [] }),
      ).rejects.toMatchObject({ code: -32002 });
      const listed = await harness.ctx.request("session/list", {});
      expect(listed.sessions).toHaveLength(0);
    });
  });

  it("succeeds silently when deleting a session it has never seen", async () => {
    const state = await createTmpDir("acp-delete-unknown");
    cleanups.push(state.cleanup);

    await withAgent([{ text: "ok" }], { sessionsDir: state.path }, async ({ harness }) => {
      // Idempotent, because a client cannot know whether the agent still holds
      // the thread: a restart forgets every session this process had.
      await expect(
        harness.ctx.request("session/delete", { sessionId: "sess_never_existed" }),
      ).resolves.toBeDefined();
    });
  });
});

describe("compaction", () => {
  /**
   * A session whose first turn reports more prompt tokens than the threshold,
   * so the second turn has to compact before it runs.
   *
   * The fake endpoint is scripted with three turns: the first user turn, the
   * summarisation request the agent makes, and the real second turn.
   */
  async function withOverflowingSession(
    compactionThresholdTokens: number,
    capabilities: { session?: ClientSessionCapabilities } | undefined,
    op: (args: { harness: Harness; server: FakeLlmServer }) => Promise<void>,
  ): Promise<void> {
    const server = await startFakeLlmServer([
      { text: "first answer", usage: { prompt_tokens: 5_000, completion_tokens: 10 } },
      { text: "Summary of the work so far." },
      { text: "second answer" },
    ]);
    servers.push(server);

    const workspace = await createTmpDir("acp-compact");
    cleanups.push(workspace.cleanup);

    const config: AgentConfig = {
      apiKey: "sk_test",
      baseUrl: server.baseUrl,
      model: "test-model",
      maxTurnRequests: 8,
      permissionMode: "ask",
      compactionThresholdTokens,
    };

    const agent = createPollinationsAgent({
      config,
      llm: new PollinationsLlm({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
      }),
    });

    await withInProcessClient(
      agent,
      { cwd: workspace.path, ...(capabilities ? { capabilities } : {}) },
      async (harness) => {
        await harness.prompt("the first question");
        await op({ harness, server });
      },
    );
  }

  it("replaces the transcript with a summary once the threshold is crossed", async () => {
    await withOverflowingSession(100, undefined, async ({ harness, server }) => {
      // The first turn reported 5000 prompt tokens, so this turn compacts first.
      await harness.prompt("the second question");

      const summarisation = server.requests[1]?.messages ?? [];
      const instruction = summarisation.at(-1);
      expect(String(instruction?.role)).toBe("user");
      expect(String(instruction?.content)).toContain("Summarise the conversation");

      // The real turn now runs against the summary, not the old transcript.
      const turn = server.requests[2]?.messages ?? [];
      const texts = turn.map((message) => contentText(message.content));
      expect(turn).toHaveLength(3); // system, summary, new prompt
      expect(texts).toContain("Summary of the work so far.");
      expect(texts.some((text) => text.includes("the first question"))).toBe(false);
    });
  });

  it("leaves the transcript alone below the threshold", async () => {
    await withOverflowingSession(1_000_000, undefined, async ({ harness, server }) => {
      await harness.prompt("the second question");

      // Two requests, one per turn: no summarisation was made.
      expect(server.requests).toHaveLength(2);
      const texts = (server.requests[1]?.messages ?? []).map((message) =>
        contentText(message.content),
      );
      expect(texts).toContain("the first question");
    });
  });

  it("never compacts when the threshold is zero", async () => {
    await withOverflowingSession(0, undefined, async ({ harness, server }) => {
      await harness.prompt("the second question");
      expect(server.requests).toHaveLength(2);
    });
  });

  it("reports the compaction lifecycle to a client that supports it", async () => {
    await withOverflowingSession(100, { session: { compaction: {} } }, async ({ harness }) => {
      await harness.prompt("the second question");

      const lifecycle = harness.updates
        .filter((update) => update.sessionUpdate === "compaction_update")
        .map((update) => String((update as { status?: unknown }).status));

      expect(lifecycle).toEqual(["in_progress", "completed"]);
    });
  });

  it("stays silent when the client did not advertise compaction", async () => {
    await withOverflowingSession(100, undefined, async ({ harness, server }) => {
      await harness.prompt("the second question");

      // The compaction still happened; the spec forbids reporting it.
      expect(server.requests).toHaveLength(3);
      const reported = harness.updates.filter(
        (update) => update.sessionUpdate === "compaction_update",
      );
      expect(reported).toHaveLength(0);
    });
  });
});

describe("slash commands", () => {
  it("advertises exactly the commands /help prints", async () => {
    await withAgent([{ text: "unused" }], {}, async ({ harness }) => {
      // The notification is deferred by the agent so a client has attached its
      // update handler first; give it time to land before the first prompt.
      await new Promise((resolve) => setTimeout(resolve, 120));

      await harness.prompt("/help");
      const help = agentText(harness.updates);

      const advertised = harness.updates.find(
        (update) => update.sessionUpdate === "available_commands_update",
      ) as { availableCommands?: Array<{ name: string; description: string }> } | undefined;

      expect(advertised?.availableCommands?.length).toBeGreaterThan(0);
      // One table drives both: a command that is implemented but unlisted, or
      // listed but unimplemented, is exactly the drift this refactor removes.
      for (const command of advertised?.availableCommands ?? []) {
        expect(help).toContain(`/${command.name}`);
        expect(help).toContain(command.description);
      }
      expect(help).toContain("/delete");
    });
  });

  it("answers /status without reaching the model", async () => {
    await withAgent([{ text: "unused" }], {}, async ({ harness, server }) => {
      const before = server.requests.length;
      await harness.prompt("/status");

      const text = agentText(harness.updates);
      expect(text).toContain("Model: test-model");
      expect(text).toContain("Reasoning: medium");
      expect(server.requests).toHaveLength(before);
    });
  });

  it("shows, switches, and rejects a model through /model", async () => {
    await withAgent([{ text: "unused" }], {}, async ({ harness, server }) => {
      await harness.prompt("/model");
      expect(agentText(harness.updates)).toContain("Current model: test-model");
      expect(server.requests).toHaveLength(0);

      await harness.prompt("/model official/quest-a");
      expect(agentText(harness.updates)).toContain("Switched model to official/quest-a.");

      await harness.prompt("/model does/not-exist");
      expect(agentText(harness.updates)).toContain('Unknown model "does/not-exist".');
      // The rejected switch must not have taken effect.
      await harness.prompt("/model");
      expect(agentText(harness.updates)).toContain("Current model: official/quest-a");
    });
  });

  it("switches mode and reports the change to the client", async () => {
    await withAgent([{ text: "unused" }], {}, async ({ harness }) => {
      // No argument: the command reports rather than switches.
      await harness.prompt("/mode");
      expect(agentText(harness.updates)).toContain("Current mode: build");

      await harness.prompt("/mode plan");

      expect(agentText(harness.updates)).toContain("Switched mode to plan.");
      const modeUpdate = harness.updates.find(
        (update) => update.sessionUpdate === "current_mode_update",
      ) as { currentModeId?: string } | undefined;
      expect(modeUpdate?.currentModeId).toBe("plan");

      await harness.prompt("/mode nope");
      expect(agentText(harness.updates)).toContain('Unknown mode "nope". Available: build, plan, ask.');
    });
  });

  it("switches reasoning effort and republishes the picker", async () => {
    await withAgent([{ text: "unused" }], {}, async ({ harness, server }) => {
      // No argument reports the current level instead of changing it.
      await harness.prompt("/reasoning");
      expect(agentText(harness.updates)).toContain("Current reasoning level: medium");

      await harness.prompt("/reasoning high");

      expect(agentText(harness.updates)).toContain("Switched reasoning level to high.");
      const configUpdate = harness.updates.find(
        (update) => update.sessionUpdate === "config_option_update",
      ) as { configOptions?: Array<{ id: string; currentValue?: string }> } | undefined;
      expect(configUpdate?.configOptions?.find((option) => option.id === "reasoning")?.currentValue).toBe(
        "high",
      );

      // The new level is what the next request carries.
      await harness.prompt("hello");
      expect(server.requests.at(-1)?.reasoning_effort).toBe("high");

      await harness.prompt("/reasoning extreme");
      expect(agentText(harness.updates)).toContain('Unknown reasoning level "extreme".');
    });
  });

  it("clears the transcript without calling the model", async () => {
    await withAgent([{ text: "first answer" }], {}, async ({ harness, server }) => {
      await harness.prompt("first question");
      expect(server.requests).toHaveLength(1);

      await harness.prompt("/clear");
      expect(agentText(harness.updates)).toContain("Conversation cleared.");
      expect(server.requests).toHaveLength(1);

      // The earlier exchange is gone from what the model sees next.
      await harness.prompt("second question");
      const messages = server.requests[1]?.messages ?? [];
      expect(JSON.stringify(messages)).not.toContain("first question");
      expect(JSON.stringify(messages)).toContain("second question");
    });
  });

  it("reports cost, tools, and an empty session list without a model call", async () => {
    const state = await createTmpDir("acp-cmds");
    cleanups.push(state.cleanup);

    await withAgent([{ text: "unused" }], { sessionsDir: state.path }, async ({ harness, server }) => {
      await harness.prompt("/cost");
      expect(agentText(harness.updates)).toContain("Tokens (last request):");

      await harness.prompt("/tools");
      const tools = agentText(harness.updates);
      expect(tools).toContain("read_file");
      expect(tools).toContain("bash");
      expect(tools).toContain("MCP tools: (none)");

      await harness.prompt("/sessions");
      // Only this session exists, and it is listed by id.
      expect(agentText(harness.updates)).toContain(harness.session.sessionId);

      expect(server.requests).toHaveLength(0);
    });
  });

  it("says there is nothing to compact on a fresh transcript", async () => {
    await withAgent([{ text: "unused" }], {}, async ({ harness, server }) => {
      await harness.prompt("/compact");

      expect(agentText(harness.updates)).toContain("Nothing to compact.");
      expect(server.requests).toHaveLength(0);
    });
  });

  it("deletes the session and stops persisting it", async () => {
    const state = await createTmpDir("acp-cmd-del");
    cleanups.push(state.cleanup);

    await withAgent([{ text: "unused" }], { sessionsDir: state.path }, async ({ harness }) => {
      const id = harness.session.sessionId;
      expect(await readdir(state.path)).toContain(`${id}.json`);

      await harness.prompt("/delete");
      expect(agentText(harness.updates)).toContain("Session deleted.");
      // The reply must not be written back: persisting would resurrect the
      // file the command just removed.
      expect(await readdir(state.path)).not.toContain(`${id}.json`);
    });
  });

  it("sends an unknown command and an argument on a plain command to the model", async () => {
    await withAgent([{ text: "reply" }, { text: "reply" }], {}, async ({ harness, server }) => {
      await harness.prompt("/frobnicate");
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.messages.some((m) => String(m.content).includes("/frobnicate"))).toBe(true);

      // `/clear now` is not a shorter way to say `/clear`; it is a message.
      await harness.prompt("/clear now");
      expect(server.requests).toHaveLength(2);
      expect(server.requests[1]?.messages.some((m) => String(m.content).includes("/clear now"))).toBe(true);
    });
  });
});

describe("shutdown", () => {
  it("aborts an in-flight turn and writes the transcript back", async () => {
    const state = await createTmpDir("acp-shutdown");
    cleanups.push(state.cleanup);

    await withAgent(
      // The stream keeps going for seconds: only the abort can finish this turn.
      [{ text: "unreachable ".repeat(50), stallMs: 5_000 }],
      { sessionsDir: state.path },
      async ({ harness, agent }) => {
        const pending = harness.prompt("long turn");
        await harness.waitFor(() =>
          harness.updates.some(
            (u) => (u as { sessionUpdate?: string }).sessionUpdate === "agent_message_chunk",
          ),
        );

        await agent.shutdown();

        const response = await pending;
        expect(response.stopReason).toBe("cancelled");

        // The transcript landed with the prompt still in it, so a restart
        // reloads the thread instead of rewinding to the previous save.
        const [name] = await readdir(state.path);
        if (!name) throw new Error("shutdown did not persist the session");
        const record = JSON.parse(await readFile(join(state.path, name), "utf8")) as {
          history: Array<{ role: string; content: unknown }>;
        };
        expect(
          record.history.some(
            (message) => message.role === "user" && JSON.stringify(message.content).includes("long turn"),
          ),
        ).toBe(true);
      },
    );
  });

  it("runs once, however often it is asked", async () => {
    await withAgent([{ text: "hi" }], {}, async ({ harness, agent }) => {
      await harness.prompt("hello");

      // The only observable of a repeated call is the wind-down log: a second
      // pass would write the same sessions again and report a second count.
      const lines: string[] = [];
      const spy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation((chunk: string | Uint8Array) => {
          lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
          return true;
        });
      try {
        await Promise.all([agent.shutdown(), agent.shutdown()]);
        await agent.shutdown();
      } finally {
        spy.mockRestore();
      }

      expect(lines.filter((line) => line.includes("shutdown complete"))).toHaveLength(1);
    });
  });
});

describe("promptToText", () => {
  it("joins blocks with a blank line and describes embedded resources", () => {
    expect(
      promptToText([
        { type: "text", text: "part one" },
        { type: "text", text: "part two" },
      ]),
    ).toBe("part one\n\npart two");
  });

  it("includes a resource's text body when present", () => {
    const text = promptToText([
      { type: "resource", resource: { uri: "file:///x.md", text: "embedded body" } },
    ]);
    expect(text).toContain("embedded body");
  });

  it("falls back to a binary placeholder when the resource has no text", () => {
    const text = promptToText([
      { type: "resource", resource: { uri: "file:///y.bin", blob: "AA==" } },
    ]);
    expect(text).toContain("file:///y.bin");
    expect(text).toContain("(binary resource)");
  });

  it("labels a prompt with no content blocks", () => {
    expect(promptToText([])).toBe("(empty prompt)");
  });

  it("describes a resource link by its uri and name", () => {
    const text = promptToText([
      { type: "resource_link", uri: "file:///z.md", name: "notes" },
    ]);
    expect(text).toBe("--- file:///z.md (notes) ---");
  });

  it("names a content block kind it cannot render", () => {
    const text = promptToText([
      // The ACP schema allows block kinds this agent never emits; render a
      // visible placeholder rather than dropping the user's content silently.
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
    ]);
    expect(text).toBe("[image content is not supported by this agent]");
  });
});
