/**
 * The RACP client the phone runs on.
 *
 * Everything here talks HTTP/SSE to a Host; nothing knows what the Host's process
 * looks like. That is the whole point of the split: the same client is served by
 * the Host at `/app` and ships inside the Android app, and the only difference
 * between the two is where the base URL comes from.
 */

export type Connection = { base: string; token: string };

const STORAGE_KEY = "qn.connection";

export class RacpClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RacpClientError";
  }
}

/** Accepts `192.168.1.5:4331`, `https://host:4331/`, or a full pairing URL. */
export function normalizeBase(input: string): string {
  let value = input.trim();
  if (!value) return "";
  const hashIndex = value.indexOf("#");
  if (hashIndex >= 0) value = value.slice(0, hashIndex);
  if (!/^https?:\/\//i.test(value)) {
    const host = value.split("/")[0] ?? "";
    const local = /^(localhost|127\.|\[::1\])/.test(host);
    value = (local ? "http://" : "https://") + value;
  }
  return value.replace(/\/+$/, "");
}

/**
 * A pairing link carries the token in the fragment so it never reaches a server
 * log. Reading it here and replacing the URL immediately means a screenshot or a
 * shared history entry cannot leak it afterwards.
 */
export function readPairingLink(): { base: string; token: string } | null {
  if (typeof location === "undefined") return null;
  const hash = location.hash.startsWith("#") ? location.hash.slice(1) : "";
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const token = params.get("t") ?? params.get("token") ?? "";
  if (!token) return null;
  const base = normalizeBase(params.get("base") ?? location.origin);
  history.replaceState(null, "", location.pathname + location.search);
  return { base, token };
}

export function loadConnection(): Connection | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Connection>;
    if (!parsed.base || !parsed.token) return null;
    return { base: normalizeBase(parsed.base), token: parsed.token };
  } catch {
    return null;
  }
}

export function saveConnection(connection: Connection): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(connection));
}

export function clearConnection(): void {
  localStorage.removeItem(STORAGE_KEY);
}

type RequestBody = Record<string, unknown>;

/** One event as the Host frames it: a JSON-RPC notification carrying a payload. */
export type HostEvent = {
  sessionId: string;
  turnId?: string;
  kind: string;
  payload?: Record<string, unknown>;
  revision?: number;
};

export type MessageItem = {
  itemId: string;
  role: string;
  text: string;
  thinking: string;
  status: string;
  createdAt?: string;
  toolName?: string;
  toolDetail?: string;
  toolFailed?: boolean;
  streaming?: boolean;
};

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") parts.push(block);
      else if (block && typeof block === "object") {
        const record = block as Record<string, unknown>;
        if (typeof record.text === "string") parts.push(record.text);
        else if (typeof record.content === "string") parts.push(record.content);
      }
    }
    return parts.join("");
  }
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (record.content !== undefined) return textOfContent(record.content);
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * Turns whatever the Host handed us into one renderable row.
 *
 * A tool call keeps its row even when nothing readable came back: a step the user
 * cannot see is still a step that happened.
 */
export function toMessageItem(raw: unknown): MessageItem | null {
  const item = asRecord(raw);
  const itemId = String(item.itemId ?? item.id ?? "");
  if (!itemId) return null;
  const itemType = String(item.itemType ?? item.type ?? "message");
  const event = asRecord(item.event);
  // Two shapes reach this function: a live frame carries the message under
  // `event.message`, while a stored history row wraps it in `content`.
  const nested = asRecord(event.message ?? item.message ?? item.content);
  const message = Object.keys(nested).length > 0 ? nested : item;
  const role = String(message.role ?? (itemType === "tool" ? "tool" : "assistant"));

  if (itemType === "tool" || role === "tool") {
    const tool = asRecord(item.tool ?? message.tool ?? item);
    const name = String(tool.toolName ?? tool.name ?? item.toolName ?? item.name ?? "tool");
    const input = tool.input ?? tool.arguments ?? item.input ?? "";
    const output = tool.output ?? tool.result ?? item.output ?? "";
    const detail = [stringifyDetail(input), stringifyDetail(output)].filter(Boolean).join(" → ");
    const status = String(item.status ?? tool.status ?? "");
    return {
      itemId,
      role: "tool",
      text: "",
      thinking: "",
      status,
      toolName: name,
      toolDetail: detail,
      toolFailed: status === "failed" || status === "error",
      createdAt: typeof item.createdAt === "string" ? item.createdAt : undefined,
    };
  }

  return {
    itemId,
    role,
    text: textOfContent(message.content ?? item.content),
    thinking: typeof message.thinking === "string" ? message.thinking : "",
    status: String(message.status ?? item.status ?? "complete"),
    createdAt: typeof message.createdAt === "string" ? message.createdAt : undefined,
  };
}

function stringifyDetail(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return value.length > 400 ? value.slice(0, 400) + "…" : value;
  try {
    const text = JSON.stringify(value);
    return text.length > 400 ? text.slice(0, 400) + "…" : text;
  } catch {
    return String(value);
  }
}

export class RacpClient {
  constructor(readonly connection: Connection) {}

  private url(path: string): string {
    return this.connection.base + path;
  }

  private headers(): Record<string, string> {
    return {
      authorization: "Bearer " + this.connection.token,
      "content-type": "application/json",
    };
  }

  async call<T>(path: string, init: { method?: string; body?: RequestBody } = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.url(path), {
        method: init.method ?? "GET",
        headers: this.headers(),
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch (cause) {
      throw new RacpClientError("UNREACHABLE", "the Host did not answer");
    }
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    const envelope = asRecord(parsed);
    if (!response.ok) {
      const code = typeof envelope.error === "string" ? envelope.error : "HTTP_" + response.status;
      const message = typeof envelope.message === "string" ? envelope.message : text.slice(0, 200);
      throw new RacpClientError(code, message || "request failed");
    }
    return ("result" in envelope ? envelope.result : parsed) as T;
  }

  /**
   * Subscribes to one session's event stream.
   *
   * `EventSource` is not used because the token has to travel in an Authorization
   * header, which `EventSource` cannot send.
   */
  stream(
    sessionId: string,
    handlers: { onEvent: (event: HostEvent) => void; onState: (state: "open" | "closed") => void },
  ): () => void {
    const controller = new AbortController();
    let closed = false;

    const run = async () => {
      try {
        const response = await fetch(this.url("/v1/sessions/" + encodeURIComponent(sessionId) + "/events"), {
          headers: { authorization: "Bearer " + this.connection.token, accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error("stream refused");
        handlers.onState("open");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const line = frame.split("\n").find((entry) => entry.startsWith("data:"));
            if (!line) continue;
            let parsed: unknown;
            try {
              parsed = JSON.parse(line.slice(5).trim());
            } catch {
              continue;
            }
            const envelope = asRecord(parsed);
            if (envelope.method !== "session/event") continue;
            const params = asRecord(envelope.params);
            if (typeof params.kind !== "string") continue;
            handlers.onEvent({
              sessionId: String(params.sessionId ?? sessionId),
              turnId: typeof params.turnId === "string" ? params.turnId : undefined,
              kind: params.kind,
              payload: asRecord(params.payload),
              revision: typeof params.revision === "number" ? params.revision : undefined,
            });
          }
        }
      } catch {
        /* aborted or unreachable; the caller decides what to show */
      } finally {
        if (!closed) handlers.onState("closed");
      }
    };

    void run();

    return () => {
      closed = true;
      controller.abort();
    };
  }
}
