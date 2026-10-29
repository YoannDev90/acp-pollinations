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
  inferGroup,
  isKnownModel,
  parseModelCatalog,
} from "../models.js";
import type { CatalogModel } from "../models.js";
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

  it("treats zero in / zero out as free", () => {
    expect(classifyTier({ paid_only: false, pricing: {} })).toBe("free");
    expect(
      classifyTier({ paid_only: false, pricing: { promptTextTokens: "0", completionTextTokens: "0" } }),
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

  it("treats absent pricing as free, matching the catalogue's :free models", () => {
    // Pollinations publishes free models with no amounts at all in `pricing`
    // (e.g. `community/...:free`), so "no price" must read as zero, not unknown.
    expect(
      classifyTier({ paid_only: false, pricing: { promptTextTokens: null, completionTextTokens: null } }),
    ).toBe("free");
    expect(classifyTier({ paid_only: false, pricing: undefined })).toBe("free");
    expect(classifyTier({ paid_only: false })).toBe("free");
  });
});

describe("inferGroup", () => {
  it("maps the origin and the :free / :paid suffix", () => {
    expect(inferGroup("community/YoannDev90/vercel-nemotron-3.5-lightning:free")).toBe("community-free");
    expect(inferGroup("nvidia/nemotron-3.5-lightning")).toBe("official-quest");
    expect(inferGroup("community/x/some-model:paid")).toBe("community-paid");
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
    ]);

    expect(byId.get("official/quest-a")?.group).toBe("official-quest");
    expect(byId.get("official/paid-b")?.group).toBe("official-paid");
    expect(byId.get("community/free-c:free")?.group).toBe("community-free");
  });

  it("sorts by group order, then success rate, then request volume", () => {
    const models = parseModelCatalog(FAKE_MODELS_PAYLOAD);
    expect(models.map((entry) => entry.id)).toEqual([
      "official/paid-b",
      "official/quest-a",
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
    expect(FALLBACK_MODELS.some((entry) => entry.id.includes("vercel-nemotron-3.5-lightning"))).toBe(true);
  });

  it("spans both origins and more than one tier", () => {
    const groups = new Set(FALLBACK_MODELS.map((entry) => entry.group));

    expect(groups.has("community-free")).toBe(true);
    expect([...groups].every((group) => MODEL_GROUP_ORDER.includes(group))).toBe(true);
  });
});
