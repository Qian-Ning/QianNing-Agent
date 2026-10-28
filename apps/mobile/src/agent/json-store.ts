import type { AgentStore, StoredMessage, StoredSession } from "./store";

/**
 * A store whose whole contents are one serialisable object.
 *
 * Two hosts now write agent state: the WebView (localStorage) and the headless
 * runtime (ADR 0338). They cannot share a live API, so they share a shape: this
 * snapshot. The headless run writes it to a file, the app drains that file and
 * merges it in ({@link ./handoff}).
 */
export type StoreSnapshot = {
  version: 1;
  sessions: StoredSession[];
  messages: Record<string, StoredMessage[]>;
  values: Record<string, string>;
};

export function emptySnapshot(): StoreSnapshot {
  return { version: 1, sessions: [], messages: {}, values: {} };
}

export class SnapshotStore implements AgentStore {
  constructor(private readonly state: StoreSnapshot = emptySnapshot()) {}

  snapshot(): StoreSnapshot {
    return {
      version: 1,
      sessions: this.state.sessions.map((session) => ({ ...session })),
      messages: Object.fromEntries(Object.entries(this.state.messages).map(([key, list]) => [key, list.map((m) => ({ ...m }))])),
      values: { ...this.state.values },
    };
  }

  listSessions(): StoredSession[] {
    return [...this.state.sessions].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  readSession(sessionId: string): StoredSession | null {
    return this.state.sessions.find((session) => session.id === sessionId) ?? null;
  }

  writeSession(session: StoredSession): void {
    this.state.sessions = this.state.sessions.filter((entry) => entry.id !== session.id);
    this.state.sessions.push({ ...session });
  }

  deleteSession(sessionId: string): void {
    this.state.sessions = this.state.sessions.filter((entry) => entry.id !== sessionId);
    delete this.state.messages[sessionId];
  }

  readMessages(sessionId: string): StoredMessage[] {
    return this.state.messages[sessionId] ?? [];
  }

  writeMessages(sessionId: string, messages: StoredMessage[]): void {
    this.state.messages[sessionId] = messages.map((message) => ({ ...message }));
  }

  readValue(key: string): string | null {
    return this.state.values[key] ?? null;
  }

  writeValue(key: string, value: string): void {
    this.state.values[key] = value;
  }
}

/** Rejects anything that is not a snapshot this build understands. */
export function parseSnapshot(raw: string): StoreSnapshot | null {
  try {
    const value = JSON.parse(raw) as Partial<StoreSnapshot>;
    if (value.version !== 1 || !Array.isArray(value.sessions)) return null;
    return {
      version: 1,
      sessions: value.sessions,
      messages: typeof value.messages === "object" && value.messages !== null ? value.messages : {},
      values: typeof value.values === "object" && value.values !== null ? value.values : {},
    };
  } catch {
    return null;
  }
}
