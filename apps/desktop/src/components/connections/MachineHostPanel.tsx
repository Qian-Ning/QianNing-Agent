/**
 * The host layer of a Connections card.
 *
 * Connections says *where the agent may work* (the target). This file adds the
 * other half of the same machine: whether our runtime is installed there, how
 * its link is doing right now, and the two ways to get it there — install over
 * the target's own SSH address, or pair a runtime the user started themselves
 * (the no-SSH path). It is one block on the target's detail pane, not a second
 * list: the old Settings page's add form is gone, and the only add flow on this
 * surface is "add target".
 *
 * The credential the install may ask for is passed straight to
 * `remoteHostBootstrap`; it never lands in a profile or a settings row.
 */
import { useCallback, useEffect, useState } from "react";
import type {
  ConnectionProfileView,
  RemoteHostLinkState,
  RemoteHostSummary,
} from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import {
  hostLinkKey,
  hostLinkOf,
  installAuthOf,
  installRequestFor,
  type HostLink,
  type MachineRow,
} from "../../lib/connection-machines";
import { useAppStore } from "../../stores/app-store";
import { Badge, Button, Field, Input, Panel, PasswordInput } from "../ui";
import { IconDownload, IconLink, IconServer } from "../icons";

/**
 * Live view of the host layer. The list call is a snapshot; `remoteHostState`
 * pushes every re-dial, drop, and failure, so the card follows a host that
 * reconnects on its own.
 */
export function useRemoteHosts() {
  const [hosts, setHosts] = useState<RemoteHostSummary[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [live, setLive] = useState<Record<string, RemoteHostLinkState>>({});

  const reload = useCallback(async () => {
    try {
      const result = await api.listRemoteHosts();
      setHosts(result.hosts);
      setUnavailable(false);
    } catch {
      // A build without the remote-host boot (or one that failed to start) still
      // has targets; the card says the state is unavailable instead of claiming
      // the runtime is not installed.
      setHosts((prev) => prev ?? []);
      setUnavailable(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const off = api.onRemoteHostState(({ hostKey, state }) => {
      setLive((prev) => (prev[hostKey] === state ? prev : { ...prev, [hostKey]: state }));
    });
    return off;
  }, []);

  return { hosts: hosts ?? [], loaded: hosts !== null, unavailable, live, reload };
}

function InstallDialog({
  profile,
  onClose,
  onInstalled,
}: {
  profile: ConnectionProfileView;
  onClose: () => void;
  onInstalled: () => void;
}) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const auth = installAuthOf(profile);
  const address =
    profile.target.kind === "ssh"
      ? `${profile.target.user ? `${profile.target.user}@` : ""}${profile.target.host}:${profile.target.port}`
      : "";

  const install = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.bootstrapRemoteHost(installRequestFor(profile, password));
      showToast(t("connections.hostInstalled", { label: profile.label }));
      onInstalled();
      onClose();
    } catch (failure) {
      setError(
        failure instanceof Error && failure.message
          ? failure.message
          : t("connections.hostInstallFailed"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t("connections.hostInstallTitle")}
    >
      <Panel className="dialog space-y-3 p-4">
        <div className="text-sm">
          {t("connections.hostInstallTitle", { label: profile.label })}
        </div>
        <p className="text-xs text-text-secondary">
          {t("connections.hostInstallBody", { address })}
        </p>
        {auth === "password" ? (
          <Field
            label={t("connections.hostSshPassword")}
            hint={t("connections.hostSshPasswordHint")}
          >
            <PasswordInput
              value={password}
              showLabel={t("connections.showPassword")}
              hideLabel={t("connections.hidePassword")}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
        ) : (
          <p className="text-xs text-text-secondary">
            {auth === "key"
              ? t("connections.hostInstallKeyHint")
              : t("connections.hostInstallAgentHint")}
          </p>
        )}
        {error ? <p className="text-xs text-warning">{error}</p> : null}
        <div className="flex items-center justify-end gap-2">
          <Button size="sm" onClick={onClose} disabled={busy}>
            {t("connections.cancel")}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={busy || (auth === "password" && password.trim() === "")}
            onClick={() => void install()}
          >
            {busy ? t("connections.hostInstalling") : t("connections.hostInstall")}
          </Button>
        </div>
      </Panel>
    </div>
  );
}

/**
 * The runtime block for one target. Renders the state badge, the live URL when
 * installed, and exactly one primary action: install, or remove.
 */
export function MachineHostSection({
  profile,
  host,
  link,
  onChanged,
}: {
  profile: ConnectionProfileView;
  host: RemoteHostSummary | undefined;
  link: HostLink;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [installing, setInstalling] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [busy, setBusy] = useState(false);

  const removeHost = async () => {
    if (!host) return;
    setBusy(true);
    try {
      await api.removeRemoteHost({ hostKey: host.hostKey });
      showToast(t("connections.hostRemoved", { label: profile.label }));
      setConfirmingRemove(false);
      onChanged();
    } catch {
      showToast(t("connections.hostRemoveFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-1.5" data-host-section={profile.id}>
      <div className="flex items-center gap-2">
        <span className="text-xs text-text-secondary">
          {t("connections.hostTitle")}
        </span>
        <Badge tone={link === "failed" || link === "unknown" ? "warning" : undefined}>
          {t(hostLinkKey(link))}
        </Badge>
        {host?.ssh?.version ? (
          <span className="text-xs text-text-secondary">
            {t("connections.hostVersion", { version: host.ssh.version })}
          </span>
        ) : null}
      </div>
      {host ? (
        <p className="break-all text-xs text-text-secondary">
          {t("connections.hostAddress", {
            url: host.url,
            key: host.hostKey,
          })}
        </p>
      ) : (
        <p className="text-xs text-text-secondary">{t("connections.hostNotInstalledHint")}</p>
      )}
      <div className="flex items-center gap-2">
        {host ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setConfirmingRemove(true)}
          >
            {t("connections.hostRemove")}
          </Button>
        ) : (
          <Button size="sm" disabled={link === "unknown"} onClick={() => setInstalling(true)}>
            <IconDownload size={14} aria-hidden />
            {t("connections.hostInstall")}
          </Button>
        )}
      </div>

      {installing ? (
        <InstallDialog
          profile={profile}
          onClose={() => setInstalling(false)}
          onInstalled={onChanged}
        />
      ) : null}

      {confirmingRemove ? (
        <div
          className="overlay"
          role="dialog"
          aria-modal="true"
          aria-label={t("connections.hostRemoveTitle")}
        >
          <Panel className="dialog space-y-3 p-4">
            <div className="text-sm">
              {t("connections.hostRemoveTitle", { label: profile.label })}
            </div>
            <p className="text-xs text-text-secondary">{t("connections.hostRemoveBody")}</p>
            <div className="flex items-center justify-end gap-2">
              <Button size="sm" onClick={() => setConfirmingRemove(false)} disabled={busy}>
                {t("connections.cancel")}
              </Button>
              <Button size="sm" variant="primary" disabled={busy} onClick={() => void removeHost()}>
                {t("connections.hostRemove")}
              </Button>
            </div>
          </Panel>
        </div>
      ) : null}
    </section>
  );
}

/**
 * A paired runtime with no target profile: a machine we can run sessions on but
 * the agent cannot dial. It keeps its own row so deleting the target above it
 * does not silently strand a running host.
 */
export function HostOnlyPanel({
  row,
  link,
  onRemoved,
}: {
  row: MachineRow;
  link: HostLink;
  onRemoved: () => void;
}) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const host = row.host;
  if (!host) return null;

  const removeHost = async () => {
    setBusy(true);
    try {
      await api.removeRemoteHost({ hostKey: host.hostKey });
      showToast(t("connections.hostRemoved", { label: host.label }));
      setConfirming(false);
      onRemoved();
    } catch {
      showToast(t("connections.hostRemoveFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel className="dest-create space-y-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm">{host.label}</span>
        <Badge>{t("connections.pairedHost")}</Badge>
        <Badge tone={link === "failed" || link === "unknown" ? "warning" : undefined}>
          {t(hostLinkKey(link))}
        </Badge>
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-text-secondary">{t("connections.hostAddressLabel")}</dt>
          <dd className="mt-0.5 break-all text-xs">
            {host.ssh
              ? `${host.ssh.user ? `${host.ssh.user}@` : ""}${host.ssh.host}:${host.ssh.port ?? 22}`
              : host.url}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-text-secondary">{t("connections.hostKeyLabel")}</dt>
          <dd className="mt-0.5 break-all text-xs">{host.hostKey}</dd>
        </div>
      </dl>
      <p className="text-xs text-text-secondary">{t("connections.hostOnlyHint")}</p>
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(true)}>
          {t("connections.hostRemove")}
        </Button>
      </div>
      {confirming ? (
        <div
          className="overlay"
          role="dialog"
          aria-modal="true"
          aria-label={t("connections.hostRemoveTitle")}
        >
          <Panel className="dialog space-y-3 p-4">
            <div className="text-sm">
              {t("connections.hostRemoveTitle", { label: host.label })}
            </div>
            <p className="text-xs text-text-secondary">{t("connections.hostRemoveBody")}</p>
            <div className="flex items-center justify-end gap-2">
              <Button size="sm" onClick={() => setConfirming(false)} disabled={busy}>
                {t("connections.cancel")}
              </Button>
              <Button size="sm" variant="primary" disabled={busy} onClick={() => void removeHost()}>
                {t("connections.hostRemove")}
              </Button>
            </div>
          </Panel>
        </div>
      ) : null}
    </Panel>
  );
}

/**
 * Pairing: the path for a machine with no SSH at all. The user starts the
 * runtime themselves, pastes the `ppt1.` token it printed, and the desktop
 * exchanges it for a device token. Imported unchanged in behaviour from the
 * retired Settings page — only its entry point moved, to this page's header.
 */
export function PairHostDialog({
  onClose,
  onPaired,
}: {
  onClose: () => void;
  onPaired: () => void;
}) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pair = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.pairRemoteHost({
        url: url.trim(),
        pairingToken: token.trim(),
        label: label.trim() || url.trim(),
      });
      showToast(t("connections.hostPaired"));
      onPaired();
      onClose();
    } catch (failure) {
      setError(
        failure instanceof Error && failure.message
          ? failure.message
          : t("connections.hostPairFailed"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t("connections.hostPairTitle")}
    >
      <Panel className="dialog space-y-3 p-4">
        <div className="text-sm">{t("connections.hostPairTitle")}</div>
        <p className="text-xs text-text-secondary">{t("connections.hostPairBody")}</p>
        <Field label={t("connections.hostPairUrl")}>
          <Input
            value={url}
            placeholder="ws://127.0.0.1:7788"
            onChange={(event) => setUrl(event.target.value)}
          />
        </Field>
        <Field label={t("connections.hostPairToken")} hint={t("connections.hostPairTokenHint")}>
          <PasswordInput
            value={token}
            showLabel={t("connections.showPassword")}
            hideLabel={t("connections.hidePassword")}
            onChange={(event) => setToken(event.target.value)}
          />
        </Field>
        <Field label={t("connections.hostPairLabel")}>
          <Input value={label} onChange={(event) => setLabel(event.target.value)} />
        </Field>
        {error ? <p className="text-xs text-warning">{error}</p> : null}
        <div className="flex items-center justify-end gap-2">
          <Button size="sm" onClick={onClose} disabled={busy}>
            {t("connections.cancel")}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={busy || url.trim() === "" || token.trim() === ""}
            onClick={() => void pair()}
          >
            <IconLink size={14} aria-hidden />
            {busy ? t("connections.hostPairing") : t("connections.hostPair")}
          </Button>
        </div>
      </Panel>
    </div>
  );
}

/** Server glyph used by the list icon slot. */
export const HostRowIcon = IconServer;

export type { HostLink };
export { hostLinkOf };
