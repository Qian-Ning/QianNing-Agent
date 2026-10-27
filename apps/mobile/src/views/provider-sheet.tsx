import { useState, type FormEvent } from "react";
import type { Translate } from "../lib/i18n";
import { isComplete } from "../agent/settings";
import type { ProviderConfig } from "../agent/host";
import { normalizeBase } from "../lib/racp";

type Props = {
  t: Translate;
  initial: ProviderConfig;
  onSave: (provider: ProviderConfig) => void;
  onClose: () => void;
};

/**
 * Model setup, on demand.
 *
 * The app never blocks on this: you can open it, look around, and only meet this
 * sheet when a turn actually needs a model. That is the difference between asking
 * for a key and demanding one.
 */
export function ProviderSheet({ t, initial, onSave, onClose }: Props) {
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [apiKey, setApiKey] = useState(initial.apiKey);
  const [modelId, setModelId] = useState(initial.modelId);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const provider: ProviderConfig = {
      baseUrl: normalizeBase(baseUrl),
      apiKey: apiKey.trim(),
      modelId: modelId.trim(),
    };
    if (!isComplete(provider)) {
      setError(t("local.needAll"));
      return;
    }
    onSave(provider);
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <form className="sheet" onClick={(event) => event.stopPropagation()} onSubmit={submit}>
        <h2>{t("local.title")}</h2>
        <p className="muted">{t("local.subtitle")}</p>
        <label htmlFor="sheet-base">{t("local.baseUrl")}</label>
        <input
          id="sheet-base"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder={t("local.baseUrlHint")}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          inputMode="url"
        />
        <label htmlFor="sheet-key">{t("local.apiKey")}</label>
        <input
          id="sheet-key"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={t("local.apiKeyHint")}
          type="password"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <label htmlFor="sheet-model">{t("local.model")}</label>
        <input
          id="sheet-model"
          value={modelId}
          onChange={(event) => setModelId(event.target.value)}
          placeholder={t("local.modelHint")}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        {error ? <p className="error">{error}</p> : null}
        <button className="primary" type="submit">
          {t("local.save")}
        </button>
        <button className="ghost wide" type="button" onClick={onClose}>
          {t("local.later")}
        </button>
      </form>
    </div>
  );
}
