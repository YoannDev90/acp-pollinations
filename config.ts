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
export const DEFAULT_COMPACTION_THRESHOLD_TOKENS = 50_000;

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
 * Order: `POLLINATIONS_API_KEY`, then the `polli auth login` credentials file.
 * Returns an empty string when neither source yields a key, so callers can
 * decide how to report the problem.
 */
export async function resolveApiKey(
  options: ResolveConfigOptions = {},
): Promise<string> {
  const env = options.env ?? process.env;

  const fromEnv = env.POLLINATIONS_API_KEY?.trim();
  if (fromEnv) return fromEnv;

  const home =
    env.POLLINATIONS_HOME?.trim() || join(homedir(), ".pollinations");
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

/** Resolves the full agent configuration from the environment. */
export async function resolveConfig(
  options: ResolveConfigOptions = {},
): Promise<AgentConfig> {
  const env = options.env ?? process.env;

  const permissionMode =
    env.ACP_PERMISSION_MODE?.trim() === "allow" ? "allow" : "ask";
  const maxTurnRequests = Number.parseInt(env.ACP_MAX_TURN_REQUESTS ?? "", 10);
  const compactionTokens = Number.parseInt(
    env.ACP_COMPACTION_THRESHOLD_TOKENS ?? "",
    10,
  );
  const home =
    env.POLLINATIONS_HOME?.trim() || join(homedir(), ".pollinations");

  return {
    apiKey: await resolveApiKey(options),
    baseUrl: (env.POLLINATIONS_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    ),
    model: env.POLLINATIONS_MODEL?.trim() || DEFAULT_MODEL,
    maxTurnRequests:
      Number.isFinite(maxTurnRequests) && maxTurnRequests > 0
        ? maxTurnRequests
        : DEFAULT_MAX_TURN_REQUESTS,
    sessionsDir: join(home, "sessions"),
    // A negative value is read as "off", which is what a CI run may want.
    compactionThresholdTokens:
      Number.isFinite(compactionTokens) && compactionTokens >= 0
        ? compactionTokens
        : DEFAULT_COMPACTION_THRESHOLD_TOKENS,
    permissionMode,
  };
}
