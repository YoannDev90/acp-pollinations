#!/usr/bin/env node
// ACP agent entry point: newline-delimited JSON-RPC over stdio.

import { Readable, Writable } from "node:stream";

import { ndJsonStream } from "@agentclientprotocol/sdk";

import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { resolveConfig } from "../src/config.js";
import { installFileLogger } from "../src/logger.js";
import { AGENT_TITLE, AGENT_VERSION, createPollinationsAgent } from "../src/agent/server.js";

const config = await resolveConfig();

// Mirror stderr to a file so diagnostics survive editor-launched processes.
const home = config.sessionsDir
  ? dirname(config.sessionsDir)
  : (process.env.POLLINATIONS_HOME?.trim() || join(homedir(), ".pollinations"));
installFileLogger(home);

if (!config.apiKey) {
  // Not fatal: `initialize` and session setup still work so clients get a
  // useful error instead of a dead process. Generation fails at `session/new`.
  process.stderr.write(
    `${AGENT_TITLE}: no Pollinations API key found. ` +
      "Set POLLINATIONS_API_KEY or run `polli auth login`.\n",
  );
}

process.stderr.write(
  `${AGENT_TITLE} ACP agent v${AGENT_VERSION} (model: ${config.model}, base: ${config.baseUrl})\n`,
);

const output = Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>;
const input = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;

const agent = createPollinationsAgent({ config });
const connection = agent.connect(ndJsonStream(output, input));

/**
 * Hard ceiling on how long a wind-down may take, in milliseconds.
 *
 * A child that refuses to die or a disk that will not take a session write
 * must not leave an editor waiting for a process that never exits.
 */
const SHUTDOWN_BUDGET_MS = 2_000;

let windDownRun: Promise<number> | null = null;

/**
 * The exit code the process would leave with right now.
 *
 * Node types `process.exitCode` as `number | string | null | undefined`, so
 * it is narrowed instead of handed to `process.exit` as-is.
 */
function pendingExitCode(): number {
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}

/**
 * Runs the wind-down once and resolves with the exit code to leave with.
 *
 * Signals and a closed connection both end up here, and they arrive in pairs:
 * a SIGTERM is followed moments later by the stdio EOF it causes. Every
 * caller joins the same run — a second `exitAfterWindDown` scheduled off a
 * fresh result would fire while the first wind-down was still writing
 * transcripts, and cut it short at the exit delay.
 */
function windDown(reason: string): Promise<number> {
  windDownRun ??= (async () => {
    process.stderr.write(`${AGENT_TITLE}: shutting down (${reason})\n`);

    const budget = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, SHUTDOWN_BUDGET_MS);
      timer.unref();
    });

    try {
      await Promise.race([agent.shutdown(), budget]);
      // This wind-down may itself have started because the connection closed;
      // closing it again must not turn a clean exit into a failure.
      try {
        connection.close();
      } catch {
        // Already closed.
      }
    } catch (error) {
      process.stderr.write(
        `${AGENT_TITLE}: shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
    return pendingExitCode();
  })();
  return windDownRun;
}

/** Leaves after a short delay, so a last line of output can reach the wire. */
function exitAfterWindDown(code: number): void {
  setTimeout(() => process.exit(code), 50);
}

// Exit once the client closes stdin, after stdout has had a chance to flush.
void connection.closed.then(() => {
  void windDown("connection closed").then(exitAfterWindDown);
});

// An editor stopping the agent sends a signal. Node's default is to kill the
// process outright, which skips the transcript write and leaves MCP children
// to be reaped by whoever spawned them.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void windDown(signal).then(exitAfterWindDown);
    // Safety net: if the wind-down never settles, leave anyway. Unref'd so it
    // can never be the reason the process stays alive.
    const timer = setTimeout(() => process.exit(pendingExitCode()), SHUTDOWN_BUDGET_MS + 500);
    timer.unref();
  });
}
