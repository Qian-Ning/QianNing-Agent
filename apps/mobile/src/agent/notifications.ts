/**
 * The phone's notification centre.
 *
 * A record of things that finished while the reader was elsewhere: a turn that
 * completed in another conversation, a scheduled task that ran. It is a log,
 * not a to-do list — entries are read and cleared, never acted on from here.
 *
 * Kept in localStorage beside the rest of the client state: the list is small,
 * has no schema to migrate, and losing it costs nothing.
 */

import { appStorage } from "../lib/app-storage";
import { clearSystemNotice, postSystemNotice } from "./system-notices";

export type Notice = {
  id: string;
  /** The conversation this belongs to, when there is one. */
  sessionId: string | null;
  title: string;
  body: string;
  at: number;
  read: boolean;
};

const KEY = "qn.notices";
const LIMIT = 50;

let cache: Notice[] | null = null;
const listeners = new Set<() => void>();

function isNotice(value: unknown): value is Notice {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.title === "string" &&
    typeof entry.body === "string" &&
    typeof entry.at === "number" &&
    typeof entry.read === "boolean" &&
    (entry.sessionId === null || typeof entry.sessionId === "string")
  );
}

function read(): Notice[] {
  if (cache) return cache;
  try {
    const raw = appStorage().get(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    cache = Array.isArray(parsed) ? parsed.filter(isNotice) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(next: Notice[]): void {
  cache = next;
  try {
    appStorage().set(KEY, JSON.stringify(next));
  } catch {
    // Storage full or unavailable: the in-memory list still works this session.
  }
  listeners.forEach((fn) => fn());
}

export function loadNotices(): Notice[] {
  return read();
}

export function unreadCount(notices: Notice[] = read()): number {
  return notices.reduce((total, notice) => (notice.read ? total : total + 1), 0);
}

export function pushNotice(input: {
  title: string;
  body?: string;
  sessionId?: string | null;
  at?: number;
}): Notice {
  const notice: Notice = {
    id: "notice_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    sessionId: input.sessionId ?? null,
    title: input.title,
    body: input.body ?? "",
    at: input.at ?? Date.now(),
    read: false,
  };
  write([notice, ...read()].slice(0, LIMIT));
  // A copy in the system tray is what reaches the reader when the app is not
  // on screen; the centre above stays the record either way.
  void postSystemNotice(notice);
  return notice;
}

/** Marks one entry read; used when the reader opens its conversation. */
export function markRead(id: string): void {
  void clearSystemNotice(id);
  const current = read();
  let changed = false;
  const next = current.map((notice) => {
    if (notice.id !== id || notice.read) return notice;
    changed = true;
    return { ...notice, read: true };
  });
  if (changed) write(next);
}

export function markAllRead(): void {
  const current = read();
  if (!current.some((notice) => !notice.read)) return;
  write(current.map((notice) => (notice.read ? notice : { ...notice, read: true })));
}

export function clearNotices(): void {
  write([]);
}

export function subscribeNotices(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Test seam: forget the cache so a fresh localStorage is re-read. */
export function resetNoticesForTests(): void {
  cache = null;
  listeners.clear();
}
