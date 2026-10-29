// Smoke check against the real Pollinations catalogue.
// Run: npx tsx scripts/check-catalogue.ts
import {
  buildModelOption,
  fetchModelCatalog,
} from "../models.js";

const models = await fetchModelCatalog({ baseUrl: "https://gen.pollinations.ai" });

console.log(`tool-capable text models: ${models.length}`);

const byGroup = new Map<string, number>();
for (const model of models) byGroup.set(model.group, (byGroup.get(model.group) ?? 0) + 1);
for (const [group, count] of [...byGroup.entries()].sort()) console.log(`  ${group.padEnd(18)} ${count}`);

const option = buildModelOption(
  models,
  "community/YoannDev90/vercel-nemotron-3.5-lightning:free",
);

console.log(`\npicker: id=${option.id} type=${option.type} category=${option.category}`);
console.log(`currentValue=${option.currentValue}`);
const groups = option.options as Array<{ group: string; name: string; options: Array<{ value: string; name: string; description?: string | null }> }>;
console.log(`groups: ${groups.map((g) => `${g.group}(${g.options.length})`).join(", ")}`);

// Is the configured default present, even though it is not in the catalogue?
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
