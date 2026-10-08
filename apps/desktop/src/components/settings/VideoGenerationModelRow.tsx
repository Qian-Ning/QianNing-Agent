import { useTranslation } from "react-i18next";
import {
  videoGenerationBindings,
  type AppSettings,
  type ProviderPublic,
  type VideoGenerationBinding,
} from "@pi-desktop/shared";
import { sameComposerModelId } from "../../lib/composer-models";
import { SettingsMenuSelect } from "./SettingsMenuSelect";
import { videoGenerationBindingAvailable } from "./video-generation-default";

function videoModelOptionId(binding: VideoGenerationBinding): string {
  return `${binding.providerId}\u0000${binding.modelId}`;
}

export function VideoGenerationModelRow({
  settings,
  providers,
  busy = false,
  onChange,
}: {
  settings: AppSettings;
  providers: ProviderPublic[];
  busy?: boolean;
  onChange?: (binding: VideoGenerationBinding) => void;
}) {
  const { t } = useTranslation();
  const binding = settings.videoGeneration;
  // An explicit candidate list is the user's selection. Do not put the stored
  // default back when they cleared it; only a missing list is the legacy
  // single-binding fallback.
  const candidates = Array.isArray(settings.videoGenerationModels)
    ? videoGenerationBindings(settings.videoGenerationModels, null)
    : videoGenerationBindings(undefined, binding);
  if (candidates.length === 0) return null;

  const activeCandidate = binding
    ? candidates.find((candidate) =>
      candidate.providerId === binding.providerId &&
      sameComposerModelId(candidate.modelId, binding.modelId),
    )
    : undefined;
  const provider = binding
    ? providers.find((entry) => entry.id === binding.providerId)
    : undefined;
  // The same availability rule that decides whether this binding may stay the
  // app default, so the row can never claim a pairing the runtime rejects.
  const valid = !!activeCandidate &&
    videoGenerationBindingAvailable(provider, activeCandidate.modelId);
  const options = candidates.map((candidate) => {
    const candidateProvider = providers.find((entry) => entry.id === candidate.providerId);
    const available = videoGenerationBindingAvailable(
      candidateProvider,
      candidate.modelId,
    );
    return {
      id: videoModelOptionId(candidate),
      label: `${candidateProvider?.name ?? candidate.providerId} · ${candidate.modelId}`,
      disabled: !available,
    };
  });
  // Disabled rows are not choices. With none left, the summary stays hidden
  // instead of showing a checked model the user can no longer pick.
  if (!options.some((option) => !option.disabled)) return null;
  const checkedId = valid && activeCandidate ? videoModelOptionId(activeCandidate) : "";

  return (
    <div className="settings-row model-default-row model-video-row">
      <div className="settings-row-copy model-default-copy">
        <div className="settings-row-title model-default-label">{t("settings.videoModel")}</div>
        <div className="settings-row-detail model-default-value">
          {valid && provider && binding ? (
            <>
              <span className="model-default-provider">{provider.name}</span>
              <span className="model-default-sep" aria-hidden>·</span>
              <span className="model-default-model font-mono">{binding.modelId}</span>
            </>
          ) : (
            <span className="model-default-empty" role="status">
              {t(activeCandidate ? "settings.videoModelUnavailable" : "settings.videoModelUnset")}
            </span>
          )}
        </div>
      </div>
      {/* Always shown while there is anything to run: a hidden picker reads as
          "cannot be changed", and a single candidate still needs to say which
          one is the default. */}
      {onChange && options.length > 0 ? (
        <SettingsMenuSelect
          className="model-video-selector"
          label={t("settings.videoModel")}
          value={checkedId}
          options={options}
          busy={busy}
          onChange={(id) => {
            const next = candidates.find((candidate) => videoModelOptionId(candidate) === id);
            if (next) onChange(next);
          }}
        />
      ) : null}
    </div>
  );
}
