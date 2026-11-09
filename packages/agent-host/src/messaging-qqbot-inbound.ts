/**
 * QQ bot inbound: Ed25519 over the timestamp and body, and the op-13 challenge.
 *
 * # The secret is a seed, not a key
 *
 * QQ does not store a key pair on the developer's behalf: the Bot Secret *is*
 * the seed. It is repeated until it reaches 32 bytes and used directly as an
 * Ed25519 private key, which is why the same string both signs the challenge the
 * platform sends and verifies the signature it attaches to every callback.
 *
 * # Two kinds of request arrive on the same URL
 *
 * `op: 13` is the callback-address validation: the platform sends
 * `{plain_token, event_ts}` and expects the token back with a signature over
 * `event_ts + plain_token`, inside a second or two. `op: 0` carries a dispatch
 * event. The validation is answered by the receiver's `validateRequest` hook,
 * before any verification runs, because the platform cannot yet be verified —
 * proving the signature is what the answer itself does.
 */

import { createPrivateKey, createPublicKey, sign as signWith, verify as verifySignature } from "node:crypto";

import {
  ingressMessageKey,
  type IngressMessage,
  type IngressNormalisation,
  type WebhookIngressAdapter,
} from "./messaging-ingress.js";
import type { IngressHandshake } from "./messaging-ingress-receiver.js";
import type { IngressVerification, IngressVerifier } from "./messaging-ingress-verify.js";

/** The path segment this platform is served under: `/webhooks/qqbot`. */
export const MESSAGING_QQBOT_PLATFORM = "qqbot";

/** The settings section a QQ bot record lives under. */
export const QQBOT_SETTINGS_SECTION = "messagingQqbot";

/** The record format and version this build writes and reads. */
export const QQBOT_FORMAT = "pi-desktop-messaging-qqbot";
export const QQBOT_FORMAT_VERSION = 1;

/** The two credentials: the app id names the bot, the secret is its seed. */
export const QQBOT_APP_ID_SECRET_REF = "secret:messaging-qqbot:app-id";
export const QQBOT_APP_SECRET_SECRET_REF = "secret:messaging-qqbot:app-secret";

/** QQ's text ceiling for one message, in characters. */
export const QQBOT_MESSAGE_LIMIT = 2_000;

/** The most delivery ids the durable replay guard remembers. */
export const QQBOT_HANDLED_CAPACITY = 1_024;

/** The op code that means "this delivery is a dispatch event". */
const OP_DISPATCH = 0;
/** The op code that means "validate this callback URL". */
const OP_VALIDATE = 13;

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The Ed25519 seed QQ derives from the Bot Secret.
 *
 * The secret is repeated and then cut to 32 bytes, which is QQ's documented
 * rule — a shorter secret is extended, a longer one truncated, and the same
 * string seeds both directions.
 */
export function qqbotSeed(secret: string): Buffer {
  const bytes = Buffer.from(secret, "utf8");
  const seed = Buffer.alloc(32);
  for (let index = 0; index < seed.length; index += 1) {
    seed[index] = bytes[index % bytes.length] ?? 0;
  }
  return seed;
}

/** The PKCS#8 envelope an Ed25519 seed needs before Node will take it. */
function privateKeyFromSeed(secret: string) {
  const der = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    qqbotSeed(secret),
  ]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

/** `Ed25519(event_ts + plain_token)`, hex — the op-13 answer's signature. */
export function qqbotChallengeSignature(secret: string, eventTs: string, plainToken: string): string {
  const key = privateKeyFromSeed(secret);
  return signWith(null, Buffer.from(`${eventTs}${plainToken}`, "utf8"), key).toString("hex");
}

/**
 * The verifier: `Ed25519(timestamp + body)` against the key the secret seeds.
 */
export function createQqbotVerifier(options: { appSecret: string }): IngressVerifier {
  const secret = options.appSecret;
  return {
    scheme: "qq-ed25519",
    async verify(rawBody: Buffer, headers): Promise<IngressVerification> {
      if (secret.trim() === "") return { ok: false, reason: "signature-mismatch" };
      const presented = text(headers["x-signature-ed25519"] ?? null);
      const timestamp = text(headers["x-signature-timestamp"] ?? null);
      if (!presented || !timestamp) return { ok: false, reason: "missing-signature" };

      const signed = Buffer.concat([Buffer.from(timestamp, "utf8"), rawBody]);
      let valid = false;
      try {
        const publicKey = createPublicKey(privateKeyFromSeed(secret));
        valid = verifySignature(null, signed, publicKey, Buffer.from(presented, "hex"));
      } catch {
        valid = false;
      }
      if (!valid) return { ok: false, reason: "signature-mismatch" };

      // The dispatch carries its own event id; a validation request has none and
      // never reaches this path.
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return { ok: false, reason: "missing-delivery-id" };
      }
      const id = isRecord(parsed) ? text(parsed.id) : null;
      if (!id) return { ok: false, reason: "missing-delivery-id" };
      // QQ's timestamp is the instant it signed, which is what the receiver's
      // replay window must measure against.
      const seconds = Number(timestamp);
      const timestampMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : Date.now();
      return { ok: true, timestampMs, deliveryId: id };
    },
  };
}

/**
 * The op-13 answer: echo the token, sign `event_ts + plain_token`.
 *
 * Returning `null` lets the request continue to the verifier, which is what
 * every other delivery does.
 */
export function createQqbotValidation(
  options: { appSecret: string },
): (
  url: URL,
  headers: Record<string, string | undefined>,
  rawBody: Buffer,
) => IngressHandshake | null {
  const secret = options.appSecret;
  return (_url, _headers, rawBody) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return null;
    }
    if (!isRecord(parsed) || parsed.op !== OP_VALIDATE) return null;
    const data: Record<string, unknown> = isRecord(parsed.d) ? parsed.d : {};
    const eventTs = text(data.event_ts) ?? text(parsed.event_ts);
    const plainToken = text(data.plain_token) ?? text(parsed.plain_token);
    if (!eventTs || !plainToken) return null;
    return {
      status: 200,
      body: JSON.stringify({
        plain_token: plainToken,
        signature: qqbotChallengeSignature(secret, eventTs, plainToken),
      }),
      contentType: "application/json",
    };
  };
}

/** The event names this channel answers; the rest are filtered. */
const MESSAGE_EVENTS = new Set(["C2C_MESSAGE_CREATE", "GROUP_AT_MESSAGE_CREATE", "AT_MESSAGE_CREATE"]);

/**
 * The adapter.
 *
 * A C2C message is addressed by the sender's open id; a group message by the
 * group's. Both carry the text in `d.content` and the message id in `d.id`.
 */
export function createQqbotAdapter(): WebhookIngressAdapter {
  return {
    kind: "webhook",
    platform: MESSAGING_QQBOT_PLATFORM,
    messageLimit: QQBOT_MESSAGE_LIMIT,
    normalise(raw: unknown): IngressNormalisation {
      if (!isRecord(raw)) return { kind: "filtered", reason: "the body is not a JSON object" };
      if (raw.op !== OP_DISPATCH) {
        return { kind: "filtered", reason: `op ${String(raw.op ?? "unknown")} is not a dispatch event` };
      }
      const event = text(raw.t);
      if (!event) return { kind: "filtered", reason: "the dispatch names no event" };
      if (!MESSAGE_EVENTS.has(event)) {
        return { kind: "filtered", reason: `event ${event} is not a message` };
      }
      const data = isRecord(raw.d) ? raw.d : null;
      if (!data) return { kind: "filtered", reason: "the dispatch carries no data" };

      const body = text(data.content);
      if (!body) return { kind: "filtered", reason: "the message carries no text" };
      const messageId = text(data.id);
      if (!messageId) return { kind: "filtered", reason: "the message carries no id" };

      const author = isRecord(data.author) ? data.author : null;
      const senderId = text(author?.id) ?? text(author?.user_openid) ?? text(author?.member_openid);
      const groupOpenId = text(data.group_openid);

      const chatId = event === "C2C_MESSAGE_CREATE" ? senderId : (groupOpenId ?? senderId);
      if (!chatId) return { kind: "filtered", reason: "the message names no conversation" };

      const inbound: IngressMessage = {
        messageId,
        chatId,
        text: body,
        ...(senderId ? { sender: { id: senderId } } : {}),
        chatKind: event === "C2C_MESSAGE_CREATE" ? "private" : "group",
      };
      return { kind: "message", message: inbound, key: ingressMessageKey(chatId, messageId) };
    },
  };
}

/** What this channel answers an accepted dispatch with. */
export const QQBOT_ACCEPT_REPLY = {
  status: 200,
  body: "",
  contentType: "text/plain; charset=utf-8",
} as const;
