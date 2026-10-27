import { useMemo, useState, type FormEvent } from "react";
import { NAMED_ENDPOINT_PRESETS } from "@pi-desktop/shared";
import { normalizeBase, RacpClient, RacpClientError, type Connection } from "../lib/racp";
import type { Translate } from "../lib/i18n";
import { isComplete, loadProvider } from "../agent/settings";
import { probeModels, type ProviderConfig } from "../agent/host";

type Props = {
  t: Translate;
  onConnected: (connection: Connection) => void;
  onLocal: (provider: ProviderConfig) => void;
  /** Enter without a model; the app asks for one only when a turn needs it. */
  onSkip: () => void;
};

/**
 * The phone's version of the desktop's "add a provider" flow: pick the service,
 * paste the key, choose from the models *that service* lists.
 *
 * The desktop's catalog already knows every endpoint it supports, so the phone
 * reads the same presets instead of asking a person to remember a Base URL. Only
 * Chat Completions presets appear, because that is the wire the phone speaks.
 */
const PRESETS = NAMED_ENDPOINT_PRESETS.filter((preset) => preset.apiStyle === "chat_completions");

export function ConnectView({ t, onConnected, onLocal, onSkip }: Props) {
  const [mode, setMode] = useState<"local" | "remote">("local");
  const [link, setLink] = useState("");
  const [token, setToken] = useState("");
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

  const submitRemote = async (event: FormEvent) => {
    event.preventDefault();
    const base = normalizeBase(link);
    if (!base) {
      setError(t("connect.unreachable"));
      return;
    }
    setBusy(true);
    setError(null);
    const connection: Connection = { base, token: token.trim() };
    try {
      await new RacpClient(connection).call("/v1/sessions");
      onConnected(connection);
    } catch (cause) {
      if (cause instanceof RacpClientError && cause.code === "UNAUTHORIZED") setError(t("connect.failed"));
      else if (cause instanceof RacpClientError && cause.code === "UNREACHABLE") setError(t("connect.unreachable"));
      else setError(cause instanceof Error ? cause.message : t("connect.failed"));
    } finally {
      setBusy(false);
    }
  };

  const submitLocal = (event: FormEvent) => {
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

      <div className="segmented" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "local"}
          className={mode === "local" ? "segment active" : "segment"}
          onClick={() => {
            setMode("local");
            setError(null);
          }}
        >
          {t("connect.modeLocal")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "remote"}
          className={mode === "remote" ? "segment active" : "segment"}
          onClick={() => {
            setMode("remote");
            setError(null);
          }}
        >
          {t("connect.modeRemote")}
        </button>
      </div>

      {mode === "local" ? (
        presetId === null ? (
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
          <form onSubmit={submitLocal}>
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
        )
      ) : (
        <>
          <p className="muted">{t("connect.subtitle")}</p>
          <form onSubmit={submitRemote}>
            <label htmlFor="link">{t("connect.link")}</label>
            <input
              id="link"
              value={link}
              onChange={(event) => {
                const value = event.target.value;
                setLink(value);
                const hash = value.indexOf("#");
                if (hash < 0) return;
                const params = new URLSearchParams(value.slice(hash + 1));
                const found = params.get("t") ?? params.get("token");
                if (found) setToken(found);
              }}
              placeholder={t("connect.linkHint")}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              inputMode="url"
            />
            <label htmlFor="token">{t("connect.token")}</label>
            <input
              id="token"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder={t("connect.tokenHint")}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              type="password"
            />
            <button className="primary" type="submit" disabled={busy || !link.trim() || !token.trim()}>
              {busy ? t("connect.busy") : t("connect.submit")}
            </button>
          </form>
        </>
      )}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
