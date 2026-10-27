import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "../lib/markdown";
import { toMessageItem, type HostClient, type HostEvent, type MessageItem } from "../lib/racp";
import type { Translate } from "../lib/i18n";

type Approval = {
  id: string;
  title: string;
  detail: string;
  revision?: number;
};

type DiffFile = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readHistory(value: unknown): MessageItem[] {
  const record = asRecord(value);
  const list = Array.isArray(value)
    ? value
    : (record.items ?? record.messages ?? record.history ?? []);
  if (!Array.isArray(list)) return [];
  const items: MessageItem[] = [];
  for (const entry of list) {
    const item = toMessageItem(entry);
    if (item) items.push(item);
  }
  return items;
}

function readApproval(payload: Record<string, unknown>): Approval | null {
  const source = asRecord(payload.approval ?? payload);
  const id = String(source.id ?? source.approvalId ?? "");
  if (!id) return null;
  return {
    id,
    title: String(source.title ?? source.toolName ?? source.name ?? ""),
    detail: String(source.summary ?? source.question ?? source.detail ?? source.reason ?? ""),
    revision: typeof source.revision === "number" ? source.revision : undefined,
  };
}

function readDiff(value: unknown): DiffFile[] {
  const record = asRecord(value);
  const files = Array.isArray(record.files) ? record.files : [];
  return files.map((entry) => {
    const file = asRecord(entry);
    return {
      path: String(file.path ?? file.file ?? ""),
      status: String(file.status ?? "modified"),
      additions: Number(file.additions ?? file.added ?? 0),
      deletions: Number(file.deletions ?? file.removed ?? 0),
      patch: String(file.patch ?? file.diff ?? ""),
    };
  });
}

type Props = {
  client: HostClient;
  sessionId: string;
  title: string;
  t: Translate;
  /** False when this phone has no model yet; the composer asks before sending. */
  configured: boolean;
  /** Only a Host with a project workspace can produce a diff. */
  canDiff: boolean;
  /** The model this phone is pinned to, shown where the desktop shows it. */
  modelLabel: string;
  /** Present only when the host can switch models; absent on a remote desktop. */
  onOpenModel?: () => void;
  onRequestSetup: () => void;
  onBack: () => void;
};

/**
 * One conversation, live.
 *
 * The stream carries incremental text (`item.delta` → `deltaText`), so a turn is
 * painted as the model writes it instead of reappearing whole at the end. The
 * transcript is reloaded only when the Host says the client fell behind
 * (`resync.required`), never on every event.
 */
export function ChatView({
  client,
  sessionId,
  title,
  t,
  configured,
  canDiff,
  modelLabel,
  onOpenModel,
  onRequestSetup,
  onBack,
}: Props) {
  const [items, setItems] = useState<MessageItem[] | null>(null);
  const [live, setLive] = useState(false);
  const [turnId, setTurnId] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffFile[] | null>(null);
  /** Text files the reader picked; sent inline with the turn, like the desktop. */
  const [files, setFiles] = useState<{ name: string; text: string }[]>([]);
  const [shownTitle, setShownTitle] = useState(title);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(title);
  const [showDiff, setShowDiff] = useState(false);

  const bottom = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const itemsRef = useRef<MessageItem[] | null>(null);
  itemsRef.current = items;

  const loadHistory = useCallback(async () => {
    try {
      const history = await client.call<unknown>("/v1/sessions/" + encodeURIComponent(sessionId) + "/history");
      const loaded = readHistory(history);
      // The live stream can deliver before this lands. Replacing the list here
      // would erase what the user already watched arrive, so a late history read
      // is merged underneath the live rows instead.
      setItems((current) => mergeHistory(loaded, current));
    } catch (cause) {
      setItems((current) => current ?? []);
      setError(cause instanceof Error ? cause.message : t("error.generic"));
    }
  }, [client, sessionId, t]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    const unsubscribe = client.stream(sessionId, {
      onState: (state) => setLive(state === "open"),
      onEvent: (event) => applyEvent(event),
    });
    return unsubscribe;

    function applyEvent(event: HostEvent) {
      const payload = event.payload ?? {};
      switch (event.kind) {
        case "item.started":
        case "item.completed": {
          const item = toMessageItem(payload);
          if (!item) return;
          setItems((current) => upsert(current, item));
          return;
        }
        case "item.delta": {
          const itemId = String(payload.itemId ?? "");
          const inner = asRecord(payload.event);
          const text = typeof inner.deltaText === "string" ? inner.deltaText : "";
          const thinking = typeof inner.deltaThinking === "string" ? inner.deltaThinking : "";
          if (!itemId || (!text && !thinking)) return;
          setItems((current) => appendDelta(current, itemId, text, thinking));
          return;
        }
        case "turn.started":
        case "turn.queued":
          setTurnId(event.turnId ?? null);
          return;
        case "turn.completed":
        case "turn.interrupted":
        case "turn.failed":
        case "turn.canceled":
          setTurnId(null);
          return;
        case "approval.requested": {
          const approval = readApproval(payload);
          if (approval) setApprovals((current) => (current.some((entry) => entry.id === approval.id) ? current : current.concat([approval])));
          return;
        }
        case "approval.resolved": {
          const approval = readApproval(payload);
          if (approval) setApprovals((current) => current.filter((entry) => entry.id !== approval.id));
          return;
        }
        case "resync.required":
          void loadHistory();
          return;
        default:
          return;
      }
    }
  }, [client, sessionId, loadHistory]);

  useEffect(() => {
    const node = bottom.current;
    // jsdom has no layout, and a browser that has not laid the list out yet has
    // nothing to scroll to; both are fine to skip.
    if (stick.current && node && typeof node.scrollIntoView === "function") {
      node.scrollIntoView({ block: "end" });
    }
  }, [items, approvals]);

  const filePicker = useRef<HTMLInputElement | null>(null);

  const addFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const picked: { name: string; text: string }[] = [];
    for (const file of Array.from(list)) {
      // A binary would arrive as mojibake and poison the turn; refuse it plainly.
      if (file.size > 200_000) {
        setError(t("chat.attachTooBig"));
        continue;
      }
      try {
        picked.push({ name: file.name, text: await file.text() });
      } catch {
        setError(t("chat.attachFailed"));
      }
    }
    if (picked.length > 0) {
      setFiles((current) => current.concat(picked.filter((entry) => !current.some((seen) => seen.name === entry.name))));
    }
    if (filePicker.current) filePicker.current.value = "";
  };

  const applyRename = async () => {
    const next = renameDraft.trim();
    if (!next || !client.renameSession) return;
    try {
      await client.renameSession(sessionId, next);
      setShownTitle(next);
      setRenaming(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("error.generic"));
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    if (!configured) {
      // Keep what was typed: the setup sheet is a detour, not a reset.
      onRequestSetup();
      return;
    }
    setSending(true);
    setError(null);
    setDraft("");
    stick.current = true;
    try {
      await client.call("/v1/sessions/" + encodeURIComponent(sessionId) + "/turns", {
        method: "POST",
        body: {
          input: files.length > 0 ? { text, attachments: files } : { text },
          context: { requestId: "phone_" + Date.now() },
        },
      });
      setFiles([]);
    } catch (cause) {
      setDraft(text);
      setError(cause instanceof Error ? cause.message : t("error.generic"));
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    if (!turnId) return;
    try {
      await client.call("/v1/turns/" + encodeURIComponent(turnId) + ":interrupt", { method: "POST", body: {} });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("error.generic"));
    }
  };

  const respond = async (approval: Approval, decision: "approve" | "deny") => {
    setApprovals((current) => current.filter((entry) => entry.id !== approval.id));
    try {
      await client.call("/v1/approvals/" + encodeURIComponent(approval.id) + ":respond", {
        method: "POST",
        body: {
          approvalId: approval.id,
          decision,
          context: {
            requestId: "phone_" + Date.now(),
            idempotencyKey: "approval:" + approval.id + ":" + decision,
            ...(approval.revision !== undefined ? { expectedRevision: approval.revision } : {}),
          },
        },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("error.generic"));
    }
  };

  const openDiff = async () => {
    setShowDiff(true);
    if (diff) return;
    try {
      const result = await client.call<unknown>("/v1/sessions/" + encodeURIComponent(sessionId) + "/diff");
      setDiff(readDiff(result));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "";
      setDiff([]);
      if (message.includes("project root")) setError(t("diff.noProject"));
      else setError(message || t("error.generic"));
    }
  };

  const rendered = useMemo(() => items ?? [], [items]);

  return (
    <div className="screen chat">
      <header className="bar">
        <button className="ghost back" onClick={onBack}>
          ‹ {t("chat.back")}
        </button>
        {client.renameSession ? (
          <button className="title-button truncate" onClick={() => setRenaming(true)}>
            {shownTitle || t("sessions.untitled")}
          </button>
        ) : (
          <h1 className="truncate">{title || t("sessions.untitled")}</h1>
        )}
        <div className="bar-actions">
          <span className={"dot" + (live ? " live" : "")} title={live ? t("chat.live") : t("chat.offline")} />
          {canDiff ? (
            <button className="ghost" onClick={() => void openDiff()}>
              {t("chat.changes")}
            </button>
          ) : null}
        </div>
      </header>

      <main
        className="transcript"
        onScroll={(event) => {
          const node = event.currentTarget;
          stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        }}
      >
        {items === null ? <p className="muted center">{t("connect.busy")}</p> : null}
        {items !== null && rendered.length === 0 ? <p className="muted center">{t("chat.empty")}</p> : null}
        {rendered
          // A stored system row (and any empty scaffold) has nothing to show; a
          // streaming row has, because the cursor is the message so far.
          .filter((item) => item.text || item.toolName || item.streaming)
          .map((item) => (
            <Bubble key={item.itemId} item={item} t={t} />
          ))}
        {approvals.map((approval) => (
          <div key={approval.id} className="card approval">
            <strong>{approval.title || t("approval.title")}</strong>
            {approval.detail ? <p className="muted">{approval.detail}</p> : null}
            <div className="approval-actions">
              <button className="danger" onClick={() => void respond(approval, "deny")}>
                {t("approval.deny")}
              </button>
              <button className="primary" onClick={() => void respond(approval, "approve")}>
                {t("approval.approve")}
              </button>
            </div>
          </div>
        ))}
        {error ? <p className="error">{error}</p> : null}
        <div ref={bottom} />
      </main>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div className="composer-box">
          {files.length > 0 ? (
            <div className="attachments">
              {files.map((file) => (
                <button
                  key={file.name}
                  type="button"
                  className="attachment"
                  onClick={() => setFiles((current) => current.filter((entry) => entry.name !== file.name))}
                >
                  {file.name} ×
                </button>
              ))}
            </div>
          ) : null}
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t("chat.placeholder")}
            rows={1}
          />
          <div className="composer-tools">
            <button type="button" className="round" aria-label={t("chat.attach")} onClick={() => filePicker.current?.click()}>
              +
            </button>
            <input
              ref={filePicker}
              type="file"
              multiple
              hidden
              accept=".txt,.md,.markdown,.json,.csv,.tsv,.log,.yml,.yaml,.ts,.tsx,.js,.jsx,.py,.sh,.html,.css,.xml,.ini,.toml"
              onChange={(event) => void addFiles(event.target.files)}
            />
            <div className="spacer" />
            <button type="button" className="chip" onClick={onOpenModel ?? onRequestSetup}>
              {modelLabel}
            </button>
            {turnId ? (
              <button type="button" className="round send stop" aria-label={t("chat.stop")} onClick={() => void stop()}>
                ■
              </button>
            ) : (
              <button type="submit" className="round send" aria-label={t("chat.send")} disabled={!draft.trim() || sending}>
                ↑
              </button>
            )}
          </div>
        </div>
      </form>

      {renaming ? (
        <div className="sheet-backdrop" onClick={() => setRenaming(false)}>
          <div className="sheet" onClick={(event) => event.stopPropagation()}>
            <h2>{t("chat.rename")}</h2>
            <input
              value={renameDraft}
              autoFocus
              onChange={(event) => setRenameDraft(event.target.value)}
              placeholder={t("sessions.untitled")}
            />
            <button
              className="primary wide"
              disabled={!renameDraft.trim()}
              onClick={() => void applyRename()}
            >
              {t("chat.renameSave")}
            </button>
            <button className="ghost wide" onClick={() => setRenaming(false)}>
              {t("sessions.cancel")}
            </button>
          </div>
        </div>
      ) : null}

      {showDiff ? (
        <div className="sheet-backdrop" onClick={() => setShowDiff(false)}>
          <div className="sheet tall" onClick={(event) => event.stopPropagation()}>
            <h2>{t("diff.title")}</h2>
            {diff === null ? <p className="muted">{t("connect.busy")}</p> : null}
            {diff !== null && diff.length === 0 ? <p className="muted">{t("diff.empty")}</p> : null}
            {diff?.map((file) => (
              <details key={file.path} className="card file">
                <summary>
                  <span className="row-title">{file.path}</span>
                  <span className="row-meta">
                    {file.status} +{file.additions} −{file.deletions}
                  </span>
                </summary>
                <pre className="diff">
                  {file.patch.split("\n").map((line, index) => (
                    <div
                      key={index}
                      className={
                        line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : ""
                      }
                    >
                      {line}
                    </div>
                  ))}
                </pre>
              </details>
            ))}
            <button className="ghost wide" onClick={() => setShowDiff(false)}>
              {t("diff.close")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * History is the tail of the record; live rows are the head. Merging keeps both
 * when a slow history read lands after the stream has already painted.
 */
function mergeHistory(loaded: MessageItem[], current: MessageItem[] | null): MessageItem[] {
  if (!current || current.length === 0) return loaded;
  const known = new Set(loaded.map((item) => item.itemId));
  const live = current.filter((item) => !known.has(item.itemId));
  return loaded.concat(live);
}

function upsert(current: MessageItem[] | null, item: MessageItem): MessageItem[] {
  const list = current ?? [];
  const index = list.findIndex((entry) => entry.itemId === item.itemId);
  if (index < 0) return list.concat([item]);
  const existing = list[index];
  if (!existing) return list.concat([item]);
  const next = list.slice();
  next[index] = {
    ...existing,
    ...item,
    // A completed item is authoritative, but an empty text on a streaming item
    // must not erase what the deltas already painted.
    text: item.text || existing.text,
    thinking: item.thinking || existing.thinking,
  };
  return next;
}

function appendDelta(
  current: MessageItem[] | null,
  itemId: string,
  text: string,
  thinking: string,
): MessageItem[] {
  const list = current ?? [];
  const index = list.findIndex((entry) => entry.itemId === itemId);
  if (index < 0) {
    return list.concat([
      { itemId, role: "assistant", text, thinking, status: "streaming", streaming: true },
    ]);
  }
  const existing = list[index];
  if (!existing) return list;
  const next = list.slice();
  next[index] = {
    ...existing,
    text: existing.text + text,
    thinking: existing.thinking + thinking,
    streaming: true,
  };
  return next;
}

function Bubble({ item, t }: { item: MessageItem; t: Translate }) {
  const [showThinking, setShowThinking] = useState(false);

  if (item.role === "tool") {
    return (
      <div className={"tool" + (item.toolFailed ? " failed" : "")}>
        <div className="tool-name">
          {item.toolName}
          {item.toolFailed ? <span className="tag">{t("chat.toolFailed")}</span> : null}
        </div>
        {item.toolDetail ? <div className="tool-detail">{item.toolDetail}</div> : null}
      </div>
    );
  }

  const mine = item.role === "user";
  return (
    <div className={"bubble" + (mine ? " mine" : "")}>
      {mine ? null : <div className="bubble-role">{t("chat.agent")}</div>}
      {item.thinking ? (
        <div className="thinking">
          <button className="ghost tiny" onClick={() => setShowThinking(!showThinking)}>
            {showThinking ? "▾ " : "▸ "}
            {t("chat.thinking")}
          </button>
          {showThinking ? <pre className="thinking-body">{item.thinking}</pre> : null}
        </div>
      ) : null}
      {item.text ? <Markdown text={item.text} /> : item.streaming ? <span className="cursor" /> : null}
    </div>
  );
}
