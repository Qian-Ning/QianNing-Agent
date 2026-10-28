import type { AgentStore, StoredMessage, StoredSession } from "./store";

/**
 * Bringing a headless run home.
 *
 * The headless host (ADR 0338) writes into its own store file while the app is
 * closed. On the next launch the app drains that file and folds it into its own
 * store, then deletes it. This module is the folding — pure, so the ordering
 * rules can be tested without a device.
 *
 * Rules, all chosen to make a merge idempotent:
 * - sessions: newer `updatedAt` wins, so a rename in the app is not undone by a
 *   stale copy from the headless run;
 * - messages: appended by `itemId`, existing order kept, duplicates dropped —
 *   re-running the same drain twice changes nothing;
 * - values: the drained side only fills gaps, because the app is the interactive
 *   writer and its value is the one the reader just saw.
 */
export type Drained = {
  sessions: StoredSession[];
  messages: Record<string, StoredMessage[]>;
  values?: Record<string, string>;
};

export type MergeReport = {
  sessionsAdded: number;
  sessionsUpdated: number;
  messagesAdded: number;
};

export function mergeHeadlessResults(store: AgentStore, drained: Drained): MergeReport {
  const report: MergeReport = { sessionsAdded: 0, sessionsUpdated: 0, messagesAdded: 0 };

  for (const incoming of drained.sessions) {
    const existing = store.readSession(incoming.id);
    if (!existing) {
      store.writeSession(incoming);
      report.sessionsAdded += 1;
    } else if (incoming.updatedAt > existing.updatedAt) {
      store.writeSession({ ...incoming, title: existing.title.trim() ? existing.title : incoming.title });
      report.sessionsUpdated += 1;
    }
  }

  for (const [sessionId, incoming] of Object.entries(drained.messages)) {
    if (!incoming?.length) continue;
    const current = store.readMessages(sessionId);
    const known = new Set(current.map((message) => message.itemId));
    const fresh = incoming.filter((message) => !known.has(message.itemId));
    if (!fresh.length) continue;
    store.writeMessages(sessionId, [...current, ...fresh]);
    report.messagesAdded += fresh.length;
  }

  for (const [key, value] of Object.entries(drained.values ?? {})) {
    if (store.readValue(key) === null) store.writeValue(key, value);
  }

  return report;
}

/** Drops sessions the app no longer has, so a deleted chat cannot come back. */
export function pruneForeignSessions(store: AgentStore, drained: Drained): Drained {
  const known = new Set(store.listSessions().map((session) => session.id));
  return {
    sessions: drained.sessions.filter((session) => known.has(session.id)),
    messages: Object.fromEntries(
      Object.entries(drained.messages).filter(([sessionId]) => known.has(sessionId)),
    ),
    values: drained.values,
  };
}
