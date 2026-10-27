import { useState, type FormEvent } from "react";
import { normalizeBase, RacpClient, RacpClientError, type Connection } from "../lib/racp";
import type { Translate } from "../lib/i18n";

type Props = {
  t: Translate;
  onConnected: (connection: Connection) => void;
};

/**
 * Pasting a pairing link fills both fields; pasting a bare address leaves the
 * token to be typed. The link is the case that matters — it is what the desktop
 * shows and what the phone can share — so it is what the field accepts first.
 */
export function ConnectView({ t, onConnected }: Props) {
  const [link, setLink] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
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

  return (
    <div className="screen connect">
      <div className="brand">
        <span className="brand-mark">Q</span>
        <h1>{t("app.name")}</h1>
      </div>
      <p className="muted">{t("connect.subtitle")}</p>
      <form onSubmit={submit}>
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
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
