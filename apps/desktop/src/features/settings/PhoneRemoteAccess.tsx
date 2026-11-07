/**
 * Remote access, phone side.
 *
 * The desktop's card answers "who may dial into this machine". On a phone the
 * question is the opposite — "which computer am I driving" — so this page pairs
 * desktops and then hands the screen over to one of their conversations.
 *
 * Three levels, one visible at a time: the computer list, that computer's
 * conversations, and one conversation. Each deeper level covers the previous
 * one completely and carries its own back control, because a phone has no room
 * for two panels, and a stack you can see through reads as a rendering fault
 * rather than as depth.
 */

import { REMOTE_UNREACHABLE, parsePairingLink } from "@pi-desktop/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

type SessionRow = {
  id: string;
  title: string;
  updatedAt?: number;
};

type Message = {
  id: string;
  role: "user" | "assistant" | "tool" | "note";
  text: string;
  toolName?: string;
};

/** A decision the desktop is waiting on before the turn can continue. */
type Approval = {
  id: string;
  kind: "tool" | "plan" | "goal";
  summary: string;
  toolName?: string;
};

type Screen =
  | { kind: "computers" }
  | { kind: "sessions"; host: PairedHost }
  | { kind: "chat"; host: PairedHost; session: SessionRow };

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
  const [screen, setScreen] = useState<Screen>({ kind: "computers" });

  const [link, setLink] = useState("");
  const [manual, setManual] = useState(false);
  const [address, setAddress] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  /**
   * A wire failure arrives as a code, because the native layer's own sentence
   * ("failed to connect to /10.0.0.2 (port 6838) … after 15000ms") tells a
   * person nothing they can act on.
   */
  const describe = useCallback(
    (cause: unknown): string => {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message === REMOTE_UNREACHABLE) return t("settings.phoneUnreachable");
      if (message === "camera-denied") return t("settings.phoneCameraDenied");
      if (message === "this build cannot scan a code") return t("settings.phoneNoScanner");
      return message;
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

  const pop = useCallback(() => {
    setScreen((current) =>
      current.kind === "chat"
        ? { kind: "sessions", host: current.host }
        : current.kind === "sessions"
          ? { kind: "computers" }
          : current,
    );
  }, []);

  /**
   * Android's back gesture never touches browser history: the native shell asks
   * `window.__qianningBack`, and each surface answers in turn. This page claims
   * the gesture only while a deeper level is open, so back still leaves
   * settings when the computer list is what is on screen.
   */
  const depth = useRef(0);
  depth.current = screen.kind === "computers" ? 0 : screen.kind === "sessions" ? 1 : 2;
  useEffect(() => {
    const host = window as unknown as { __qianningBack?: () => boolean };
    const previous = host.__qianningBack;
    const installed = () => {
      if (depth.current === 0) return previous ? previous() : false;
      pop();
      return true;
    };
    host.__qianningBack = installed;
    return () => {
      if (host.__qianningBack === installed) host.__qianningBack = previous;
    };
  }, [pop]);

  const parsed = useMemo(() => parsePairingLink(link), [link]);

  const pairWith = useCallback(
    async (target: { url: string; token: string }) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await api.pairComputer({ url: target.url, token: target.token });
        setLink("");
        setAddress("");
        setToken("");
        await refresh();
      } catch (cause) {
        setError(describe(cause));
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh, describe],
  );

  const connect = useCallback(() => {
    const target = manual ? { url: address.trim(), token: token.trim() } : parsed;
    if (!target?.url || !target.token) return;
    void pairWith(target);
  }, [manual, address, token, parsed, pairWith]);

  /**
   * A scanned code is a pairing link, so it goes straight to the same parser
   * and then to the same pairing call — one tap instead of scan, read, confirm.
   */
  const scan = useCallback(async () => {
    setError(null);
    try {
      const { text } = await api.scanPairingCode();
      if (!text) return;
      setManual(false);
      setLink(text);
      const target = parsePairingLink(text);
      if (!target) {
        setError(t("settings.phoneNotLink"));
        return;
      }
      await pairWith(target);
    } catch (cause) {
      setError(describe(cause));
    }
  }, [pairWith, describe, t]);

  const forget = useCallback(
    async (host: PairedHost) => {
      try {
        await api.removePairedComputer(host.hostKey);
        setScreen({ kind: "computers" });
        await refresh();
      } catch (cause) {
        setError(describe(cause));
      }
    },
    [refresh, describe],
  );

  return (
    <div className="phone-remote">
      <SettingsCard title={t("settings.phonePaired")} description={t("settings.phoneNote")}>
        {supported ? null : <p className="phone-remote-note">{t("settings.phoneUnsupported")}</p>}
        {hosts.length === 0 && supported ? (
          <p className="phone-remote-note">{t("settings.phoneEmpty")}</p>
        ) : (
          <ul className="phone-remote-list">
            {hosts.map((host) => (
              <li key={host.hostKey}>
                <button
                  type="button"
                  className="phone-remote-computer"
                  onClick={() => setScreen({ kind: "sessions", host })}
                >
                  <span className="phone-remote-live" aria-hidden="true" />
                  <span className="phone-remote-copy">
                    <span className="phone-remote-name">{host.label}</span>
                    <span className="phone-remote-url">{host.url.replace(/^https?:\/\//, "")}</span>
                  </span>
                  <span className="phone-remote-arrow" aria-hidden="true">
                    ›
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>

      <SettingsCard title={t("settings.phoneAdd")}>
        {manual ? (
          <>
            <label className="phone-remote-field">
              <span>{t("settings.phoneAddress")}</span>
              <Input
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                placeholder={t("settings.phoneAddressHint")}
                inputMode="url"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
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
          </>
        ) : (
          <label className="phone-remote-field">
            <span>{t("settings.phoneLink")}</span>
            <Input
              value={link}
              onChange={(event) => setLink(event.target.value)}
              placeholder={t("settings.phoneLinkHint")}
              inputMode="url"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </label>
        )}

        {link.trim() && !manual ? (
          <p className={parsed ? "phone-remote-target" : "phone-remote-warn"}>
            {parsed
              ? t("settings.phoneTarget", { host: parsed.url.replace(/^https?:\/\//, "") })
              : t("settings.phoneNotLink")}
          </p>
        ) : null}

        <div className="phone-remote-actions">
          <Button type="button" variant="secondary" onClick={() => void scan()} disabled={!supported}>
            {t("settings.phoneScan")}
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={() => connect()}
            disabled={busy || (manual ? !address.trim() || !token.trim() : !parsed)}
          >
            {busy ? t("settings.phoneConnecting") : t("settings.phoneConnect")}
          </Button>
        </div>

        <button type="button" className="phone-remote-switch" onClick={() => setManual((value) => !value)}>
          {manual ? t("settings.phoneUseLink") : t("settings.phoneManual")}
        </button>
      </SettingsCard>

      {error ? <p className="phone-remote-error">{error}</p> : null}

      {screen.kind !== "computers" ? (
        <div className="phone-remote-screen">
          <RemoteSessions
            host={screen.host}
            openSession={screen.kind === "chat" ? screen.session : null}
            onOpen={(session) => setScreen({ kind: "chat", host: screen.host, session })}
            onBack={pop}
            onForget={() => void forget(screen.host)}
            describe={describe}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * One computer: its conversations, and on top of them one conversation.
 *
 * A computer can hold thousands of conversations and the desktop sends them all
 * at once, so the list renders its head and grows on demand instead of trying
 * to lay out every row. Search is local because the payload is already here.
 */
function RemoteSessions({
  host,
  openSession,
  onOpen,
  onBack,
  onForget,
  describe,
}: {
  host: PairedHost;
  openSession: SessionRow | null;
  onOpen: (session: SessionRow) => void;
  onBack: () => void;
  onForget: () => void;
  describe: (cause: unknown) => string;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [items, setItems] = useState<SessionRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(60);

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const answer = await api.remoteSessions(host.hostKey);
      setItems(
        answer.sessions.map((session) => ({
          id: session.id,
          title: session.title,
          ...(typeof session.updatedAt === "number" ? { updatedAt: session.updatedAt } : {}),
        })),
      );
      setStatus("ready");
    } catch (cause) {
      setLoadError(describe(cause));
      setStatus("error");
    }
  }, [host.hostKey, describe]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((session) => session.title.toLowerCase().includes(needle));
  }, [items, query]);

  const visible = filtered.slice(0, shown);
  const remaining = filtered.length - visible.length;

  return (
    <>
      <header className="phone-remote-head">
        <button type="button" className="phone-remote-back" onClick={onBack} aria-label={t("settings.phoneBack")}>
          ‹
        </button>
        <span className="phone-remote-head-copy">
          <span className="phone-remote-head-title">{host.label}</span>
          <span className="phone-remote-head-sub">{host.url.replace(/^https?:\/\//, "")}</span>
        </span>
      </header>

      <div className="phone-remote-body">
        <div className="phone-remote-search">
          <Input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setShown(60);
            }}
            placeholder={t("settings.phoneSearch")}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
          />
        </div>

        {status === "loading" && items.length === 0 ? (
          <p className="phone-remote-hint">{t("settings.phoneLoading")}</p>
        ) : null}
        {status === "error" ? <p className="phone-remote-error">{loadError}</p> : null}
        {status === "ready" && filtered.length === 0 && items.length > 0 ? (
          <p className="phone-remote-hint">{query.trim() ? t("settings.phoneNoMatch") : t("settings.phoneNoSessions")}</p>
        ) : null}
        {status === "ready" && items.length === 0 ? (
          <p className="phone-remote-hint">{t("settings.phoneNoSessions")}</p>
        ) : null}

        {visible.length > 0 ? (
          <ul className="phone-remote-sessions">
            {visible.map((session) => (
              <li key={session.id}>
                <button type="button" className="phone-remote-session" onClick={() => onOpen(session)}>
                  <span className="phone-remote-session-title">{session.title}</span>
                  <span className="phone-remote-session-time">{relative(session.updatedAt, t)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {remaining > 0 ? (
          <Button type="button" variant="ghost" onClick={() => setShown((value) => value + 120)}>
            {t("settings.phoneMore", { n: remaining })}
          </Button>
        ) : null}

        <button type="button" className="phone-remote-switch is-danger" onClick={onForget}>
          {t("settings.phoneRemove")}
        </button>
      </div>

      {openSession ? (
        <RemoteConversation host={host} session={openSession} onBack={onBack} describe={describe} />
      ) : null}
    </>
  );
}

/**
 * One conversation, read from the paired computer and continued there.
 *
 * The desktop owns the turn: this screen sends the prompt over RACP and then
 * polls the transcript, because the phone's native bridge answers one request
 * at a time and does not carry the event stream. Polling stops as soon as two
 * consecutive reads agree, or when the screen closes.
 */
function RemoteConversation({
  host,
  session,
  onBack,
  describe,
}: {
  host: PairedHost;
  session: SessionRow;
  onBack: () => void;
  describe: (cause: unknown) => string;
}) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [approvals, setApprovals] = useState<Approval[]>([]);
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
        setError(describe(cause));
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load, describe]);

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
      // The host answers with the transcript, the questions it is waiting on and
      // whether the turn is still running, so one read per tick is enough — and
      // the stop condition is the host's own answer instead of a guess about
      // when the words stopped changing.
      for (let attempt = 0; attempt < 90 && alive.current; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, attempt < 4 ? 500 : 900));
        const snapshot = await api.remoteChat(host.hostKey, session.id);
        if (!alive.current) break;
        setMessages(snapshot.messages);
        setApprovals(snapshot.approvals);
        if (!snapshot.active) break;
      }
    } catch (cause) {
      setError(describe(cause));
    } finally {
      if (alive.current) setSending(false);
    }
  }, [draft, sending, host.hostKey, session.id, describe]);

  /**
   * Answers one approval and drops it from the list immediately: the next poll
   * confirms, but a card that lingers after a tap reads as a dead button.
   */
  const answer = useCallback(
    async (approval: Approval, decision: "allow-once" | "allow-session" | "deny" | "approve" | "reject") => {
      setApprovals((current) => current.filter((entry) => entry.id !== approval.id));
      try {
        await api.remoteRespondApproval(host.hostKey, approval.id, decision);
      } catch (cause) {
        setError(describe(cause));
      }
    },
    [host.hostKey, describe],
  );

  return (
    <>
      <header className="phone-remote-head">
        <button type="button" className="phone-remote-back" onClick={onBack} aria-label={t("settings.phoneBack")}>
          ‹
        </button>
        <span className="phone-remote-head-copy">
          <span className="phone-remote-head-title">{session.title}</span>
          <span className="phone-remote-head-sub">{host.label}</span>
        </span>
      </header>

      <div className="phone-remote-thread">
        {status === "loading" ? <p className="phone-remote-hint">{t("settings.phoneLoading")}</p> : null}
        {status === "ready" && messages.length === 0 ? (
          <p className="phone-remote-hint">{t("settings.phoneSessionEmpty")}</p>
        ) : null}
        {status === "error" ? <p className="phone-remote-error">{error}</p> : null}

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

      {status === "ready" && error ? <p className="phone-remote-error">{error}</p> : null}

      {approvals.map((approval) => (
        <div key={approval.id} className="phone-remote-approval">
          <p className="phone-remote-approval-head">
            {t("settings.phoneApproval")}
            {approval.toolName ? ` · ${approval.toolName}` : ""}
          </p>
          {approval.summary ? <p className="phone-remote-approval-body">{approval.summary}</p> : null}
          <div className="phone-remote-approval-actions">
            {approval.kind === "tool" ? (
              <>
                <Button type="button" variant="primary" onClick={() => void answer(approval, "allow-once")}>
                  {t("settings.phoneAllowOnce")}
                </Button>
                <Button type="button" variant="secondary" onClick={() => void answer(approval, "allow-session")}>
                  {t("settings.phoneAllowSession")}
                </Button>
                <Button type="button" variant="ghost" onClick={() => void answer(approval, "deny")}>
                  {t("settings.phoneDeny")}
                </Button>
              </>
            ) : (
              <>
                <Button type="button" variant="primary" onClick={() => void answer(approval, "approve")}>
                  {t("settings.phoneApprove")}
                </Button>
                <Button type="button" variant="ghost" onClick={() => void answer(approval, "reject")}>
                  {t("settings.phoneReject")}
                </Button>
              </>
            )}
          </div>
        </div>
      ))}

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
    </>
  );
}
