/**
 * Pure selection logic for the composer model picker's two-pane layout.
 *
 * The picker shows a left rail of sources (favorites, recents, then every
 * configured provider) and a right pane of the models for the active source,
 * plus a capability filter row and a cross-provider search. All of that is
 * derived here so the view stays declarative and the rules are unit-testable
 * without a DOM: the hook owns menu/open/keyboard state, this module owns what
 * the rail, the pane and the filters contain.
 *
 * Nothing here performs I/O or reads persisted state; favorites and recents
 * arrive as plain key lists from `composer-model-preferences`.
 */
import {
  modelMatchesFilter,
  type ModelFilter,
  type ModelInfo,
  type ProviderPublic,
} from "@pi-desktop/shared";
import {
  composerModelBinding,
  composerModelMatchesQuery,
  sameComposerModelId,
} from "./composer-models.ts";
import { composerModelKey } from "./composer-model-preferences.ts";

export type ComposerModelEntry = {
  provider: ProviderPublic;
  providerDisplayName: string;
  providerSearchText: string;
  model: ModelInfo;
  /** Stable (providerId, modelId) identity used for favorites/recents. */
  key: string;
};

export type ComposerProviderGroup = {
  provider: ProviderPublic;
  providerDisplayName: string;
  providerSearchText: string;
  models: ModelInfo[];
};

/** A left-rail source: a pinned bucket (favorites/recents) or one provider. */
export type ComposerRailSource =
  | { kind: "favorites"; id: "favorites"; count: number }
  | { kind: "recents"; id: "recents"; count: number }
  | {
      kind: "provider";
      id: string;
      provider: ProviderPublic;
      displayName: string;
      count: number;
    };

/** The capability filters offered in the picker, in display order. */
export const COMPOSER_MODEL_FILTERS: readonly ModelFilter[] = [
  "reasoning",
  "vision",
  "tools",
  "pdf",
] as const;

/** i18n key for a capability filter chip's label. */
export function composerModelFilterLabelKey(filter: ModelFilter): string {
  switch (filter) {
    case "reasoning":
      return "chat.modelFilterReasoning";
    case "vision":
      return "chat.modelFilterVision";
    case "tools":
      return "chat.modelFilterTools";
    case "pdf":
      return "chat.modelFilterPdf";
    default:
      return "chat.modelFilterReasoning";
  }
}

/** Whether a model satisfies every active capability filter (AND semantics). */
export function composerModelMatchesFilters(
  model: ModelInfo,
  filters: readonly ModelFilter[],
): boolean {
  return filters.every((filter) => modelMatchesFilter(model, filter));
}

/** Flatten configured provider groups into (provider, model) entries. */
export function composerModelEntries(
  groups: readonly ComposerProviderGroup[],
): ComposerModelEntry[] {
  return groups.flatMap((group) =>
    group.models.map((model) => ({
      provider: group.provider,
      providerDisplayName: group.providerDisplayName,
      providerSearchText: group.providerSearchText,
      model,
      key: composerModelKey(group.provider.id, model.modelId),
    })),
  );
}

function entryMatchesQuery(entry: ComposerModelEntry, queryNeedle: string): boolean {
  return composerModelMatchesQuery(
    entry.model,
    entry.providerSearchText,
    queryNeedle,
    composerModelBinding(entry.provider, entry.model.modelId)?.alias,
  );
}

/** Look up entries by their composite key, preserving the requested order. */
function entriesForKeys(
  keys: readonly string[],
  byKey: Map<string, ComposerModelEntry>,
): ComposerModelEntry[] {
  const out: ComposerModelEntry[] = [];
  for (const key of keys) {
    const entry = byKey.get(key);
    if (entry) out.push(entry);
  }
  return out;
}

export type ComposerRailInput = {
  groups: readonly ComposerProviderGroup[];
  favorites: readonly string[];
  recents: readonly string[];
  filters: readonly ModelFilter[];
};

/**
 * Build the left-rail sources. Favorites and recents appear only when they
 * resolve to at least one currently configured model that also passes the
 * active capability filters; their counts and every provider count reflect the
 * same filters, so the rail never advertises a bucket the right pane renders
 * empty.
 */
export function composerRailSources({
  groups,
  favorites,
  recents,
  filters,
}: ComposerRailInput): ComposerRailSource[] {
  const entries = composerModelEntries(groups);
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const passesFilters = (entry: ComposerModelEntry) =>
    composerModelMatchesFilters(entry.model, filters);

  const sources: ComposerRailSource[] = [];

  const favoriteCount = entriesForKeys(favorites, byKey).filter(passesFilters).length;
  if (favoriteCount > 0) {
    sources.push({ kind: "favorites", id: "favorites", count: favoriteCount });
  }
  const recentCount = entriesForKeys(recents, byKey).filter(passesFilters).length;
  if (recentCount > 0) {
    sources.push({ kind: "recents", id: "recents", count: recentCount });
  }
  for (const group of groups) {
    const count = group.models.filter((model) =>
      composerModelMatchesFilters(model, filters),
    ).length;
    sources.push({
      kind: "provider",
      id: group.provider.id,
      provider: group.provider,
      displayName: group.providerDisplayName,
      count,
    });
  }
  return sources;
}

export type ComposerPaneInput = ComposerRailInput & {
  /** Active rail selection: a provider id, or the "favorites"/"recents" bucket. */
  activeSource: string;
  /** Trimmed, lower-cased search needle; empty means "no search". */
  queryNeedle: string;
};

export type ComposerPaneResult = {
  /** Whether the pane is showing cross-provider search results. */
  searching: boolean;
  /** The ordered entries the right pane renders. */
  entries: ComposerModelEntry[];
};

/**
 * Resolve the right-pane entries for the current rail selection, filters and
 * search.
 *
 * A non-empty query always searches across every provider and ignores the rail
 * selection, so a model is reachable by name no matter which source is active.
 * Favorites keep their starred order; recents keep newest-first; a provider
 * keeps its configured order. Capability filters apply in every case. When a
 * favorite entry is shown it floats pinned entries to the top within a
 * provider view so a starred model stays easy to re-find.
 */
export function composerPaneEntries({
  groups,
  favorites,
  recents,
  filters,
  activeSource,
  queryNeedle,
}: ComposerPaneInput): ComposerPaneResult {
  const entries = composerModelEntries(groups);
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const passesFilters = (entry: ComposerModelEntry) =>
    composerModelMatchesFilters(entry.model, filters);

  if (queryNeedle) {
    return {
      searching: true,
      entries: entries
        .filter(passesFilters)
        .filter((entry) => entryMatchesQuery(entry, queryNeedle)),
    };
  }

  if (activeSource === "favorites") {
    return { searching: false, entries: entriesForKeys(favorites, byKey).filter(passesFilters) };
  }
  if (activeSource === "recents") {
    return { searching: false, entries: entriesForKeys(recents, byKey).filter(passesFilters) };
  }

  const favoriteSet = new Set(favorites);
  const providerEntries = entries
    .filter((entry) => entry.provider.id === activeSource)
    .filter(passesFilters);
  // Pinned models float to the top of a provider view without disturbing the
  // relative order of either partition.
  const pinned = providerEntries.filter((entry) => favoriteSet.has(entry.key));
  const rest = providerEntries.filter((entry) => !favoriteSet.has(entry.key));
  return { searching: false, entries: [...pinned, ...rest] };
}

/**
 * Pick the rail source that should be active when the menu opens. Prefer the
 * provider of the currently selected model so the user lands on their own
 * model; fall back to the first provider, then to favorites or recents when no
 * provider is configured.
 */
export function composerInitialSource(
  sources: readonly ComposerRailSource[],
  selectedProviderId: string | undefined,
): string {
  if (selectedProviderId) {
    const match = sources.find(
      (source) => source.kind === "provider" && source.id === selectedProviderId,
    );
    if (match) return match.id;
  }
  const firstProvider = sources.find((source) => source.kind === "provider");
  if (firstProvider) return firstProvider.id;
  return sources[0]?.id ?? "";
}

/** Index of the selected (provider, model) within a flat entry list, or -1. */
export function composerActiveEntryIndex(
  entries: readonly ComposerModelEntry[],
  selectedProviderId: string | undefined,
  selectedModelId: string | undefined,
): number {
  if (!selectedProviderId || !selectedModelId) return -1;
  return entries.findIndex(
    (entry) =>
      entry.provider.id === selectedProviderId &&
      sameComposerModelId(entry.model.modelId, selectedModelId),
  );
}
