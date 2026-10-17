/**
 * The outbound Matrix send path: one `PUT .../send/m.room.message/{txnId}` per
 * chunk of a reply.
 *
 * It lives apart from the sync client so each module has one responsibility; the
 * adapter re-exports these symbols, so callers and tests import one place.
 *
 * The boundary rule, the order of the chunks, the wait out of a 429 and the
 * bounded retry of a 5xx are the shared delivery loop's ([`deliverInChunks`]).
 * What stays Matrix's is one request: the endpoint rule, the URL (a room id is
 * percent-encoded — `!abc:server` contains a colon), the bearer header, the body
 * (`m.text`), and how a status maps onto the shared outcome vocabulary.
 *
 * # The transaction id, stated once
 *
 * The request path carries a transaction id, and the homeserver treats a second
 * `PUT` with an id it has already seen as the *same* send: it answers the first
 * event id again and stores nothing. That is a trap in both directions.
 *
 * - A constant id — or one derived from the reply text — makes every send after
 *   the first look like a replay, so a second, genuinely different message is
 *   silently dropped. Each attempt therefore draws a fresh id
 *   ([`MATRIX_TXN_ID_PREFIX`] plus a UUID): two sends of identical text are two
 *   posts, which is what the driver asked for.
 * - A retry is only ever made when the previous attempt provably did not store
 *   an event: a 429 (refused before processing) or a 5xx (the server failed
 *   before answering with an event id). A transport failure whose outcome is
 *   unknown — a timeout, a dropped connection — is reported as `refused` and not
 *   retried at all, because with a fresh id per attempt a blind retry of an
 *   attempt that did land would post the reply twice. That is the one rule that
 *   makes "a fresh id per attempt" and "a retry cannot double-post" both true.
 *
 * The token never appears in a URL, a result, or an error this module builds.
 */

import { randomUUID } from "node:crypto";

import {
  deliverInChunks,
  type IngressDeliveryResult,
  type IngressPostOutcome,
} from "./messaging-ingress.js";
import { validateInboundEndpoint } from "./messaging-inbound.js";

/**
 * The most characters one Matrix message should carry.
 *
 * Matrix itself imposes no per-event body limit that this build can rely on — a
 * homeserver enforces its own `max_upload_size`-adjacent limits and a synapse
 * deployment usually refuses an event whose JSON exceeds about 65 KiB. Since a
 * reply is UTF-8 JSON and non-Latin scripts cost up to three bytes a character,
 * 4000 characters stays well inside that ceiling in every supported locale while
 * keeping a long answer to a handful of events rather than dozens. It is a
 * product choice, declared here, not a protocol constant.
 */
export const MATRIX_MESSAGE_LIMIT = 4_000;

/** The prefix every transaction id this build generates carries. */
export const MATRIX_TXN_ID_PREFIX = "pi-desktop-";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The host's fetch, injected so the send path is testable. */
export type MatrixFetch = typeof fetch;

/** The shared result shape; a Matrix send has nothing of its own to add. */
export type MatrixSendResult = IngressDeliveryResult;

export type MatrixSenderOptions = {
  /** The homeserver base URL, e.g. `https://matrix.example.org`. */
  endpoint: string;
  /** The account's access token, from Element or a login call. */
  token: string;
  requestTimeoutMs?: number;
  /** How the sender waits out a rate limit; injectable for tests. */
  wait?: (ms: number) => Promise<void>;
  fetchImpl?: MatrixFetch;
  /** The network policy's answer: is a plaintext hop to the LAN allowed? */
  allowInsecureHttp?: boolean;
  maxAttempts?: number;
  /** Test seam: the transaction id source; production draws a UUID per attempt. */
  newTxnId?: () => string;
};

export type MatrixSender = {
  /** Send one reply into `roomId`, chunked at [`MATRIX_MESSAGE_LIMIT`]. */
  send(roomId: string, text: string): Promise<MatrixSendResult>;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * The outbound send path: the shared delivery loop over one `PUT` per chunk.
 *
 * A 429 is waited out from `retry_after_ms` (which Matrix puts in the JSON body)
 * or `Retry-After` (seconds), a 5xx is retried on the shared bounded backoff, and
 * any other refusal ends the send with a status-only detail. Redirects are not
 * followed: the bearer token would travel to whatever host the redirect named.
 */
export function createMatrixSender(options: MatrixSenderOptions): MatrixSender {
  const token = options.token.trim();
  const timeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const fetchImpl = options.fetchImpl ?? fetch;
  const newTxnId =
    options.newTxnId ?? (() => `${MATRIX_TXN_ID_PREFIX}${randomUUID()}`);

  /** One `PUT` of one chunk, in the shared loop's outcome vocabulary. */
  const post = async (base: string, roomId: string, chunk: string): Promise<IngressPostOutcome> => {
    // A fresh id for this attempt: see the module note. It is drawn here, not
    // once per reply, so no two requests can share one.
    const txnId = newTxnId();
    const path = `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response: Response;
    try {
      response = await fetchImpl(`${base}/_matrix/client/v3${path}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ msgtype: "m.text", body: chunk }),
        signal: controller.signal,
        // A followed PUT would carry the bearer token to another host.
        redirect: "manual",
      });
    } catch {
      // The request may or may not have been applied. Reporting it as refused
      // ends the reply instead of retrying it with a new transaction id, which
      // could post the same chunk twice.
      return {
        kind: "refused",
        error: controller.signal.aborted
          ? "the send timed out and its outcome is unknown"
          : "the send failed before the server answered",
      };
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) {
      const header = response.headers.get("retry-after");
      const seconds = header !== null ? Number(header) : Number.NaN;
      if (Number.isFinite(seconds) && seconds >= 0) {
        return { kind: "rate-limited", retryAfterMs: Math.ceil(seconds * 1000) };
      }
      const body = (await response.json().catch(() => null)) as unknown;
      const retryAfterMs = isRecord(body) ? Number(body.retry_after_ms) : Number.NaN;
      return {
        kind: "rate-limited",
        retryAfterMs: Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? Math.ceil(retryAfterMs) : 1000,
      };
    }
    if (response.status >= 500) return { kind: "unavailable" };
    if (response.status >= 300 && response.status < 400) {
      return { kind: "refused", error: `matrix answered a redirect (HTTP ${response.status})` };
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as unknown;
      const errcode = isRecord(body) && typeof body.errcode === "string" ? ` (${body.errcode})` : "";
      return { kind: "refused", error: `matrix answered HTTP ${response.status}${errcode}` };
    }
    const body = (await response.json().catch(() => null)) as unknown;
    return {
      kind: "accepted",
      id: isRecord(body) && typeof body.event_id === "string" ? body.event_id : "",
    };
  };

  return {
    async send(roomId: string, text: string): Promise<MatrixSendResult> {
      const room = roomId.trim();
      if (!token) return { ok: false, error: "the configured access token is empty", sent: 0 };
      if (!room) return { ok: false, error: "the destination room is empty", sent: 0 };
      const checked = validateInboundEndpoint(options.endpoint, {
        allowInsecureHttp: options.allowInsecureHttp,
      });
      if (!checked.ok) return { ok: false, error: checked.error, sent: 0 };
      const base = `${checked.url.protocol}//${checked.url.host}${checked.url.pathname.replace(/\/+$/, "")}`;
      return deliverInChunks(text, {
        platform: "matrix",
        limit: MATRIX_MESSAGE_LIMIT,
        post: (chunk) => post(base, room, chunk),
        maxAttempts,
        wait,
      });
    },
  };
}
