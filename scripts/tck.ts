#!/usr/bin/env tsx
/**
 * Runs the ACP conformance suite (acp-tck) against the built agent.
 *
 * Two hazards drove the shape of this script, both of which silently produce a
 * verdict about something other than the code in front of you:
 *
 *   - A stale `dist/`. The suite launches the *built* binary, so a `dist/` older
 *     than the sources certifies yesterday's agent. The build is refreshed here
 *     whenever any source file is newer than the entry point.
 *   - The developer's real `~/.pollinations`. `session/list` and `session/delete`
 *     are conformance requirements, so the suite really does delete sessions.
 *     Pointed at the default home it would have been deleting the operator's own,
 *     and reading them into `session/list` assertions besides. `POLLINATIONS_HOME`
 *     is redirected at a scratch tree that is wiped before every run.
 *
 * The agent is wired to a local fake Pollinations endpoint, so a run needs no
 * API key, costs nothing, and is repeatable — including under CI. `TCK_LIVE=1`
 * swaps the real API in, which is the only way to exercise the actual
 * tool-calling loop but bills for every request.
 *
 * `TCK_REF` overrides the pinned acp-tck commit; `TCK_LIVE=1` needs a real
 * `POLLINATIONS_API_KEY` in the environment.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import type { RecordedRequest } from "../tests/helpers/fake-llm-server.js";
import { startFakeLlmServer } from "../tests/helpers/fake-llm-server.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TCK_DIR = join(ROOT, ".tools", "acp-tck");
const SCRATCH = join(ROOT, ".tck");
const WORKSPACE = join(SCRATCH, "workspace");
const HOME = join(SCRATCH, "home");
const REPORT = join(SCRATCH, "report.json");
const ENTRY = join(ROOT, "dist", "bin", "pollinations-acp-server.js");
const TCK_URL = "https://github.com/EugeneTheDev/acp-tck";

/**
 * Pinned so a green verdict means the same thing next month as it did today.
 * The suite's own requirements and verdict rules change under it, which is the
 * whole reason not to silently float on `main`.
 */
const DEFAULT_TCK_REF = "b7f40fb3c003c45926547be5a1f7e2b374035815";

/**
 * Only the cancellation tests need a prompt the agent stays busy on, and the
 * fake endpoint stalls exactly when it sees this token. A distinctive one keeps
 * a stale transcript entry from stalling an unrelated later turn.
 */
const CANCEL_TOKEN = "TCK-CANCEL-STALL";

/** How long the fake endpoint withholds its final frame on the cancel prompt. */
const CANCEL_STALL_MS = 8_000;

const rel = (path: string): string => relative(ROOT, path) || ".";

function log(message: string): void {
  process.stderr.write(`tck: ${message}\n`);
}

function fail(message: string): never {
  process.stderr.write(`tck: ${message}\n`);
  process.exit(2);
}

/** Newest modification time among the files `tsc` actually compiles. */
function newestSourceMtime(): number {
  const roots = [
    join(ROOT, "bin"),
    join(ROOT, "tests"),
    join(ROOT, "tsconfig.json"),
    join(ROOT, "package.json"),
    ...readdirSync(ROOT)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => join(ROOT, name)),
  ];

  let newest = 0;
  const walk = (path: string): void => {
    const stat = statSync(path);
    if (!stat.isDirectory()) {
      newest = Math.max(newest, stat.mtimeMs);
      return;
    }
    for (const entry of readdirSync(path)) {
      // `dist/` and `node_modules/` carry no source of truth for the build.
      if (entry === "node_modules" || entry === "dist") continue;
      walk(join(path, entry));
    }
  };
  for (const path of roots) walk(path);
  return newest;
}

function ensureBuilt(): void {
  const stale =
    !existsSync(ENTRY) || statSync(ENTRY).mtimeMs < newestSourceMtime();
  if (!stale) return;

  log("dist/ is missing or older than the sources; rebuilding");
  const build = spawnSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
  if (build.status !== 0) fail("the build failed; nothing to test");
}

function ensureTck(ref: string): void {
  if (existsSync(join(TCK_DIR, ".git"))) return;

  log(`cloning acp-tck into ${rel(TCK_DIR)}`);
  mkdirSync(dirname(TCK_DIR), { recursive: true });

  // A full clone rather than a shallow one: `git checkout <sha>` cannot reach a
  // pinned commit from a `--depth 1` clone of `main` without a second fetch.
  const clone = spawnSync("git", ["clone", "--quiet", TCK_URL, TCK_DIR], {
    stdio: "inherit",
  });
  if (clone.status !== 0) fail(`could not clone ${TCK_URL}`);

  const checkout = spawnSync("git", ["-C", TCK_DIR, "checkout", "--quiet", ref], {
    stdio: "inherit",
  });
  if (checkout.status !== 0) {
    fail(`acp-tck has no commit ${ref}; set TCK_REF to a real one`);
  }
}

/** True when any user message carries the cancellation token. */
function isCancelPrompt(request: RecordedRequest): boolean {
  return request.messages.some((message) => {
    if (message.role !== "user") return false;
    const content = message.content;
    if (typeof content === "string") return content.includes(CANCEL_TOKEN);
    if (!Array.isArray(content)) return false;
    return content.some((part) => {
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" && text.includes(CANCEL_TOKEN);
    });
  });
}

/**
 * One content frame, then silence.
 *
 * The frame matters: an agent that never receives anything may well treat the
 * turn as a transport failure and complete it, which is not the same as a turn
 * that was cancelled while genuinely in flight.
 */
const STALL_FRAME = `data: ${JSON.stringify({
  choices: [{ delta: { content: "…" } }],
})}\n\n`;

async function main(): Promise<void> {
  const live = process.env.TCK_LIVE?.trim() === "1";
  const ref = process.env.TCK_REF?.trim() || DEFAULT_TCK_REF;

  ensureBuilt();
  ensureTck(ref);

  // The suite is destructive by design, so it gets its own disposable home and
  // workspace rather than the operator's.
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(WORKSPACE, { recursive: true });
  mkdirSync(HOME, { recursive: true });

  const args = [
    "--project", TCK_DIR,
    "run", "acp-tck",
    "--agent-cwd", WORKSPACE,
    "--timeout", "90",
    "--test-timeout", "300",
    "--cancel-prompt", CANCEL_TOKEN,
    "--report-json", REPORT,
    // `session/new` refuses to run without a key, and the tool path asks the
    // client for permission before writing — neither of which the harness is
    // scripted to answer.
    "--agent-env", "POLLINATIONS_API_KEY=tck-dummy-key",
    "--agent-env", `POLLINATIONS_HOME=${HOME}`,
    "--agent-env", "ACP_PERMISSION_MODE=allow",
    "--",
    "node", ENTRY,
  ];

  const server = live
    ? null
    : await startFakeLlmServer([], {
        turnFor: (request) =>
          isCancelPrompt(request)
            ? { rawFrames: [STALL_FRAME], stallMs: CANCEL_STALL_MS }
            : { text: "Done." },
      });

  if (server) {
    args.splice(args.indexOf("--"), 0, "--agent-env", `POLLINATIONS_BASE_URL=${server.baseUrl}`);
    log(`fake Pollinations endpoint on ${server.baseUrl} (TCK_LIVE=1 for the real API)`);
  } else if (!process.env.POLLINATIONS_API_KEY?.trim()) {
    fail("TCK_LIVE=1 needs a real POLLINATIONS_API_KEY in the environment");
  }

  log(`acp-tck @ ${ref.slice(0, 12)} — ${live ? "live API" : "fake endpoint"}`);

  const code = await new Promise<number | null>((resolve) => {
    const child = spawn("uv", args, { cwd: ROOT, stdio: "inherit" });
    child.on("exit", resolve);
    child.on("error", () => resolve(1));
  });

  await server?.close();

  const verdict = code === 0 ? "CONFORMANT" : "NOT CONFORMANT";
  log(`${verdict} (exit ${code}) — report at ${rel(REPORT)}`);
  process.exit(code ?? 1);
}

await main();
