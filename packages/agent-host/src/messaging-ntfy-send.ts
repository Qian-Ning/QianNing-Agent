/**
 * The outbound ntfy send path: one `POST {base}/{topic}` per chunk of a reply.
 *
 * It lives apart from the poll client so each module has one responsibility; the
 * inbound module re-exports these symbols, so callers and tests import one place.
 *
 * The chunk order, the wait out of a 429 and the bounded retry of a 5xx are the
 * shared delivery loop's ([`deliverInChunks`]). What stays ntfy's is one request:
 * the endpoint rule, the URL (the topic is a path segment), the optional bearer
 * header, the raw message body, and how a status maps onto the shared outcome
 * vocabulary.
 *
 * # The own-message marker
 *
 * ntfy has no concept of "our own message": every message on a topic is just a
 * message, with no author and no bot flag. A channel that publishes to the same
 * topic it subscribes to would therefore read its own reply back as an inbound
 * message and turn it into a second turn — a loop that never ends on its own.
 *
 * Every chunk this module posts therefore carries the tag
 * [`NTFY_OWN_TAG`], and the receive path drops a message whose tags contain it.
 * The tag is the platform's own mechanism (the `X-Tags` header becomes the
 * event's `tags` array) and it is invisible in the message body, so a user's
 * notification client shows nothing unusual and the text is never prefixed with
 * a marker the model would have to learn to ignore.
 *
 * The marker is not a security boundary — anyone who can write to the topic can
 * copy the tag — it is the loop breaker, which is the only thing it is asked to
 * be.
 *
 * The token never appears in a URL, a result, or an error this module builds.
 */

import {
  deliverInChunks,
  type IngressDeliveryResult,
  type IngressPostOutcome,
} from "./messaging-ingress.js";
import { validateInboundEndpoint } from "./messaging-inbound.js";

/**
 * The most bytes one ntfy message body may carry.
 *
 * ntfy's own server limit is 4096 bytes for a message body on the public
 * server, and a self-hosted server may be configured lower but never higher
 * than what this build can rely on. The limit is a byte count on the wire, so
 * the shared chunker runs in byte mode: a reply in Chinese, Korean or emoji
 * costs three or four bytes a character, and a character-counted chunker would
 * overflow the very limit it was meant to protect.
 */
export const NTFY_MESSAGE_LIMIT = 4_096;

/**
 * The tag every outbound message carries, and the one the receive path drops.
 *
 * Lower case and hyphenated because ntfy tags are lower-cased by the server and
 * a camel-case spelling would never compare equal.
 */
export const NTFY_OWN_TAG = "pi-desktop-agent";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The host's fetch, injected so the send path is testable. */
export type NtfyFetch = typeof fetch;

/** The shared result shape; an ntfy send has nothing of its own to add. */
export type NtfySendResult = IngressDeliveryResult;

export type NtfySenderOptions = {
  /** The ntfy server's base URL, e.g. `https://ntfy.sh`. */
  endpoint: string;
  /** The topic a reply is published to. */
  topic: string;
  /** An access token for a protected topic; absent means an open topic. */
  token?: string;
  requestTimeoutMs?: number;
  /** How the sender waits out a rate limit; injectable for tests. */
  wait?: (ms: number) => Promise<void>;
  fetchImpl?: NtfyFetch;
  /** The network policy's answer: is a plaintext hop to the LAN allowed? */
  allowInsecureHttp?: boolean;
  maxAttempts?: number;
};

export type NtfySender = {
  /** Send one reply to the configured topic, chunked at the byte limit. */
  send(text: string): Promise<NtfySendResult>;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * A topic name ntfy itself accepts: letters, digits, underscores and dashes,
 * up to 64 characters. Anything else is refused here rather than becoming an
 * unexpected path segment (a topic of `../admin` would address another route).
 */
export function isValidNtfyTopic(topic: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(topic);
}

/** The base URL every ntfy path is appended to, or the reason it is refused. */
export function ntfyApiBase(
  endpoint: string,
  options: { allowInsecureHttp?: boolean } = {},
): { ok: true; base: string } | { ok: false; error: string } {
  const checked = validateInboundEndpoint(endpoint, options);
  if (!checked.ok) return checked;
  const base = `${checked.url.protocol}//${checked.url.host}${checked.url.pathname.replace(/\/+$/, "")}`;
  return { ok: true, base };
}

/**
 * The outbound send path: the shared delivery loop over one `POST` per chunk.
 *
 * A 429 is waited out from `Retry-After` (ntfy sends seconds), a 5xx is retried
 * on the shared bounded backoff, and any other refusal ends the send with a
 * status-only detail. Redirects are never followed: with a bearer token
 * attached a followed redirect would carry it to whatever host the answer
 * named.
 */
export function createNtfySender(options: NtfySenderOptions): NtfySender {
  const token = options.token?.trim() ?? "";
  const topic = options.topic.trim();
  const timeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const fetchImpl = options.fetchImpl ?? fetch;

  /** One `POST` of one chunk, in the shared loop's outcome vocabulary. */
  const post = async (base: string, chunk: string): Promise<IngressPostOutcome> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response: Response;
    try {
      response = await fetchImpl(`${base}/${encodeURIComponent(topic)}`, {
        method: "POST",
        headers: {
          "content-type": "text/plain; charset=utf-8",
          // The loop breaker: the receive path drops a message carrying it.
          "X-Tags": NTFY_OWN_TAG,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: chunk,
        signal: controller.signal,
        // A followed POST would carry the bearer token to another host.
        redirect: "manual",
      });
    } catch {
      // The request may or may not have been applied. Reporting it as refused
      // ends the reply rather than retrying a chunk that may already have
      // landed, which would publish the same text twice.
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
      return {
        kind: "rate-limited",
        retryAfterMs: Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : 1000,
      };
    }
    if (response.status >= 500) return { kind: "unavailable" };
    if (response.status >= 300 && response.status < 400) {
      return { kind: "refused", error: `ntfy answered a redirect (HTTP ${response.status})` };
    }
    if (!response.ok) {
      return { kind: "refused", error: `ntfy answered HTTP ${response.status} for the publish` };
    }
    // ntfy answers with the stored message as JSON. The id is not needed by the
    // caller, but the shared loop wants one, and an unreadable body is still a
    // successful publish.
    const body = (await response.json().catch(() => null)) as unknown;
    return {
      kind: "accepted",
      id: isRecord(body) && typeof body.id === "string" ? body.id : "",
    };
  };

  return {
    async send(text: string): Promise<NtfySendResult> {
      if (!isValidNtfyTopic(topic)) {
        return { ok: false, error: "the configured topic is not a valid ntfy topic name", sent: 0 };
      }
      const checked = ntfyApiBase(options.endpoint, {
        allowInsecureHttp: options.allowInsecureHttp,
      });
      if (!checked.ok) return { ok: false, error: checked.error, sent: 0 };
      return deliverInChunks(text, {
        platform: "ntfy",
        limit: NTFY_MESSAGE_LIMIT,
        limitUnit: "bytes",
        post: (chunk) => post(checked.base, chunk),
        maxAttempts,
        wait,
      });
    },
  };
}
