import { useEffect, useState } from "react";
import type { Translate } from "../lib/i18n";
import { clearNotices, loadNotices, markAllRead, subscribeNotices, unreadCount, type Notice } from "../agent/notifications";

/**
 * The log of things that finished while the reader was elsewhere. Rows are
 * plain records, not buttons: there is nothing to press on a notification the
 * phone cannot deep-link into yet, and a dead tap is worse than a text row.
 */
export function NotificationsPage({ t }: { t: Translate }) {
  const [notices, setNotices] = useState<Notice[]>(() => loadNotices());

  useEffect(() => {
    const refresh = () => setNotices(loadNotices());
    refresh();
    return subscribeNotices(refresh);
  }, []);

  const unread = unreadCount(notices);

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
          {notices.map((notice) => (
            <article key={notice.id} className={notice.read ? "notice" : "notice unread"}>
              <div className="notice-head">
                <span className="row-title">{notice.title}</span>
                <span className="row-meta">{formatTime(notice.at)}</span>
              </div>
              {notice.body ? <p className="notice-body">{notice.body}</p> : null}
            </article>
          ))}
        </div>
      )}
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
