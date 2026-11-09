/**
 * The Microsoft Graph client, and the subscription that keeps notifications
 * coming.
 *
 * # Two things Graph does that the other channels do not
 *
 * 1. **Notifications expire.** A channel-message subscription lives at most an
 *    hour, so a channel that is not renewed stops silently. The keeper here
 *    renews at four fifths of the lifetime and re-creates the subscription when
 *    Graph answers that it is gone.
 * 2. **The notification carries no text.** It names a resource path; the message
 *    is a second request. That is why the projection is asynchronous and why
 *    this client is shared by the receiver and the keeper.
 *
 * # One credential, two directions
 *
 * Both directions use the same app registration with the Graph application
 * permission: `client_credentials`, no assertion to sign.
 */

/** The token endpoint's host; the tenant is a path segment. */
const LOGIN_BASE = "https://login.microsoftonline.com";
/** The default API root. */
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
/** The scope a client-credentials grant asks for. */
const SCOPE = "https://graph.microsoft.com/.default";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type GraphClientOptions = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  fetch?: FetchLike;
  now?: () => number;
};

export type GraphClient = {
  /** A token, reused until shortly before it expires. */
  token(): Promise<string>;
  get(pathOrUrl: string): Promise<unknown>;
  post(pathOrUrl: string, body: unknown): Promise<unknown>;
  patch(pathOrUrl: string, body: unknown): Promise<unknown>;
  remove(pathOrUrl: string): Promise<void>;
};

/** The default fetcher: plain HTTPS through `fetch`. */
const defaultFetch: FetchLike = (url, init) => fetch(url, init);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Refuse what the graph will refuse, before the round trip. */
export function createGraphClient(options: GraphClientOptions): GraphClient {
  const tenantId = options.tenantId.trim();
  const clientId = options.clientId.trim();
  const clientSecret = options.clientSecret.trim();
  if (tenantId === "" || clientId === "" || clientSecret === "") {
    throw new Error("a Graph client needs a tenant, a client id and a secret");
  }
  const base = (options.baseUrl ?? GRAPH_BASE).replace(/\/+$/, "");
  const doFetch = options.fetch ?? defaultFetch;
  const now = options.now ?? (() => Date.now());

  let cached: { token: string; expiresAt: number } | null = null;

  const readError = async (response: Response): Promise<string> => {
    const text = await response.text().catch(() => "");
    if (text === "") return `HTTP ${response.status}`;
    try {
      const parsed: unknown = JSON.parse(text);
      const message = isRecord(parsed) && isRecord(parsed.error) ? parsed.error.message : null;
      const code = isRecord(parsed) && isRecord(parsed.error) ? parsed.error.code : null;
      const detail = [code, message].filter((part) => typeof part === "string").join(": ");
      return detail === "" ? `HTTP ${response.status}` : `HTTP ${response.status} (${detail})`;
    } catch {
      return `HTTP ${response.status}`;
    }
  };

  const mint = async (): Promise<{ token: string; expiresAt: number }> => {
    const url = `${LOGIN_BASE}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: SCOPE,
    });
    const response = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!response.ok) throw new Error(`the Graph token endpoint answered ${await readError(response)}`);
    const body: unknown = await response.json();
    const token = isRecord(body) && typeof body.access_token === "string" ? body.access_token : "";
    if (token === "") throw new Error("the Graph token endpoint answered without a token");
    const seconds = isRecord(body) && typeof body.expires_in === "number" ? body.expires_in : 3_600;
    // Ninety seconds early: a token that expires mid-request is a failed send,
    // and a request can take longer than the caller expects.
    return { token, expiresAt: now() + Math.max(60, seconds - 90) * 1_000 };
  };

  const token = async (): Promise<string> => {
    if (cached && cached.expiresAt > now()) return cached.token;
    cached = await mint();
    return cached.token;
  };

  const call = async (
    method: string,
    pathOrUrl: string,
    body?: unknown,
  ): Promise<Response> => {
    const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${base}${pathOrUrl}`;
    const bearer = await token();
    const headers: Record<string, string> = { authorization: `Bearer ${bearer}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await doFetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`Graph ${method} ${pathOrUrl} answered ${await readError(response)}`);
    return response;
  };

  return {
    token,
    async get(pathOrUrl) {
      return (await call("GET", pathOrUrl)).json();
    },
    async post(pathOrUrl, body) {
      return (await call("POST", pathOrUrl, body)).json();
    },
    async patch(pathOrUrl, body) {
      return (await call("PATCH", pathOrUrl, body)).json();
    },
    async remove(pathOrUrl) {
      // A DELETE answers 204, and reading that as JSON would throw.
      await call("DELETE", pathOrUrl);
    },
  };
}

/** A subscription as this Host keeps it. */
export type GraphSubscription = {
  id: string;
  resource: string;
  expiresAt: number;
};

export type GraphSubscriptionKeeperOptions = {
  client: GraphClient;
  /** The public URL Graph posts notifications to. */
  notificationUrl: string;
  /** The URL Graph posts lifecycle events to; defaults to `notificationUrl`. */
  lifecycleUrl?: string;
  /** The resource to watch, e.g. `/teams/{team}/channels/{channel}/messages`. */
  resource: string;
  /** The shared value that authenticates Graph's deliveries to this channel. */
  clientState: string;
  /** Graph's own ceiling for this resource, in minutes. */
  lifetimeMinutes?: number;
  /** Called when a renewal fails; the keeper keeps trying on its next tick. */
  onFailure?: (error: string) => void;
  now?: () => number;
};

export type GraphSubscriptionLease = {
  /** Create the subscription, or extend the one this keeper already holds. */
  ensure(): Promise<GraphSubscription>;
  /** Stop the timer; the subscription itself is left to expire. */
  stop(): void;
  /** The subscription currently held, if any. */
  current(): GraphSubscription | null;
};

/**
 * Keep one subscription alive.
 *
 * The renewal interval is deliberately shorter than the lifetime: a renewal that
 * fails once still gets several more attempts before Graph drops the
 * subscription, and a channel that is only renewed at the deadline loses the
 * window where a retry would have saved it.
 */
export function createGraphSubscriptionLease(
  options: GraphSubscriptionKeeperOptions,
): GraphSubscriptionLease {
  const now = options.now ?? (() => Date.now());
  const lifetimeMinutes = options.lifetimeMinutes ?? 55;
  const clientState = options.clientState.trim();
  if (clientState === "") throw new Error("a Graph subscription needs a client state");
  let held: GraphSubscription | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const expiration = () => new Date(now() + lifetimeMinutes * 60_000).toISOString();

  const ensure = async (): Promise<GraphSubscription> => {
    if (held) {
      try {
        await options.client.patch(`/subscriptions/${held.id}`, { expirationDateTime: expiration() });
        held = { ...held, expiresAt: now() + lifetimeMinutes * 60_000 };
        return held;
      } catch (error) {
        // Graph answers 404 for a subscription that was removed (the user
        // revoked permission, or an admin deleted it), so the next step is to
        // create a fresh one rather than to keep patching a dead id.
        options.onFailure?.(error instanceof Error ? error.message : String(error));
        held = null;
      }
    }
    const created = await options.client.post("/subscriptions", {
      changeType: "created",
      notificationUrl: options.notificationUrl,
      ...(options.lifecycleUrl ? { lifecycleNotificationUrl: options.lifecycleUrl } : {}),
      resource: options.resource,
      expirationDateTime: expiration(),
      clientState,
    });
    const id = isRecord(created) && typeof created.id === "string" ? created.id : "";
    if (id === "") throw new Error("Graph created a subscription without an id");
    held = { id, resource: options.resource, expiresAt: now() + lifetimeMinutes * 60_000 };
    return held;
  };

  const schedule = (): void => {
    if (stopped) return;
    // Four fifths of the lifetime: enough slack for two failed attempts.
    const delay = Math.max(30_000, (lifetimeMinutes * 60_000 * 4) / 5);
    timer = setTimeout(() => {
      void ensure()
        .catch((error: unknown) => {
          options.onFailure?.(error instanceof Error ? error.message : String(error));
        })
        .finally(schedule);
    }, delay);
    // A pending renewal must not hold the process open.
    if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  };

  return {
    ensure,
    current: () => held,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/** Start a lease and keep it renewed; the first creation happens immediately. */
export async function startGraphSubscription(
  options: GraphSubscriptionKeeperOptions,
): Promise<GraphSubscriptionLease> {
  const lease = createGraphSubscriptionLease(options);
  await lease.ensure();
  return lease;
}
