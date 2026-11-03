import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { resolveApiKey, resolveEnvConfig } from "../src/config.js";
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
    const home = await homeWith({
      "config-acp": { api_key: "from_config" },
      "credentials.json": { apiKey: "from_credentials" },
    });

    const key = await resolveApiKey({ env: { POLLINATIONS_HOME: home } });

    // The README documents `api_key`; a user copying it must not silently
    // fall through to a different key or to none at all.
    expect(key).toBe("from_config");
  });

  it("still accepts the legacy spellings", async () => {
    const camel = await homeWith({ "config-acp": { apiKey: "camel" } });
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
    expect(config.baseUrl).toBe("https://gen.pollinations.ai");
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
});
