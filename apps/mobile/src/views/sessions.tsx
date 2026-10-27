import { useCallback, useEffect, useState } from "react";
import { type HostClient } from "../lib/racp";
import type { Translate } from "../lib/i18n";

export type SessionSummary = {
  id: string;
  title: string;
  updatedAt?: string;
  projectId?: string;
};

type Project = { id: string; name: string };

function toSessions(value: unknown): SessionSummary[] {
  const list = Array.isArray(value) ? value : [];
  const out: SessionSummary[] = [];
  for (const entry of list) {
    const row = entry as Record<string, unknown>;
    const id = String(row.id ?? row.sessionId ?? "");
    if (!id) continue;
    out.push({
      id,
      title: typeof row.title === "string" && row.title.trim() ? row.title : "",
      ...(typeof row.updatedAt === "string" ? { updatedAt: row.updatedAt } : {}),
      ...(typeof row.projectId === "string" ? { projectId: row.projectId } : {}),
    });
  }
  return out;
}

function toProjects(value: unknown): Project[] {
  const list = Array.isArray(value) ? value : [];
  const out: Project[] = [];
  for (const entry of list) {
    const row = entry as Record<string, unknown>;
    const id = String(row.id ?? row.projectId ?? "");
    if (!id) continue;
    out.push({ id, name: String(row.name ?? row.title ?? row.path ?? id) });
  }
  return out;
}

function relativeTime(iso: string | undefined, lang: string): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return lang === "zh" ? "刚刚" : "just now";
  if (minutes < 60) return lang === "zh" ? minutes + " 分钟前" : minutes + "m ago";
  const hours = Math.round(minutes / 60);
  if (hours < 24) return lang === "zh" ? hours + " 小时前" : hours + "h ago";
  const days = Math.round(hours / 24);
  if (days < 30) return lang === "zh" ? days + " 天前" : days + "d ago";
  return new Date(then).toLocaleDateString();
}

type Props = {
  client: HostClient;
  t: Translate;
  lang: string;
  /** Whether a model is set up; false still lets the list be browsed. */
  configured: boolean;
  onRequestSetup: () => void;
  onOpen: (session: SessionSummary) => void;
  onSignOut: () => void;
};

/**
 * The session list, with the two things a list needs to stay usable: creating a
 * session that can actually touch files, and removing the ones nobody will open
 * again.
 */
export function SessionsView({
  client,
  t,
  lang,
  configured,
  onRequestSetup,
  onOpen,
  onSignOut,
}: Props) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [editing, setEditing] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const listed = await client.call<{ sessions?: unknown } | unknown[]>("/v1/sessions");
      const value = Array.isArray(listed) ? listed : (listed as { sessions?: unknown }).sessions;
      setSessions(toSessions(value));
    } catch (cause) {
      setSessions([]);
      setError(cause instanceof Error ? cause.message : t("error.generic"));
    }
  }, [client, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openChooser = async () => {
    setChoosing(true);
    setError(null);
    try {
      const listed = await client.call<{ projects?: unknown } | unknown[]>("/v1/projects");
      const value = Array.isArray(listed) ? listed : (listed as { projects?: unknown }).projects;
      const found = toProjects(value);
      setProjects(found);
      // A Host with no projects — the agent on this phone — has nothing to pick
      // from, so the sheet would be a door with one handle.
      if (found.length === 0) {
        setChoosing(false);
        await createSession(null);
      }
    } catch {
      setProjects([]);
      setChoosing(false);
      await createSession(null);
    }
  };

  const createSession = async (projectId: string | null) => {
    setChoosing(false);
    setError(null);
    try {
      const created = await client.call<{ session?: { id?: string; title?: string } }>("/v1/sessions", {
        method: "POST",
        body: { mode: "agent", ...(projectId ? { projectId } : {}) },
      });
      const id = created.session?.id;
      if (!id) throw new Error(t("error.generic"));
      onOpen({ id, title: created.session?.title ?? "" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("error.generic"));
    }
  };

  const remove = async (sessionId: string) => {
    if (armed !== sessionId) {
      setArmed(sessionId);
      return;
    }
    setArmed(null);
    try {
      await client.call("/v1/sessions/" + encodeURIComponent(sessionId) + ":delete", {
        method: "POST",
        body: {},
      });
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("error.generic"));
    }
  };

  return (
    <div className="screen sessions">
      <header className="bar">
        <h1>{t("sessions.title")}</h1>
        <div className="bar-actions">
          <button className="ghost" onClick={() => void openChooser()} aria-label={t("sessions.new")}>
            +
          </button>
          <button className="ghost" onClick={() => { setEditing(!editing); setArmed(null); }}>
            {editing ? t("sessions.done") : t("sessions.edit")}
          </button>
        </div>
      </header>

      <main>
        {sessions === null ? <p className="muted center">{t("connect.busy")}</p> : null}
        {sessions?.length === 0 ? (
          <div className="empty">
            <h2>{t("sessions.emptyTitle")}</h2>
            <p>{t("sessions.emptyHint")}</p>
            {configured ? null : (
              <button className="primary" onClick={onRequestSetup}>
                {t("sessions.setup")}
              </button>
            )}
            <button className="ghost wide" onClick={() => void openChooser()}>
              {t("sessions.new")}
            </button>
          </div>
        ) : null}
        {sessions === null ? null : groupSessions(sessions, Date.now()).map((group) => (
          <section key={group.key} className="group">
            <h2 className="group-label">{t(group.labelKey)}</h2>
            {group.items.map((session) => {
              const title = session.title || t("sessions.untitled");
              if (!editing) {
                return (
                  <button key={session.id} className="row" onClick={() => onOpen(session)}>
                    <span className="row-title">{title}</span>
                    <span className="row-meta">{relativeTime(session.updatedAt, lang)}</span>
                  </button>
                );
              }
              return (
                <div key={session.id} className="row editing">
                  <span className="row-title">{title}</span>
                  <button
                    className={"danger" + (armed === session.id ? " armed" : "")}
                    onClick={() => void remove(session.id)}
                  >
                    {armed === session.id ? t("sessions.deleteArmed") : t("sessions.delete")}
                  </button>
                </div>
              );
            })}
          </section>
        ))}
        {error ? <p className="error">{error}</p> : null}
      </main>

      <footer>
        <button className="ghost wide" onClick={onSignOut}>
          {t("sessions.signOut")}
        </button>
      </footer>

      {choosing ? (
        <div className="sheet-backdrop" onClick={() => setChoosing(false)}>
          <div className="sheet" onClick={(event) => event.stopPropagation()}>
            <h2>{t("sessions.project")}</h2>
            {projects.map((project) => (
              <button key={project.id} className="card row" onClick={() => void createSession(project.id)}>
                <span className="row-title">{project.name}</span>
              </button>
            ))}
            <button className="card row" onClick={() => void createSession(null)}>
              <span className="row-title">{t("sessions.noProject")}</span>
              <span className="row-meta">{t("sessions.noProjectHint")}</span>
            </button>
            <button className="ghost wide" onClick={() => setChoosing(false)}>
              {t("sessions.cancel")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}


/**
 * The desktop groups its history into today / yesterday / this week / older,
 * because a flat list stops being scannable the moment it has more than a
 * screenful. Same buckets here, same order, empty buckets dropped.
 */
export function groupSessions(
  sessions: readonly SessionSummary[],
  now: number,
): { key: string; labelKey: "sessions.today" | "sessions.yesterday" | "sessions.week" | "sessions.earlier"; items: SessionSummary[] }[] {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  const day = 86_400_000;

  const buckets = [
    { key: "today", labelKey: "sessions.today" as const, min: today, max: Infinity, items: [] as SessionSummary[] },
    { key: "yesterday", labelKey: "sessions.yesterday" as const, min: today - day, max: today, items: [] as SessionSummary[] },
    { key: "week", labelKey: "sessions.week" as const, min: today - 7 * day, max: today - day, items: [] as SessionSummary[] },
    { key: "earlier", labelKey: "sessions.earlier" as const, min: -Infinity, max: today - 7 * day, items: [] as SessionSummary[] },
  ];

  for (const session of sessions) {
    const stamp = session.updatedAt ? Date.parse(session.updatedAt) : Number.NaN;
    // An undated session still has to land somewhere; "older" is the honest bucket.
    const at = Number.isNaN(stamp) ? -Infinity : stamp;
    const bucket = buckets.find((entry) => at >= entry.min && at < entry.max) ?? buckets[3]!;
    bucket.items.push(session);
  }

  return buckets.filter((bucket) => bucket.items.length > 0);
}
