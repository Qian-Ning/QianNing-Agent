/**
 * The signal-cli bridge client: JSON-RPC over HTTP to a process the user runs.
 *
 * signal-cli is a separate program. This build does not bundle it, install it,
 * register a number with it, or keep it alive; the user registers a number with
 * signal-cli, starts its HTTP JSON-RPC listener, and points this channel at the
 * address that listener answers on. Nothing here speaks Signal's wire protocol
 * itself — the protocol is signal-cli's, and it is documented at
 * <https://github.com/AsamK/signal-cli>.
 *
 * # The interface this is written against
 *
 * One endpoint, one method per request, JSON-RPC 2.0:
 *
 * - `send` — params `{ account, recipient, message }` for a direct message, and
 *   `{ account, groupId, message }` for a group. The answer carries a
 *   `timestamp`.
 * - `receive` — params `{ account, timeout }`, where `timeout` is in **seconds**
 *   and the call blocks for up to that long before answering. The result is an
 *   array of envelope wrappers.
 *
 * The request body is `{ jsonrpc: "2.0", id, method, params }` and a successful
 * answer is `{ jsonrpc: "2.0", id, result }`; a refused one is
 * `{ jsonrpc: "2.0", id, error: { code, message } }`. Those are the two shapes
 * this client accepts, and [`readSignalRpcAnswer`] refuses anything else with a
 * named reason rather than handing `undefined` to a caller that will dereference
 * it three frames later.
 *
 * # Why a timeout is not optional
 *
 * `receive` is a long poll: the bridge holds the connection open and answers
 * when something arrives or its own timeout expires. A bridge that has hung, or
 * an HTTP hop that has silently half-closed, would otherwise leave the poll
 * pending for as long as the Host lives. Every call therefore has its own
 * deadline, and the caller's `AbortSignal` aborts the request as well, so a
 * channel being switched off does not wait for a poll to finish.
 *
 * # The token
 *
 * An optional bearer token, when the bridge sits behind something that asks for
 * one. It travels in the `Authorization` header and nowhere else: not the URL,
 * not the params, not an error string, not an audit record. A redirect is not
 * followed, because following one would carry that header to whatever host the
 * answer names.
 */

/** The address signal-cli's HTTP JSON-RPC listener answers on by default. */
export const SIGNAL_DEFAULT_BRIDGE_URL = "http://127.0.0.1:8080";

/** The documented JSON-RPC path under that base. */
export const SIGNAL_RPC_PATH = "/api/v1/rpc";

/** How long one `send` may take before it is abandoned. */
export const SIGNAL_DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** How long one `receive` long poll asks the bridge to wait, in seconds. */
export const SIGNAL_DEFAULT_RECEIVE_TIMEOUT_S = 20;

/**
 * The largest answer this client will read, in bytes.
 *
 * A `receive` answer is a batch of envelopes, so it is the only response that
 * can grow without bound — a bridge that answered a megabyte of JSON has either
 * misbehaved or been pointed at the wrong port. The cap turns that into a named
 * failure instead of memory pressure inside the Host.
 */
export const SIGNAL_MAX_RESPONSE_BYTES = 1024 * 1024;

/** One HTTP call, injectable so a test can drive a real loopback server or a double. */
export type SignalFetch = (input: string, init: RequestInit) => Promise<Response>;

/** Why a call failed, as a closed set of reasons. */
export type SignalRpcFailureReason =
  | "unreachable"
  | "timeout"
  | "aborted"
  | "http-status"
  | "malformed"
  | "rpc-error";

/** A failed call. `detail` is short, structural text — never the token or the body. */
export type SignalRpcFailure = {
  ok: false;
  reason: SignalRpcFailureReason;
  error: string;
  /** The HTTP status, when the failure was an HTTP answer. */
  status?: number;
  /** The bridge's own JSON-RPC error code, when it refused the method. */
  code?: number;
};

export type SignalRpcSuccess<T> = { ok: true; result: T };
export type SignalRpcAnswer<T> = SignalRpcSuccess<T> | SignalRpcFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether an address is this machine, where a plaintext hop cannot be observed off-box. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1";
}

/**
 * The JSON-RPC URL for a configured bridge base.
 *
 * `https` is accepted anywhere. `http` is accepted only for a loopback host,
 * because that is the shape the documented default takes
 * (`http://127.0.0.1:8080`) and the traffic never leaves the machine. A bridge
 * on another machine must be reached over `https`, unless the caller explicitly
 * allows plaintext (`allowInsecureHttp`), which is the same relaxation the ntfy
 * and Telegram channels take from the shared network policy.
 */
export function signalRpcUrl(
  bridgeUrl: string,
  options: { allowInsecureHttp?: boolean } = {},
): { ok: true; url: string } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(bridgeUrl.trim());
  } catch {
    return { ok: false, error: "the bridge URL is not a URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "the bridge URL must use HTTP or HTTPS" };
  }
  if (!parsed.hostname) return { ok: false, error: "the bridge URL must name a host" };
  if (parsed.username || parsed.password) {
    // A credential in the URL would land in every log line that prints it.
    return { ok: false, error: "the bridge URL must not contain a user name or password" };
  }
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    if (options.allowInsecureHttp !== true) {
      return {
        ok: false,
        error: "a bridge that is not on this machine must be reached over HTTPS",
      };
    }
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = path.endsWith(SIGNAL_RPC_PATH) ? path : `${path}${SIGNAL_RPC_PATH}`;
  parsed.search = "";
  parsed.hash = "";
  return { ok: true, url: parsed.toString() };
}

/**
 * Read one JSON-RPC answer, refusing anything that is not one.
 *
 * This is the "fail loudly" seam. A 200 with an HTML body (a proxy's error
 * page), a `{ "result": null }`, or a body with neither `result` nor `error` is
 * a malformed answer, not an empty success: so is a `result` that is missing the
 * shape the method promises. Each is reported with the reason that names it, and
 * nothing is returned as `undefined`.
 */
export function readSignalRpcAnswer<T>(
  payload: unknown,
  readResult: (result: unknown) => T | null,
): SignalRpcAnswer<T> {
  if (!isRecord(payload)) {
    return { ok: false, reason: "malformed", error: "the bridge answered something that is not a JSON object" };
  }
  if (isRecord(payload.error)) {
    const code = typeof payload.error.code === "number" ? payload.error.code : undefined;
    const message = typeof payload.error.message === "string" ? payload.error.message.slice(0, 200) : "";
    return {
      ok: false,
      reason: "rpc-error",
      error: message !== "" ? `the bridge refused the call: ${message}` : "the bridge refused the call",
      ...(code !== undefined ? { code } : {}),
    };
  }
  if (!("result" in payload)) {
    return { ok: false, reason: "malformed", error: "the bridge's answer carries neither a result nor an error" };
  }
  const read = readResult(payload.result);
  if (read === null) {
    return { ok: false, reason: "malformed", error: "the bridge's result is not the shape this method answers with" };
  }
  return { ok: true, result: read };
}

/** One `send` answer: the timestamp the bridge accepted the message at. */
export type SignalSendResult = { timestamp: number | null };

/** Read a `send` result: `{ timestamp }`, or `{}` on a bridge that omits it. */
export function readSignalSendResult(result: unknown): SignalSendResult | null {
  if (!isRecord(result)) return null;
  const timestamp = typeof result.timestamp === "number" && Number.isFinite(result.timestamp)
    ? result.timestamp
    : null;
  return { timestamp };
}

/**
 * Read a `receive` result.
 *
 * The documented answer is an array of envelope wrappers, each `{ account,
 * envelope: { … } }` — the same object `signal-cli receive --json` prints per
 * line. A bare envelope (an object with `sourceNumber`/`sourceUuid` at the top)
 * is accepted too, because that is how the daemon's own push frames are shaped
 * and a bridge build may hand either over. Everything else is refused, but a
 * single unrecognised *entry* in an otherwise valid array is kept: the adapter
 * filters entries it cannot use, and one odd envelope must not fail the batch.
 */
export function readSignalReceiveResult(result: unknown): unknown[] | null {
  if (!Array.isArray(result)) return null;
  return result as unknown[];
}

/** A `receive` answer: the envelopes the bridge handed over, in its own order. */
export type SignalReceiveResult = { envelopes: unknown[] };

export type SignalRpcClientOptions = {
  /** The bridge base, e.g. `http://127.0.0.1:8080`. */
  bridgeUrl: string;
  /** The Signal account this channel speaks as, e.g. `+15551234567`. */
  account: string;
  /** An optional bearer token for the bridge; never logged, never in a URL. */
  token?: string;
  /** How long one `send` may take. */
  requestTimeoutMs?: number;
  /** How long one `receive` asks the bridge to block, in seconds. */
  receiveTimeoutS?: number;
  /** Allow a plaintext hop to a bridge that is not on this machine. */
  allowInsecureHttp?: boolean;
  /** Test seam: the HTTP call. */
  fetchImpl?: SignalFetch;
};

/**
 * The bridge client.
 *
 * Both methods answer a typed result and never throw: the poll loop and the
 * reply path each own a retry policy, and neither wants an exception escaping
 * into a `while` loop that was written to keep running.
 */
export class SignalRpcClient {
  private readonly url: { ok: true; url: string } | { ok: false; error: string };
  private readonly account: string;
  private readonly token: string;
  private readonly requestTimeoutMs: number;
  private readonly receiveTimeoutS: number;
  private readonly fetchImpl: SignalFetch;
  private nextId = 1;

  constructor(options: SignalRpcClientOptions) {
    this.url = signalRpcUrl(options.bridgeUrl, {
      ...(options.allowInsecureHttp !== undefined ? { allowInsecureHttp: options.allowInsecureHttp } : {}),
    });
    this.account = options.account.trim();
    this.token = options.token?.trim() ?? "";
    this.requestTimeoutMs = Math.max(
      1_000,
      Math.floor(options.requestTimeoutMs ?? SIGNAL_DEFAULT_REQUEST_TIMEOUT_MS),
    );
    this.receiveTimeoutS = Math.max(
      1,
      Math.floor(options.receiveTimeoutS ?? SIGNAL_DEFAULT_RECEIVE_TIMEOUT_S),
    );
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /** The account this client speaks as. */
  get configuredAccount(): string {
    return this.account;
  }

  /** The endpoint the client posts to, or the reason the configured base is refused. */
  get endpoint(): { ok: true; url: string } | { ok: false; error: string } {
    return this.url;
  }

  /**
   * One JSON-RPC call.
   *
   * `timeoutMs` is the HTTP deadline; `receive` passes a deadline that is longer
   * than the long poll it asked for, so the bridge's own timeout answers first
   * and this one only fires on a bridge that has stopped answering at all.
   */
  private async call<T>(
    method: string,
    params: Record<string, unknown>,
    readResult: (result: unknown) => T | null,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<SignalRpcAnswer<T>> {
    if (!this.url.ok) return { ok: false, reason: "unreachable", error: this.url.error };
    if (this.account === "") {
      return { ok: false, reason: "malformed", error: "the channel has no Signal account configured" };
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) controller.abort();

    const id = `signal-rpc-${this.nextId++}`;
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(this.url.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            ...(this.token !== "" ? { Authorization: `Bearer ${this.token}` } : {}),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            method,
            params: { account: this.account, ...params },
          }),
          signal: controller.signal,
          // A redirect would carry the bearer header to another host.
          redirect: "manual",
        });
      } catch {
        if (signal?.aborted) {
          return { ok: false, reason: "aborted", error: "the request was cancelled" };
        }
        if (timedOut) {
          return {
            ok: false,
            reason: "timeout",
            error: `the bridge did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`,
          };
        }
        return {
          ok: false,
          reason: "unreachable",
          error: "the bridge is not reachable — is signal-cli running with its HTTP listener on?",
        };
      }

      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          reason: "http-status",
          error: `the bridge refused the credentials (HTTP ${response.status})`,
          status: response.status,
        };
      }
      if (response.status >= 300 && response.status < 400) {
        return {
          ok: false,
          reason: "http-status",
          error: "the bridge answered a redirect, which is not followed",
          status: response.status,
        };
      }
      if (!response.ok) {
        return {
          ok: false,
          reason: "http-status",
          error: `the bridge answered HTTP ${response.status}`,
          status: response.status,
        };
      }

      let text: string;
      try {
        text = await response.text();
      } catch {
        return { ok: false, reason: "malformed", error: "the bridge's answer could not be read" };
      }
      if (text.length > SIGNAL_MAX_RESPONSE_BYTES) {
        return { ok: false, reason: "malformed", error: "the bridge's answer is larger than this client accepts" };
      }
      let payload: unknown;
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        return { ok: false, reason: "malformed", error: "the bridge's answer is not JSON" };
      }
      return readSignalRpcAnswer(payload, readResult);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Send one plain-text message.
   *
   * Exactly one of `recipient` and `groupId` is used; the caller decides which
   * by the chat id's shape (see the adapter). Attachments, quotes, reactions and
   * edits are not part of this client: it sends text.
   */
  async send(
    target: { recipient: string } | { groupId: string },
    message: string,
    signal?: AbortSignal,
  ): Promise<SignalRpcAnswer<SignalSendResult>> {
    return this.call(
      "send",
      { ...target, message },
      readSignalSendResult,
      this.requestTimeoutMs,
      signal,
    );
  }

  /**
   * One long poll for new envelopes.
   *
   * The HTTP deadline is the poll's own timeout plus a margin, so a bridge that
   * honours `timeout` answers well inside it and only a stalled bridge reaches
   * the deadline.
   */
  async receive(signal?: AbortSignal): Promise<SignalRpcAnswer<SignalReceiveResult>> {
    const answer = await this.call(
      "receive",
      { timeout: this.receiveTimeoutS },
      (result) => {
        const envelopes = readSignalReceiveResult(result);
        return envelopes === null ? null : { envelopes };
      },
      (this.receiveTimeoutS + 10) * 1_000,
      signal,
    );
    return answer;
  }

  /**
   * Whether the bridge answers at all, for a settings-page check.
   *
   * A `receive` with a one-second timeout is the cheapest documented call that
   * proves the listener is up and the account is registered: a bridge that is
   * running but has no account answers a JSON-RPC error, which is a different
   * answer from "nothing to receive".
   */
  async probe(signal?: AbortSignal): Promise<{ ok: true } | SignalRpcFailure> {
    const answer = await this.call(
      "receive",
      { timeout: 1 },
      (result) => {
        const envelopes = readSignalReceiveResult(result);
        return envelopes === null ? null : { envelopes };
      },
      5_000,
      signal,
    );
    return answer.ok ? { ok: true } : answer;
  }
}
