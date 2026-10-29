import type { SessionConfigOption, SessionConfigSelectOption } from "@agentclientprotocol/sdk";

/**
 * Pollinations model catalogue: fetch, classify, and render the model picker.
 *
 * The picker is a native ACP feature — `session/new` advertises `configOptions`
 * and the client sends `session/set_config_option` when the user picks another
 * model — so all this module has to produce is one `select` option whose values
 * match the catalogue taxonomy.
 *
 * Classification is the operator's rule of thumb over the `/v1/models` fields:
 *
 * - `paid`   — `paid_only: true`, requires purchased pollen.
 * - `free`   — 0 in / 0 out *published explicitly*. Absent amounts do not count:
 *              an unstated price varies, and varying prices are `quest`.
 * - `quest`  — everything else: open to everyone, metered pollen.
 *
 * Combined with the model's origin this yields five picker groups, not six:
 * `official-free` cannot occur. First-party models are sold, and nothing in the
 * catalogue ever marks one complimentary, so the type forbids it outright.
 */

/** `configId` of the model picker, as sent in `session/set_config_option`. */
export const MODEL_CONFIG_ID = "model";

/** How long a fetched catalogue is reused before being refreshed. */
export const MODEL_CATALOG_TTL_MS = 5 * 60_000;

/** Where the model is published: Pollinations' own, or a community author's. */
export type Origin = "official" | "community";

export type PricingTier = "paid" | "quest" | "free";

/**
 * Picker group: where the model comes from, then how it is billed.
 *
 * Deliberately not `` `${Origin}-${PricingTier}` ``: that cross product would
 * include `official-free`, which the rules above rule out. Writing the five
 * groups out lets the compiler reject one if it ever creeps back in.
 */
export type ModelGroup =
  | "official-paid"
  | "official-quest"
  | "community-paid"
  | "community-quest"
  | "community-free";

/** One model that a session can be switched to. */
export type CatalogModel = {
  id: string;
  title: string;
  description: string | null;
  group: ModelGroup;
  /** Context window in tokens, when the catalogue reports one. */
  contextLength: number | null;
  /** Pollen per prompt text token; `null` when the catalogue omits pricing. */
  promptPrice: number | null;
  /** Pollen per completion text token; `null` when the catalogue omits pricing. */
  completionPrice: number | null;
  /** Last known provider health, e.g. `healthy` or `degraded`. */
  health: string | null;
  /** Last known success rate, in percent. */
  successRate: number | null;
  /** Last known request volume; a rough popularity signal. */
  requests: number;
};

/** Group ids in the order they are shown to the user. */
export const MODEL_GROUP_ORDER: readonly ModelGroup[] = [
  "official-paid",
  "official-quest",
  "community-paid",
  "community-quest",
  "community-free",
];

const GROUP_LABELS: Record<ModelGroup, string> = {
  "official-paid": "Official · paid",
  "official-quest": "Official · quest",
  "community-paid": "Community · paid",
  "community-quest": "Community · quest",
  "community-free": "Community · free",
};

/**
 * A small hand-picked catalogue used when `/v1/models` cannot be reached, so a
 * flaky network never blocks `session/new` or empties the picker.
 *
 * Metadata here is deliberately minimal: context, health, and pricing drift,
 * and the point is to offer working choices, not to mirror the live numbers.
 */
export const FALLBACK_MODELS: readonly CatalogModel[] = [
  {
    id: "community/YoannDev90/vercel-nemotron-3.5-lightning:free",
    title: "Vercel Nemotron 3.5 Lightning",
    description: "offline fallback list",
    group: "community-quest",
    contextLength: null,
    promptPrice: null,
    completionPrice: null,
    health: null,
    successRate: null,
    requests: 0,
  },
  {
    id: "nvidia/nemotron-3.5-lightning",
    title: "Nemotron 3.5 Lightning",
    description: "offline fallback list",
    group: "official-quest",
    contextLength: null,
    promptPrice: null,
    completionPrice: null,
    health: null,
    successRate: null,
    requests: 0,
  },
  {
    id: "openai/gpt-5.4-nano",
    title: "GPT-5.4 Nano",
    description: "offline fallback list",
    group: "official-quest",
    contextLength: null,
    promptPrice: null,
    completionPrice: null,
    health: null,
    successRate: null,
    requests: 0,
  },
  {
    id: "z-ai/glm-5.3-flash",
    title: "GLM-5.3-Flash",
    description: "offline fallback list",
    group: "official-quest",
    contextLength: null,
    promptPrice: null,
    completionPrice: null,
    health: null,
    successRate: null,
    requests: 0,
  },
  {
    id: "anthropic/claude-sonnet-5.5",
    title: "Claude Sonnet 5.5",
    description: "offline fallback list",
    group: "official-paid",
    contextLength: null,
    promptPrice: null,
    completionPrice: null,
    health: null,
    successRate: null,
    requests: 0,
  },
  {
    id: "community/Catniti/nemotron-3.5-lightning",
    title: "Nemotron 3.5 Lightning",
    description: "offline fallback list",
    group: "community-quest",
    contextLength: null,
    promptPrice: null,
    completionPrice: null,
    health: null,
    successRate: null,
    requests: 0,
  },
];

export type FetchModelCatalogOptions = {
  /** API base URL, without a trailing slash. */
  baseUrl: string;
  /** Injected for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Per-request timeout. Defaults to 10 seconds. */
  timeoutMs?: number;
};

/**
 * Reads `GET /v1/models` and keeps the models a coding agent can actually use:
 * text models with tool calling, reachable through chat completions.
 *
 * Anything else — image, audio, realtime, embeddings, tool-less chat — would
 * break the agent's tool loop, so it is dropped rather than offered.
 */
export async function fetchModelCatalog(
  options: FetchModelCatalogOptions,
): Promise<CatalogModel[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  // A signal aborted *before* this call never fires its listener again.
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);

  try {
    const response = await fetchImpl(`${baseUrl}/v1/models`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`GET /v1/models responded with ${response.status} ${response.statusText}`);
    }

    return parseModelCatalog(await response.json());
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** Turns a `/v1/models` payload into sorted, filter-qualified models. */
export function parseModelCatalog(payload: unknown): CatalogModel[] {
  const entries = readEntries(payload);
  const models: CatalogModel[] = [];

  for (const entry of entries) {
    const model = toCatalogModel(entry);
    if (model) models.push(model);
  }

  return sortModels(models);
}

/**
 * Renders the ACP `select` option that drives the model picker.
 *
 * `currentModel` is always present in the returned options, even when it is not
 * in the catalogue: the protocol requires `currentValue` to be one of `options`,
 * and a freshly published or offline model must not blank out the picker.
 */
export function buildModelOption(
  models: readonly CatalogModel[],
  currentModel: string,
): SessionConfigOption {
  const known = models.some((model) => model.id === currentModel);
  const all = known ? models : [...models, placeholderFor(currentModel)];

  const byGroup = new Map<ModelGroup, SessionConfigSelectOption[]>();
  for (const model of all) {
    const options = byGroup.get(model.group) ?? [];
    options.push({
      value: model.id,
      name: model.title,
      description: describeModel(model),
    });
    byGroup.set(model.group, options);
  }

  const groups = MODEL_GROUP_ORDER.filter((group) => byGroup.has(group)).map((group) => ({
    group,
    name: GROUP_LABELS[group],
    options: byGroup.get(group) as SessionConfigSelectOption[],
  }));

  return {
    type: "select",
    id: MODEL_CONFIG_ID,
    name: "Model",
    description: "Pollinations model used for this session",
    category: "model",
    currentValue: currentModel,
    options: groups,
  };
}

/** Whether the catalogue offers this model id. */
export function isKnownModel(models: readonly CatalogModel[], id: string): boolean {
  return models.some((model) => model.id === id);
}

/**
 * Combines a model's origin with its billing tier.
 *
 * The only rule here that is not a plain join: an `official` model can never be
 * `free`, so that tier degrades to `quest`.
 */
export function groupOf(origin: Origin, tier: PricingTier): ModelGroup {
  if (origin === "official") return tier === "paid" ? "official-paid" : "official-quest";
  if (tier === "paid") return "community-paid";
  if (tier === "free") return "community-free";
  return "community-quest";
}

/**
 * Groups a bare model id when the live catalogue is unavailable.
 *
 * Only the id is known here, and its `:free` / `:paid` suffixes are typed by
 * whoever published the model rather than reported by the API, so they carry no
 * weight. An unknown model is assumed open to everyone: `quest`.
 */
export function inferGroup(id: string): ModelGroup {
  const origin: Origin = id.startsWith("community/") ? "community" : "official";
  return groupOf(origin, "quest");
}

/**
 * Billing tier of one entry, per the `paid` / `free` / `quest` rule.
 *
 * `free` needs the catalogue to publish an explicit 0 in / 0 out. Amounts that
 * are simply absent mean the price varies, and varying prices are `quest`:
 * calling an unstated price "free" would be a promise nobody made.
 */
export function classifyTier(entry: {
  paid_only?: unknown;
  pricing?: { promptTextTokens?: unknown; completionTextTokens?: unknown } | null;
}): PricingTier {
  if (entry.paid_only === true) return "paid";
  const prompt = numberOr(entry.pricing?.promptTextTokens, null);
  const completion = numberOr(entry.pricing?.completionTextTokens, null);
  return prompt === 0 && completion === 0 ? "free" : "quest";
}

/* ------------------------------------------------------------------ *
 * Internals
 * ------------------------------------------------------------------ */

/** The `/v1/models` entry shape this module cares about. */
type RawModelEntry = {
  id?: unknown;
  title?: unknown;
  description?: unknown;
  category?: unknown;
  tools?: unknown;
  capabilities?: unknown;
  supported_endpoints?: unknown;
  paid_only?: unknown;
  community?: unknown;
  context_length?: unknown;
  pricing?: { promptTextTokens?: unknown; completionTextTokens?: unknown } | null;
  health?: { status?: unknown; success_rate?: unknown; requests?: unknown } | null;
};

function readEntries(payload: unknown): RawModelEntry[] {
  if (typeof payload !== "object" || payload === null) return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data.filter(
    (entry): entry is RawModelEntry => typeof entry === "object" && entry !== null,
  );
}

function toCatalogModel(entry: RawModelEntry): CatalogModel | null {
  const id = textOf(entry.id);
  if (!id) return null;

  // The agent is text-only: anything outside `text` cannot drive its tool loop.
  if (textOf(entry.category) !== "text") return null;

  const endpoints = Array.isArray(entry.supported_endpoints)
    ? entry.supported_endpoints.filter((value): value is string => typeof value === "string")
    : null;
  if (endpoints && !endpoints.includes("/v1/chat/completions")) return null;

  const capabilities = Array.isArray(entry.capabilities)
    ? entry.capabilities.filter((value): value is string => typeof value === "string")
    : [];
  if (entry.tools !== true && !capabilities.includes("tool_calling")) return null;

  const origin: Origin = entry.community === true ? "community" : "official";

  return {
    id,
    title: textOf(entry.title) || id,
    description: textOf(entry.description),
    group: groupOf(origin, classifyTier(entry)),
    contextLength: positiveInt(entry.context_length),
    promptPrice: priceOf(entry.pricing?.promptTextTokens),
    completionPrice: priceOf(entry.pricing?.completionTextTokens),
    health: textOf(entry.health?.status),
    successRate: numberOr(entry.health?.success_rate, null),
    requests: positiveInt(entry.health?.requests) ?? 0,
  };
}

/** Best-effort stand-in for a model the live catalogue did not list. */
function placeholderFor(id: string): CatalogModel {
  return {
    id,
    title: id,
    description: "selected model is not in the fetched catalogue",
    group: inferGroup(id),
    contextLength: null,
    promptPrice: null,
    completionPrice: null,
    health: null,
    successRate: null,
    requests: 0,
  };
}

function sortModels(models: CatalogModel[]): CatalogModel[] {
  const rank = new Map(MODEL_GROUP_ORDER.map((group, index) => [group, index]));

  return [...models].sort((left, right) => {
    const byGroup = (rank.get(left.group) ?? 99) - (rank.get(right.group) ?? 99);
    if (byGroup !== 0) return byGroup;

    // Best success rate first, then the busiest models; unknown rates sink.
    const byRate = (right.successRate ?? -1) - (left.successRate ?? -1);
    if (byRate !== 0) return byRate;

    const byRequests = right.requests - left.requests;
    if (byRequests !== 0) return byRequests;

    return left.id.localeCompare(right.id);
  });
}

/** One-line summary the client shows next to a model name. */
function describeModel(model: CatalogModel): string {
  const parts: string[] = [];

  if (model.contextLength) parts.push(`${formatContext(model.contextLength)} ctx`);
  if (model.successRate !== null) parts.push(`${Math.round(model.successRate)}% success`);
  parts.push(formatPricing(model));
  if (model.health && model.health !== "healthy") parts.push(model.health);

  return parts.join(" · ");
}

function formatPricing(model: CatalogModel): string {
  if (model.group.endsWith("-free")) return "free";
  if (model.promptPrice === null || model.completionPrice === null) return "pollen pricing unknown";
  return `${formatPrice(model.promptPrice)}/${formatPrice(model.completionPrice)} pollen/M in/out`;
}

function formatPrice(perToken: number): string {
  return `${Number((perToken * 1_000_000).toPrecision(3))}`;
}

function formatContext(tokens: number): string {
  const millions = tokens / 1_000_000;
  if (millions >= 1) {
    const rounded = millions >= 10 ? Math.round(millions) : Math.round(millions * 10) / 10;
    return `${rounded}M`;
  }
  return `${Math.round(tokens / 1000)}K`;
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Parses a catalogue number, treating absent values as the fallback. */
function numberOr<T>(value: unknown, fallback: T): number | T {
  // `Number(null)` is 0, which would turn "unknown" into "free" or "0%".
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveInt(value: unknown): number | null {
  const parsed = numberOr(value, 0);
  return parsed > 0 ? Math.round(parsed) : null;
}

function priceOf(value: unknown): number | null {
  const parsed = numberOr(value, null);
  return parsed === null || parsed < 0 ? null : parsed;
}
