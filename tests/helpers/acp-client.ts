import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  PROTOCOL_VERSION,
  client as createClientApp,
  methods,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import type {
  ActiveSession,
  AgentApp,
  ClientContext,
  ClientSessionCapabilities,
  ContentBlock,
  InitializeResponse,
  PromptResponse,
  RequestPermissionRequest,
  SessionUpdate,
  Stream,
} from "@agentclientprotocol/sdk";

/**
 * Test-only ACP client.
 *
 * This is *not* a product client: the ACP SDK already provides `client()`,
 * `ndJsonStream`, session routing, and schema validation. What lives here is
 * the small set of client-side behaviours an agent needs a counterparty for —
 * filesystem, terminal, and permission handlers — wired to the real disk so a
 * prompt turn can be exercised end to end without an editor.
 */
export type Harness = {
  ctx: ClientContext;
  session: ActiveSession;
  initializeResponse: InitializeResponse;
  cwd: string;
  /** Every `session/request_permission` the agent sent, in order. */
  permissionRequests: RequestPermissionRequest[];
  /** Every `session/update` streamed so far, in order. */
  updates: SessionUpdate[];
  /** Commands run in a client-side terminal, in order. */
  terminalCommands: string[];
  /** Files returned by `fs/read_text_file` regardless of disk state. */
  virtualFiles: Map<string, string>;
  /** Answer to permission prompts; return an `optionId`, or `null` to cancel. */
  answerPermission?: (request: RequestPermissionRequest) => string | null;
  /** Whether the client advertises `fs`, `terminal`, and session capabilities. */
  capabilities?: {
    fs?: boolean;
    terminal?: boolean;
    session?: ClientSessionCapabilities;
  };
  /** Sends a prompt and drains updates until the turn stops. */
  prompt: (input: string | ContentBlock[]) => Promise<PromptResponse>;
  /** Waits until `predicate` holds over the streamed updates. */
  waitFor: (predicate: () => boolean, timeoutMs?: number) => Promise<void>;
};

type BaseOptions = {
  cwd: string;
  capabilities?: {
    fs?: boolean;
    terminal?: boolean;
    session?: ClientSessionCapabilities;
  };
  answerPermission?: (request: RequestPermissionRequest) => string | null;
};

type ClientAppWithHarness = {
  harness: HarnessInternal;
  app: ReturnType<typeof createClientApp>;
};

/** Runs `op` against an in-process agent, connected directly (no transport). */
export async function withInProcessClient(
  agent: AgentApp,
  options: BaseOptions,
  op: (harness: Harness) => Promise<void>,
): Promise<void> {
  const { harness, app } = buildClientApp(options);
  await app.connectWith(agent, (ctx) => runScenario(ctx, harness, op));
}

/** Runs `op` against an agent subprocess over newline-delimited JSON stdio. */
export async function withSubprocessClient(
  command: string[],
  options: BaseOptions & { env?: Record<string, string | undefined> },
  op: (harness: Harness & { stderr: () => string; kill: () => void }) => Promise<void>,
): Promise<void> {
  const child: ChildProcess = spawn(command[0] as string, command.slice(1), {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...options.env },
  });

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const output = Writable.toWeb(child.stdin!) as unknown as WritableStream<Uint8Array>;
  const input = Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(output, input);
  const { harness, app } = buildClientApp(options);

  try {
    await app.connectWith(stream, (ctx) =>
      runScenario(ctx, harness, (h) =>
        op({ ...h, stderr: () => stderr, kill: () => child.kill("SIGKILL") }),
      ),
    );
  } finally {
    if (!child.killed) child.kill("SIGKILL");
  }
}

/* ------------------------------------------------------------------ *
 * Internals
 * ------------------------------------------------------------------ */

type HarnessInternal = Harness;

function buildClientApp(options: BaseOptions): ClientAppWithHarness {
  const terminals = new Map<string, RunningTerminal>();
  let terminalCounter = 0;

  const harness: HarnessInternal = {
    ctx: null as unknown as ClientContext,
    session: null as unknown as ActiveSession,
    initializeResponse: null as unknown as InitializeResponse,
    cwd: options.cwd,
    permissionRequests: [],
    updates: [],
    terminalCommands: [],
    virtualFiles: new Map(),
    capabilities: options.capabilities,
    answerPermission: options.answerPermission,
    prompt: async () => {
      throw new Error("prompt() is only available inside a scenario");
    },
    waitFor: async () => {
      throw new Error("waitFor() is only available inside a scenario");
    },
  };

  const app = createClientApp({ name: "test-client" })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      harness.permissionRequests.push(params);
      const answer = harness.answerPermission
        ? harness.answerPermission(params)
        : (params.options.find((option) => option.kind.startsWith("allow"))?.optionId ?? null);

      return answer === null
        ? { outcome: { outcome: "cancelled" } }
        : { outcome: { outcome: "selected", optionId: answer } };
    })
    .onRequest(methods.client.fs.readTextFile, async ({ params }) => {
      const virtual = harness.virtualFiles.get(params.path);
      if (virtual !== undefined) return { content: sliceLines(virtual, params.line, params.limit) };

      try {
        const content = await readFile(params.path, "utf8");
        return { content: sliceLines(content, params.line, params.limit) };
      } catch {
        throw new Error(`File not found: ${params.path}`);
      }
    })
    .onRequest(methods.client.fs.writeTextFile, async ({ params }) => {
      harness.virtualFiles.set(params.path, params.content);
      await mkdir(dirname(params.path), { recursive: true });
      await writeFile(params.path, params.content, "utf8");
      return {};
    })
    .onRequest(methods.client.terminal.create, async ({ params }) => {
      harness.terminalCommands.push([params.command, ...(params.args ?? [])].join(" "));
      const id = `term_${++terminalCounter}`;
      terminals.set(id, startLocalTerminal(params.command, params.args ?? [], params.cwd));
      return { terminalId: id };
    })
    .onRequest(methods.client.terminal.output, async ({ params }) => {
      const terminal = requireTerminal(terminals, params.terminalId);
      return {
        output: terminal.output,
        truncated: terminal.truncated,
        exitStatus: terminal.exited
          ? { exitCode: terminal.exitCode, signal: terminal.signal }
          : null,
      };
    })
    .onRequest(methods.client.terminal.waitForExit, async ({ params }) => {
      const terminal = requireTerminal(terminals, params.terminalId);
      await terminal.exitedP;
      return { exitCode: terminal.exitCode, signal: terminal.signal };
    })
    .onRequest(methods.client.terminal.kill, async ({ params }) => {
      requireTerminal(terminals, params.terminalId).child.kill("SIGKILL");
      return {};
    })
    .onRequest(methods.client.terminal.release, async ({ params }) => {
      const terminal = terminals.get(params.terminalId);
      if (terminal && !terminal.exited) terminal.child.kill("SIGKILL");
      terminals.delete(params.terminalId);
      return {};
    })
    .onNotification("*", ({ method }) => {
      // Nothing to do: this exists so updates for a session the harness did not
      // open itself — a reloaded one — are consumed instead of blocking the
      // agent on a notification nobody reads.
      void method;
    });

  return { harness, app };
}

async function runScenario(
  ctx: ClientContext,
  harness: HarnessInternal,
  op: (harness: Harness) => Promise<void>,
): Promise<void> {
  harness.ctx = ctx;

  harness.initializeResponse = await ctx.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      ...(harness.capabilities?.fs === false ? {} : { fs: { readTextFile: true, writeTextFile: true } }),
      ...(harness.capabilities?.terminal === false ? {} : { terminal: true }),
      ...(harness.capabilities?.session ? { session: harness.capabilities.session } : {}),
    },
  });

  await ctx.buildSession(harness.cwd).withSession(async (session) => {
    harness.session = session;

    harness.prompt = (input) => {
      const pending = session.prompt(input);
      // Drain updates concurrently so nothing is dropped while the turn runs.
      void drainUntilStop(session, harness.updates);
      return pending;
    };
    harness.waitFor = (predicate, timeoutMs = 5_000) =>
      waitFor(predicate, harness.updates, timeoutMs);

    await op(harness);
  });
}

async function drainUntilStop(session: ActiveSession, sink: SessionUpdate[]): Promise<void> {
  for (;;) {
    const message = await session.nextUpdate();
    if (message.kind === "stop") return;
    sink.push(message.update);
  }
}

async function waitFor(predicate: () => boolean, updates: SessionUpdate[], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (updates.length > 10_000) throw new Error("waitFor: too many updates");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitFor: condition not met before timeout");
}

type RunningTerminal = {
  child: ChildProcess;
  output: string;
  truncated: boolean;
  exited: boolean;
  exitCode: number | null;
  signal: string | null;
  exitedP: Promise<void>;
};

const TERMINAL_OUTPUT_LIMIT = 256 * 1024;

function startLocalTerminal(command: string, args: string[], cwd?: string | null): RunningTerminal {
  const child = spawn(command, args, {
    cwd: cwd ?? process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const terminal: RunningTerminal = {
    child,
    output: "",
    truncated: false,
    exited: false,
    exitCode: null,
    signal: null,
    exitedP: new Promise(() => undefined),
  };

  const collect = (chunk: Buffer) => {
    if (terminal.output.length >= TERMINAL_OUTPUT_LIMIT) {
      terminal.truncated = true;
      return;
    }
    terminal.output += chunk.toString("utf8");
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  terminal.exitedP = new Promise((resolve) => {
    child.on("close", (code, signal) => {
      terminal.exited = true;
      terminal.exitCode = code;
      terminal.signal = signal;
      resolve();
    });
    child.on("error", () => {
      terminal.exited = true;
      resolve();
    });
  });

  return terminal;
}

function requireTerminal(
  terminals: Map<string, RunningTerminal>,
  id: string,
): RunningTerminal {
  const terminal = terminals.get(id);
  if (!terminal) throw new Error(`Unknown terminal: ${id}`);
  return terminal;
}

function sliceLines(content: string, line?: number | null, limit?: number | null): string {
  if (line == null && limit == null) return content;
  const lines = content.split("\n");
  const start = Math.max(0, (line ?? 1) - 1);
  const end = limit == null ? lines.length : start + limit;
  return lines.slice(start, end).join("\n");
}

/** Removes a scratch workspace. */
export async function removeTree(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
