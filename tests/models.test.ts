import { describe, expect, it } from "vitest";

import type {
  SessionConfigOption,
  SessionConfigSelect,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from "@agentclientprotocol/sdk";

import {
  FALLBACK_MODELS,
  MODEL_CONFIG_ID,
  MODEL_GROUP_ORDER,
  buildModelOption,
  classifyTier,
  fetchModelCatalog,
  groupOf,
  inferGroup,
  isKnownModel,
  parseModelCatalog,
} from "../models.js";
import type { CatalogModel } from "../models.js";
import { DEFAULT_MODEL } from "../config.js";
import {
  FAKE_MODELS_PAYLOAD,
  startFakeLlmServer,
} from "./helpers/fake-llm-server.js";

/** Minimal catalogue model with test-friendly defaults. */
function model(overrides: Partial<CatalogModel> & { id: string }): CatalogModel {
  return {
    title: overrides.id,
    description: null,
    group: "official-quest",
    contextLength: null,
    promptPrice: null,
    completionPrice: null,
    health: null,
    successRate: null,
    requests: 0,
    ...overrides,
  };
}

/** Narrows a picker option to its `select` shape, which is all we build. */
function asSelect(option: SessionConfigOption): SessionConfigSelect {
  if (option.type !== "select") throw new Error(`expected a select option, got ${option.type}`);
  return option;
}

/**
 * Discriminates the picker's grouped options.
 *
 * `SessionConfigSelectOptions` is a union of two *arrays*, so `Array.isArray`
 * cannot narrow it; the shapes differ by field instead.
 */
function groupedOptions(
  options: SessionConfigSelect["options"],
): SessionConfigSelectGroup[] {
  const entries = options as Array<SessionConfigSelectOption | SessionConfigSelectGroup>;
  const looksGrouped = entries.every(
    (entry) => "group" in entry && Array.isArray((entry as SessionConfigSelectGroup).options),
  );
  if (!looksGrouped) throw new Error("expected grouped picker options");
  return entries as SessionConfigSelectGroup[];
}

/** Flattens the picker's groups back into `groupId -> option values`. */
function groupValues(option: SessionConfigOption): Record<string, string[]> {
  return Object.fromEntries(
    groupedOptions(asSelect(option).options).map((group) => [
      group.group,
      group.options.map((entry) => entry.value),
    ]),
  );
}

describe("classifyTier", () => {
  it("treats paid_only models as paid regardless of price", () => {
    expect(
      classifyTier({ paid_only: true, pricing: { promptTextTokens: "0", completionTextTokens: "0" } }),
    ).toBe("paid");
  });

  it("treats an explicit zero in / zero out as free", () => {
    expect(
      classifyTier({ paid_only: false, pricing: { promptTextTokens: "0", completionTextTokens: "0" } }),
    ).toBe("free");
    expect(
      classifyTier({ paid_only: false, pricing: { promptTextTokens: 0, completionTextTokens: 0 } }),
    ).toBe("free");
  });

  it("treats any non-zero price as quest", () => {
    expect(
      classifyTier({ paid_only: false, pricing: { promptTextTokens: "0.0000001", completionTextTokens: "0" } }),
    ).toBe("quest");
    expect(
      classifyTier({ paid_only: false, pricing: { promptTextTokens: "0", completionTextTokens: "0.0000004" } }),
    ).toBe("quest");
  });

  it("treats absent pricing as quest, because an unstated price varies", () => {
    // A missing amount is not a zero: nobody promised it costs nothing. The
    // live catalogue publishes 143 models with no text amounts at all, and
    // calling them free would be inventing a price.
    expect(
      classifyTier({ paid_only: false, pricing: { promptTextTokens: null, completionTextTokens: null } }),
    ).toBe("quest");
    expect(classifyTier({ paid_only: false, pricing: undefined })).toBe("quest");
    expect(classifyTier({ paid_only: false, pricing: {} })).toBe("quest");
    expect(classifyTier({ paid_only: false })).toBe("quest");
  });
});

describe("groupOf", () => {
  it("never places an official model in a free group", () => {
    const produced = new Set<string>([
      groupOf("official", "paid"),
      groupOf("official", "quest"),
      groupOf("official", "free"),
      groupOf("community", "paid"),
      groupOf("community", "quest"),
      groupOf("community", "free"),
    ]);

    expect(produced.has("official-free")).toBe(false);
    expect(produced).toEqual(new Set(MODEL_GROUP_ORDER));
  });
});

describe("inferGroup", () => {
  it("reads only the origin, ignoring the hand-written :free / :paid suffix", () => {
    expect(inferGroup("nvidia/nemotron-3.5-lightning")).toBe("official-quest");
    expect(inferGroup("community/Catniti/nemotron-3.5-lightning")).toBe("community-quest");
    // Suffixes are typed by whoever published the model, not reported by the
    // API, so a `:free` id is not enough to claim the model costs nothing.
    expect(inferGroup("community/YoannDev90/vercel-nemotron-3.5-lightning:free")).toBe("community-quest");
    expect(inferGroup("community/x/some-model:paid")).toBe("community-quest");
    expect(inferGroup("openai/some-model:free")).toBe("official-quest");
  });
});

describe("parseModelCatalog", () => {
  it("keeps only tool-capable text models, grouped by origin and tier", () => {
    const models = parseModelCatalog(FAKE_MODELS_PAYLOAD);
    const byId = new Map(models.map((entry) => [entry.id, entry]));

    // The tool-less text model and the image model are dropped.
    expect([...byId.keys()].sort()).toEqual([
      "community/free-c:free",
      "official/paid-b",
      "official/quest-a",
      "official/unpriced-d",
    ]);

    expect(byId.get("official/quest-a")?.group).toBe("official-quest");
    expect(byId.get("official/paid-b")?.group).toBe("official-paid");
    expect(byId.get("community/free-c:free")?.group).toBe("community-free");
    // An official model with no published text price is quest, never free:
    // `official-free` is not a group the picker can emit.
    expect(byId.get("official/unpriced-d")?.group).toBe("official-quest");
  });

  it("sorts by group order, then success rate, then request volume", () => {
    const models = parseModelCatalog(FAKE_MODELS_PAYLOAD);
    expect(models.map((entry) => entry.id)).toEqual([
      "official/paid-b",
      "official/quest-a",
      "official/unpriced-d",
      "community/free-c:free",
    ]);
  });

  it("survives a payload that is not a catalogue", () => {
    expect(parseModelCatalog(undefined)).toEqual([]);
    expect(parseModelCatalog({})).toEqual([]);
    expect(parseModelCatalog({ data: "nope" })).toEqual([]);
    expect(parseModelCatalog({ data: [null, 42, "x"] })).toEqual([]);
  });

  it("reads context, pricing and health defensively", () => {
    const models = parseModelCatalog({
      data: [
        {
          id: "a/b",
          category: "text",
          tools: true,
          context_length: "not-a-number",
          health: { status: "degraded", success_rate: null, requests: "50" },
          pricing: { promptTextTokens: "0.0000001" },
        },
      ],
    });

    expect(models[0]?.contextLength).toBeNull();
    expect(models[0]?.successRate).toBeNull();
    expect(models[0]?.requests).toBe(50);
    expect(models[0]?.completionPrice).toBeNull();
    expect(models[0]?.promptPrice).toBeCloseTo(1e-7);
  });
});

describe("buildModelOption", () => {
  const models = parseModelCatalog(FAKE_MODELS_PAYLOAD);

  it("exposes a select option with the ACP `model` category", () => {
    const option = buildModelOption(models, "official/quest-a");

    expect(option.type).toBe("select");
    expect(option.id).toBe(MODEL_CONFIG_ID);
    expect(option.category).toBe("model");
    expect(option.currentValue).toBe("official/quest-a");
  });

  it("groups options and orders groups by MODEL_GROUP_ORDER", () => {
    const groups = Object.keys(groupValues(buildModelOption(models, "official/quest-a")));

    expect(groups).toEqual([
      "official-paid",
      "official-quest",
      "community-free",
    ]);
    expect(groups).toEqual(MODEL_GROUP_ORDER.filter((group) => groups.includes(group)));
  });

  it("keeps the current model selectable even when absent from the catalogue", () => {
    // A freshly published model must not blank out the picker: the protocol
    // requires `currentValue` to be one of the offered options.
    const option = buildModelOption(models, "community/YoannDev90/vercel-nemotron-3.5-lightning:free");
    const values = Object.values(groupValues(option)).flat();

    expect(option.currentValue).toBe("community/YoannDev90/vercel-nemotron-3.5-lightning:free");
    expect(values).toContain("community/YoannDev90/vercel-nemotron-3.5-lightning:free");
  });

  it("never injects a duplicate when the current model is already listed", () => {
    const option = buildModelOption(models, "official/quest-a");
    const values = Object.values(groupValues(option)).flat();

    expect(values.filter((value) => value === "official/quest-a")).toHaveLength(1);
  });

  it("summarises each model for the client UI", () => {
    const option = buildModelOption(models, "official/quest-a");
    const questA = groupedOptions(asSelect(option).options)
      .flatMap((group) => group.options)
      .find((entry) => entry.value === "official/quest-a");

    expect(questA?.name).toBe("Quest A");
    expect(questA?.description).toContain("200K ctx");
    expect(questA?.description).toContain("99% success");
    expect(questA?.description).toContain("0.1/0.4 pollen/M in/out");
  });
});

describe("isKnownModel", () => {
  const models = parseModelCatalog(FAKE_MODELS_PAYLOAD);

  it("accepts listed ids and rejects everything else", () => {
    expect(isKnownModel(models, "official/quest-a")).toBe(true);
    expect(isKnownModel(models, "official/no-tools")).toBe(false);
    expect(isKnownModel(models, "")).toBe(false);
  });
});

describe("fetchModelCatalog", () => {
  it("reads and filters the live endpoint", async () => {
    const server = await startFakeLlmServer([]);
    try {
      const models = await fetchModelCatalog({ baseUrl: `${server.baseUrl}/` });

      expect(models.map((entry) => entry.id)).toEqual([
        "official/paid-b",
        "official/quest-a",
        "official/unpriced-d",
        "community/free-c:free",
      ]);
    } finally {
      await server.close();
    }
  });

  it("reports a non-2xx catalogue instead of silently returning nothing", async () => {
    const failing = await startFakeLlmServer([], {
      failModelsWith: { status: 503, body: "down" },
    });

    try {
      await expect(fetchModelCatalog({ baseUrl: failing.baseUrl })).rejects.toThrow(/503/);
    } finally {
      await failing.close();
    }
  });

  it("propagates aborts from the caller", async () => {
    const controller = new AbortController();
    controller.abort();

    const server = await startFakeLlmServer([]);
    try {
      await expect(
        fetchModelCatalog({ baseUrl: server.baseUrl, signal: controller.signal }),
      ).rejects.toThrow();
    } finally {
      await server.close();
    }
  });
});

describe("FALLBACK_MODELS", () => {
  it("offers the configured default so an offline picker still works", () => {
    expect(FALLBACK_MODELS.some((entry) => entry.id === DEFAULT_MODEL)).toBe(true);
  });

  it("spans both origins and more than one tier", () => {
    const groups = [...new Set(FALLBACK_MODELS.map((entry) => entry.group))];

    expect(groups.some((group) => group.startsWith("official"))).toBe(true);
    expect(groups.some((group) => group.startsWith("community"))).toBe(true);
    expect(groups.some((group) => group.endsWith("-paid"))).toBe(true);
    expect(groups.some((group) => group.endsWith("-quest"))).toBe(true);
    expect(groups.every((group) => MODEL_GROUP_ORDER.includes(group))).toBe(true);
  });

  it("claims no free tier it cannot verify offline", () => {
    // The fallback carries no pricing, so it must not promise free models.
    expect(FALLBACK_MODELS.some((entry) => entry.group.endsWith("-free"))).toBe(false);
  });
});
