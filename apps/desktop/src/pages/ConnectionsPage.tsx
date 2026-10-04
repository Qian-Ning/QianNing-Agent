import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ConnectionActivityEntry,
  ConnectionHostKeyPolicy,
  ConnectionKind,
  ConnectionLimits,
  ConnectionProbeErrorDetails,
  ConnectionProfileDraft,
  ConnectionProfileUpdate,
  ConnectionProfileView,
  ConnectionTarget,
} from "@pi-desktop/shared";
import { useAppStore } from "../stores/app-store";
import { api } from "../lib/api";
import {
  Badge,
  Button,
  Field,
  Input,
  Panel,
  PasswordInput,
  SegmentedControl,
  SettingsToggle,
} from "../components/ui";
import { IconPlus, IconServer } from "../components/icons";

/**
 * The Connections destination (ADR 0320, `04-ux/01-ui-ia.md` §3.6): the list of
 * outbound targets the user owns, and the place a changed host key is cleared.
 *
 * This round ships the SSH transport, so the add form offers SSH and nothing
 * else — a form that could store a serial target the host cannot dial would be
 * a promise the build does not keep. The list and the detail view render the
 * kind generically, so adding the byte-stream transports is a form change and
 * not a rewrite.
 *
 * Nothing here creates a profile for the agent: every mutation on this page is
 * a person acting, and the host's agent-facing surface has no such method.
 */

const SHIPPED_KINDS: ConnectionKind[] = ["ssh"];

const KIND_LABEL: Record<ConnectionKind, string> = {
  ssh: "connections.kindSsh",
  serial: "connections.kindSerial",
  telnet: "connections.kindTelnet",
  "raw-tcp": "connections.kindRawTcp",
};

const POLICY_LABEL: Record<ConnectionHostKeyPolicy, string> = {
  strict: "connections.policyStrict",
  "accept-new": "connections.policyAcceptNew",
  pinned: "connections.policyPinned",
};

const POLICIES: ConnectionHostKeyPolicy[] = ["strict", "accept-new", "pinned"];

type Draft = {
  profileId?: string;
  label: string;
  host: string;
  port: string;
  user: string;
  identityFile: string;
  proxyJump: string;
  hostKeyPolicy: ConnectionHostKeyPolicy;
  hostKeyFingerprint: string;
  multiplex: "per-call" | "multiplex";
  timeoutMs: string;
  outputBytes: string;
  streamBytes: string;
};

function blankDraft(): Draft {
  return {
    label: "",
    host: "",
    port: "22",
    user: "",
    identityFile: "",
    proxyJump: "",
    hostKeyPolicy: "accept-new",
    hostKeyFingerprint: "",
    multiplex: "per-call",
    timeoutMs: "",
    outputBytes: "",
    streamBytes: "",
  };
}

function draftFrom(profile: ConnectionProfileView): Draft {
  const target = profile.target;
  const ssh = target.kind === "ssh" ? target : undefined;
  return {
    profileId: profile.id,
    label: profile.label,
    host: ssh?.host ?? "",
    port: String(ssh?.port ?? 22),
    user: ssh?.user ?? "",
    identityFile: ssh?.identityFile ?? "",
    proxyJump: ssh?.proxyJump ?? "",
    hostKeyPolicy: profile.hostKeyPolicy,
    hostKeyFingerprint: profile.hostKeyFingerprint ?? "",
    multiplex: profile.multiplex,
    timeoutMs: String(profile.limits.timeoutMs),
    outputBytes: String(profile.limits.outputBytes),
    streamBytes: String(profile.limits.streamBytes),
  };
}

/** A blank optional string means "not set"; the host validates what is left. */
function optional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function numberOf(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function buildTarget(draft: Draft): ConnectionTarget {
  return {
    kind: "ssh",
    host: draft.host.trim(),
    port: numberOf(draft.port) ?? 22,
    ...(optional(draft.user) ? { user: draft.user.trim() } : {}),
    ...(optional(draft.identityFile)
      ? { identityFile: draft.identityFile.trim() }
      : {}),
    ...(optional(draft.proxyJump) ? { proxyJump: draft.proxyJump.trim() } : {}),
  };
}

function buildLimits(draft: Draft): ConnectionLimits | undefined {
  const timeoutMs = numberOf(draft.timeoutMs);
  const outputBytes = numberOf(draft.outputBytes);
  const streamBytes = numberOf(draft.streamBytes);
  if (timeoutMs === undefined && outputBytes === undefined && streamBytes === undefined) {
    return undefined;
  }
  // The host refuses a partial set, so an untouched field falls back to the
  // host default rather than being left out.
  return {
    timeoutMs: timeoutMs ?? 0,
    outputBytes: outputBytes ?? 0,
    streamBytes: streamBytes ?? 0,
  };
}

function summarize(profile: ConnectionProfileView): string {
  const target = profile.target;
  switch (target.kind) {
    case "ssh":
      return target.user
        ? `${target.user}@${target.host}:${target.port}`
        : `${target.host}:${target.port}`;
    case "serial":
      return target.port;
    default:
      return `${target.host}:${target.port}`;
  }
}

export function ConnectionsPage() {
  const { t } = useTranslation();
  const settings = useAppStore((s) => s.settings);
  const showToast = useAppStore((s) => s.showToast);
  const setPage = useAppStore((s) => s.setPage);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);

  const [profiles, setProfiles] = useState<ConnectionProfileView[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activity, setActivity] = useState<ConnectionActivityEntry[]>([]);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [credential, setCredential] = useState("");
  const [credentialFor, setCredentialFor] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const switchOn = settings?.remoteControlEnabled === true;

  const load = useCallback(async () => {
    try {
      const result = await api.listConnectionProfiles();
      setProfiles(result.profiles);
      setLoadError(false);
    } catch {
      setProfiles([]);
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () => profiles?.find((profile) => profile.id === selectedId) ?? null,
    [profiles, selectedId],
  );

  useEffect(() => {
    if (!selected) {
      setActivity([]);
      return;
    }
    let cancelled = false;
    void api
      .getConnectionActivity(selected.id)
      .then((result) => {
        if (!cancelled) setActivity(result.activity);
      })
      .catch(() => {
        if (!cancelled) setActivity([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const run = async (work: () => Promise<unknown>, failureKey: string) => {
    setBusy(true);
    try {
      await work();
      await load();
    } catch {
      showToast(t(failureKey));
    } finally {
      setBusy(false);
    }
  };

  const saveDraft = async () => {
    if (!editing) return;
    const base: ConnectionProfileDraft = {
      label: editing.label.trim(),
      kind: "ssh",
      target: buildTarget(editing),
      hostKeyPolicy: editing.hostKeyPolicy,
      ...(editing.hostKeyPolicy === "pinned" && optional(editing.hostKeyFingerprint)
        ? { hostKeyFingerprint: editing.hostKeyFingerprint.trim() }
        : {}),
      multiplex: editing.multiplex,
      ...(buildLimits(editing) ? { limits: buildLimits(editing) } : {}),
    };
    const target = editing;
    setEditing(null);
    await run(async () => {
      if (target.profileId) {
        const update: ConnectionProfileUpdate = {
          ...base,
          profileId: target.profileId,
        };
        const saved = await api.updateConnectionProfile(update);
        if (credentialFor === saved.id && credential !== "") {
          await api.setConnectionCredential(saved.id, credential);
        }
      } else {
        const created = await api.createConnectionProfile(base);
        if (credential !== "") {
          await api.setConnectionCredential(created.id, credential);
        }
        setSelectedId(created.id);
      }
      setCredential("");
      setCredentialFor(null);
    }, "connections.saveFailed");
  };

  const probe = (profile: ConnectionProfileView) =>
    run(() => api.probeConnectionProfile(profile.id), "connections.probeFailed");

  // A key that is unknown or changed makes the probe itself fail — nothing is
  // trusted until a person looks — so the fingerprint to accept comes from that
  // refusal's payload, not from a successful probe.
  const acceptHostKey = (profile: ConnectionProfileView) =>
    run(async () => {
      const fingerprint = await api.probeConnectionProfile(profile.id).then(
        (result) => result.fingerprint,
        (error: unknown) => {
          const details = (error as { details?: ConnectionProbeErrorDetails })
            .details;
          return details?.fingerprint;
        },
      );
      if (!fingerprint) throw new Error("no fingerprint to accept");
      await api.acceptConnectionHostKey(profile.id, fingerprint);
    }, "connections.probeFailed");

  const remove = (profile: ConnectionProfileView) =>
    run(async () => {
      await api.deleteConnectionProfile(profile.id);
      if (selectedId === profile.id) setSelectedId(null);
    }, "connections.deleteFailed");

  if (loadError) {
    return (
      <div className="route-surface-inner">
        <Panel className="p-4">
          <div className="text-sm text-text-secondary">{t("connections.loadFailed")}</div>
        </Panel>
      </div>
    );
  }

  return (
    <div className="route-surface-inner space-y-3">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-sm">{t("connections.title")}</h1>
          <p className="text-xs text-text-secondary">{t("connections.subtitle")}</p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setEditing(blankDraft())}>
          <IconPlus size={14} aria-hidden />
          {t("connections.add")}
        </Button>
      </header>

      {!switchOn ? (
        <Panel className="space-y-2 p-3">
          <div className="text-sm">{t("connections.switchOffTitle")}</div>
          <p className="text-xs text-text-secondary">{t("connections.switchOffBody")}</p>
          <Button
            size="sm"
            onClick={() => {
              setSettingsTab("ai");
              setPage("settings");
            }}
          >
            {t("connections.openSettings")}
          </Button>
        </Panel>
      ) : null}

      {profiles === null ? (
        <Panel className="p-4">
          <div className="text-sm text-text-secondary">{t("connections.loading")}</div>
        </Panel>
      ) : profiles.length === 0 ? (
        <Panel className="space-y-2 p-4">
          <div className="text-sm">{t("connections.empty")}</div>
          <p className="text-xs text-text-secondary">{t("connections.emptyBody")}</p>
        </Panel>
      ) : (
        <div className="space-y-2">
          {profiles.map((profile) => {
            const failed =
              profile.lastProbe !== null && profile.lastProbe.ok === false;
            return (
              <Panel key={profile.id} className="flex items-center gap-3 p-3">
                <IconServer size={16} aria-hidden />
                <button
                  type="button"
                  className="flex-1 text-left"
                  data-nav={`connection-${profile.id}`}
                  onClick={() => setSelectedId(profile.id)}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm">{profile.label}</span>
                    <Badge>{t(KIND_LABEL[profile.kind])}</Badge>
                    {failed ? <Badge tone="warning">{t("connections.probeFailed")}</Badge> : null}
                  </div>
                  <div className="text-xs text-text-secondary">
                    {summarize(profile)}
                  </div>
                </button>
                <span className="text-xs text-text-secondary">
                  {profile.lastProbe === null
                    ? t("connections.neverProbed")
                    : profile.lastProbe.ok
                      ? t("connections.probeOk")
                      : t("connections.probeFailed")}
                </span>
                <SettingsToggle
                  checked={profile.enabled}
                  disabled={busy}
                  label={profile.label}
                  onChange={() =>
                    void run(
                      () => api.setConnectionEnabled(profile.id, !profile.enabled),
                      "connections.enableFailed",
                    )
                  }
                />
              </Panel>
            );
          })}
        </div>
      )}

      {selected ? (
        <Panel className="space-y-3 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm">{selected.label}</span>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => setSelectedId(null)}>
                {t("connections.back")}
              </Button>
              <Button size="sm" onClick={() => setEditing(draftFrom(selected))}>
                {t("connections.edit")}
              </Button>
              <Button
                size="sm"
                disabled={busy || !switchOn || !selected.enabled}
                title={switchOn ? undefined : t("connections.probeBlocked")}
                onClick={() => void probe(selected)}
              >
                {t("connections.probe")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setConfirmingDelete(selected.id)}
              >
                {t("connections.delete")}
              </Button>
            </div>
          </div>

          <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
            <div>
              <dt className="text-text-secondary">{t("connections.kind")}</dt>
              <dd>{t(KIND_LABEL[selected.kind])}</dd>
            </div>
            <div>
              <dt className="text-text-secondary">{t("connections.host")}</dt>
              <dd>{summarize(selected)}</dd>
            </div>
            <div>
              <dt className="text-text-secondary">{t("connections.credential")}</dt>
              <dd>
                {selected.credentialConfigured
                  ? t("connections.credentialConfigured")
                  : t("connections.credentialMissing")}
              </dd>
            </div>
            <div>
              <dt className="text-text-secondary">{t("connections.hostKey")}</dt>
              <dd>{t(POLICY_LABEL[selected.hostKeyPolicy])}</dd>
            </div>
            <div>
              <dt className="text-text-secondary">{t("connections.fingerprint")}</dt>
              <dd>{selected.hostKeyFingerprint ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-text-secondary">{t("connections.multiplex")}</dt>
              <dd>
                {selected.multiplex === "multiplex"
                  ? t("connections.multiplexMultiplex")
                  : t("connections.multiplexPerCall")}
              </dd>
            </div>
            <div>
              <dt className="text-text-secondary">{t("connections.lastProbe")}</dt>
              <dd>
                {selected.lastProbe === null
                  ? t("connections.neverProbed")
                  : `${selected.lastProbe.ok ? t("connections.probeOk") : t("connections.probeFailed")} · ${
                      selected.lastProbe.errorCode ?? ""
                    }`.trim()}
              </dd>
            </div>
          </dl>

          {selected.lastProbe !== null && selected.lastProbe.ok === false ? (
            <div className="space-y-2">
              <p className="text-xs text-text-secondary">{t("connections.hostKeyWarn")}</p>
              <Button
                size="sm"
                disabled={busy || !switchOn || !selected.enabled}
                title={switchOn ? undefined : t("connections.probeBlocked")}
                onClick={() => void acceptHostKey(selected)}
              >
                {t("connections.acceptHostKey")}
              </Button>
            </div>
          ) : null}

          <section className="space-y-1">
            <div className="text-xs text-text-secondary">{t("connections.credential")}</div>
            <p className="text-xs text-text-secondary">{t("connections.credentialHint")}</p>
            <div className="flex items-center gap-2">
              <PasswordInput
                value={credential}
                showLabel={t("connections.credentialSet")}
                hideLabel={t("connections.cancel")}
                onChange={(event) => {
                  setCredential(event.target.value);
                  setCredentialFor(selected.id);
                }}
              />
              <Button
                size="sm"
                disabled={busy || credential === ""}
                onClick={() =>
                  void run(async () => {
                    await api.setConnectionCredential(selected.id, credential);
                    setCredential("");
                    setCredentialFor(null);
                  }, "connections.credentialFailed")
                }
              >
                {t("connections.credentialSet")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || !selected.credentialConfigured}
                onClick={() =>
                  void run(
                    () => api.clearConnectionCredential(selected.id),
                    "connections.credentialFailed",
                  )
                }
              >
                {t("connections.credentialClear")}
              </Button>
            </div>
          </section>

          <section className="space-y-1">
            <div className="text-xs text-text-secondary">{t("connections.activity")}</div>
            {activity.length === 0 ? (
              <p className="text-xs text-text-secondary">{t("connections.activityEmpty")}</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {activity.map((row, index) => (
                  <li key={`${row.ts}-${index}`} className="flex items-center gap-2">
                    <span className="text-text-secondary">
                      {new Date(row.ts).toLocaleString()}
                    </span>
                    <span>{row.action}</span>
                    <span className="text-text-secondary">{row.outcome}</span>
                    {row.errorCode ? (
                      <span className="text-text-secondary">{row.errorCode}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </Panel>
      ) : null}

      {editing ? (
        <div className="overlay" role="dialog" aria-modal="true" aria-label={t("connections.add")}>
          <Panel className="space-y-3 p-4">
            <div className="text-sm">
              {editing.profileId ? t("connections.edit") : t("connections.add")}
            </div>

            <Field label={t("connections.label")}>
              <Input
                value={editing.label}
                onChange={(event) =>
                  setEditing({ ...editing, label: event.target.value })
                }
              />
            </Field>

            <Field label={t("connections.kind")}>
              <Input value={t(KIND_LABEL[SHIPPED_KINDS[0]])} readOnly disabled />
            </Field>

            <Field label={t("connections.host")}>
              <Input
                value={editing.host}
                onChange={(event) => setEditing({ ...editing, host: event.target.value })}
              />
            </Field>

            <Field label={t("connections.port")}>
              <Input
                value={editing.port}
                inputMode="numeric"
                onChange={(event) => setEditing({ ...editing, port: event.target.value })}
              />
            </Field>

            <Field label={t("connections.user")}>
              <Input
                value={editing.user}
                onChange={(event) => setEditing({ ...editing, user: event.target.value })}
              />
            </Field>

            <Field label={t("connections.identityFile")}>
              <Input
                value={editing.identityFile}
                onChange={(event) =>
                  setEditing({ ...editing, identityFile: event.target.value })
                }
              />
            </Field>

            <Field label={t("connections.proxyJump")}>
              <Input
                value={editing.proxyJump}
                onChange={(event) => setEditing({ ...editing, proxyJump: event.target.value })}
              />
            </Field>

            <Field label={t("connections.hostKey")}>
              <SegmentedControl
                value={editing.hostKeyPolicy}
                label={t("connections.hostKey")}
                onChange={(value) =>
                  setEditing({ ...editing, hostKeyPolicy: value as ConnectionHostKeyPolicy })
                }
                options={POLICIES.map((policy) => ({
                  value: policy,
                  label: t(POLICY_LABEL[policy]),
                }))}
              />
            </Field>

            {editing.hostKeyPolicy === "pinned" ? (
              <Field label={t("connections.fingerprint")} hint={t("connections.fingerprintHint")}>
                <Input
                  value={editing.hostKeyFingerprint}
                  onChange={(event) =>
                    setEditing({ ...editing, hostKeyFingerprint: event.target.value })
                  }
                />
              </Field>
            ) : null}

            <Field label={t("connections.multiplex")}>
              <SegmentedControl
                value={editing.multiplex}
                label={t("connections.multiplex")}
                onChange={(value) =>
                  setEditing({
                    ...editing,
                    multiplex: value as Draft["multiplex"],
                  })
                }
                options={[
                  { value: "per-call", label: t("connections.multiplexPerCall") },
                  { value: "multiplex", label: t("connections.multiplexMultiplex") },
                ]}
              />
            </Field>

            <div className="space-y-1">
              <div className="text-xs text-text-secondary">{t("connections.limits")}</div>
              <p className="text-xs text-text-secondary">{t("connections.limitsHint")}</p>
              <Field label={t("connections.timeoutMs")}>
                <Input
                  value={editing.timeoutMs}
                  inputMode="numeric"
                  onChange={(event) =>
                    setEditing({ ...editing, timeoutMs: event.target.value })
                  }
                />
              </Field>
              <Field label={t("connections.outputBytes")}>
                <Input
                  value={editing.outputBytes}
                  inputMode="numeric"
                  onChange={(event) =>
                    setEditing({ ...editing, outputBytes: event.target.value })
                  }
                />
              </Field>
              <Field label={t("connections.streamBytes")}>
                <Input
                  value={editing.streamBytes}
                  inputMode="numeric"
                  onChange={(event) =>
                    setEditing({ ...editing, streamBytes: event.target.value })
                  }
                />
              </Field>
            </div>

            <div className="flex items-center justify-end gap-2">
              <Button
                size="sm"
                onClick={() => {
                  setEditing(null);
                  setCredential("");
                  setCredentialFor(null);
                }}
              >
                {t("connections.cancel")}
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={busy || editing.label.trim() === "" || editing.host.trim() === ""}
                onClick={() => void saveDraft()}
              >
                {t("connections.save")}
              </Button>
            </div>
          </Panel>
        </div>
      ) : null}

      {confirmingDelete ? (
        <div
          className="overlay"
          role="dialog"
          aria-modal="true"
          aria-label={t("connections.deleteTitle")}
        >
          <Panel className="space-y-3 p-4">
            <div className="text-sm">{t("connections.deleteTitle")}</div>
            <p className="text-xs text-text-secondary">{t("connections.deleteBody")}</p>
            <div className="flex items-center justify-end gap-2">
              <Button size="sm" onClick={() => setConfirmingDelete(null)}>
                {t("connections.cancel")}
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={busy}
                onClick={() => {
                  const profile = profiles?.find((row) => row.id === confirmingDelete);
                  setConfirmingDelete(null);
                  if (profile) void remove(profile);
                }}
              >
                {t("connections.delete")}
              </Button>
            </div>
          </Panel>
        </div>
      ) : null}
    </div>
  );
}
