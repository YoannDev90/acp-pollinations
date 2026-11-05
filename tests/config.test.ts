import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  resolveApiKey,
  resolveConfig,
  resolveEnvConfig,
} from "../src/config.js";
import { createTmpDir } from "./helpers/tmp.js";

const cleanups: Array<() => Promise<void>> = [];

afterAll(async () => {
  await Promise.all(cleanups.map((cleanup) => cleanup()));
});

/** Builds an isolated `$POLLINATIONS_HOME` holding the given JSON files. */
async function homeWith(files: Record<string, unknown>): Promise<string> {
  const dir = await createTmpDir("acp-config");
  cleanups.push(dir.cleanup);
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir.path, name), JSON.stringify(body));
  }
  return dir.path;
}

describe("resolveApiKey", () => {
  it("prefers the environment over every file", async () => {
    const home = await homeWith({
      "config-acp": { api_key: "from_config" },
      "credentials.json": { apiKey: "from_credentials" },
    });

    const key = await resolveApiKey({
      env: { POLLINATIONS_API_KEY: "from_env", POLLINATIONS_HOME: home },
    });

    expect(key).toBe("from_env");
  });

  it("reads the documented api_key spelling from the config file", async () => {
    const home = await homeWith({ "config-acp": { api_key: "from_config" } });

    expect(await resolveApiKey({ env: { POLLINATIONS_HOME: home } })).toBe("from_config");
  });

  it("reads the spellings older releases used", async () => {
    const camel = await homeWith({ "config-acp.json": { apiKey: "camel" } });
    expect(await resolveApiKey({ env: { POLLINATIONS_HOME: camel } })).toBe("camel");

    const snake = await homeWith({ "config-acp.json": { pollinations_api_key: "snake" } });
    expect(await resolveApiKey({ env: { POLLINATIONS_HOME: snake } })).toBe("snake");
  });

  it("falls back to the credentials file the CLI writes", async () => {
    const home = await homeWith({ "credentials.json": { apiKey: "sk_login" } });

    expect(await resolveApiKey({ env: { POLLINATIONS_HOME: home } })).toBe("sk_login");
  });

  it("finds nothing when no source has a key", async () => {
    const home = await homeWith({});

    expect(await resolveApiKey({ env: { POLLINATIONS_HOME: home } })).toBe("");
    // An empty string, not a throw: `initialize` must still answer so the
    // client can report a missing key instead of a dead process.
    expect(await resolveApiKey({ env: { POLLINATIONS_HOME: "/nonexistent/acp-home" } })).toBe("");
  });

  it("ignores a config file that is not an object", async () => {
    const dir = await createTmpDir("acp-config-broken");
    cleanups.push(dir.cleanup);
    await mkdir(dir.path, { recursive: true });
    await writeFile(join(dir.path, "config-acp"), "not json at all");
    await writeFile(join(dir.path, "credentials.json"), JSON.stringify({ apiKey: "sk_real" }));

    // A corrupt config degrades to the next source rather than to a crash.
    expect(await resolveApiKey({ env: { POLLINATIONS_HOME: dir.path } })).toBe("sk_real");
  });

  it("ignores a credentials file that is not an object", async () => {
    const dir = await createTmpDir("acp-config-scalar");
    cleanups.push(dir.cleanup);
    await writeFile(join(dir.path, "credentials.json"), JSON.stringify("sk_not_an_object"));

    expect(await resolveApiKey({ env: { POLLINATIONS_HOME: dir.path } })).toBe("");
  });

  it("ignores a credentials entry that is not a non-empty string", async () => {
    const home = await homeWith({ "credentials.json": { apiKey: 42 } });
    expect(await resolveApiKey({ env: { POLLINATIONS_HOME: home } })).toBe("");

    const blank = await homeWith({ "credentials.json": { apiKey: "   " } });
    expect(await resolveApiKey({ env: { POLLINATIONS_HOME: blank } })).toBe("");
  });

  it("reads the real process environment when no override is given", async () => {
    // Deliberately unscoped: the branch under test is the `process.env` side of
    // `options.env ?? process.env`, which only the argument-less call reaches.
    expect(typeof (await resolveApiKey())).toBe("string");
    expect(typeof (await resolveApiKey({ credentialsFile: "/nonexistent/creds.json" }))).toBe(
      "string",
    );
  });
});

describe("resolveEnvConfig", () => {
  it("takes each setting from the environment first", () => {
    const config = resolveEnvConfig(
      {
        POLLINATIONS_BASE_URL: "https://example.test/",
        POLLINATIONS_MODEL: "env-model",
        ACP_PERMISSION_MODE: "allow",
        ACP_MAX_TURN_REQUESTS: "7",
      },
      "sk",
      { model: "file-model", baseUrl: "https://file.test", permission_mode: "ask" },
    );

    expect(config.baseUrl).toBe("https://example.test");
    expect(config.model).toBe("env-model");
    expect(config.permissionMode).toBe("allow");
    expect(config.maxTurnRequests).toBe(7);
  });

  it("falls back to the config file and then to defaults", () => {
    const config = resolveEnvConfig({}, "sk", { model: "file-model" });

    expect(config.model).toBe("file-model");
    expect(config.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(config.permissionMode).toBe("ask");
  });

  it("treats a negative compaction threshold as disabled", () => {
    expect(resolveEnvConfig({ ACP_COMPACTION_THRESHOLD_TOKENS: "-1" }, "sk").compactionThresholdTokens).toBe(
      -1,
    );
    expect(resolveEnvConfig({ ACP_COMPACTION_THRESHOLD_TOKENS: "junk" }, "sk").compactionThresholdTokens).toBe(
      0,
    );
  });

  it("reads snake_case settings from the config file", () => {
    const config = resolveEnvConfig({}, "sk", {
      permission_mode: "allow",
      base_url: "https://snake.test",
      max_turn_requests: 9,
      compaction_threshold_tokens: 5000,
    });

    expect(config.permissionMode).toBe("allow");
    expect(config.baseUrl).toBe("https://snake.test");
    expect(config.maxTurnRequests).toBe(9);
    expect(config.compactionThresholdTokens).toBe(5000);
  });

  it("reads camelCase settings from the config file", () => {
    const config = resolveEnvConfig({}, "sk", {
      permissionMode: "allow",
      baseUrl: "https://camel.test",
      maxTurnRequests: 4,
      compactionThresholdTokens: 1500,
    });

    expect(config.permissionMode).toBe("allow");
    expect(config.baseUrl).toBe("https://camel.test");
    expect(config.maxTurnRequests).toBe(4);
    expect(config.compactionThresholdTokens).toBe(1500);
  });

  it("skips non-scalar settings instead of stringifying them", () => {
    // A typo'd object would otherwise reach `parseInt` as "[object Object]".
    const config = resolveEnvConfig({}, "sk", {
      max_turn_requests: { oops: true },
      compaction_threshold_tokens: ["nope"],
    });

    expect(config.maxTurnRequests).toBe(24);
    expect(config.compactionThresholdTokens).toBe(0);
  });
});

describe("resolveConfig", () => {
  it("resolves the whole configuration from the environment", async () => {
    const home = await homeWith({ "config-acp": { api_key: "sk_config" } });
    const previousKey = process.env.POLLINATIONS_API_KEY;
    const previousHome = process.env.POLLINATIONS_HOME;
    process.env.POLLINATIONS_API_KEY = "sk_env";
    process.env.POLLINATIONS_HOME = home;

    try {
      const config = await resolveConfig();

      expect(config.apiKey).toBe("sk_env");
      expect(config.baseUrl).toBe(DEFAULT_BASE_URL);
      expect(config.model).toBe(DEFAULT_MODEL);
      expect(config.sessionsDir).toBe(join(home, "sessions"));
      expect(config.permissionMode).toBe("ask");
    } finally {
      if (previousKey === undefined) delete process.env.POLLINATIONS_API_KEY;
      else process.env.POLLINATIONS_API_KEY = previousKey;
      if (previousHome === undefined) delete process.env.POLLINATIONS_HOME;
      else process.env.POLLINATIONS_HOME = previousHome;
    }
  });

  it("honours an explicit environment override", async () => {
    const home = await homeWith({ "config-acp": { api_key: "sk_config" } });
    const config = await resolveConfig({ env: { POLLINATIONS_HOME: home } });

    expect(config.apiKey).toBe("sk_config");
    expect(config.sessionsDir).toBe(join(home, "sessions"));
  });

  it("reports a missing key instead of refusing to start", async () => {
    const home = await homeWith({});
    const config = await resolveConfig({ env: { POLLINATIONS_HOME: home } });

    expect(config.apiKey).toBe("");
    expect(config.model).toBe(DEFAULT_MODEL);
  });

  it("falls back to the home directory when no home is configured", async () => {
    // No `POLLINATIONS_HOME` at all: the agent must still produce a usable
    // configuration, whichever key the machine happens to hold.
    const config = await resolveConfig({ env: {} });

    expect(typeof config.apiKey).toBe("string");
    expect(config.baseUrl).toBeTruthy();
  });
});
