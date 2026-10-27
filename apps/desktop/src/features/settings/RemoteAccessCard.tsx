/**
 * Remote access (ADR 0333 P1). Off by default and loopback-only when on, so the
 * card leads with the switch and only reveals the address once something is
 * actually listening.
 *
 * The issued token is shown exactly once, in this component's state, and only
 * until the user leaves the page: the Host keeps a hash, so there is no second
 * chance to read it. That is deliberate — a "show token again" button would mean
 * storing the secret somewhere the renderer can reach.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { RemoteAccessStatus, RemoteDeviceSummary, RemoteIssuedDevice } from "@pi-desktop/shared";

import { Button, Input } from "../../components/ui";
import { api } from "../../lib/api";
import { SettingsCard, SettingsRow } from "./primitives";

export function RemoteAccessCard() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");
  const [issued, setIssued] = useState<RemoteIssuedDevice | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .getRemoteAccess()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        // A settings page must render on a cold start; "off" is the truth when
        // the listener could not answer.
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const start = useCallback(async (exposure: "loopback" | "lan") => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.enableRemoteAccess(exposure));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  const stop = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.disableRemoteAccess());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  const issue = useCallback(async () => {
    const trimmed = label.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const device = await api.issueRemoteDevice(trimmed);
      setIssued(device);
      setLabel("");
      setStatus(await api.getRemoteAccess());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [label]);

  const revoke = useCallback(async (deviceId: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.revokeRemoteDevice(deviceId);
      if (issued?.deviceId === deviceId) setIssued(null);
      setStatus(await api.getRemoteAccess());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [issued?.deviceId]);

  const devices: RemoteDeviceSummary[] = status?.devices ?? [];
  const running = status?.running === true;

  /**
   * Opening this link is the whole pairing step: the page reads the token out of
   * the fragment, sets the address to the origin it was served from, and lands
   * on the session list with nothing typed. It works in a browser tab as well as
   * in the phone shell, and can be sent over any messaging app.
   */
  const pairingLink =
    issued && status?.url ? `${status.url}/app#t=${encodeURIComponent(issued.token)}` : null;

  const copyPairing = useCallback(async () => {
    if (!pairingLink) return;
    try {
      await navigator.clipboard.writeText(pairingLink);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [pairingLink]);

  return (
    <SettingsCard title={t("settings.remoteAccess")} description={t("settings.remoteAccessDesc")}>
      <SettingsRow
        title={t("settings.remoteAccessEnable")}
        description={t("settings.remoteAccessEnableDesc")}
        detail={running ? t("settings.remoteAccessListening", { host: status?.host, port: status?.port }) : t("settings.remoteAccessOff")}
      >
        {running ? (
          <Button variant="secondary" onClick={() => void stop()} disabled={busy}>
            {t("settings.remoteAccessDisable")}
          </Button>
        ) : (
          <>
            <Button variant="primary" onClick={() => void start("lan")} disabled={busy}>
              {t("settings.remoteModeLan")}
            </Button>
            <Button variant="secondary" onClick={() => void start("loopback")} disabled={busy}>
              {t("settings.remoteModeLoopback")}
            </Button>
          </>
        )}
      </SettingsRow>

      {running && status?.url ? (
        <SettingsRow
          title={t("settings.remoteUrlTitle")}
          description={t("settings.remoteUrlDesc")}
          detail={status.exposure === "lan" ? t("settings.remoteModeLan") : t("settings.remoteModeLoopback")}
        >
          <code data-testid="remote-url">{status.url}</code>
        </SettingsRow>
      ) : null}

      <SettingsRow
        title={t("settings.remoteDevices")}
        description={t("settings.remoteDevicesDesc")}
        detail={t("settings.remoteDeviceCount", { n: status?.pairedDevices ?? 0 })}
      >
        <Input
          value={label}
          placeholder={t("settings.remoteDeviceLabel")}
          onChange={(event) => setLabel(event.target.value)}
          aria-label={t("settings.remoteDeviceLabel")}
        />
        <Button variant="primary" onClick={() => void issue()} disabled={busy || label.trim().length === 0}>
          {t("settings.remoteIssueDevice")}
        </Button>
      </SettingsRow>

      {issued ? (
        <SettingsRow
          title={t("settings.remoteTokenTitle")}
          description={t("settings.remoteTokenDesc", { label: issued.label })}
        >
          <code data-testid="remote-issued-token">{issued.token}</code>
          {pairingLink ? (
            <Button variant="primary" onClick={() => void copyPairing()}>
              {copied ? t("settings.remotePairingCopied") : t("settings.remotePairingCopy")}
            </Button>
          ) : null}
        </SettingsRow>
      ) : null}

      {pairingLink ? (
        <SettingsRow
          title={t("settings.remotePairingTitle")}
          description={t("settings.remotePairingDesc")}
        >
          <code data-testid="remote-pairing-link">{pairingLink}</code>
        </SettingsRow>
      ) : null}

      {devices.length > 0 ? (
        <>
          {devices.map((device) => (
            <SettingsRow
              key={device.deviceId}
              title={device.label}
              detail={
                device.revokedAt
                  ? t("settings.remoteDeviceRevoked")
                  : device.lastSeenAt
                    ? t("settings.remoteDeviceLastSeen", { at: device.lastSeenAt })
                    : t("settings.remoteDeviceNeverSeen")
              }
            >
              {device.revokedAt ? null : (
                <Button variant="ghost" onClick={() => void revoke(device.deviceId)} disabled={busy}>
                  {t("settings.remoteRevoke")}
                </Button>
              )}
            </SettingsRow>
          ))}
        </>
      ) : (
        <p>{t("settings.remoteNoDevices")}</p>
      )}

      {error ? (
        <p role="alert">{error}</p>
      ) : null}
    </SettingsCard>
  );
}
