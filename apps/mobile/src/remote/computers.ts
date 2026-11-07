/**
 * Paired computers, as the phone sees them.
 *
 * The desktop's remote listener speaks RACP over HTTPS and serves its own
 * self-signed certificate at `/cert` before any credential exists. Pairing is
 * therefore: fetch that certificate once, keep it, and from then on trust
 * exactly that certificate for exactly that address. Nothing else on the
 * network is accepted, and no plaintext fallback exists.
 */

import { REMOTE_UNREACHABLE } from "@pi-desktop/shared";

export type PairedComputer = {
  /** Stable key: the address the user paired. */
  key: string;
  label: string;
  /** Origin only, e.g. `https://192.168.1.8:7317`. */
  url: string;
  /** The certificate to pin, PEM. */
  pem: string;
  /** SHA-256 shown in the UI so the two screens can be compared. */
  fingerprint: string;
  /** Device token the desktop issued for this phone. */
  token: string;
  addedAt: number;
};

export type RemoteSession = {
  id: string;
  title: string;
  updatedAt?: number;
  messageCount?: number;
};

const KEY = "qn.remote.computers";

type QnRemotePlugin = {
  fetchCertificate(options: { url: string }): Promise<{ pem: string; fingerprint: string }>;
  request(options: {
    url: string;
    method: string;
    path: string;
    token: string;
    pem: string;
    body?: string;
  }): Promise<{ status: number; body: string }>;
};

function plugin(): QnRemotePlugin | null {
  const capacitor = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } })
    .Capacitor;
  const found = capacitor?.Plugins?.QnRemote;
  return (found as QnRemotePlugin | undefined) ?? null;
}

export function hasRemoteHost(): boolean {
  return plugin() !== null;
}

/** Accept what a user types: `192.168.1.8:7317`, `https://…`, or a pasted URL. */
export function normalizeAddress(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("address is empty");
  const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withScheme);
  if (url.protocol !== "https:") {
    throw new Error("a paired computer is reached over https://");
  }
  if (!url.port) throw new Error("the address needs the port the desktop shows");
  return `${url.protocol}//${url.host}`;
}

/** Opens the camera and returns the code it read; null when the user backs out. */
export async function scanPairingCode(): Promise<string | null> {
  const plugins = (globalThis as { window?: { Capacitor?: { Plugins?: Record<string, unknown> } } })
    .window?.Capacitor?.Plugins;
  const scanner = plugins?.QrScan as { scan?: () => Promise<{ text?: string }> } | undefined;
  if (!scanner?.scan) throw new Error("this build cannot scan a code");
  try {
    const result = await scanner.scan();
    return result?.text ?? null;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // Backing out of the camera is not a failure; a refused permission is.
    if (/cancel/i.test(message)) return null;
    if (/camera-denied/i.test(message)) throw new Error("camera-denied");
    throw cause instanceof Error ? cause : new Error(message);
  }
}

function read(): PairedComputer[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is PairedComputer => {
      if (!entry || typeof entry !== "object") return false;
      const row = entry as Partial<PairedComputer>;
      return (
        typeof row.key === "string" &&
        typeof row.url === "string" &&
        typeof row.pem === "string" &&
        typeof row.token === "string"
      );
    });
  } catch {
    return [];
  }
}

function write(computers: PairedComputer[]): void {
  localStorage.setItem(KEY, JSON.stringify(computers));
}

export function listComputers(): PairedComputer[] {
  return read().sort((a, b) => b.addedAt - a.addedAt);
}

export function removeComputer(key: string): boolean {
  const computers = read();
  const remaining = computers.filter((entry) => entry.key !== key);
  if (remaining.length === computers.length) return false;
  write(remaining);
  return true;
}

/**
 * Fetch the desktop's certificate and keep it. The token is not checked here —
 * the first authenticated call proves it, and a bad token then reads as a 401
 * on the computer's row instead of a pairing that cannot be undone.
 */
export async function pairComputer(input: {
  url: string;
  token: string;
  label?: string;
}): Promise<PairedComputer> {
  const bridge = plugin();
  if (!bridge) throw new Error("this build cannot reach a computer");
  const url = normalizeAddress(input.url);
  const token = input.token.trim();
  if (!token) throw new Error("paste the device token the desktop issued");
  const certificate = await bridge.fetchCertificate({ url });
  const computer: PairedComputer = {
    key: url,
    label: input.label?.trim() || new URL(url).hostname,
    url,
    pem: certificate.pem,
    fingerprint: certificate.fingerprint,
    token,
    addedAt: Date.now(),
  };
  write([...read().filter((entry) => entry.key !== url), computer]);
  return computer;
}

/**
 * Why the phone could not reach a paired computer, when the cause was the wire.
 *
 * The native side hands back the platform's own sentence — "failed to connect
 * to /192.168.10.104 (port 6838) from /192.168.10.71 (port 47018) after 15000ms"
 * — which names addresses and nothing a person can act on. A shared code lets
 * the screen say what to check instead.
 */
function isWireFailure(message: string): boolean {
  return (
    /failed to connect/i.test(message) ||
    /timed? ?out/i.test(message) ||
    /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i.test(message)
  );
}

async function call(
  computer: PairedComputer,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const bridge = plugin();
  if (!bridge) throw new Error("this build cannot reach a computer");
  let answer: Awaited<ReturnType<QnRemotePlugin["request"]>>;
  try {
    answer = await bridge.request({
      url: computer.url,
      method,
      path,
      token: computer.token,
      pem: computer.pem,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(isWireFailure(message) ? REMOTE_UNREACHABLE : message);
  }
  let parsed: unknown = null;
  try {
    parsed = answer.body ? JSON.parse(answer.body) : null;
  } catch {
    parsed = null;
  }
  if (answer.status === 401) throw new Error("the desktop refused that device token");
  if (answer.status === 403) throw new Error("that device token is not allowed to do this");
  if (answer.status >= 400) {
    const message = (parsed as { message?: string } | null)?.message;
    throw new Error(message ?? `the desktop answered ${answer.status}`);
  }
  return (parsed as { result?: unknown } | null)?.result ?? null;
}

function asSessions(value: unknown): RemoteSession[] {
  const list = Array.isArray(value)
    ? value
    : ((value as { sessions?: unknown; items?: unknown } | null)?.sessions ??
      (value as { items?: unknown } | null)?.items);
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => {
      const row = entry as { id?: unknown; title?: unknown; updatedAt?: unknown; messageCount?: unknown };
      if (typeof row?.id !== "string") return null;
      // The desktop reports `updatedAt` as an ISO string on newer hosts and as
      // epoch milliseconds on older ones; both sort and render the same after
      // this normalisation.
      const updated =
        typeof row.updatedAt === "number"
          ? row.updatedAt
          : typeof row.updatedAt === "string"
            ? Date.parse(row.updatedAt)
            : Number.NaN;
      return {
        id: row.id,
        title: typeof row.title === "string" && row.title ? row.title : "未命名会话",
        ...(Number.isFinite(updated) ? { updatedAt: updated } : {}),
        ...(typeof row.messageCount === "number" ? { messageCount: row.messageCount } : {}),
      };
    })
    .filter((entry): entry is RemoteSession => entry !== null);
}

/** The computer's conversations, newest first — proof the link is live. */
export async function fetchSessions(computer: PairedComputer): Promise<RemoteSession[]> {
  const result = await call(computer, "GET", "/v1/sessions");
  return asSessions(result).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/** One line of a conversation, reduced to what a phone screen can show. */
export type RemoteMessage = {
  id: string;
  role: "user" | "assistant" | "tool" | "note";
  text: string;
  at?: number;
  /** The tool's name, when the line is a tool call. */
  toolName?: string;
};

type Block = { type?: unknown; text?: unknown };

/**
 * Text out of one RACP message.
 *
 * A message's `content` is either a string or an array of blocks; thinking and
 * image blocks carry no text a phone should read, so only text blocks survive.
 * Unknown shapes yield "" rather than "[object Object]" in a bubble.
 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as Block[]) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
      parts.push(block.text.trim());
    }
  }
  return parts.join("\n\n");
}

/**
 * The transcript, keyed by item id.
 *
 * The host records a message twice — `message_start` while it streams and
 * `message_end` when it settles — and a tool twice for the same reason, so a
 * naive walk of the page yields two rows with one id. React would warn about a
 * duplicate key and the reader would see the same sentence twice, so later
 * entries replace earlier ones and a tool row keeps the name its start carried
 * even when the end carries only a result.
 */
function asMessages(value: unknown): RemoteMessage[] {
  const items = (value as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  const byId = new Map<string, RemoteMessage>();
  for (const entry of items) {
    const row = entry as {
      id?: unknown;
      itemType?: unknown;
      createdAt?: unknown;
      content?: unknown;
    };
    if (typeof row.id !== "string") continue;
    const at = typeof row.createdAt === "string" ? Date.parse(row.createdAt) : Number.NaN;
    const when = Number.isFinite(at) ? { at } : {};

    if (row.itemType === "message") {
      const message = (row.content ?? {}) as {
        role?: unknown;
        content?: unknown;
        toolName?: unknown;
      };
      // The host types a tool result as a message with `role: "tool"` whose
      // content is the tool's JSON — not a sentence. It becomes one quiet line.
      if (message.role === "tool") {
        const name = typeof message.toolName === "string" ? message.toolName : "";
        if (!name) continue;
        byId.set(row.id, { id: row.id, role: "tool", text: name, toolName: name, ...when });
        continue;
      }
      // System messages are the host talking to itself; a phone transcript is
      // the user and the assistant.
      if (message.role !== "user" && message.role !== "assistant") continue;
      const role = message.role === "user" ? "user" : "assistant";
      const text = textOf(message.content);
      // A streaming message with no text yet must not erase the settled copy.
      if (!text) continue;
      byId.set(row.id, { id: row.id, role, text, ...when });
      continue;
    }
    if (row.itemType === "tool") {
      const tool = (row.content ?? {}) as { toolName?: unknown };
      const previous = byId.get(row.id);
      const name =
        typeof tool.toolName === "string" && tool.toolName ? tool.toolName : (previous?.toolName ?? "");
      // A tool that ended but never started here has no name to show.
      if (!name) continue;
      byId.set(row.id, { id: row.id, role: "tool", text: name, toolName: name, ...when });
      continue;
    }
    if (row.itemType === "compaction") {
      byId.set(row.id, { id: row.id, role: "note", text: "…", ...when });
    }
  }
  return [...byId.values()];
}

/** The visible transcript of one conversation on the paired computer. */
export async function fetchHistory(
  computer: PairedComputer,
  sessionId: string,
  limit?: number,
): Promise<RemoteMessage[]> {
  // Paging is asked for in the query string so a long conversation arrives as
  // its most recent window instead of everything the host has ever stored. The
  // phone renders what arrives, oldest first.
  const query = limit && limit > 0 ? `?limit=${Math.floor(limit)}` : "";
  const result = await call(
    computer,
    "GET",
    `/v1/sessions/${encodeURIComponent(sessionId)}/history${query}`,
  );
  return asMessages(result);
}

function requestId(): string {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Send a prompt into a conversation that lives on the paired computer. */
export async function sendTurn(
  computer: PairedComputer,
  sessionId: string,
  text: string,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  await call(computer, "POST", `/v1/sessions/${encodeURIComponent(sessionId)}/turns`, {
    input: { text: trimmed },
    context: { requestId: requestId() },
  });
}

/** A question the desktop's agent is waiting on before it can continue. */
export type RemoteApproval = {
  id: string;
  kind: "tool" | "plan" | "goal";
  summary: string;
  toolName?: string;
  title?: string;
  risk?: "low" | "medium" | "high";
  /** What the host will accept here; a decision outside this list is refused. */
  allowed: string[];
};

/**
 * The approvals a running turn is blocked on.
 *
 * `session/attach` answers with a snapshot that carries `pendingApprovals`;
 * there is no separate list operation. The phone only asks while its own turn is
 * in flight, because attach also resumes that session's queue — polling it at
 * rest would nudge a session the user deliberately paused.
 */
export async function fetchApprovals(
  computer: PairedComputer,
  sessionId: string,
): Promise<RemoteApproval[]> {
  const result = await call(
    computer,
    "POST",
    `/v1/sessions/${encodeURIComponent(sessionId)}:attach`,
    { includeSnapshot: true, context: { requestId: requestId() } },
  );
  return asApprovals((result as { snapshot?: { pendingApprovals?: unknown } } | null)?.snapshot?.pendingApprovals);
}

function asApprovals(pending: unknown): RemoteApproval[] {
  if (!Array.isArray(pending)) return [];
  return pending.flatMap((entry) => {
    const row = entry as {
      id?: unknown;
      kind?: unknown;
      summary?: unknown;
      toolName?: unknown;
      title?: unknown;
      risk?: unknown;
      allowedDecisions?: unknown;
    };
    if (typeof row.id !== "string") return [];
    const kind = row.kind === "plan" || row.kind === "goal" ? row.kind : "tool";
    const allowed = Array.isArray(row.allowedDecisions)
      ? row.allowedDecisions.filter((decision): decision is string => typeof decision === "string")
      : [];
    return [
      {
        id: row.id,
        kind,
        summary: typeof row.summary === "string" ? row.summary : "",
        allowed,
        ...(typeof row.title === "string" ? { title: row.title } : {}),
        ...(typeof row.toolName === "string" ? { toolName: row.toolName } : {}),
        ...(row.risk === "low" || row.risk === "medium" || row.risk === "high"
          ? { risk: row.risk }
          : {}),
      } satisfies RemoteApproval,
    ];
  });
}

/** One read of a conversation: what was said, what it waits on, whether it runs. */
export type ChatSnapshot = {
  messages: RemoteMessage[];
  approvals: RemoteApproval[];
  /** A turn is running or queued, so another read will show more. */
  active: boolean;
};

/**
 * The whole state of a conversation in one request.
 *
 * `session/attach` already answers with the transcript, the pending approvals
 * and the active turn, so a turn in progress costs one request per tick instead
 * of one for the words and another for the questions. It also removes the guess
 * about when to stop: `active` is the host's own answer.
 */
export async function fetchChat(
  computer: PairedComputer,
  sessionId: string,
): Promise<ChatSnapshot> {
  const result = await call(
    computer,
    "POST",
    `/v1/sessions/${encodeURIComponent(sessionId)}:attach`,
    { includeSnapshot: true, context: { requestId: requestId() } },
  );
  const snapshot =
    (result as {
      snapshot?: {
        items?: unknown;
        activeItems?: unknown;
        pendingApprovals?: unknown;
        activeTurn?: unknown;
        queuedTurns?: unknown;
      };
    } | null)?.snapshot ?? {};
  const queued = Array.isArray(snapshot.queuedTurns) ? snapshot.queuedTurns.length : 0;
  const messages = asMessages({ items: snapshot.items });
  // A message being written lives in `activeItems`, not in `items`: the page
  // would otherwise sit still until the whole answer landed. The settled copy
  // wins when both carry the same id, so nothing is shown twice.
  const settled = new Set(messages.map((message) => message.id));
  for (const live of asMessages({ items: snapshot.activeItems })) {
    if (!settled.has(live.id)) messages.push(live);
  }
  return {
    messages,
    approvals: asApprovals(snapshot.pendingApprovals),
    active: Boolean(snapshot.activeTurn) || queued > 0,
  };
}

/** Answers one approval; `decision` must be one that kind allows. */
export const APPROVAL_DECISIONS: ReadonlySet<string> = new Set([
  "allow-once",
  "allow-session",
  "deny",
  "approve",
  "reject",
]);

export type ApprovalDecision = "allow-once" | "allow-session" | "deny" | "approve" | "reject";

export async function respondApproval(
  computer: PairedComputer,
  approvalId: string,
  decision: ApprovalDecision,
): Promise<void> {
  await call(computer, "POST", `/v1/approvals/${encodeURIComponent(approvalId)}:respond`, {
    decision,
    context: { requestId: requestId() },
  });
}

/**
 * Starts a conversation on that computer.
 *
 * `session/create` takes the title and the permission mode; the provider and
 * model come from the computer's own defaults, which is what a person expects
 * when they start a chat from the phone.
 */
export async function createSession(
  computer: PairedComputer,
  title: string,
): Promise<{ id: string; title: string }> {
  const trimmed = title.trim();
  const result = await call(computer, "POST", "/v1/sessions", {
    ...(trimmed ? { title: trimmed } : {}),
    mode: "agent",
    permissionMode: "ask",
  });
  const session = (result as { session?: { id?: unknown; title?: unknown } } | null)?.session;
  if (!session || typeof session.id !== "string") {
    throw new Error("the computer did not return the new conversation");
  }
  return {
    id: session.id,
    title: typeof session.title === "string" && session.title ? session.title : trimmed,
  };
}
