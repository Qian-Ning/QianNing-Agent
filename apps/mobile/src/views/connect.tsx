import { useState, type FormEvent } from "react";
import { normalizeBase, RacpClient, RacpClientError, type Connection } from "../lib/racp";
import type { Translate } from "../lib/i18n";
import { isComplete, loadProvider } from "../agent/settings";
import type { ProviderConfig } from "../agent/host";

type Props = {
  t: Translate;
  onConnected: (connection: Connection) => void;
  onLocal: (provider: ProviderConfig) => void;
  /** Enter without a model; the app asks for one only when a turn needs it. */
  onSkip: () => void;
};

/**
 * Two ways to have an agent: one that runs here, and one that runs on a computer.
 *
 * They are presented as equal choices because they are — the phone does not need
 * a desktop to be useful. Pairing stays first-class because it is the only path
 * that reaches files the phone cannot see.
 */
export function ConnectView({ t, onConnected, onLocal, onSkip }: Props) {
  const [mode, setMode] = useState<"local" | "remote">("local");
  const [link, setLink] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = loadProvider();
  const [baseUrl, setBaseUrl] = useState(saved?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(saved?.apiKey ?? "");
  const [modelId, setModelId] = useState(saved?.modelId ?? "");

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
        <>
          <p className="muted">{t("local.subtitle")}</p>
          <form onSubmit={submitLocal}>
            <label htmlFor="baseUrl">{t("local.baseUrl")}</label>
            <input
              id="baseUrl"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder={t("local.baseUrlHint")}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              inputMode="url"
            />
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
            <label htmlFor="model">{t("local.model")}</label>
            <input
              id="model"
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
              placeholder={t("local.modelHint")}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <button className="primary" type="submit" disabled={busy}>
              {busy ? t("local.busy") : t("local.start")}
            </button>
            <button className="ghost wide" type="button" onClick={onSkip}>
              {t("local.skip")}
            </button>
          </form>
        </>
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
