/**
 * Favorites, recents, capability filters and the active rail source for the
 * composer's two-pane model picker.
 *
 * This hook owns only the model-selection UI state and derives the rail and
 * pane from the pure helpers in `composer-model-selector`; it performs no
 * network or session work. The owning controller (`useComposerModelMenu`)
 * passes the configured provider groups in and reads the derived rail/pane
 * back out, so the heavy selection logic stays here instead of swelling the
 * controller.
 *
 * Favorites and recents persist to `localStorage` (renderer UI preference,
 * not host state) and are re-read whenever the menu opens so a star set in one
 * place is reflected everywhere.
 */
import type { ModelFilter, ProviderPublic } from "@pi-desktop/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  composerInitialSource,
  composerPaneEntries,
  composerRailSources,
  type ComposerModelEntry,
  type ComposerProviderGroup,
  type ComposerRailSource,
} from "../../../../lib/composer-model-selector";
import {
  composerModelKey,
  loadFavoriteModelKeys,
  loadRecentModelKeys,
  rememberRecentModelKey,
  toggleFavoriteModelKey,
} from "../../../../lib/composer-model-preferences";

type UseComposerModelSelectorOptions = {
  groups: ComposerProviderGroup[];
  query: string;
  menuOpen: boolean;
  selectedProviderId: string | undefined;
  selectedModelId: string | undefined;
};

export type ComposerModelSelector = {
  railSources: ComposerRailSource[];
  activeSource: string;
  setActiveSource: (id: string) => void;
  paneEntries: ComposerModelEntry[];
  paneSearching: boolean;
  filters: ModelFilter[];
  toggleFilter: (filter: ModelFilter) => void;
  favoriteKeys: Set<string>;
  isFavorite: (providerId: string, modelId: string) => boolean;
  toggleFavorite: (provider: ProviderPublic, modelId: string) => void;
  markRecent: (providerId: string, modelId: string) => void;
};

export function useComposerModelSelector({
  groups,
  query,
  menuOpen,
  selectedProviderId,
  selectedModelId,
}: UseComposerModelSelectorOptions): ComposerModelSelector {
  const [favorites, setFavorites] = useState<string[]>(() => loadFavoriteModelKeys());
  const [recents, setRecents] = useState<string[]>(() => loadRecentModelKeys());
  const [filters, setFilters] = useState<ModelFilter[]>([]);
  const [activeSource, setActiveSource] = useState("");

  const queryNeedle = query.trim().toLowerCase();

  const railSources = useMemo(
    () => composerRailSources({ groups, favorites, recents, filters }),
    [groups, favorites, recents, filters],
  );

  const pane = useMemo(
    () =>
      composerPaneEntries({
        groups,
        favorites,
        recents,
        filters,
        activeSource,
        queryNeedle,
      }),
    [groups, favorites, recents, filters, activeSource, queryNeedle],
  );

  // Opening the menu is the moment to resync persisted favorites/recents, clear
  // any stale filter, and land the rail on the provider of the current model.
  useEffect(() => {
    if (!menuOpen) return;
    const fav = loadFavoriteModelKeys();
    const rec = loadRecentModelKeys();
    setFavorites(fav);
    setRecents(rec);
    setFilters([]);
    setActiveSource(
      composerInitialSource(
        composerRailSources({ groups, favorites: fav, recents: rec, filters: [] }),
        selectedProviderId,
      ),
    );
    // Intentionally keyed to the open transition only: the rail must not jump
    // while the user is browsing. `groups`/`selectedProviderId` are read fresh
    // above, so an exhaustive-deps lint would force spurious resets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen]);

  // Keep the active source valid: a filter that empties the favorites or
  // recents bucket must not leave the pane pointing at a vanished source.
  useEffect(() => {
    if (!menuOpen) return;
    if (railSources.some((source) => source.id === activeSource)) return;
    setActiveSource(composerInitialSource(railSources, selectedProviderId));
  }, [menuOpen, railSources, activeSource, selectedProviderId]);

  const toggleFilter = useCallback((filter: ModelFilter) => {
    setFilters((current) =>
      current.includes(filter)
        ? current.filter((entry) => entry !== filter)
        : [...current, filter],
    );
  }, []);

  const favoriteKeys = useMemo(() => new Set(favorites), [favorites]);

  const isFavorite = useCallback(
    (providerId: string, modelId: string) =>
      favoriteKeys.has(composerModelKey(providerId, modelId)),
    [favoriteKeys],
  );

  const toggleFavorite = useCallback((provider: ProviderPublic, modelId: string) => {
    setFavorites(toggleFavoriteModelKey(provider.id, modelId));
  }, []);

  const markRecent = useCallback((providerId: string, modelId: string) => {
    setRecents(rememberRecentModelKey(providerId, modelId));
  }, []);

  return {
    railSources,
    activeSource,
    setActiveSource,
    paneEntries: pane.entries,
    paneSearching: pane.searching,
    filters,
    toggleFilter,
    favoriteKeys,
    isFavorite,
    toggleFavorite,
    markRecent,
  };
}
