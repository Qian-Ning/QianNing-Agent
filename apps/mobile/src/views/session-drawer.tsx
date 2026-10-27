import { useEffect, useState } from "react";
import type { HostClient } from "../lib/racp";
import type { Translate } from "../lib/i18n";
import { groupSessions, type SessionSummary } from "./sessions";

type Props = {
  client: HostClient;
  t: Translate;
  lang: string;
  currentId?: string;
  onSelect: (session: { id: string; title: string }) => void;
  onNew: () => void;
  onSettings: () => void;
  onClose: () => void;
};

function toSessions(value: unknown): SessionSummary[] {
  const list = Array.isArray(value) ? value : [];
  const out: SessionSummary[] = [];
  for (const entry of list) {
    const row = entry as Record<string, unknown>;
    const id = String(row.id ?? row.sessionId ?? "");
    if (!id) continue;
    out.push({
      id,
      title: typeof row.title === "string" ? row.title : "",
      ...(typeof row.updatedAt === "string" ? { updatedAt: row.updatedAt } : {}),
    });
  }
  return out;
}

/**
 * The desktop keeps its history in a permanent left column. A phone cannot
 * afford the width, so the same column arrives as a drawer: same order, same
 * grouping, same row shape — one tap away instead of always visible.
 */
export function SessionDrawer({
  client,
  t,
  currentId,
  onSelect,
  onNew,
  onSettings,
  onClose,
}: Props) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const listed = await client.call<{ sessions?: unknown } | unknown[]>("/v1/sessions");
        const value = Array.isArray(listed) ? listed : (listed as { sessions?: unknown }).sessions;
        if (live) setSessions(toSessions(value));
      } catch {
        if (live) setSessions([]);
      }
    })();
    return () => {
      live = false;
    };
  }, [client]);

  const needle = query.trim().toLowerCase();
  const visible = (sessions ?? []).filter((session) =>
    needle ? session.title.toLowerCase().includes(needle) : true,
  );

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(event) => event.stopPropagation()}>
        <header className="drawer-bar">
          <h1>{t("app.name")}</h1>
          <button className="ghost" aria-label={t("settings.title")} onClick={onSettings}>
            ⚙
          </button>
        </header>

        <input
          className="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("sessions.search")}
        />

        <div className="drawer-list">
          {sessions === null ? <p className="muted">{t("connect.busy")}</p> : null}
          {sessions !== null && visible.length === 0 ? (
            <p className="muted">{t("sessions.emptyTitle")}</p>
          ) : null}
          {groupSessions(visible, Date.now()).map((group) => (
            <section key={group.key} className="group">
              <h2 className="group-label">{t(group.labelKey)}</h2>
              {group.items.map((session) => (
                <button
                  key={session.id}
                  className={"row" + (session.id === currentId ? " current" : "")}
                  onClick={() => onSelect({ id: session.id, title: session.title })}
                >
                  <span className="row-title">{session.title || t("sessions.untitled")}</span>
                </button>
              ))}
            </section>
          ))}
        </div>

        <footer className="drawer-foot">
          <button
            className="primary wide"
            onClick={() => {
              onNew();
              onClose();
            }}
          >
            {t("sessions.new")}
          </button>
        </footer>
      </aside>
    </div>
  );
}
