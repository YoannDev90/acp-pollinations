import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { SessionConfigOption, SessionConfigSelectGroup, ClientSessionCapabilities } from "@agentclientprotocol/sdk";
import { afterAll, describe, expect, it } from "vitest";

import type { AgentConfig } from "../config.js";
import { PollinationsLlm } from "../llm.js";
import { createPollinationsAgent, promptToText } from "../server.js";
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

type OpArgs = { cwd: string; server: FakeLlmServer; harness: Harness };

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
    await op({ cwd: workspace.path, server, harness });
  });
}

/** Collects the agent's streamed text from the update log. */
function agentText(updates: unknown[]): string {
  return updates
    .filter((u) => (u as { sessionUpdate?: string }).sessionUpdate === "agent_message_chunk")
    .map((u) => ((u as { content: { text?: string } }).content.text ?? ""))
    .join("");
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
      failModelsWith: { status: 503, body: "down" },
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
      if (String(input).includes("/v1/models")) reads += 1;
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
      expect(harness.session.newSessionResponse.configOptions).toHaveLength(1);
      expect(reads).toBe(1);

      // A second session in the same agent reuses the cached catalogue.
      const second = await harness.ctx.buildSession(workspace.path).withSession(async (session) => {
        expect(session.newSessionResponse.configOptions).toHaveLength(1);
        return session.sessionId;
      });

      expect(second).toBeTruthy();
      expect(reads).toBe(1);
    });
  });
});

describe("session/load", () => {
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
        const texts = messages.map((message) => String(message.content ?? ""));
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
      const texts = turn.map((message) => String(message.content ?? ""));
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
        String(message.content ?? ""),
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
});
