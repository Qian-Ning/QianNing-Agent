/**
 * Connections, phone side.
 *
 * The desktop page is about a machine the *agent runtime* may work on: it pairs
 * a host, installs the runtime, and multiplexes. A phone cannot install a
 * runtime anywhere, so this page answers the question a phone actually has —
 * "SSH to my machine and run something from here" — with a real client behind
 * it (the `QnSsh` plugin). The machines it stores are the same list the agent's
 * `ssh_run` tool uses.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, Input } from "../../components/ui";
import { api } from "../../lib/api";

type SshProfile = {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  enabled: boolean;
  auth: string;
  fingerprint: string;
  hasSecret: boolean;
  connected: boolean;
};

type Draft = {
  id?: string;
  name: string;
  host: string;
  port: string;
  user: string;
  auth: "password" | "key";
  password: string;
  privateKey: string;
  passphrase: string;
};

const EMPTY_DRAFT: Draft = {
  name: "",
  host: "",
  port: "22",
  user: "",
  auth: "password",
  password: "",
  privateKey: "",
  passphrase: "",
};

export function PhoneConnections() {
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState<SshProfile[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [active, setActive] = useState<SshProfile | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [command, setCommand] = useState("");
  const logRef = useRef<HTMLPreElement | null>(null);

  const [supported, setSupported] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const answer = await api.sshProfiles();
      setProfiles(answer.profiles);
      setSupported(answer.supported);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const save = useCallback(async () => {
    if (!draft) return;
    setBusy("save");
    setError(null);
    try {
      await api.sshSaveProfile({
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name,
        host: draft.host,
        port: Number(draft.port) || 22,
        user: draft.user,
        auth: draft.auth,
        ...(draft.auth === "password" && draft.password ? { password: draft.password } : {}),
        ...(draft.auth === "key" && draft.privateKey ? { privateKey: draft.privateKey } : {}),
        ...(draft.auth === "key" && draft.passphrase ? { passphrase: draft.passphrase } : {}),
      });
      setDraft(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }, [draft, refresh]);

  const test = useCallback(async (profile: SshProfile) => {
    setBusy(`test:${profile.id}`);
    setError(null);
    setNotice(null);
    try {
      const answer = await api.sshProbe(profile.id);
      setNotice(
        t("connections.phoneReachable", {
          banner: answer.banner || profile.host,
          fingerprint: (answer.fingerprint || profile.fingerprint).slice(0, 23),
        }),
      );
      await refresh();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(
        message.startsWith("HOST_KEY_CHANGED:")
          ? t("connections.phoneKeyChanged", { fingerprint: message.slice(17, 40) })
          : message,
      );
    } finally {
      setBusy(null);
    }
  }, [refresh, t]);

  const openTerminal = useCallback(
    async (profile: SshProfile) => {
      setActive(profile);
      setLog([`$ ssh ${profile.user}@${profile.host}`]);
      setBusy(`open:${profile.id}`);
      setError(null);
      try {
        await api.sshRun(profile.id, "echo connected");
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const send = useCallback(async () => {
    if (!active || !command.trim()) return;
    const line = command.trim();
    setCommand("");
    setLog((current) => [...current, `$ ${line}`]);
    setBusy(`run:${active.id}`);
    try {
      const answer = await api.sshRun(active.id, line, 60_000);
      const text = answer.output.replace(/\s+$/, "");
      setLog((current) => [
        ...current,
        ...(text ? text.split("\n") : []),
        ...(answer.timedOut ? [`! ${t("connections.phoneTimeout")}`] : []),
        ...(answer.exitStatus ? [`! exit ${answer.exitStatus}`] : []),
      ]);
    } catch (cause) {
      setLog((current) => [
        ...current,
        `! ${cause instanceof Error ? cause.message : String(cause)}`,
      ]);
    } finally {
      setBusy(null);
    }
  }, [active, command, t]);

  const remove = useCallback(
    async (profile: SshProfile) => {
      await api.sshDeleteProfile(profile.id);
      if (active?.id === profile.id) setActive(null);
      await refresh();
    },
    [active?.id, refresh],
  );

  const disconnect = useCallback(
    async (profile: SshProfile) => {
      await api.sshDisconnect(profile.id);
      if (active?.id === profile.id) setActive(null);
      await refresh();
    },
    [active?.id, refresh],
  );

  return (
    <div className="phone-ssh">
      <header className="phone-ssh-head">
        <h1>{t("connections.title")}</h1>
        <p>{t("connections.phoneSubtitle")}</p>
      </header>

      {supported ? null : <p className="phone-ssh-error">{t("connections.phoneUnsupported")}</p>}
      {error ? <p className="phone-ssh-error">{error}</p> : null}
      {notice ? <p className="phone-ssh-notice">{notice}</p> : null}

      <div className="phone-ssh-toolbar">
        <Button
          type="button"
          onClick={() => setDraft((current) => (current ? null : { ...EMPTY_DRAFT }))}
        >
          {draft ? t("connections.phoneCancel") : t("connections.phoneAdd")}
        </Button>
      </div>

      {draft ? (
        <div className="phone-ssh-form">
          <label>
            <span>{t("connections.phoneName")}</span>
            <Input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label>
            <span>{t("connections.phoneHost")}</span>
            <Input
              value={draft.host}
              onChange={(event) => setDraft({ ...draft, host: event.target.value })}
              placeholder="192.168.1.8"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              inputMode="url"
            />
          </label>
          <label>
            <span>{t("connections.phonePort")}</span>
            <Input
              value={draft.port}
              onChange={(event) => setDraft({ ...draft, port: event.target.value })}
              inputMode="numeric"
              autoComplete="off"
            />
          </label>
          <label>
            <span>{t("connections.phoneUser")}</span>
            <Input
              value={draft.user}
              onChange={(event) => setDraft({ ...draft, user: event.target.value })}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </label>
          <div className="phone-ssh-auth">
            <button
              type="button"
              className={draft.auth === "password" ? "is-active" : ""}
              onClick={() => setDraft({ ...draft, auth: "password" })}
            >
              {t("connections.phoneAuthPassword")}
            </button>
            <button
              type="button"
              className={draft.auth === "key" ? "is-active" : ""}
              onClick={() => setDraft({ ...draft, auth: "key" })}
            >
              {t("connections.phoneAuthKey")}
            </button>
          </div>
          {draft.auth === "password" ? (
            <label>
              <span>{t("connections.phonePassword")}</span>
              <Input
                type="password"
                value={draft.password}
                onChange={(event) => setDraft({ ...draft, password: event.target.value })}
                autoComplete="off"
              />
            </label>
          ) : (
            <>
              <label>
                <span>{t("connections.phonePrivateKey")}</span>
                <textarea
                  className="phone-ssh-key"
                  value={draft.privateKey}
                  onChange={(event) => setDraft({ ...draft, privateKey: event.target.value })}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  spellCheck={false}
                />
              </label>
              <label>
                <span>{t("connections.phonePassphrase")}</span>
                <Input
                  type="password"
                  value={draft.passphrase}
                  onChange={(event) => setDraft({ ...draft, passphrase: event.target.value })}
                  autoComplete="off"
                />
              </label>
            </>
          )}
          <Button
            type="button"
            disabled={busy === "save" || !draft.host.trim() || !draft.user.trim()}
            onClick={() => void save()}
          >
            {t("connections.phoneSave")}
          </Button>
        </div>
      ) : null}

      <ul className="phone-ssh-list">
        {profiles.length === 0 ? (
          <li className="phone-ssh-empty">{t("connections.phoneEmpty")}</li>
        ) : (
          profiles.map((profile) => (
            <li key={profile.id} className="phone-ssh-row">
              <div className="phone-ssh-copy">
                <span className="phone-ssh-name">
                  <span
                    className={`phone-ssh-dot${profile.connected ? " is-live" : ""}`}
                    aria-hidden
                  />
                  {profile.name}
                </span>
                <span className="phone-ssh-addr">
                  {profile.user}@{profile.host}:{profile.port}
                </span>
                {profile.fingerprint ? (
                  <span className="phone-ssh-fp">{profile.fingerprint.slice(0, 23)}…</span>
                ) : (
                  <span className="phone-ssh-fp">{t("connections.phoneUnknownKey")}</span>
                )}
              </div>
              <div className="phone-ssh-actions">
                <button
                  type="button"
                  onClick={() => void test(profile)}
                  disabled={busy === `test:${profile.id}`}
                >
                  {busy === `test:${profile.id}`
                    ? t("connections.phoneTesting")
                    : t("connections.phoneTest")}
                </button>
                <button
                  type="button"
                  className="phone-ssh-primary"
                  onClick={() => void openTerminal(profile)}
                  disabled={busy === `open:${profile.id}`}
                >
                  {t("connections.phoneTerminal")}
                </button>
                {profile.connected ? (
                  <button type="button" onClick={() => void disconnect(profile)}>
                    {t("connections.phoneDisconnect")}
                  </button>
                ) : (
                  <button type="button" onClick={() => void remove(profile)}>
                    {t("connections.phoneDelete")}
                  </button>
                )}
              </div>
            </li>
          ))
        )}
      </ul>

      {active ? (
        <section className="phone-ssh-terminal">
          <header>
            <span>{`${active.user}@${active.host}`}</span>
            <button type="button" onClick={() => setActive(null)}>
              {t("connections.phoneClose")}
            </button>
          </header>
          <pre ref={logRef} className="phone-ssh-log">
            {log.join("\n")}
          </pre>
          <form
            className="phone-ssh-input"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <Input
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder={t("connections.phoneCommandPlaceholder")}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <Button type="submit" disabled={Boolean(busy) || !command.trim()}>
              {t("connections.phoneSend")}
            </Button>
          </form>
        </section>
      ) : null}
    </div>
  );
}
