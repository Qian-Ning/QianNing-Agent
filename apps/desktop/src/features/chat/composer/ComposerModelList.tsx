import { formatTokenCount, type ModelInfo, type ProviderPublic } from "@pi-desktop/shared";
import type { TFunction } from "i18next";
import type { RefObject } from "react";
import {
  IconCheck,
  IconClock,
  IconEye,
  IconSearch,
  IconSparkles,
  IconStar,
} from "../../../components/icons";
import {
  composerModelBadges,
  composerModelBinding,
  composerModelDisplayName,
  sameComposerModelId,
} from "../../../lib/composer-models";
import {
  COMPOSER_MODEL_FILTERS,
  composerModelFilterLabelKey,
  type ComposerModelEntry,
  type ComposerRailSource,
} from "../../../lib/composer-model-selector";
import type { ComposerModelSelector } from "./hooks/useComposerModelSelector";

/**
 * Two-pane model browser (left rail of sources + right pane of models) with a
 * cross-provider search and capability filters. The flat pane list is owned by
 * the controller so a single highlight index drives both the keyboard
 * navigation and what is rendered here; this view never decides selection.
 */
export function ComposerModelList({
  t, query, setQuery, modelSearchRef, modelListRef, paneEntries,
  modelHighlight, setModelHighlight, selectedProviderId, selectedModelId, selectModel, selector,
}: {
  t: TFunction;
  query: string;
  setQuery: (query: string) => void;
  modelSearchRef: RefObject<HTMLInputElement | null>;
  modelListRef: RefObject<HTMLDivElement | null>;
  paneEntries: ComposerModelEntry[];
  modelHighlight: number;
  setModelHighlight: (index: number) => void;
  selectedProviderId?: string;
  selectedModelId?: string;
  selectModel: (provider: ProviderPublic, modelId: string) => void | Promise<void>;
  selector: ComposerModelSelector;
}) {
  const railLabel = (source: ComposerRailSource): string => {
    if (source.kind === "favorites") return t("chat.modelSourceFavorites");
    if (source.kind === "recents") return t("chat.modelSourceRecents");
    return source.displayName;
  };
  const hasProviderRail = selector.railSources.some((source) => source.kind === "provider");

  return (
    <div className="composer-model-browser">
      <label className="composer-model-search">
        <IconSearch size={13} aria-hidden="true" />
        <span className="sr-only">{t("chat.searchModels")}</span>
        <input
          ref={modelSearchRef}
          type="text"
          value={query}
          placeholder={t("chat.searchModels")}
          aria-label={t("chat.searchModels")}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      <div className="composer-model-filters" role="group" aria-label={t("chat.searchModels")}>
        {COMPOSER_MODEL_FILTERS.map((filter) => {
          const active = selector.filters.includes(filter);
          const label = t(composerModelFilterLabelKey(filter));
          return (
            <button
              key={filter}
              type="button"
              className={`composer-model-filter-chip ${active ? "active" : ""}`}
              aria-pressed={active}
              onClick={() => selector.toggleFilter(filter)}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div className="composer-model-browser-body">
        <div className="composer-model-rail" role="tablist" aria-orientation="vertical">
          {selector.railSources.map((source, index) => {
            const previousProvider =
              index > 0 && selector.railSources[index - 1]?.kind === "provider";
            const showProvidersHeading = source.kind === "provider" && !previousProvider;
            const active = !selector.paneSearching && source.id === selector.activeSource;
            return (
              <div key={source.id} className="composer-model-rail-slot">
                {showProvidersHeading ? (
                  <div className="composer-model-rail-heading">
                    {t("chat.modelSourceProviders")}
                  </div>
                ) : null}
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`composer-model-rail-item ${active ? "active" : ""}`}
                  onClick={() => {
                    setQuery("");
                    selector.setActiveSource(source.id);
                  }}
                >
                  <span className="composer-model-rail-icon" aria-hidden="true">
                    {source.kind === "favorites" ? (
                      <IconStar size={13} />
                    ) : source.kind === "recents" ? (
                      <IconClock size={13} />
                    ) : null}
                  </span>
                  <span className="composer-model-rail-label">{railLabel(source)}</span>
                  <span className="composer-model-rail-count">{source.count}</span>
                </button>
              </div>
            );
          })}
        </div>

        <div className="composer-model-pane" ref={modelListRef}>
          {paneEntries.map((entry, index) => (
            <ComposerModelRow
              key={entry.key}
              t={t}
              entry={entry}
              index={index}
              showProvider={selector.paneSearching || !hasProviderRail}
              active={
                selectedProviderId === entry.provider.id &&
                sameComposerModelId(selectedModelId ?? "", entry.model.modelId)
              }
              highlighted={modelHighlight === index}
              favorite={selector.isFavorite(entry.provider.id, entry.model.modelId)}
              onHover={() => setModelHighlight(index)}
              onSelect={() => void selectModel(entry.provider, entry.model.modelId)}
              onToggleFavorite={() => selector.toggleFavorite(entry.provider, entry.model.modelId)}
            />
          ))}
          {paneEntries.length === 0 ? (
            <div className="composer-model-empty">{t("chat.noModelResults")}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** One model row in the right pane: label, capability badges, context, star. */
function ComposerModelRow({
  t, entry, index, showProvider, active, highlighted, favorite, onHover, onSelect, onToggleFavorite,
}: {
  t: TFunction;
  entry: ComposerModelEntry;
  index: number;
  showProvider: boolean;
  active: boolean;
  highlighted: boolean;
  favorite: boolean;
  onHover: () => void;
  onSelect: () => void;
  onToggleFavorite: () => void;
}) {
  const { provider, model } = entry;
  const alias = composerModelBinding(provider, model.modelId)?.alias?.trim();
  const optionDisplayName = composerModelDisplayName(provider, model.modelId, model.displayName);
  const favoriteLabel = favorite ? t("chat.modelFavoriteRemove") : t("chat.modelFavoriteAdd");
  return (
    <div
      className={`composer-plus-item composer-model-option ${active ? "active" : ""} ${highlighted ? "kb-active" : ""}`}
      data-model-index={index}
    >
      <button
        type="button"
        title={model.modelId}
        className="composer-model-option-select"
        role="menuitemradio"
        aria-checked={active}
        onMouseMove={onHover}
        onClick={onSelect}
      >
        <span className="composer-model-option-main">
          {showProvider ? (
            <span className="composer-model-option-provider">{entry.providerDisplayName}</span>
          ) : null}
          <span className={`composer-model-label ${alias ? "is-alias" : ""}`}>
            {alias || optionDisplayName}
          </span>
          <span className="composer-model-option-meta">
            {composerModelBadges(model, provider).map((badge) => {
              const badgeLabel = t(
                badge === "reasoning" ? "chat.modelBadgeReasoning" : "chat.modelBadgeVision",
              );
              return (
                <span
                  key={badge}
                  className="composer-model-option-badge"
                  title={badgeLabel}
                  aria-label={badgeLabel}
                  role="img"
                >
                  {badge === "reasoning" ? (
                    <IconSparkles size={12} aria-hidden="true" />
                  ) : (
                    <IconEye size={12} aria-hidden="true" />
                  )}
                </span>
              );
            })}
            {model.contextWindow ? (
              <span className="composer-model-option-ctx">
                {formatTokenCount(model.contextWindow)}
              </span>
            ) : null}
          </span>
        </span>
        {active ? (
          <IconCheck size={14} className="composer-model-check" aria-hidden="true" />
        ) : null}
      </button>
      <button
        type="button"
        className={`composer-model-fav ${favorite ? "active" : ""}`}
        aria-label={favoriteLabel}
        aria-pressed={favorite}
        title={favoriteLabel}
        onClick={onToggleFavorite}
      >
        <IconStar size={13} aria-hidden="true" />
      </button>
    </div>
  );
}
