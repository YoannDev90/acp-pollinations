#!/usr/bin/env node
// ACP agent entry point: newline-delimited JSON-RPC over stdio.

import { Readable, Writable } from "node:stream";

import { ndJsonStream } from "@agentclientprotocol/sdk";

import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { resolveConfig } from "../config.js";
import { installFileLogger } from "../logger.js";
import { AGENT_TITLE, AGENT_VERSION, createPollinationsAgent } from "../server.js";

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

const connection = createPollinationsAgent({ config }).connect(ndJsonStream(output, input));

// Exit once the client closes stdin, after stdout has had a chance to flush.
void connection.closed.then(() => {
  setTimeout(() => process.exit(process.exitCode ?? 0), 50);
});
