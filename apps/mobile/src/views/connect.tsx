import { useMemo, useState, type FormEvent } from "react";
import { NAMED_ENDPOINT_PRESETS } from "@pi-desktop/shared";
import { normalizeBase } from "../lib/racp";
import type { Translate } from "../lib/i18n";
import { isComplete, loadProvider } from "../agent/settings";
import { probeModels, type ProviderConfig } from "../agent/host";

type Props = {
  t: Translate;
  onLocal: (provider: ProviderConfig) => void;
  /** Enter without a model; the app asks for one only when a turn needs it. */
  onSkip: () => void;
};

/**
 * First run asks for one thing: which service, and its key.
 *
 * Pairing with a computer is not part of setting up a model — it lives in
 * Settings → 连接, next to the other connection concerns. The desktop already
 * knows every endpoint it supports, so the phone reads the same catalog instead
 * of asking a person to remember a Base URL. Only Chat Completions presets
 * appear, because that is the wire the phone speaks.
 */
const PRESETS = NAMED_ENDPOINT_PRESETS.filter((preset) => preset.apiStyle === "chat_completions");

export function ConnectView({ t, onLocal, onSkip }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saved = loadProvider();
  const [presetId, setPresetId] = useState<string | null>(saved ? "custom" : null);
  const [customBase, setCustomBase] = useState(saved?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(saved?.apiKey ?? "");
  const [modelId, setModelId] = useState(saved?.modelId ?? "");
  const [models, setModels] = useState<string[] | null>(null);

  const custom = presetId === "custom";
  const preset = useMemo(() => PRESETS.find((entry) => entry.id === presetId), [presetId]);
  const baseUrl = custom ? customBase : (preset?.baseUrl ?? "");

  const fetchModels = async () => {
    setBusy(true);
    setError(null);
    try {
      const list = await probeModels(normalizeBase(baseUrl), apiKey.trim());
      setModels(list);
      if (list.length === 0) setError(t("local.noModels"));
      else setModelId((current) => (list.includes(current) ? current : (list[0] as string)));
    } catch (cause) {
      setModels(null);
      setError(cause instanceof Error ? cause.message : t("error.generic"));
    } finally {
      setBusy(false);
    }
  };

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
    setError(null);
    onLocal(provider);
  };

  return (
    <div className="screen connect">
      <div className="brand">
        <span className="brand-mark">Q</span>
        <h1>{t("app.name")}</h1>
      </div>

      {presetId === null ? (
        <>
          <p className="muted">{t("local.pickProvider")}</p>
          <div className="provider-list">
            {PRESETS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="row"
                onClick={() => {
                  setPresetId(entry.id);
                  setModels(null);
                  setModelId("");
                }}
              >
                <span className="row-title">{entry.name}</span>
                <span className="row-meta">{entry.baseUrl.replace(/^https:\/\//, "")}</span>
              </button>
            ))}
            <button
              type="button"
              className="row"
              onClick={() => {
                setPresetId("custom");
                setModels(null);
              }}
            >
              <span className="row-title">{t("local.custom")}</span>
              <span className="row-meta">{t("local.customHint")}</span>
            </button>
          </div>
          <button className="ghost wide" type="button" onClick={onSkip}>
            {t("local.skip")}
          </button>
        </>
      ) : (
        <form onSubmit={submit}>
          <button
            type="button"
            className="ghost back"
            onClick={() => {
              setPresetId(null);
              setError(null);
            }}
          >
            ‹ {t("local.changeProvider")}
          </button>
          <p className="muted">{custom ? t("local.subtitle") : preset?.name}</p>

          {custom ? (
            <>
              <label htmlFor="baseUrl">{t("local.baseUrl")}</label>
              <input
                id="baseUrl"
                value={customBase}
                onChange={(event) => setCustomBase(event.target.value)}
                placeholder={t("local.baseUrlHint")}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                inputMode="url"
              />
            </>
          ) : null}

          <label htmlFor="apiKey">{t("local.apiKey")}</label>
          <input
            id="apiKey"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={t("local.apiKeyHint")}
            type="password"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />

          <button type="button" className="ghost wide" disabled={busy} onClick={() => void fetchModels()}>
            {busy ? t("local.busy") : t("local.fetchModels")}
          </button>

          {models !== null && models.length > 0 ? (
            <>
              <label>{t("local.models")}</label>
              <div className="model-list pick">
                {models.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className={id === modelId ? "row chosen" : "row"}
                    onClick={() => setModelId(id)}
                  >
                    <span className="row-title">
                      {id}
                      {id === modelId ? <span className="tick"> ✓</span> : null}
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : null}

          <button className="primary wide" type="submit" disabled={!modelId || busy}>
            {t("local.start")}
          </button>
          <button className="ghost wide" type="button" onClick={onSkip}>
            {t("local.skip")}
          </button>
        </form>
      )}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
