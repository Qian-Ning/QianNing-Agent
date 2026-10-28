import { useEffect, useState } from "react";
import type { Translate } from "../lib/i18n";
import {
  clearNotices,
  loadNotices,
  markAllRead,
  markRead,
  subscribeNotices,
  unreadCount,
  type Notice,
} from "../agent/notifications";

type Props = {
  t: Translate;
  /** Opens the conversation a notice belongs to; absent when no host is up. */
  onOpenSession?: (sessionId: string) => void;
};

/**
 * The log of things that finished while the reader was elsewhere.
 *
 * An entry that knows its conversation is a row you can open — that is the only
 * reason to keep the session id at all. Entries without one stay plain records
 * rather than looking tappable and doing nothing.
 */
export function NotificationsPage({ t, onOpenSession }: Props) {
  const [notices, setNotices] = useState<Notice[]>(() => loadNotices());

  useEffect(() => {
    const refresh = () => setNotices(loadNotices());
    refresh();
    return subscribeNotices(refresh);
  }, []);

  const unread = unreadCount(notices);

  const open = (notice: Notice) => {
    if (!notice.sessionId || !onOpenSession) return;
    markRead(notice.id);
    onOpenSession(notice.sessionId);
  };

  return (
    <>
      <div className="settings-actions">
        <button className="ghost" onClick={() => markAllRead()} disabled={unread === 0}>
          {t("settings.notifications.markRead")}
        </button>
        <button className="ghost" onClick={() => clearNotices()} disabled={notices.length === 0}>
          {t("settings.notifications.clear")}
        </button>
      </div>
      {notices.length === 0 ? (
        <p className="empty-note">{t("settings.notifications.empty")}</p>
      ) : (
        <div className="settings-list notice-list">
          {notices.map((notice) =>
            notice.sessionId && onOpenSession ? (
              <button
                key={notice.id}
                type="button"
                className={notice.read ? "notice openable" : "notice openable unread"}
                onClick={() => open(notice)}
              >
                <NoticeBody notice={notice} />
              </button>
            ) : (
              <article key={notice.id} className={notice.read ? "notice" : "notice unread"}>
                <NoticeBody notice={notice} />
              </article>
            ),
          )}
        </div>
      )}
    </>
  );
}

function NoticeBody({ notice }: { notice: Notice }) {
  return (
    <>
      <span className="notice-head">
        <span className="row-title">{notice.title}</span>
        <span className="row-meta">{formatTime(notice.at)}</span>
      </span>
      {notice.body ? <span className="notice-body">{notice.body}</span> : null}
    </>
  );
}

function formatTime(at: number): string {
  const date = new Date(at);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "numeric", day: "numeric" }) +
        " " +
        date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
