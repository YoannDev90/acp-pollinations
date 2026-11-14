import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { spawn } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";

import type { AgentConfig } from "../src/config.js";
import {
  DEFAULT_SETTINGS_FILE_NAME,
  SETTINGS_FILE_NAMES,
  ensureSettingsFile,
  findSettingsFile,
  openSettingsFile,
  readSettingsFile,
  readSettingsFileAt,
} from "../src/settings-file.js";
import { createTmpDir } from "./helpers/tmp.js";

const cleanups: Array<() => Promise<void>> = [];

afterAll(async () => {
  await Promise.all(cleanups.map((cleanup) => cleanup()));
});

/** An isolated directory, registered for cleanup. */
async function tmpDir(prefix: string): Promise<string> {
  const dir = await createTmpDir(prefix);
  cleanups.push(dir.cleanup);
  return dir.path;
}

/** A configuration shaped the way `resolveConfig` would have produced it. */
function configWith(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    apiKey: "sk_test",
    baseUrl: "https://example.test",
    model: "test-model",
    maxTurnRequests: 8,
    permissionMode: "ask",
    compactionThresholdTokens: 0,
    defaultMode: "build",
    defaultReasoning: "medium",
    ...overrides,
  };
}

type SpawnOutcome = "spawn" | "error" | "both" | "throw";
type FakeChild = {
  once(event: string, listener: () => void): FakeChild;
  unref(): void;
};

/**
 * A `spawn` double that records every launch and reports how each child
 * behaved.
 *
 * A real one would open an editor window on the machine running the test,
 * and "the binary is not there" is the interesting case anyway: it is what
 * makes the candidate list fall through to the next entry.
 */
function fakeSpawn(behaviour: (command: string) => SpawnOutcome): {
  calls: Array<{ command: string; args: string[] }>;
  spawnImpl: typeof spawn;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  const unrefed: string[] = [];

  const spawnImpl = ((command: string, args: string[]) => {
    calls.push({ command, args });
    const outcome = behaviour(command);
    if (outcome === "throw") throw new Error("no such binary");

    const child: FakeChild = {
      once(event: string, listener: () => void): typeof child {
        // `both` fires `spawn` and then `error`: the second settle has to be
        // ignored, or a platform emitting both would flip a successful open.
        if (outcome === "both" || event === outcome) listener();
        return child;
      },
      unref(): void {
        unrefed.push(command);
      },
    };
    return child;
  }) as unknown as typeof import("node:child_process").spawn;

  return { calls, spawnImpl };
}

describe("settings file probe", () => {
  it("offers the oldest spelling first, so existing setups keep working", () => {
    expect(SETTINGS_FILE_NAMES[0]).toBe(DEFAULT_SETTINGS_FILE_NAME);
    expect([...SETTINGS_FILE_NAMES]).toEqual([
      DEFAULT_SETTINGS_FILE_NAME,
      "config-acp.json",
      "config.json",
    ]);
  });

  it("reads the first candidate that parses as an object", async () => {
    const home = await tmpDir("acp-settings-probe");
    await writeFile(join(home, "config-acp"), JSON.stringify({ model: "first" }));
    await writeFile(join(home, "config-acp.json"), JSON.stringify({ model: "second" }));
    await writeFile(join(home, "config.json"), JSON.stringify({ model: "third" }));

    expect(await readSettingsFile(home)).toEqual({ model: "first" });
    expect(await findSettingsFile(home)).toBe(join(home, "config-acp"));
  });

  it("falls past a candidate that is corrupt or is not an object", async () => {
    const home = await tmpDir("acp-settings-corrupt");
    await writeFile(join(home, "config-acp"), "{ not json");
    await writeFile(join(home, "config-acp.json"), "[1, 2]");
    await writeFile(join(home, "config.json"), JSON.stringify({ model: "survivor" }));

    expect(await readSettingsFile(home)).toEqual({ model: "survivor" });
    expect(await findSettingsFile(home)).toBe(join(home, "config.json"));
  });

  it("reports where a file would be created when none exists", async () => {
    const home = await tmpDir("acp-settings-empty");

    expect(await readSettingsFile(home)).toEqual({});
    expect(await findSettingsFile(home)).toBe(join(home, DEFAULT_SETTINGS_FILE_NAME));
  });

  it("reads one exact file instead of probing a home directory", async () => {
    const home = await tmpDir("acp-settings-exact");
    const path = join(home, "custom.json");
    await writeFile(path, JSON.stringify({ model: "exact" }));

    expect(await readSettingsFileAt(path)).toEqual({ model: "exact" });
  });

  it("degrades to no settings when the exact file cannot be used", async () => {
    const home = await tmpDir("acp-settings-unusable");
    const missing = join(home, "missing.json");
    const malformed = join(home, "malformed.json");
    const list = join(home, "list.json");
    const scalar = join(home, "scalar.json");
    await writeFile(malformed, "{ not json");
    await writeFile(list, "[1, 2]");
    await writeFile(scalar, '"just a string"');

    for (const path of [missing, malformed, list, scalar]) {
      expect(await readSettingsFileAt(path)).toEqual({});
    }
  });
});

describe("ensureSettingsFile", () => {
  it("writes a starter file seeded with the settings in effect", async () => {
    const home = await tmpDir("acp-settings-create");
    const path = join(home, "nested", "config-acp");

    const result = await ensureSettingsFile(path, configWith());

    expect(result).toEqual({ path, created: true });
    const written = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    // The key is seeded empty on purpose: a secret must not be copied into a
    // file just because it happened to be in the environment.
    expect(written.api_key).toBe("");
    expect(written).toMatchObject({
      model: "test-model",
      base_url: "https://example.test",
      permission_mode: "ask",
      max_turn_requests: 8,
      compaction_threshold_tokens: 0,
      default_mode: "build",
      default_reasoning: "medium",
      mcp_servers: [],
    });
    // Absent means "auto"; writing `[]` would switch discovery off forever.
    expect(written).not.toHaveProperty("skill_roots");
  });

  it("records skill roots when the operator already pinned them", async () => {
    const home = await tmpDir("acp-settings-roots");
    const path = join(home, "config-acp");

    await ensureSettingsFile(path, configWith({ skillRoots: [] }));

    const written = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(written.skill_roots).toEqual([]);
  });

  it("never touches a file that already exists", async () => {
    const home = await tmpDir("acp-settings-existing");
    const path = join(home, "config-acp");
    await writeFile(path, '{"model":"hand-edited"}');

    const result = await ensureSettingsFile(path, configWith());

    expect(result).toEqual({ path, created: false });
    expect(await readFile(path, "utf8")).toBe('{"model":"hand-edited"}');
  });

  it("keeps the file a concurrent /config created first", async () => {
    const home = await tmpDir("acp-settings-race");
    const path = join(home, "config-acp");
    // A dangling symlink fails `access` (so this call believes the file is
    // missing) yet is still a path, so the exclusive create loses the race —
    // exactly the window the `wx` flag exists for.
    await symlink(join(home, "never-written"), path);

    const result = await ensureSettingsFile(path, configWith());

    expect(result).toEqual({ path, created: false });
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  it("fails loudly when the parent path is not a directory", async () => {
    const home = await tmpDir("acp-settings-blocked");
    const blocker = join(home, "blocker");
    await writeFile(blocker, "in the way");

    await expect(ensureSettingsFile(join(blocker, "config-acp"), configWith())).rejects.toThrow();
  });
});

describe("openSettingsFile", () => {
  it("prefers $VISUAL and keeps its flags", async () => {
    const { calls, spawnImpl } = fakeSpawn(() => "spawn");

    const result = await openSettingsFile("/tmp/config-acp", {
      env: { VISUAL: "code --wait", EDITOR: "vim" },
      spawnImpl,
    });

    expect(result).toEqual({ opened: true, via: "VISUAL" });
    expect(calls).toEqual([{ command: "code", args: ["--wait", "/tmp/config-acp"] }]);
  });

  it("skips a blank $VISUAL and uses $EDITOR", async () => {
    const { calls, spawnImpl } = fakeSpawn(() => "spawn");

    const result = await openSettingsFile("/tmp/config-acp", {
      env: { VISUAL: "   ", EDITOR: "vim" },
      spawnImpl,
    });

    expect(result).toEqual({ opened: true, via: "EDITOR" });
    expect(calls).toEqual([{ command: "vim", args: ["/tmp/config-acp"] }]);
  });

  it("falls back to the platform opener when no editor is configured", async () => {
    const { calls, spawnImpl } = fakeSpawn(() => "spawn");

    const result = await openSettingsFile("/tmp/config-acp", { env: {}, spawnImpl });

    // Windows has no file opener, so there is nothing to try without an
    // editor configured; the other platforms have one.
    if (process.platform === "win32") {
      expect(result).toEqual({ opened: false, via: "" });
      expect(calls).toEqual([]);
      return;
    }

    expect(result.opened).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["/tmp/config-acp"]);
    // `xdg-open` on Linux, `open` on macOS.
    expect(["xdg-open", "open"]).toContain(result.via);
  });

  it("tries the next candidate when one cannot start", async () => {
    const { calls, spawnImpl } = fakeSpawn((command) => (command === "code" ? "error" : "spawn"));

    const result = await openSettingsFile("/tmp/config-acp", {
      env: { VISUAL: "code", EDITOR: "vim" },
      spawnImpl,
    });

    expect(result).toEqual({ opened: true, via: "EDITOR" });
    expect(calls.map((call) => call.command)).toEqual(["code", "vim"]);
  });

  it("reports failure when every candidate is unavailable", async () => {
    const { spawnImpl } = fakeSpawn(() => "error");

    const result = await openSettingsFile("/tmp/config-acp", {
      env: { VISUAL: "code", EDITOR: "vim" },
      spawnImpl,
    });

    expect(result).toEqual({ opened: false, via: "" });
  });

  it("treats a spawn that throws as a candidate that could not start", async () => {
    const { spawnImpl } = fakeSpawn(() => "throw");

    const result = await openSettingsFile("/tmp/config-acp", {
      env: { EDITOR: "vim" },
      spawnImpl,
    });

    expect(result).toEqual({ opened: false, via: "" });
  });

  it("settles once when a child reports both spawn and error", async () => {
    const { spawnImpl } = fakeSpawn(() => "both");

    const result = await openSettingsFile("/tmp/config-acp", {
      env: { EDITOR: "vim" },
      spawnImpl,
    });

    expect(result).toEqual({ opened: true, via: "EDITOR" });
  });
});
