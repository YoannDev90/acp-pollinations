// Smoke check against the real Pollinations catalogue.
// Run: npx tsx scripts/check-catalogue.ts
import type {
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from "@agentclientprotocol/sdk";

import {
  buildModelOption,
  fetchModelCatalog,
} from "../src/models.js";
import { DEFAULT_MODEL } from "../src/config.js";

const models = await fetchModelCatalog({ baseUrl: "https://gen.pollinations.ai" });

console.log(`tool-capable text models: ${models.length}`);

const byGroup = new Map<string, number>();
for (const model of models) byGroup.set(model.group, (byGroup.get(model.group) ?? 0) + 1);
for (const [group, count] of [...byGroup.entries()].sort()) console.log(`  ${group.padEnd(18)} ${count}`);

const option = buildModelOption(models, DEFAULT_MODEL);

console.log(`\npicker: id=${option.id} type=${option.type} category=${option.category}`);
console.log(`currentValue=${option.currentValue}`);
// The picker is always a select group; anything else would mean
// `buildModelOption` changed shape, and the rest of this script would be
// printing nonsense rather than failing.
if (option.type !== "select") throw new Error(`expected a select option, got ${option.type}`);
// A select may be a flat list of options or a list of groups; the picker this
// script inspects is always grouped, so anything ungrouped is filtered out
// rather than walked as if it had a group.
const options: Array<SessionConfigSelectOption | SessionConfigSelectGroup> = option.options;
const groups = options.filter((entry): entry is SessionConfigSelectGroup => "group" in entry);
console.log(`groups: ${groups.map((g) => `${g.group}(${g.options.length})`).join(", ")}`);

// The default is normally listed; a model the catalogue has not caught up
// with is injected as a placeholder rather than dropped from the picker.
const flat = groups.flatMap((g) => g.options);
const current = flat.filter((entry) => entry.value === option.currentValue);
console.log(`\ncurrent model appears ${current.length} time(s) in the picker`);
console.log(`  -> ${current[0]?.name} | ${current[0]?.description}`);

console.log("\nfirst 6 entries of each group:");
const seen = new Set<string>();
for (const entry of flat) {
  const group = groups.find((g) => g.options.some((o) => o.value === entry.value));
  if (!group) continue;
  if (seen.has(group.group)) continue;
  seen.add(group.group);
  console.log(`\n[${group.name}]`);
  for (const optionEntry of group.options.slice(0, 6)) {
    console.log(`  ${optionEntry.value.padEnd(56)} ${optionEntry.description ?? ""}`);
  }
}
