import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Default Pollinations API base URL (OpenAI-compatible). */
export const DEFAULT_BASE_URL = "https://gen.pollinations.ai";

/** Default coding model. Open to everyone, metered in pollen; supports tools. */
export const DEFAULT_MODEL = "z-ai/glm-5.3-flash";

/** Default ceiling on model requests inside a single prompt turn. */
export const DEFAULT_MAX_TURN_REQUESTS = 24;

/**
 * Prompt tokens at or above which a session's transcript is summarised and
 * replaced. Chosen well under typical context windows, so a long session keeps
 * working instead of quietly paying for its whole history on every turn.
 */
export const DEFAULT_COMPACTION_THRESHOLD_TOKENS = 0;

/** Resolved runtime configuration for the agent. */
export type AgentConfig = {
  /** Pollinations secret key (`sk_...`). */
  apiKey: string;
  /** API base URL, without a trailing slash. */
  baseUrl: string;
  /** Model ID used for every request in a session. */
  model: string;
  /** Maximum number of model requests within one prompt turn. */
  maxTurnRequests: number;
  /**
   * Directory holding persisted sessions, so `session/load` can restore a
   * thread after the agent process restarts. Omit to keep sessions in memory
   * only, which is what tests do.
   */
  sessionsDir?: string;
  /**
   * Prompt tokens at or above which the transcript is summarised and replaced.
   * `0` disables compaction entirely.
   */
  compactionThresholdTokens: number;
  /**
   * `ask` prompts the client before mutating the workspace, `allow` skips
   * permission requests entirely (useful for CI and demos).
   */
  permissionMode: "ask" | "allow";
};

export type ResolveConfigOptions = {
  env?: NodeJS.ProcessEnv;
  /** Explicit credentials file, defaults to `$POLLINATIONS_HOME/credentials.json`. */
  credentialsFile?: string;
};

/**
 * Reads a Pollinations API key.
 *
 * Order: `POLLINATIONS_API_KEY`, then the config file, then the `polli auth
 * login` credentials file. Returns an empty string when no source yields a
 * key, so callers can decide how to report the problem.
 */
async function readConfigFile(home: string): Promise<Record<string, unknown>> {
  for (const name of ["config-acp", "config-acp.json", "config.json"]) {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(home, name), "utf8"));
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return {};
}

export async function resolveApiKey(
  options: ResolveConfigOptions = {},
): Promise<string> {
  const env = options.env ?? process.env;

  const fromEnv = env.POLLINATIONS_API_KEY?.trim();
  if (fromEnv) return fromEnv;

  const home =
    env.POLLINATIONS_HOME?.trim() || join(homedir(), ".pollinations");

  // Config file (editable) takes precedence over the credentials file.
  // `api_key` is the documented spelling; `apiKey` and `pollinations_api_key`
  // are kept because released configurations already use them.
  const configFile = await readConfigFile(home);
  const fromConfig =
    configFile.api_key ?? configFile.apiKey ?? configFile.pollinations_api_key;
  if (typeof fromConfig === "string" && fromConfig.trim()) return fromConfig.trim();

  const credentialsFile =
    options.credentialsFile ?? join(home, "credentials.json");

  try {
    const parsed: unknown = JSON.parse(await readFile(credentialsFile, "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      const apiKey = (parsed as { apiKey?: unknown }).apiKey;
      if (typeof apiKey === "string" && apiKey.trim()) return apiKey.trim();
    }
  } catch {
    // Missing or unreadable credentials are not fatal here; the caller reports.
  }

  return "";
}

/**
 * First of `candidates` that is a string or a number, rendered as text.
 *
 * The config file is `Record<string, unknown>`, so a value could be anything.
 * Stringifying blindly would turn a typo'd object into `"[object Object]"` and
 * hand `parseInt` a `NaN` it has to recover from; non-scalars are skipped
 * instead, which leaves the caller on its default.
 */
function scalarOption(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" || typeof candidate === "number") {
      return String(candidate);
    }
  }
  return undefined;
}

/** Pure resolution of environment-driven fields, given an already-resolved key. */
export function resolveEnvConfig(
  env: NodeJS.ProcessEnv,
  apiKey: string,
  configFile: Record<string, unknown> = {},
): AgentConfig {
  const permissionMode = (
    env.ACP_PERMISSION_MODE?.trim() ||
    (typeof configFile.permission_mode === "string" ? configFile.permission_mode.trim() : "") ||
    (typeof configFile.permissionMode === "string" ? configFile.permissionMode.trim() : "")
  ) === "allow"
    ? "allow"
    : "ask";

  const maxTurnRequests = Number.parseInt(
    env.ACP_MAX_TURN_REQUESTS ??
      scalarOption(configFile.max_turn_requests, configFile.maxTurnRequests) ??
      "",
    10,
  );
  const compactionTokens = Number.parseInt(
    env.ACP_COMPACTION_THRESHOLD_TOKENS ??
      scalarOption(
        configFile.compaction_threshold_tokens,
        configFile.compactionThresholdTokens,
      ) ??
      "",
    10,
  );
  const home =
    env.POLLINATIONS_HOME?.trim() || join(homedir(), ".pollinations");

  const baseUrl =
    env.POLLINATIONS_BASE_URL?.trim() ||
    (typeof configFile.base_url === "string" ? configFile.base_url.trim() : "") ||
    (typeof configFile.baseUrl === "string" ? configFile.baseUrl.trim() : "") ||
    DEFAULT_BASE_URL;

  const model =
    env.POLLINATIONS_MODEL?.trim() ||
    (typeof configFile.model === "string" ? configFile.model.trim() : "") ||
    DEFAULT_MODEL;

  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    model,
    maxTurnRequests:
      Number.isFinite(maxTurnRequests) && maxTurnRequests > 0
        ? maxTurnRequests
        : DEFAULT_MAX_TURN_REQUESTS,
    sessionsDir: join(home, "sessions"),
    // A negative value is read as "off", which is what a CI run may want.
    compactionThresholdTokens:
      Number.isFinite(compactionTokens) && compactionTokens >= -1
        ? compactionTokens
        : DEFAULT_COMPACTION_THRESHOLD_TOKENS,
    permissionMode,
  };
}

/** Resolves the full agent configuration from the environment. */
export async function resolveConfig(
  options: ResolveConfigOptions = {},
): Promise<AgentConfig> {
  const env = options.env ?? process.env;
  const home = env.POLLINATIONS_HOME?.trim() || join(homedir(), ".pollinations");
  const configFile = await readConfigFile(home);
  const apiKey = await resolveApiKey(options);
  const config = resolveEnvConfig(env, apiKey, configFile);

  process.stderr.write(
    `Pollinations: config baseUrl=${config.baseUrl} model=${config.model} ` +
      `maxTurnRequests=${config.maxTurnRequests} compactionThreshold=${config.compactionThresholdTokens} ` +
      `permissionMode=${config.permissionMode} sessionsDir=${config.sessionsDir} ` +
      `apiKey=${config.apiKey ? "present" : "missing"}\n`,
  );

  return config;
}
