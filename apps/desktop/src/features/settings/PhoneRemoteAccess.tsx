/**
 * Remote access, phone side.
 *
 * The desktop's card answers "who may dial into this machine". On a phone the
 * question is the opposite one — "which computer am I driving" — so this page
 * pairs desktops instead of listening for devices, and then lets the phone walk
 * into one of that computer's conversations and keep talking in it.
 *
 * The surface stays shallow on purpose: a list of computers, one opened at a
 * time, and one conversation above it. A settings page is not a workspace, and
 * every extra control costs a thumb-reach on a screen this narrow.
 */


import { REMOTE_UNREACHABLE } from "@pi-desktop/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, Input, portalOverlay } from "../../components/ui";
import { api } from "../../lib/api";
import { SettingsCard } from "./primitives";

type PairedHost = {
  hostKey: string;
  label: string;
  url: string;
  fingerprint?: string;
  connected: boolean;
};

type SessionRow = {
  id: string;
  title: string;
  updatedAt?: number;
};

type Message = {
  id: string;
  role: "user" | "assistant" | "tool" | "note";
  text: string;
  at?: number;
  toolName?: string;
};

type SessionState = {
  status: "loading" | "ready" | "error";
  items: SessionRow[];
  error?: string;
};

/** "3 分钟前" from the catalog, not from a date library. */
function relative(at: number | undefined, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (!at || !Number.isFinite(at)) return "";
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return t("settings.relativeNow");
  if (minutes < 60) return t("settings.relativeMinutes", { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("settings.relativeHours", { n: hours });
  return t("settings.relativeDays", { n: Math.round(hours / 24) });
}

export function PhoneRemoteAccess() {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<PairedHost[]>([]);
  const [supported, setSupported] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [address, setAddress] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Record<string, SessionState>>({});
  const [open, setOpen] = useState<{ host: PairedHost; session: SessionRow } | null>(null);

  /**
   * A wire failure arrives as a code, because the native layer's own sentence
   * ("failed to connect to /10.0.0.2 (port 6838) … after 15000ms") tells a
   * person nothing they can act on.
   */
  const describe = useCallback(
    (cause: unknown): string => {
      const message = cause instanceof Error ? cause.message : String(cause);
      return message === REMOTE_UNREACHABLE ? t("settings.phoneUnreachable") : message;
    },
    [t],
  );

  const refresh = useCallback(async () => {
    try {
      const answer = await api.listPairedComputers();
      setHosts(answer.hosts);
      setSupported(answer.supported);
    } catch (cause) {
      setError(describe(cause));
    }
  }, [describe]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadSessions = useCallback(
    async (host: PairedHost) => {
      setSessions((current) => ({
        ...current,
        [host.hostKey]: { status: "loading", items: current[host.hostKey]?.items ?? [] },
      }));
      try {
        const answer = await api.remoteSessions(host.hostKey);
        setSessions((current) => ({
          ...current,
          [host.hostKey]: {
            status: "ready",
            items: answer.sessions.map((session) => ({
              id: session.id,
              title: session.title,
              ...(typeof session.updatedAt === "number" ? { updatedAt: session.updatedAt } : {}),
            })),
          },
        }));
      } catch (cause) {
        setSessions((current) => ({
          ...current,
          [host.hostKey]: { status: "error", items: [], error: describe(cause) },
        }));
      }
    },
    [describe],
  );

  const toggle = useCallback(
    (host: PairedHost) => {
      setError(null);
      if (expanded === host.hostKey) {
        setExpanded(null);
        return;
      }
      setExpanded(host.hostKey);
      void loadSessions(host);
    },
    [expanded, loadSessions],
  );

  const connect = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.pairComputer({ url: address.trim(), token: token.trim() });
      setAddress("");
      setToken("");
      setAdding(false);
      await refresh();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  }, [address, token, busy, refresh, describe]);

  const forget = useCallback(
    async (host: PairedHost) => {
      try {
        await api.removePairedComputer(host.hostKey);
        setExpanded((current) => (current === host.hostKey ? null : current));
        await refresh();
      } catch (cause) {
        setError(describe(cause));
      }
    },
    [refresh, describe],
  );

  return (
    <div className="phone-remote">
      {supported ? null : (
        <SettingsCard title={t("settings.phoneTitle")}>
          <p className="phone-remote-note">{t("settings.phoneUnsupported")}</p>
        </SettingsCard>
      )}

      <SettingsCard title={t("settings.phonePaired")}>
        {hosts.length === 0 ? (
          <p className="phone-remote-note">{t("settings.phoneEmpty")}</p>
        ) : (
          <ul className="phone-remote-list">
            {hosts.map((host) => {
              const state = sessions[host.hostKey];
              const isOpen = expanded === host.hostKey;
              return (
                <li key={host.hostKey} className={isOpen ? "phone-remote-item is-open" : "phone-remote-item"}>
                  <button
                    type="button"
                    className="phone-remote-computer"
                    onClick={() => toggle(host)}
                    aria-expanded={isOpen}
                  >
                    <span className="phone-remote-dot" aria-hidden="true" />
                    <span className="phone-remote-copy">
                      <span className="phone-remote-name">{host.label}</span>
                      <span className="phone-remote-url">{host.url.replace(/^https?:\/\//, "")}</span>
                    </span>
                    <span className="phone-remote-chevron" aria-hidden="true">
                      {isOpen ? "−" : "+"}
                    </span>
                  </button>

                  {isOpen ? (
                    <div className="phone-remote-detail">
                      {state?.status === "loading" ? (
                        <p className="phone-remote-hint">{t("settings.phoneLoading")}</p>
                      ) : null}
                      {state?.status === "error" ? <p className="phone-remote-error">{state.error}</p> : null}
                      {state?.status === "ready" && state.items.length === 0 ? (
                        <p className="phone-remote-hint">{t("settings.phoneNoSessions")}</p>
                      ) : null}
                      {state?.status === "ready" && state.items.length > 0 ? (
                        <ul className="phone-remote-sessions">
                          {state.items.map((session) => (
                            <li key={session.id}>
                              <button
                                type="button"
                                className="phone-remote-session"
                                onClick={() => setOpen({ host, session })}
                              >
                                <span className="phone-remote-session-title">{session.title}</span>
                                <span className="phone-remote-session-time">
                                  {relative(session.updatedAt, t)}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      <div className="phone-remote-detail-actions">
                        <button
                          type="button"
                          className="phone-remote-link"
                          onClick={() => void loadSessions(host)}
                        >
                          {t("settings.phoneRefresh")}
                        </button>
                        <button
                          type="button"
                          className="phone-remote-link is-danger"
                          onClick={() => void forget(host)}
                        >
                          {t("settings.phoneRemove")}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </SettingsCard>

      {adding ? (
        <SettingsCard title={t("settings.phoneAdd")}>
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
          <p className="phone-remote-hint">{t("settings.phoneNote")}</p>
          <div className="phone-remote-sheet-actions">
            <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
              {t("settings.phoneCancel")}
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={busy || !address.trim() || !token.trim()}
              onClick={() => void connect()}
            >
              {busy ? t("settings.phoneConnecting") : t("settings.phoneConnect")}
            </Button>
          </div>
        </SettingsCard>
      ) : (
        <Button type="button" className="phone-remote-add" onClick={() => setAdding(true)}>
          {t("settings.phoneAdd")}
        </Button>
      )}

      {error ? <p className="phone-remote-error">{error}</p> : null}

      {open
        ? portalOverlay(
            <RemoteConversation host={open.host} session={open.session} onClose={() => setOpen(null)} />,
          )
        : null}
    </div>
  );
}

/**
 * One conversation, read from the paired computer and continued there.
 *
 * The desktop owns the turn: this sheet sends the prompt over RACP and then
 * polls the transcript, because the phone's native bridge answers one request
 * at a time and does not carry the event stream. Polling stops as soon as two
 * consecutive reads agree, or when the sheet closes.
 */
function RemoteConversation({
  host,
  session,
  onClose,
}: {
  host: PairedHost;
  session: SessionRow;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async (): Promise<Message[]> => {
    const answer = await api.remoteHistory(host.hostKey, session.id);
    if (alive.current) setMessages(answer.messages);
    return answer.messages;
  }, [host.hostKey, session.id]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await load();
        if (!cancelled) setStatus("ready");
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      await api.remoteSendTurn(host.hostKey, session.id, text);
      setDraft("");
      // The reply is produced on the desktop, so read until two reads agree
      // instead of guessing how long a turn takes.
      let previous = -1;
      for (let attempt = 0; attempt < 40 && alive.current; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, attempt < 4 ? 800 : 2_000));
        const next = await load();
        if (next.length === previous && next.some((message) => message.role === "assistant")) break;
        previous = next.length;
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (alive.current) setSending(false);
    }
  }, [draft, sending, host.hostKey, session.id, load]);

  return (
    <div className="phone-remote-sheet" role="dialog" aria-label={session.title}>
      <header className="phone-remote-sheet-head">
        <button type="button" className="phone-remote-sheet-back" onClick={onClose}>
          {t("settings.phoneBack")}
        </button>
        <span className="phone-remote-sheet-title">{session.title}</span>
        <span className="phone-remote-sheet-host">{host.label}</span>
      </header>

      <div className="phone-remote-thread">
        {status === "loading" ? <p className="phone-remote-hint">{t("settings.phoneLoading")}</p> : null}
        {status === "ready" && messages.length === 0 ? (
          <p className="phone-remote-hint">{t("settings.phoneSessionEmpty")}</p>
        ) : null}
        {messages.map((message) =>
          message.role === "tool" ? (
            <p key={message.id} className="phone-remote-tool">
              {t("settings.phoneTool")} · {message.toolName ?? message.text}
            </p>
          ) : message.role === "note" ? (
            <p key={message.id} className="phone-remote-divider">
              {t("settings.phoneCompacted")}
            </p>
          ) : (
            <div key={message.id} className={`phone-remote-bubble is-${message.role}`}>
              {message.text}
            </div>
          ),
        )}
        <div ref={bottom} />
      </div>

      {error ? <p className="phone-remote-error">{error}</p> : null}

      <form
        className="phone-remote-compose"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t("settings.phoneComposer")}
          disabled={sending}
        />
        <Button type="submit" variant="primary" disabled={sending || !draft.trim()}>
          {sending ? t("settings.phoneSending") : t("settings.phoneSend")}
        </Button>
      </form>
    </div>
  );
}
