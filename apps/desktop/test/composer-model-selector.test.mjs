import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPOSER_MODEL_FILTERS,
  composerActiveEntryIndex,
  composerInitialSource,
  composerModelEntries,
  composerModelFilterLabelKey,
  composerModelMatchesFilters,
  composerPaneEntries,
  composerRailSources,
} from "../src/lib/composer-model-selector.ts";
import { composerModelKey } from "../src/lib/composer-model-preferences.ts";

/** Minimal ProviderPublic-shaped stub for selector logic. */
const provider = (id, name, modelIds) => ({
  id,
  name,
  enabled: true,
  hasSecret: true,
  authKind: "api_key",
  models: modelIds.map((modelId) => ({
    id: modelId,
    contextWindow: 128_000,
    maxTokens: 8_192,
    thinkingLevels: [],
    defaultThinkingLevel: null,
  })),
});

const model = (modelId, extra = {}) => ({
  modelId,
  displayName: modelId,
  providerId: extra.providerId ?? "p",
  capabilities: extra.capabilities ?? ["text"],
  reasoning: extra.reasoning,
  toolCall: extra.toolCall,
  modalities: extra.modalities,
  source: "discovered",
});

const group = (prov, models) => ({
  provider: prov,
  providerDisplayName: prov.name,
  providerSearchText: prov.name,
  models,
});

const kira = provider("kira", "Kira AI", ["ds-v4-flash", "qwen-free"]);
const amd = provider("amd", "AMD", ["mimo-flash", "ds-v41-flash"]);

const groups = [
  group(kira, [
    model("ds-v4-flash", { providerId: "kira", capabilities: ["text", "tools"], toolCall: true, reasoning: true }),
    model("qwen-free", { providerId: "kira", capabilities: ["text"] }),
  ]),
  group(amd, [
    model("mimo-flash", {
      providerId: "amd",
      capabilities: ["text", "vision", "tools"],
      toolCall: true,
      reasoning: true,
      modalities: { input: ["text", "image"] },
    }),
    model("ds-v41-flash", { providerId: "amd", capabilities: ["text", "tools"], toolCall: true }),
  ]),
];

test("entries carry a stable (provider, model) key", () => {
  const entries = composerModelEntries(groups);
  assert.equal(entries.length, 4);
  assert.equal(entries[0].key, composerModelKey("kira", "ds-v4-flash"));
  assert.equal(entries[2].key, composerModelKey("amd", "mimo-flash"));
});

test("capability filters use AND semantics", () => {
  const vision = model("m", { capabilities: ["text", "vision"], modalities: { input: ["image"] } });
  assert.equal(composerModelMatchesFilters(vision, ["vision"]), true);
  assert.equal(composerModelMatchesFilters(vision, ["vision", "tools"]), false);
  assert.equal(composerModelMatchesFilters(vision, []), true);
});

test("every exposed filter maps to an i18n key", () => {
  for (const filter of COMPOSER_MODEL_FILTERS) {
    assert.match(composerModelFilterLabelKey(filter), /^chat\.modelFilter/);
  }
});

test("rail lists favorites and recents before providers, with filtered counts", () => {
  const favorites = [composerModelKey("amd", "mimo-flash")];
  const recents = [composerModelKey("kira", "ds-v4-flash"), composerModelKey("amd", "ds-v41-flash")];
  const sources = composerRailSources({ groups, favorites, recents, filters: [] });
  assert.deepEqual(
    sources.map((s) => s.id),
    ["favorites", "recents", "kira", "amd"],
  );
  assert.equal(sources[0].count, 1);
  assert.equal(sources[1].count, 2);
  // Provider counts reflect the configured models.
  assert.equal(sources.find((s) => s.id === "kira").count, 2);
});

test("rail hides a pinned bucket when filters empty it", () => {
  // Only vision model is mimo-flash (amd). Favoriting a text-only model and
  // then filtering by vision must drop the favorites bucket entirely.
  const favorites = [composerModelKey("kira", "qwen-free")];
  const sources = composerRailSources({ groups, favorites, recents: [], filters: ["vision"] });
  assert.equal(sources.some((s) => s.id === "favorites"), false);
  // AMD still has one vision model; Kira has none, count 0 but row kept.
  assert.equal(sources.find((s) => s.id === "amd").count, 1);
  assert.equal(sources.find((s) => s.id === "kira").count, 0);
});

test("pane shows a provider's models in configured order, pinned first", () => {
  const favorites = [composerModelKey("amd", "ds-v41-flash")];
  const result = composerPaneEntries({
    groups,
    favorites,
    recents: [],
    filters: [],
    activeSource: "amd",
    queryNeedle: "",
  });
  assert.equal(result.searching, false);
  assert.deepEqual(
    result.entries.map((e) => e.model.modelId),
    ["ds-v41-flash", "mimo-flash"],
  );
});

test("a search needle crosses every provider and ignores the rail selection", () => {
  const result = composerPaneEntries({
    groups,
    favorites: [],
    recents: [],
    filters: [],
    activeSource: "kira",
    queryNeedle: "flash",
  });
  assert.equal(result.searching, true);
  assert.deepEqual(
    result.entries.map((e) => e.model.modelId),
    ["ds-v4-flash", "mimo-flash", "ds-v41-flash"],
  );
});

test("search respects active capability filters", () => {
  const result = composerPaneEntries({
    groups,
    favorites: [],
    recents: [],
    filters: ["vision"],
    activeSource: "kira",
    queryNeedle: "flash",
  });
  assert.deepEqual(
    result.entries.map((e) => e.model.modelId),
    ["mimo-flash"],
  );
});

test("favorites bucket keeps starred order and filters out stale keys", () => {
  const favorites = [
    composerModelKey("amd", "mimo-flash"),
    composerModelKey("ghost", "removed-model"),
    composerModelKey("kira", "ds-v4-flash"),
  ];
  const result = composerPaneEntries({
    groups,
    favorites,
    recents: [],
    filters: [],
    activeSource: "favorites",
    queryNeedle: "",
  });
  assert.deepEqual(
    result.entries.map((e) => e.model.modelId),
    ["mimo-flash", "ds-v4-flash"],
  );
});

test("initial source prefers the selected model's provider", () => {
  const sources = composerRailSources({ groups, favorites: [], recents: [], filters: [] });
  assert.equal(composerInitialSource(sources, "amd"), "amd");
  assert.equal(composerInitialSource(sources, undefined), "kira");
  assert.equal(composerInitialSource(sources, "gone"), "kira");
});

test("active entry index finds the selected provider+model pair", () => {
  const entries = composerModelEntries(groups);
  assert.equal(composerActiveEntryIndex(entries, "amd", "mimo-flash"), 2);
  assert.equal(composerActiveEntryIndex(entries, "amd", "nope"), -1);
  assert.equal(composerActiveEntryIndex(entries, undefined, undefined), -1);
});
