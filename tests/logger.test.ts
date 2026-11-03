import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { installFileLogger } from "../src/logger.js";
import { createTmpDir } from "./helpers/tmp.js";

const cleanups: Array<() => Promise<void>> = [];
/** The real stderr, restored after every test so vitest keeps its output. */
const realWrite = process.stderr.write.bind(process.stderr);
/** Roots whose logger is still installed, unwound after each test. */
let installed: string | null = null;

afterEach(async () => {
  process.stderr.write = realWrite as typeof process.stderr.write;
  installed = null;
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/**
 * Installs a logger rooted in a fresh directory and returns its log path.
 *
 * The previous logger is unhooked first: `installFileLogger` wraps whatever
 * `stderr.write` currently is, so without this each test would write through
 * every earlier test's wrapper as well.
 */
async function install(maxBytes?: number): Promise<string> {
  if (installed) process.stderr.write = realWrite as typeof process.stderr.write;
  const dir = await createTmpDir("acp-logger");
  cleanups.push(dir.cleanup);
  installed = dir.path;
  return maxBytes === undefined
    ? installFileLogger(dir.path)
    : installFileLogger(dir.path, maxBytes);
}

describe("installFileLogger", () => {
  it("mirrors stderr into a timestamped file", async () => {
    const logFile = await install();

    process.stderr.write("hello from the agent\n");

    const contents = await readFile(logFile, "utf8");
    expect(contents).toContain("hello from the agent");
    // The timestamp is what makes interleaved sessions readable later.
    expect(contents).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] hello from the agent/m);
  });

  it("leaves the terminal output unadorned", async () => {
    const dir = await createTmpDir("acp-logger-plain");
    cleanups.push(dir.cleanup);
    installed = dir.path;

    // Install over a capture, so the wrapper's "original" write is what we
    // observe: the file gets the timestamp, the terminal must not.
    const seen: string[] = [];
    process.stderr.write = ((chunk: unknown) => {
      seen.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    const logFile = installFileLogger(dir.path);

    process.stderr.write("plain line\n");

    expect(seen).toEqual(["plain line\n"]);
    expect(await readFile(logFile, "utf8")).toContain("[");
    expect(await readFile(logFile, "utf8")).toContain("plain line");
  });

  it("counts pre-existing content against the rotation budget", async () => {
    const dir = await createTmpDir("acp-logger-existing");
    cleanups.push(dir.cleanup);
    await mkdir(join(dir.path, "logs"), { recursive: true });
    // A restart must not reset the budget, or the file would reach twice the
    // ceiling before the first rotation of the new process. The content is
    // there before the logger opens, which is exactly what `sizeOf` reads.
    const existing = "x".repeat(190);
    await writeFile(join(dir.path, "logs", "pollinations-acp-server.log"), existing);

    const logFile = installFileLogger(dir.path, 200);
    installed = dir.path;
    process.stderr.write("p\n");

    expect((await stat(logFile)).size).toBeLessThan(200);
    expect(await readFile(`${logFile}.1`, "utf8")).toBe(existing);
  });

  it("rotates the live file and keeps a bounded number of generations", async () => {
    const logFile = await install(64);

    for (let i = 0; i < 20; i += 1) process.stderr.write(`MARK-${i} ${"line".repeat(20)}\n`);

    const files = (await readdir(dirname(logFile))).filter((name) =>
      name.startsWith("pollinations-acp-server.log"),
    );
    // Live file plus `.1`, `.2`, `.3`: nothing grows without bound.
    expect(files.sort()).toEqual(
      [
        "pollinations-acp-server.log",
        "pollinations-acp-server.log.1",
        "pollinations-acp-server.log.2",
        "pollinations-acp-server.log.3",
      ].sort(),
    );

    // The newest write is in the live file; generation `.3` is the oldest and
    // must predate it.
    expect(await readFile(logFile, "utf8")).toContain("MARK-19");
    expect(await readFile(`${logFile}.3`, "utf8")).not.toContain("MARK-19");
  });

  it("keeps writing to stderr when the log file cannot be written", async () => {
    const dir = await createTmpDir("acp-logger-blocked");
    cleanups.push(dir.cleanup);
    // A directory where the log file belongs makes every append throw.
    await mkdir(join(dir.path, "logs", "pollinations-acp-server.log"), { recursive: true });

    const seen: string[] = [];
    process.stderr.write = ((chunk: unknown) => {
      seen.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    const logFile = installFileLogger(dir.path);
    process.stderr.write("still reaches the terminal\n");

    // Logging must never take down the agent: the write still went through.
    expect(seen).toEqual(["still reaches the terminal\n"]);
    expect(typeof logFile).toBe("string");
  });
});
