import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
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

/**
 * Which of ssh's ways in the form is set up for. The host stores no such
 * field: it decides from the identity path and a configured credential, and
 * this choice is what `buildTarget` maps onto them.
 */
type AuthMethod = "agent" | "key" | "password";

/** Host defaults, mirrored from crates/host-core/src/connection/params.rs. The
 * host is authoritative and clamps; these are what the form opens with. */
const DEFAULT_LIMITS = {
  timeoutMs: 60_000,
  outputBytes: 262_144,
  streamBytes: 65_536,
} as const;

type Draft = {
  profileId?: string;
  label: string;
  host: string;
  port: string;
  user: string;
  auth: AuthMethod;
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
    auth: "agent",
    identityFile: "",
    proxyJump: "",
    hostKeyPolicy: "accept-new",
    hostKeyFingerprint: "",
    multiplex: "per-call",
    // The host's own defaults (crates/host-core/src/connection/params.rs:
    // DEFAULT_TIMEOUT_MS / DEFAULT_OUTPUT_BYTES / DEFAULT_STREAM_BYTES), prefilled
    // so the form opens with numbers that work. The host clamps whatever is sent,
    // and each value may only be lowered.
    timeoutMs: String(DEFAULT_LIMITS.timeoutMs),
    outputBytes: String(DEFAULT_LIMITS.outputBytes),
    streamBytes: String(DEFAULT_LIMITS.streamBytes),
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
    auth:
      ssh?.identityFile && ssh.identityFile.trim() !== ""
        ? "key"
        : profile.credentialConfigured
          ? "password"
          : "agent",
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

/** The stored path is a local detail: the form shows the file name only. */
function fileNameOf(value: string): string {
  const parts = value.split(/[\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : value;
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
    ...(draft.auth === "key" && optional(draft.identityFile)
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
  // The host rejects a partial set outright, and rejects 0 as out of range: an
  // emptied field has to fall back to the host default, not to zero, or the save
  // fails with a bounds error about a field the user never touched.
  return {
    timeoutMs: timeoutMs && timeoutMs > 0 ? timeoutMs : DEFAULT_LIMITS.timeoutMs,
    outputBytes: outputBytes && outputBytes > 0 ? outputBytes : DEFAULT_LIMITS.outputBytes,
    streamBytes: streamBytes && streamBytes > 0 ? streamBytes : DEFAULT_LIMITS.streamBytes,
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

  // The draft owns the choice, so the control below writes to something and the
  // form reacts. `blankDraft` and `draftFrom` seed it; `buildTarget` maps it back
  // onto the two fields the host really stores.
  const authMethod: AuthMethod = editing?.auth ?? "agent";
  const editingProfile = editing?.profileId
    ? (profiles ?? []).find((row) => row.id === editing.profileId)
    : undefined;
  const authHint =
    authMethod === "key"
      ? t("connections.identityFileHint")
      : authMethod === "password"
        ? t("connections.authPasswordHint")
        : t("connections.authAgentHint");
  // ssh reads the key file; we only ever keep its path. A pasted key body is the
  // one mistake this field invites, so it is caught here rather than at connect
  // time.
  const identityLooksLikeKey = /-----BEGIN|PRIVATE KEY|OPENSSH PRIVATE/.test(
    editing?.identityFile ?? "",
  );

  const chooseAuthMethod = (method: AuthMethod) => {
    setEditing((prev) => {
      if (!prev) return prev;
      // Only the key method carries a path; dropping one the moment the method
      // leaves "key" keeps a stale path from riding along invisibly.
      return method === "key"
        ? { ...prev, auth: method }
        : { ...prev, auth: method, identityFile: "" };
    });
  };

  const pickIdentityFile = async () => {
    const result = await api.pickIdentityFile();
    if (!result.path) return;
    // The dialog outlives this render: merge into whatever the draft is by then.
    setEditing((prev) => (prev ? { ...prev, identityFile: result.path! } : prev));
  };

  if (loadError) {
    return (
      <div className="route-scroll">
        <div className="page-frame">
          <Panel className="page-card page-empty">
            <div className="page-empty-icon">
              <IconServer size={20} aria-hidden />
            </div>
            <h2>{t("connections.loadFailed")}</h2>
          </Panel>
        </div>
      </div>
    );
  }

  return (
    <div className="route-scroll">
      <div className="page-frame">
        <div className="page-header">
          <div>
            <h1 className="page-title">{t("connections.title")}</h1>
            <p className="dest-row-meta">{t("connections.subtitle")}</p>
          </div>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => setEditing(blankDraft())}
          >
            <IconPlus size={14} aria-hidden />
            {t("connections.add")}
          </Button>
        </div>

      {!switchOn ? (
        <Panel className="mb-4 flex items-center gap-3">
          <span className="dest-row-meta min-w-0 flex-1">
            <span className="font-medium">{t("connections.switchOffTitle")}</span>{" "}
            <span className="text-text-secondary">{t("connections.switchOffBody")}</span>
          </span>
          <Button
            className="flex-none"
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
        <p className="dest-row-meta" role="status">{t("connections.loading")}</p>
      ) : profiles.length === 0 ? (
        <div className="page-card page-empty">
          <Panel className="page-empty-icon">
            <IconServer size={18} aria-hidden className="text-text-secondary" />
          </Panel>
          <h2>{t("connections.empty")}</h2>
          <p className="dest-row-meta">{t("connections.emptyBody")}
          </p>
          <Button
            className="mt-1"
            variant="primary"
            size="sm"
            onClick={() => setEditing(blankDraft())}
          >
            <IconPlus size={14} aria-hidden />
            {t("connections.add")}
          </Button>
        </div>
      ) : (
        <div className="dest-list">
          {profiles.map((profile) => {
            const failed =
              profile.lastProbe !== null && profile.lastProbe.ok === false;
            const open = profile.id === selectedId && selected !== null;
            return (
              <Fragment key={profile.id}>
                <Panel className="dest-row">
                  <div className="dest-row-icon"><IconServer
                    size={16}
                    aria-hidden
                    className="flex-none text-text-secondary"
                  /></div>
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    data-nav={`connection-${profile.id}`}
                    aria-expanded={open}
                    onClick={() =>
                      setSelectedId(open ? null : profile.id)
                    }
                  >
                    <span className="dest-row-title w-full">
                      <span className="truncate text-sm">{profile.label}</span>
                      <Badge>{t(KIND_LABEL[profile.kind])}</Badge>
                      {failed ? (
                        <Badge tone="warning">{t("connections.probeFailed")}</Badge>
                      ) : null}
                    </span>
                    <span className="dest-row-meta block truncate">
                      {summarize(profile)}
                    </span>
                  </button>
                  <span className="flex-none text-xs text-text-secondary">
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
                {open && selected ? (
                  <Panel className="dest-create space-y-4">
                    {selected.lastProbe !== null &&
                    selected.lastProbe.ok === false ? (
                      <div className="flex items-center gap-3">
                        <Badge tone="warning" className="flex-none">
                          {t("connections.probeFailed")}
                        </Badge>
                        <p className="min-w-0 flex-1 text-xs text-text-secondary">
                          {t("connections.hostKeyWarn")}
                        </p>
                        <Button
                          className="flex-none"
                          size="sm"
                          disabled={busy || !switchOn || !selected.enabled}
                          title={switchOn ? undefined : t("connections.probeBlocked")}
                          onClick={() => void acceptHostKey(selected)}
                        >
                          {t("connections.acceptHostKey")}
                        </Button>
                      </div>
                    ) : null}

                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {selected.label}
                      </span>
                      <Button
                        className="flex-none"
                        size="sm"
                        disabled={busy || !switchOn || !selected.enabled}
                        title={switchOn ? undefined : t("connections.probeBlocked")}
                        onClick={() => void probe(selected)}
                      >
                        {t("connections.probe")}
                      </Button>
                      <Button
                        className="flex-none"
                        size="sm"
                        onClick={() => setEditing(draftFrom(selected))}
                      >
                        {t("connections.edit")}
                      </Button>
                    </div>

                    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                      <div>
                        <dt className="text-xs text-text-secondary">
                          {t("connections.kind")}
                        </dt>
                        <dd className="mt-0.5 text-xs">{t(KIND_LABEL[selected.kind])}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-text-secondary">
                          {t("connections.host")}
                        </dt>
                        <dd className="mt-0.5 break-all text-xs">
                          {summarize(selected)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-text-secondary">
                          {t("connections.credential")}
                        </dt>
                        <dd className="mt-0.5 text-xs">
                          {selected.credentialConfigured
                            ? t("connections.credentialConfigured")
                            : t("connections.credentialMissing")}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-text-secondary">
                          {t("connections.hostKey")}
                        </dt>
                        <dd className="mt-0.5 text-xs">
                          {t(POLICY_LABEL[selected.hostKeyPolicy])}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-text-secondary">
                          {t("connections.fingerprint")}
                        </dt>
                        <dd className="mt-0.5 break-all text-xs">
                          {selected.hostKeyFingerprint ?? "—"}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-text-secondary">
                          {t("connections.multiplex")}
                        </dt>
                        <dd className="mt-0.5 text-xs">
                          {selected.multiplex === "multiplex"
                            ? t("connections.multiplexMultiplex")
                            : t("connections.multiplexPerCall")}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-text-secondary">
                          {t("connections.lastProbe")}
                        </dt>
                        <dd className="mt-0.5 text-xs">
                          {selected.lastProbe === null
                            ? t("connections.neverProbed")
                            : `${selected.lastProbe.ok ? t("connections.probeOk") : t("connections.probeFailed")} · ${
                                selected.lastProbe.errorCode ?? ""
                              }`.trim()}
                        </dd>
                      </div>
                    </dl>

                    <section className="space-y-1.5">
                      <div className="text-xs text-text-secondary">
                        {t("connections.credential")}
                      </div>
                      <p className="text-xs text-text-secondary">
                        {t("connections.credentialHint")}
                      </p>
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

                    <section className="space-y-1.5">
                      <div className="text-xs text-text-secondary">
                        {t("connections.activity")}
                      </div>
                      {activity.length === 0 ? (
                        <p className="text-xs text-text-secondary">
                          {t("connections.activityEmpty")}
                        </p>
                      ) : (
                        <ul className="space-y-1 text-xs">
                          {activity.map((row, index) => (
                            <li
                              key={`${row.ts}-${index}`}
                              className="flex items-center gap-2"
                            >
                              <span className="flex-none text-text-secondary">
                                {new Date(row.ts).toLocaleString()}
                              </span>
                              <span>{row.action}</span>
                              <span className="text-text-secondary">{row.outcome}</span>
                              {row.errorCode ? (
                                <span className="text-text-secondary">
                                  {row.errorCode}
                                </span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>

                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setConfirmingDelete(selected.id)}
                      >
                        {t("connections.delete")}
                      </Button>
                    </div>
                  </Panel>
                ) : null}
              </Fragment>
            );
          })}
        </div>
      )}

      {editing ? (
        <div className="overlay" role="dialog" aria-modal="true" aria-label={t("connections.add")}>
          <Panel className="dialog connections-editor space-y-4">
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

            <Field label={t("connections.authMethod")}>
              <SegmentedControl
                value={authMethod}
                label={t("connections.authMethod")}
                onChange={(value) => chooseAuthMethod(value as AuthMethod)}
                options={[
                  { value: "agent", label: t("connections.authAgent") },
                  { value: "key", label: t("connections.authKey") },
                  { value: "password", label: t("connections.authPassword") },
                ]}
              />
            </Field>
            <p className="-mt-1 text-xs text-text-secondary">{authHint}</p>

            {authMethod !== "agent" ? (
              <Field label={t("connections.credential")}>
                <div className="space-y-1.5">
                  <PasswordInput
                    value={credential}
                    showLabel={t("connections.credentialSet")}
                    hideLabel={t("connections.cancel")}
                    onChange={(event) => {
                      setCredential(event.target.value);
                      // Names the profile the secret belongs to, so the save path
                      // hands it to this target rather than to the selected one.
                      setCredentialFor(editing.profileId ?? null);
                    }}
                  />
                  <p className="text-xs text-text-secondary">
                    {authMethod === "key"
                      ? t("connections.credentialKeyHint")
                      : t("connections.credentialPasswordHint")}
                  </p>
                  {editing.profileId ? (
                    <p className="text-xs text-text-secondary">
                      {editingProfile?.credentialConfigured
                        ? t("connections.credentialConfigured")
                        : t("connections.credentialMissing")}
                    </p>
                  ) : null}
                </div>
              </Field>
            ) : null}

            {authMethod === "key" ? (
              <Field
                label={t("connections.identityFile")}
                hint={
                  identityLooksLikeKey
                    ? t("connections.identityFileLooksLikeKey")
                    : t("connections.identityFileHint")
                }
              >
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    {/* Read-only on purpose: the picker is the way in, and the
                        path itself never needs to be on screen or editable. */}
                    <Input value={fileNameOf(editing.identityFile)} readOnly />
                  </div>
                  <Button
                    className="flex-none whitespace-nowrap"
                    size="sm"
                    onClick={() => void pickIdentityFile()}
                  >
                    {t("connections.pickIdentityFile")}
                  </Button>
                </div>
                <p className="text-xs text-text-secondary">
                  {t("connections.identityFileMasked")}
                </p>
              </Field>
            ) : null}

            <Field label={t("connections.proxyJump")}>
              <div className="space-y-1.5">
                <Input
                  value={editing.proxyJump}
                  onChange={(event) =>
                    setEditing({ ...editing, proxyJump: event.target.value })
                  }
                />
                <p className="text-xs text-text-secondary">
                  {t("connections.proxyJumpHint")}
                </p>
              </div>
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
              <p className="text-xs text-text-secondary">
                {t("connections.limitsDefaultsHint")}
              </p>
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
                disabled={
                  busy ||
                  editing.label.trim() === "" ||
                  editing.host.trim() === "" ||
                  identityLooksLikeKey ||
                  (authMethod === "password" &&
                    credential.trim() === "" &&
                    !editingProfile?.credentialConfigured)
                }
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
          <Panel className="dialog space-y-3 p-4">
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
      </div>
    );
}
