import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { AgentConfig } from "./config.js";

/**
 * Name written when no settings file exists yet: the oldest spelling, which
 * every released setup already probes first.
 */
export const DEFAULT_SETTINGS_FILE_NAME = "config-acp";

/**
 * Candidate settings file names, in probe order.
 *
 * Several spellings exist because released setups use all of them; the first
 * one that parses wins, and `/config` opens exactly the one in effect so the
 * file a user edits is the file the agent reads.
 */
export const SETTINGS_FILE_NAMES = [
  DEFAULT_SETTINGS_FILE_NAME,
  "config-acp.json",
  "config.json",
] as const;

/** Where a settings file lives and whether it was just written. */
export type EnsureSettingsResult = {
  path: string;
  created: boolean;
};

/** Outcome of an attempt to hand the file to an editor. */
export type OpenSettingsResult = {
  opened: boolean;
  /** How it was opened (`EDITOR`, `VISUAL`, `xdg-open`, …); empty on failure. */
  via: string;
};

/** Overrides for {@link openSettingsFile}. */
export type OpenSettingsOptions = {
  /** Environment holding `$VISUAL` / `$EDITOR`. Defaults to the process env. */
  env?: NodeJS.ProcessEnv;
  /**
   * Injected `spawn`, for tests: a real one would open a GUI window on a
   * developer's machine the first time a test runs `/config`.
   */
  spawnImpl?: typeof spawn;
};

/**
 * Reads the first settings file it finds under `home`, or an empty record.
 *
 * A missing or corrupt file is not an error: the environment and the
 * credentials file are still allowed to answer, which is what lets the agent
 * start on a machine that never had a config at all.
 */
export async function readSettingsFile(home: string): Promise<Record<string, unknown>> {
  return (await probeSettingsFile(home)).record;
}

/** Reads one exact settings file, or an empty record when it cannot be used. */
export async function readSettingsFileAt(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or malformed settings degrade to "no file settings".
  }
  return {};
}

/**
 * The settings file in effect under `home`: the first candidate that parses,
 * or the path a new one would be created at.
 *
 * Returning the would-be path rather than an existing one is what lets
 * `/config` create the file on a machine that has never had one.
 */
export async function findSettingsFile(home: string): Promise<string> {
  return (await probeSettingsFile(home)).path;
}

/** Shared probe behind {@link readSettingsFile} and {@link findSettingsFile}. */
async function probeSettingsFile(
  home: string,
): Promise<{ path: string; record: Record<string, unknown> }> {
  for (const name of SETTINGS_FILE_NAMES) {
    const path = join(home, name);
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return { path, record: parsed as Record<string, unknown> };
      }
    } catch {
      // Try the next candidate.
    }
  }
  return { path: join(home, DEFAULT_SETTINGS_FILE_NAME), record: {} };
}

/**
 * Creates the settings file with the settings currently in effect, when it is
 * missing, so `/config` always has something to open.
 *
 * Seeding with the *resolved* values is the point: an operator opening the
 * file wants to see what the agent actually runs with, not a table of
 * defaults to re-derive. `api_key` stays empty on purpose — a secret is not
 * copied into a file just because it happened to be in the environment. An
 * existing file is never touched.
 */
export async function ensureSettingsFile(
  path: string,
  config: AgentConfig,
): Promise<EnsureSettingsResult> {
  try {
    await access(path);
    return { path, created: false };
  } catch {
    // Missing is the case this function exists for.
  }

  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${JSON.stringify(settingsScaffold(config), null, 2)}\n`, {
      encoding: "utf8",
      // Exclusive: a concurrent `/config` that won the race keeps its file
      // instead of having this one overwrite what the user just started.
      flag: "wx",
    });
    return { path, created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { path, created: false };
    throw error;
  }
}

/** The starter document, spelled the way `resolveEnvConfig` reads it. */
function settingsScaffold(config: AgentConfig): Record<string, unknown> {
  const body: Record<string, unknown> = {
    api_key: "",
    model: config.model,
    base_url: config.baseUrl,
    permission_mode: config.permissionMode,
    max_turn_requests: config.maxTurnRequests,
    compaction_threshold_tokens: config.compactionThresholdTokens,
    default_mode: config.defaultMode,
    default_reasoning: config.defaultReasoning,
    mcp_servers: [],
  };
  // Absent means "auto" for skill roots; writing `[]` would silently turn
  // discovery off for every later session, so the key only appears when the
  // operator already pinned it.
  if (config.skillRoots !== undefined) body.skill_roots = config.skillRoots;
  return body;
}

/**
 * Opens the settings file without blocking on the editor.
 *
 * Order: `$VISUAL`, `$EDITOR`, then the platform's file opener, so a headless
 * box with only `xdg-open` still gets the file somewhere. The child is
 * detached and unrefed: the agent must not wait for the editor to close, and
 * an editor that outlives the session must not keep the process alive.
 * `opened: false` means every candidate failed, and the caller reports the
 * path instead of pretending the file is open.
 */
export async function openSettingsFile(
  path: string,
  options: OpenSettingsOptions = {},
): Promise<OpenSettingsResult> {
  const env = options.env ?? process.env;
  const spawnImpl = options.spawnImpl ?? spawn;

  for (const candidate of editorCandidates(env, path)) {
    if (await launch(spawnImpl, candidate.command, candidate.args)) {
      return { opened: true, via: candidate.via };
    }
  }
  return { opened: false, via: "" };
}

type LaunchCandidate = {
  command: string;
  args: string[];
  via: string;
};

/** Editors to try, most specific first; `$VISUAL` outranks `$EDITOR`. */
function editorCandidates(env: NodeJS.ProcessEnv, path: string): LaunchCandidate[] {
  const candidates: LaunchCandidate[] = [];
  for (const variable of ["VISUAL", "EDITOR"] as const) {
    const value = env[variable]?.trim();
    if (!value) continue;
    // The variable may carry flags ("code --wait"), so it splits like a
    // shell line rather than being one executable name.
    const parts = value.split(/\s+/);
    const command = parts[0];
    if (command) candidates.push({ command, args: [...parts.slice(1), path], via: variable });
  }

  const opener =
    process.platform === "darwin"
      ? { command: "open", args: [path] }
      : // `start` is a shell builtin on Windows; guessing at `cmd.exe` would
        // open a console window instead of the file, so there is no opener.
        process.platform === "win32"
        ? null
        : { command: "xdg-open", args: [path] };
  if (opener) candidates.push({ ...opener, via: opener.command });

  return candidates;
}

/**
 * Spawns one candidate and reports whether it started.
 *
 * A binary that does not exist surfaces as an `error` event rather than a
 * throw, so the promise has to watch both outcomes — and settle once, since
 * some platforms emit `spawn` and `error` for different failure modes.
 */
function launch(
  spawnImpl: typeof spawn,
  command: string,
  args: string[],
): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnImpl(command, args, { detached: true, stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }

    let settled = false;
    const settle = (opened: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(opened);
    };
    child.once("spawn", () => {
      child.unref();
      settle(true);
    });
    child.once("error", () => settle(false));
  });
}
