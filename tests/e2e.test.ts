import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { withSubprocessClient } from "./helpers/acp-client.js";
import type { Harness } from "./helpers/acp-client.js";
import { startFakeLlmServer } from "./helpers/fake-llm-server.js";
import type { FakeLlmServer, FakeTurn } from "./helpers/fake-llm-server.js";
import { createTmpDir } from "./helpers/tmp.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const binary = join(projectRoot, "dist", "bin", "pollinations-acp-server.js");

type ProcessHarness = Harness & { stderr: () => string; kill: () => void };
type Op = (harness: ProcessHarness, server: FakeLlmServer) => Promise<void>;

/**
 * Spawns the compiled agent over stdio and runs `op` against it.
 *
 * This is the only test that exercises the real process boundary: the same
 * `ndJsonStream` transport, the same env-driven config, and the same binary
 * an editor would launch.
 */
async function withAgentProcess(turns: FakeTurn[], op: Op): Promise<void> {
  const server = await startFakeLlmServer(turns);
  const workspace = await createTmpDir("acp-e2e");

  try {
    await access(binary, constants.R_OK);
  } catch {
    throw new Error(`Agent binary not built: ${binary}. Run \`npm run build\` first.`);
  }

  try {
    await withSubprocessClient(
      ["node", binary],
      {
        cwd: workspace.path,
        env: {
          POLLINATIONS_API_KEY: "sk_e2e",
          POLLINATIONS_BASE_URL: server.baseUrl,
          POLLINATIONS_MODEL: "e2e-model",
          // Never inherit a developer's real credentials into the child.
          POLLINATIONS_HOME: workspace.path,
          ACP_PERMISSION_MODE: "ask",
        },
      },
      async (harness) => op(harness, server),
    );
  } finally {
    await workspace.cleanup();
    await server.close();
  }
}

/** Collects streamed agent text from the update log. */
function agentText(updates: unknown[]): string {
  return updates
    .filter((u) => (u as { sessionUpdate?: string }).sessionUpdate === "agent_message_chunk")
    .map((u) => ((u as { content: { text?: string } }).content.text ?? ""))
    .join("");
}

describe("pollinations-acp-server (subprocess)", () => {
  it("answers initialize over the real stdio wire", async () => {
    await withAgentProcess([], async (harness) => {
      expect(harness.initializeResponse.protocolVersion).toBe(1);
      expect(harness.initializeResponse.agentInfo?.name).toBe("pollinations");
      // The banner goes to stderr so it never corrupts the JSON-RPC stream.
      expect(harness.stderr()).toContain("Pollinations ACP agent");
    });
  });

  it("completes a text-only prompt turn across the process boundary", async () => {
    await withAgentProcess([{ text: "pong" }], async (harness) => {
      const response = await harness.prompt("ping");

      expect(response.stopReason).toBe("end_turn");
      expect(agentText(harness.updates)).toBe("pong");
    });
  });

  it("streams tool_call updates and honors a permission grant", async () => {
    const turns: FakeTurn[] = [
      {
        toolCalls: [
          {
            id: "call_e2e",
            name: "write_file",
            arguments: JSON.stringify({ path: "made.txt", content: "from subprocess" }),
          },
        ],
      },
      { text: "done" },
    ];

    await withAgentProcess(turns, async (harness) => {
      const response = await harness.prompt("create made.txt");

      expect(response.stopReason).toBe("end_turn");
      expect(harness.permissionRequests).toHaveLength(1);
      expect(harness.permissionRequests[0]?.toolCall.name).toBe("write_file");

      // The write landed in the real workspace directory.
      expect(await readFile(join(harness.cwd, "made.txt"), "utf8")).toBe("from subprocess");
    });
  });

  it("sends the configured model and API key on the wire", async () => {
    await withAgentProcess([{ text: "ok" }], async (harness, server) => {
      await harness.prompt("hi");

      const request = server.requests[0];
      expect(request?.model).toBe("e2e-model");
      expect(request?.stream).toBe(true);
      expect(request?.authorization).toBe("Bearer sk_e2e");
    });
  });

  it("sends the offered tools alongside the prompt", async () => {
    await withAgentProcess([{ text: "ok" }], async (harness, server) => {
      await harness.prompt("hi");

      const names = server.requests[0]?.tools?.map((tool) => tool.function.name) ?? [];
      expect(names).toContain("read_file");
      expect(names).toContain("write_file");
      expect(names).toContain("bash");
    });
  });
});
