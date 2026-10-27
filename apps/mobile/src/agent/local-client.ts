/**
 * The local Host, spoken through the same surface the remote one speaks.
 *
 * The screens do not know whether the agent is on the phone or on a desktop:
 * they call RACP paths, and this class answers them from `LocalAgentHost`. That
 * is deliberate — "the phone is a Host" is only true if the phone's Host is
 * indistinguishable from the one across the network.
 */

import type { HostEvent, RequestBody } from "../lib/racp";
import { RacpClientError } from "../lib/racp";
import type { LocalAgentHost } from "./host";

type Handlers = {
  onEvent: (event: HostEvent) => void;
  onState: (state: "open" | "closed") => void;
};

const HISTORY_PAGE = 200;

export class LocalClient {
  /** turnId → sessionId, so the interrupt path resolves like it does remotely. */
  private readonly turns = new Map<string, string>();

  constructor(private readonly host: LocalAgentHost) {}

  async call<T>(path: string, init: { method?: string; body?: RequestBody } = {}): Promise<T> {
    const [route, query] = splitQuery(path);
    const method = init.method ?? "GET";

    if (route === "/v1/projects") return { projects: [] } as T;

    if (route === "/v1/sessions" && method === "POST") {
      const body = (init.body ?? {}) as { title?: string };
      const session = this.host.createSession(typeof body.title === "string" ? body.title : "");
      return { session: { id: session.id, title: session.title } } as T;
    }

    if (route === "/v1/sessions" && method === "GET") {
      const limit = Number(query.get("limit") ?? "0");
      const sessions = this.host.listSessions();
      return {
        sessions: (limit > 0 ? sessions.slice(0, limit) : sessions).map((session) => ({
          id: session.id,
          title: session.title,
          updatedAt: session.updatedAt,
        })),
      } as T;
    }

    const sessionMatch = /^\/v1\/sessions\/([^/]+)$/.exec(route);
    if (sessionMatch && method === "POST" && /:delete$/.test(route)) {
      this.host.deleteSession(decodeURIComponent(sessionMatch[1] as string).replace(/:delete$/, ""));
      return { ok: true } as T;
    }

    const historyMatch = /^\/v1\/sessions\/([^/]+)\/history$/.exec(route);
    if (historyMatch) {
      const sessionId = decodeURIComponent(historyMatch[1] as string);
      const rows = this.host.history(sessionId).slice(-HISTORY_PAGE);
      return rows.map(toHistoryRow) as T;
    }

    const turnsMatch = /^\/v1\/sessions\/([^/]+)\/turns$/.exec(route);
    if (turnsMatch && method === "POST") {
      const sessionId = decodeURIComponent(turnsMatch[1] as string);
      const body = (init.body ?? {}) as { input?: { text?: string } };
      const text = body.input?.text ?? "";
      if (!text.trim()) throw new RacpClientError("INVALID_REQUEST", "a turn needs input text");
      const turnId = "t_" + Date.now().toString(36);
      this.turns.set(turnId, sessionId);
      // The turn runs to completion before this resolves, which keeps the
      // composer's "sending" state honest; events stream while it runs.
      await this.host.send(sessionId, text);
      return { turn: { id: turnId } } as T;
    }

    const interruptMatch = /^\/v1\/turns\/([^/:]+):interrupt$/.exec(route);
    if (interruptMatch) {
      const turnId = decodeURIComponent(interruptMatch[1] as string);
      const sessionId = this.turns.get(turnId);
      if (sessionId) this.host.interrupt(sessionId);
      return { ok: true } as T;
    }

    const diffMatch = /^\/v1\/sessions\/([^/]+)\/diff$/.exec(route);
    if (diffMatch) {
      throw new RacpClientError(
        "CAPABILITY_UNAVAILABLE",
        "this agent has no project workspace, so there is no diff to show",
      );
    }

    const eventsMatch = /^\/v1\/sessions\/([^/]+)\/events$/.exec(route);
    if (eventsMatch) {
      throw new RacpClientError(
        "NOT_SUPPORTED",
        "the local Host pushes events through stream(), not a request",
      );
    }

    throw new RacpClientError("METHOD_NOT_FOUND", "the local Host does not serve " + path);
  }

  stream(sessionId: string, handlers: Handlers): () => void {
    let open = true;
    queueMicrotask(() => {
      if (open) handlers.onState("open");
    });
    const unsubscribe = this.host.subscribe(sessionId, (event) => handlers.onEvent(event));
    return () => {
      open = false;
      unsubscribe();
      handlers.onState("closed");
    };
  }
}

function splitQuery(path: string): [string, URLSearchParams] {
  const index = path.indexOf("?");
  if (index < 0) return [path, new URLSearchParams()];
  return [path.slice(0, index), new URLSearchParams(path.slice(index + 1))];
}

/**
 * History rows use the same shape the wire uses, so `toMessageItem` has one
 * parser instead of two.
 */
function toHistoryRow(entry: {
  itemId: string;
  role: string;
  text: string;
  status: string;
  createdAt: string;
  toolName?: string;
  toolDetail?: string;
  toolFailed?: boolean;
}): Record<string, unknown> {
  if (entry.role === "tool") {
    return {
      itemId: entry.itemId,
      itemType: "tool",
      status: entry.status,
      createdAt: entry.createdAt,
      tool: { name: entry.toolName ?? "tool", input: entry.toolDetail ?? "", output: entry.text },
    };
  }
  return {
    itemId: entry.itemId,
    itemType: "message",
    status: entry.status,
    createdAt: entry.createdAt,
    event: {
      message: {
        id: entry.itemId,
        role: entry.role,
        content: [{ type: "text", text: entry.text }],
        status: entry.status,
      },
    },
  };
}
