/**
 * Where the phone keeps its own agent state.
 *
 * Local storage today, behind an interface. The data is a session list, a
 * transcript per session, and a small key/value area for the agent's notes — a
 * few hundred kilobytes in normal use. Swapping in IndexedDB or SQLite later
 * changes this file and nothing above it.
 */

export type StoredMessage = {
  itemId: string;
  role: string;
  text: string;
  thinking?: string;
  status: string;
  createdAt: string;
  toolName?: string;
  toolDetail?: string;
  toolFailed?: boolean;
  /**
   * Which provider and model produced this message. Usage statistics group by
   * them, and a transcript that cannot say which model wrote it cannot report
   * anything but a single anonymous bucket.
   */
  providerId?: string;
  modelId?: string;
  /** Token accounting for this message, as the shared context ring reads it. */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    totalTokens: number;
    cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
};

export type StoredSession = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Per-conversation instructions, appended to the phone's own prompt. The
   * desktop keeps the same field on a session, so the same dialog works on
   * both surfaces.
   */
  systemPrompt?: string;
  /** Phone project folder the conversation belongs to, when it belongs to one. */
  projectPath?: string;
};

export interface AgentStore {
  listSessions(): StoredSession[];
  readSession(sessionId: string): StoredSession | null;
  writeSession(session: StoredSession): void;
  deleteSession(sessionId: string): void;
  readMessages(sessionId: string): StoredMessage[];
  writeMessages(sessionId: string, messages: StoredMessage[]): void;
  readValue(key: string): string | null;
  writeValue(key: string, value: string): void;
}

const SESSIONS_KEY = "qn.agent.sessions";
const VALUES_KEY = "qn.agent.values";
const MESSAGES_PREFIX = "qn.agent.messages.";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

export class BrowserStore implements AgentStore {
  listSessions(): StoredSession[] {
    return readJson<StoredSession[]>(SESSIONS_KEY, []).sort((a, b) =>
      a.updatedAt < b.updatedAt ? 1 : -1,
    );
  }

  readSession(sessionId: string): StoredSession | null {
    return this.listSessions().find((session) => session.id === sessionId) ?? null;
  }

  writeSession(session: StoredSession): void {
    const sessions = readJson<StoredSession[]>(SESSIONS_KEY, []).filter(
      (entry) => entry.id !== session.id,
    );
    sessions.push(session);
    writeJson(SESSIONS_KEY, sessions);
  }

  deleteSession(sessionId: string): void {
    writeJson(
      SESSIONS_KEY,
      readJson<StoredSession[]>(SESSIONS_KEY, []).filter((entry) => entry.id !== sessionId),
    );
    localStorage.removeItem(MESSAGES_PREFIX + sessionId);
  }

  readMessages(sessionId: string): StoredMessage[] {
    return readJson<StoredMessage[]>(MESSAGES_PREFIX + sessionId, []);
  }

  writeMessages(sessionId: string, messages: StoredMessage[]): void {
    writeJson(MESSAGES_PREFIX + sessionId, messages);
  }

  readValue(key: string): string | null {
    const values = readJson<Record<string, string>>(VALUES_KEY, {});
    return values[key] ?? null;
  }

  writeValue(key: string, value: string): void {
    const values = readJson<Record<string, string>>(VALUES_KEY, {});
    values[key] = value;
    writeJson(VALUES_KEY, values);
  }
}

/** The tests' store: same contract, no globals, no persistence. */
export class MemoryStore implements AgentStore {
  private sessions = new Map<string, StoredSession>();
  private messages = new Map<string, StoredMessage[]>();
  private values = new Map<string, string>();

  listSessions(): StoredSession[] {
    return [...this.sessions.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  readSession(sessionId: string): StoredSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  writeSession(session: StoredSession): void {
    this.sessions.set(session.id, session);
  }

  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.messages.delete(sessionId);
  }

  readMessages(sessionId: string): StoredMessage[] {
    return this.messages.get(sessionId) ?? [];
  }

  writeMessages(sessionId: string, messages: StoredMessage[]): void {
    this.messages.set(sessionId, messages);
  }

  readValue(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  writeValue(key: string, value: string): void {
    this.values.set(key, value);
  }
}
