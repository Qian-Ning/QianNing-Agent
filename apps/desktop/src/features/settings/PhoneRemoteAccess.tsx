/**
 * Remote access, phone side.
 *
 * The desktop's card answers "who may dial into this machine". On a phone the
 * question is the opposite one — "which computer am I driving" — so this page
 * pairs desktops instead of listening for devices: fetch each computer's own
 * certificate, pin it, and keep the device token that computer issued.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, Input } from "../../components/ui";
import { api } from "../../lib/api";
import { SettingsCard } from "./primitives";

type PairedHost = {
  hostKey: string;
  label: string;
  url: string;
  fingerprint?: string;
  connected: boolean;
};

export function PhoneRemoteAccess() {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<PairedHost[]>([]);
  const [supported, setSupported] = useState(true);
  const [address, setAddress] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, number | null>>({});

  const refresh = useCallback(async () => {
    try {
      const answer = await api.listPairedComputers();
      setHosts(answer.hosts);
      setSupported(answer.supported);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.pairComputer({ url: address.trim(), token: token.trim() });
      setAddress("");
      setToken("");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [address, token, busy, refresh]);

  const check = useCallback(async (hostKey: string) => {
    setCounts((current) => ({ ...current, [hostKey]: null }));
    try {
      const answer = await api.remoteSessions(hostKey);
      setCounts((current) => ({ ...current, [hostKey]: answer.sessions.length }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setCounts((current) => {
        const next = { ...current };
        delete next[hostKey];
        return next;
      });
    }
  }, []);

  const forget = useCallback(
    async (hostKey: string) => {
      await api.removePairedComputer(hostKey);
      await refresh();
    },
    [refresh],
  );

  return (
    <div className="phone-remote">
      <SettingsCard title={t("settings.phoneTitle")}>
        <p className="phone-remote-note">{t("settings.phoneNote")}</p>
        {supported ? null : <p className="phone-remote-error">{t("settings.phoneUnsupported")}</p>}
        <label className="phone-remote-field">
          <span>{t("settings.phoneAddress")}</span>
          <Input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder={t("settings.phoneAddressHint")}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            inputMode="url"
          />
        </label>
        <label className="phone-remote-field">
          <span>{t("settings.phoneToken")}</span>
          <Input
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={t("settings.phoneTokenHint")}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
        </label>
        <Button
          type="button"
          className="phone-remote-connect"
          disabled={busy || !address.trim() || !token.trim()}
          onClick={() => void connect()}
        >
          {busy ? t("settings.phoneConnecting") : t("settings.phoneConnect")}
        </Button>
        {error ? <p className="phone-remote-error">{error}</p> : null}
      </SettingsCard>

      <SettingsCard title={t("settings.phonePaired")}>
        {hosts.length === 0 ? (
          <p className="phone-remote-empty">{t("settings.phoneEmpty")}</p>
        ) : (
          <ul className="phone-remote-list">
            {hosts.map((host) => (
              <li key={host.hostKey} className="phone-remote-row">
                <div className="phone-remote-copy">
                  <span className="phone-remote-name">{host.label}</span>
                  <span className="phone-remote-url">{host.url}</span>
                  {host.fingerprint ? (
                    <span className="phone-remote-fingerprint" title={host.fingerprint}>
                      {host.fingerprint.slice(0, 23)}…
                    </span>
                  ) : null}
                </div>
                <div className="phone-remote-actions">
                  <button
                    type="button"
                    className="phone-remote-check"
                    onClick={() => void check(host.hostKey)}
                  >
                    {counts[host.hostKey] === undefined
                      ? t("settings.phoneCheck")
                      : counts[host.hostKey] === null
                        ? t("settings.phoneChecking")
                        : t("settings.phoneSessions", { count: counts[host.hostKey] })}
                  </button>
                  <button
                    type="button"
                    className="phone-remote-remove"
                    onClick={() => void forget(host.hostKey)}
                  >
                    {t("settings.phoneRemove")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>
    </div>
  );
}
