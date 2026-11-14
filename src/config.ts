import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import { stripTrailingSlashes } from "./net.js";
import { findSettingsFile, readSettingsFile, readSettingsFileAt } from "./settings-file.js";

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

/**
 * Session modes a session can start in, in the order clients list them.
 *
 * Owned here rather than in the agent so `default_mode` is validated against
 * the same ids the protocol advertises: a typo in the settings file degrades
 * to `build` instead of reaching a client as an unknown mode.
 */
export const MODE_VALUES = ["build", "plan", "ask"] as const;

/** Reasoning efforts a session can start at; see {@link MODE_VALUES}. */
export const REASONING_VALUES = ["none", "low", "medium", "high"] as const;

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
  /**
   * Mode a new session starts in. Validated against {@link MODE_VALUES} when
   * the settings are resolved, so an unknown value in the file becomes
   * `build` rather than a mode no client knows.
   */
  defaultMode: (typeof MODE_VALUES)[number];
  /** Reasoning effort a new session starts at; see {@link defaultMode}. */
  defaultReasoning: (typeof REASONING_VALUES)[number];
  /**
   * MCP servers configured in the settings file, in addition to whatever the
   * client passes to `session/new`.
   *
   * Entries stay unvalidated here — `connectMcpServers` is what decides which
   * shapes are usable — so a bad entry costs one session its tools rather
   * than the whole configuration.
   */
  mcpServers?: Array<Record<string, unknown>>;
  /**
   * The editable settings file: the first candidate that parses under the
   * home directory, or the path `/config` creates one at.
   *
   * `undefined` only for a configuration assembled by hand, where there is no
   * home directory to derive a path from.
   */
  settingsFile?: string;
  /**
   * Directories searched for Agent Skills, each holding `<skill>/SKILL.md`.
   *
   * `undefined` uses the defaults — the session's own roots plus the user's
   * home — and an empty list disables skill discovery entirely, which is what
   * a test or a locked-down deployment wants.
   */
  skillRoots?: string[];
};

/**
 * Overrides for `resolveConfig` and `resolveApiKey`.
 *
 * Both default to the real process environment and the real home directory;
 * tests pass `env` so a key or a home path never has to be present on the
 * machine running them.
 */
export type ResolveConfigOptions = {
  /** Environment to read. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Explicit credentials file, defaults to `$POLLINATIONS_HOME/credentials.json`. */
  credentialsFile?: string;
  /**
   * Settings file already resolved, so a caller that knows the path — the
   * agent does, from {@link AgentConfig} — reads exactly that file instead of
   * re-probing a home directory that may have gained another candidate since.
   *
   * `undefined` keeps the home probe; a caller with no home to probe (a test
   * with a hand-built config) leaves it unset *and* skips the read entirely.
   */
  settingsFile?: string;
};

/**
 * The agent's home directory: `POLLINATIONS_HOME`, else `~/.pollinations`.
 *
 * One definition, because every reader — credentials, settings, sessions,
 * logs — has to agree on it, and a divergence would make a file that exists
 * invisible to the code that is supposed to read it.
 */
function homeDir(env: NodeJS.ProcessEnv): string {
  return env.POLLINATIONS_HOME?.trim() || join(homedir(), ".pollinations");
}

/**
 * The settings record a resolution should read: the file already named, or
 * the first candidate under the home directory.
 *
 * One definition so the key, the session defaults, and `/config` cannot end
 * up describing three different files.
 */
async function settingsRecord(
  options: ResolveConfigOptions,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  if (options.settingsFile !== undefined) return readSettingsFileAt(options.settingsFile);
  return readSettingsFile(homeDir(env));
}

/**
 * Reads a Pollinations API key.
 *
 * Order: `POLLINATIONS_API_KEY`, then the config file, then the `polli auth
 * login` credentials file. Returns an empty string when no source yields a
 * key, so callers can decide how to report the problem — the agent starts
 * without one and fails at `session/new`, rather than dying at boot.
 */
export async function resolveApiKey(
  options: ResolveConfigOptions = {},
): Promise<string> {
  const env = options.env ?? process.env;

  const fromEnv = env.POLLINATIONS_API_KEY?.trim();
  if (fromEnv) return fromEnv;

  const home = homeDir(env);

  // Config file (editable) takes precedence over the credentials file.
  // `api_key` is the documented spelling; `apiKey` and `pollinations_api_key`
  // are kept because released configurations already use them.
  const configFile = await settingsRecord(options, env);
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

/**
 * Skill roots pinned by the operator, or `undefined` for the defaults.
 *
 * The environment wins over the config file, and a present-but-empty value
 * means "discover nothing" rather than "fall back": turning skills off has to
 * be possible without unsetting everything else.
 */
function skillRootsOption(
  env: NodeJS.ProcessEnv,
  configFile: Record<string, unknown>,
): string[] | undefined {
  const fromEnv = env.ACP_SKILL_ROOTS;
  if (fromEnv !== undefined) return splitRoots(fromEnv);

  const raw = configFile.skill_roots ?? configFile.skillRoots;
  if (typeof raw === "string") return splitRoots(raw);
  if (Array.isArray(raw)) {
    const roots: string[] = [];
    for (const candidate of raw as unknown[]) {
      if (typeof candidate === "string" && candidate.trim()) roots.push(candidate.trim());
    }
    return roots;
  }
  return undefined;
}

/** Splits a path-list on the platform delimiter, dropping empty entries. */
function splitRoots(value: string): string[] {
  return value
    .split(delimiter)
    .map((root) => root.trim())
    .filter(Boolean);
}

/** A known session mode, or `build` when the configured value is not one. */
function pickMode(value: string): (typeof MODE_VALUES)[number] {
  for (const mode of MODE_VALUES) if (mode === value) return mode;
  return "build";
}

/** A known reasoning effort, or `medium` when the configured value is not one. */
function pickReasoning(value: string): (typeof REASONING_VALUES)[number] {
  for (const level of REASONING_VALUES) if (level === value) return level;
  return "medium";
}

/**
 * MCP servers listed in the settings file, or `undefined` when there are none.
 *
 * Non-object entries are dropped here so the count in the startup log is the
 * number `connectMcpServers` will actually attempt: a string in a list of
 * servers is a typo, and skipping it later would only hide it.
 */
function mcpServersOption(
  configFile: Record<string, unknown>,
): Array<Record<string, unknown>> | undefined {
  const raw = configFile.mcp_servers ?? configFile.mcpServers;
  if (!Array.isArray(raw)) return undefined;
  const servers = (raw as unknown[]).filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );
  return servers.length > 0 ? servers : undefined;
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
  const home = homeDir(env);

  const skillRoots = skillRootsOption(env, configFile);
  const mcpServers = mcpServersOption(configFile);

  const defaultMode = pickMode(
    env.ACP_DEFAULT_MODE?.trim() ||
      scalarOption(configFile.default_mode, configFile.defaultMode) ||
      "",
  );
  const defaultReasoning = pickReasoning(
    env.ACP_DEFAULT_REASONING?.trim() ||
      scalarOption(configFile.default_reasoning, configFile.defaultReasoning) ||
      "",
  );

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
    baseUrl: stripTrailingSlashes(baseUrl),
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
    defaultMode,
    defaultReasoning,
    ...(mcpServers !== undefined ? { mcpServers } : {}),
    ...(skillRoots !== undefined ? { skillRoots } : {}),
  };
}

/** Resolves the full agent configuration from the environment. */
export async function resolveConfig(
  options: ResolveConfigOptions = {},
): Promise<AgentConfig> {
  const env = options.env ?? process.env;
  const home = homeDir(env);
  const configFile = await settingsRecord(options, env);
  const apiKey = await resolveApiKey(options);
  const config = resolveEnvConfig(env, apiKey, configFile);
  // Resolved, never created: starting the agent must not write to the disk,
  // and `/config` is the one that materialises the file when it is missing.
  config.settingsFile = options.settingsFile ?? (await findSettingsFile(home));

  process.stderr.write(
    `Pollinations: config baseUrl=${config.baseUrl} model=${config.model} ` +
      `maxTurnRequests=${config.maxTurnRequests} compactionThreshold=${config.compactionThresholdTokens} ` +
      `permissionMode=${config.permissionMode} sessionsDir=${config.sessionsDir} ` +
      `defaultMode=${config.defaultMode} defaultReasoning=${config.defaultReasoning} ` +
      `settingsFile=${config.settingsFile} mcpServers=${config.mcpServers?.length ?? 0} ` +
      `skillRoots=${
        config.skillRoots === undefined
          ? "auto"
          : config.skillRoots.length === 0
            ? "off"
            : config.skillRoots.join(delimiter)
      } ` +
      `apiKey=${config.apiKey ? "present" : "missing"}\n`,
  );

  return config;
}

/**
 * The session-scoped settings a new session should start from, re-read from
 * the settings file.
 *
 * The file is the user's: editing it has to reach the next session without a
 * restart, so `session/new` asks again instead of trusting the startup
 * snapshot. A home with no readable settings keeps the startup values — that
 * is also what a corrupt file degrades to, since both look like "nothing to
 * read" and neither may fail a session that is only opening.
 */
export async function resolveSessionDefaults(
  base: AgentConfig,
  options: ResolveConfigOptions = {},
): Promise<Pick<AgentConfig, "model" | "defaultMode" | "defaultReasoning" | "mcpServers">> {
  const path = options.settingsFile ?? base.settingsFile;
  // No resolved file means there is no file layer to apply. A configuration
  // assembled by hand has no home directory behind it, and probing the real
  // one from a test would let a developer's own `config-acp` decide what a
  // session starts with.
  if (path === undefined) return sessionDefaultsOf(base);

  const configFile = await readSettingsFileAt(path);
  if (Object.keys(configFile).length === 0) return sessionDefaultsOf(base);

  return sessionDefaultsOf(resolveEnvConfig(options.env ?? process.env, base.apiKey, configFile));
}

/** The four settings a session opens with; the rest are fixed for the process. */
function sessionDefaultsOf(
  config: AgentConfig,
): Pick<AgentConfig, "model" | "defaultMode" | "defaultReasoning" | "mcpServers"> {
  return {
    model: config.model,
    defaultMode: config.defaultMode,
    defaultReasoning: config.defaultReasoning,
    ...(config.mcpServers !== undefined ? { mcpServers: config.mcpServers } : {}),
  };
}

/**
 * One line per setting: the effective value and where it comes from.
 *
 * `/settings` prints these so a user can tell an environment override from a
 * file value from a default *before* editing anything — the point of showing
 * the file is knowing which key will actually change behaviour. The key never
 * appears: a transcript is persisted, and "present" is all anyone needs.
 */
export async function describeSettings(options: ResolveConfigOptions = {}): Promise<string[]> {
  const env = options.env ?? process.env;
  const file = await settingsRecord(options, env);
  const config = resolveEnvConfig(env, await resolveApiKey(options), file);

  const rows: ReadonlyArray<{
    label: string;
    value: string;
    /** Environment variable that overrides the file, when there is one. */
    variable?: string;
    /** Settings-file keys that satisfy the setting, in spelling order. */
    keys: readonly string[];
    /** An empty variable still counts as an override (skill roots). */
    emptyOverrides?: boolean;
  }> = [
    {
      label: "api_key",
      value: config.apiKey ? "present" : "missing",
      variable: "POLLINATIONS_API_KEY",
      keys: ["api_key", "apiKey", "pollinations_api_key"],
    },
    { label: "model", value: config.model, variable: "POLLINATIONS_MODEL", keys: ["model"] },
    {
      label: "base_url",
      value: config.baseUrl,
      variable: "POLLINATIONS_BASE_URL",
      keys: ["base_url", "baseUrl"],
    },
    {
      label: "permission_mode",
      value: config.permissionMode,
      variable: "ACP_PERMISSION_MODE",
      keys: ["permission_mode", "permissionMode"],
    },
    {
      label: "max_turn_requests",
      value: String(config.maxTurnRequests),
      variable: "ACP_MAX_TURN_REQUESTS",
      keys: ["max_turn_requests", "maxTurnRequests"],
    },
    {
      label: "compaction_threshold_tokens",
      value: String(config.compactionThresholdTokens),
      variable: "ACP_COMPACTION_THRESHOLD_TOKENS",
      keys: ["compaction_threshold_tokens", "compactionThresholdTokens"],
    },
    {
      label: "default_mode",
      value: config.defaultMode,
      variable: "ACP_DEFAULT_MODE",
      keys: ["default_mode", "defaultMode"],
    },
    {
      label: "default_reasoning",
      value: config.defaultReasoning,
      variable: "ACP_DEFAULT_REASONING",
      keys: ["default_reasoning", "defaultReasoning"],
    },
    {
      label: "skill_roots",
      value:
        config.skillRoots === undefined
          ? "auto"
          : config.skillRoots.length === 0
            ? "off"
            : config.skillRoots.join(delimiter),
      variable: "ACP_SKILL_ROOTS",
      keys: ["skill_roots", "skillRoots"],
      emptyOverrides: true,
    },
    {
      label: "mcp_servers",
      value: `${config.mcpServers?.length ?? 0} configured`,
      keys: ["mcp_servers", "mcpServers"],
    },
  ];

  return rows.map((row) => {
    const source = settingSource(row, env, file);
    return `${row.label.padEnd(28)} ${row.value}  [${source}]`;
  });
}

/** `env: NAME`, `file`, or `default` — the layer the value was taken from. */
function settingSource(
  row: { variable?: string; keys: readonly string[]; emptyOverrides?: boolean },
  env: NodeJS.ProcessEnv,
  file: Record<string, unknown>,
): string {
  const raw = row.variable === undefined ? undefined : env[row.variable];
  const fromEnv =
    row.variable !== undefined &&
    (row.emptyOverrides ? raw !== undefined : Boolean(raw?.trim()));
  if (fromEnv && row.variable !== undefined) return `env: ${row.variable}`;
  if (row.keys.some((key) => file[key] !== undefined)) return "file";
  return "default";
}
