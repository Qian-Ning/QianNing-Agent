/**
 * Paired computers, as the phone sees them.
 *
 * The desktop's remote listener speaks RACP over HTTPS and serves its own
 * self-signed certificate at `/cert` before any credential exists. Pairing is
 * therefore: fetch that certificate once, keep it, and from then on trust
 * exactly that certificate for exactly that address. Nothing else on the
 * network is accepted, and no plaintext fallback exists.
 */

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

async function call(
  computer: PairedComputer,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const bridge = plugin();
  if (!bridge) throw new Error("this build cannot reach a computer");
  const answer = await bridge.request({
    url: computer.url,
    method,
    path,
    token: computer.token,
    pem: computer.pem,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
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
      return {
        id: row.id,
        title: typeof row.title === "string" && row.title ? row.title : "未命名会话",
        ...(typeof row.updatedAt === "number" ? { updatedAt: row.updatedAt } : {}),
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
