/**
 * Feishu (Lark) inbound: the event subscription shape, authenticated by the
 * app's verification token.
 *
 * # Two directions, two different credentials
 *
 * Feishu's custom app answers with an app id and an app secret, exchanged for
 * a short-lived `tenant_access_token` before every send; that exchange is
 * `crates/host-core/src/messaging_feishu.rs`. *This* module never sends. It
 * receives what the platform posts to the app's Request URL and needs a
 * different credential: the **verification token** the app's event
 * subscription page prints. Feishu puts it in every event body (`header.token`
 * in the 2.0 schema, a top-level `token` in the older one), so the request is
 * authenticated by comparing that field — there is no signature header to check
 * unless the app also set an encrypt key.
 *
 * # Encryption is refused, not half-done
 *
 * With an encrypt key configured, Feishu encrypts the whole body and the event
 * arrives as `{"encrypt": "..."}`. Decrypting it needs the key and Feishu's
 * AES layout; a channel that silently accepted the envelope and found no event
 * inside would look like a broken integration rather than a missing feature.
 * So an encrypted envelope is filtered with that reason, and the settings page
 * says plainly to leave the encrypt key empty.
 *
 * # The URL-verification handshake
 *
 * Before Feishu will deliver events it asks the Request URL to prove it is
 * listening: it posts `{"type":"url_verification","challenge":"..."}`, and the
 * endpoint must answer with that same `challenge` as JSON. That event is not a
 * message, so it is a `filtered` outcome carrying an `ack` — the wording the
 * transport echoes — and the gate neither records nor routes it.
 */

import { timingSafeEqual } from "node:crypto";

import {
  ingressMessageKey,
  type IngressMessage,
  type IngressNormalisation,
  type WebhookIngressAdapter,
} from "./messaging-ingress.js";
import type { IngressVerification, IngressVerifier } from "./messaging-ingress-verify.js";

/** The path segment this platform is served under: `/webhooks/feishu`. */
export const MESSAGING_FEISHU_PLATFORM = "feishu";

/**
 * The reply limit, in characters.
 *
 * Feishu's own text message cap is much larger, but a reply is chunked before
 * it is handed to host-core's sender, and this number is the ceiling a caller
 * respects. 4096 matches every other channel in this build.
 */
export const FEISHU_INBOUND_MESSAGE_LIMIT = 4_096;

/** The most delivery ids the durable replay guard remembers. */
export const FEISHU_HANDLED_CAPACITY = 2_048;

/**
 * Where the app's verification token lives in the host's secret store.
 *
 * It is not part of the record: it authenticates every inbound request, so it is
 * a credential like any other and is written through the secret store's own
 * path, exactly as the app secret is.
 */
export const FEISHU_VERIFICATION_TOKEN_SECRET_REF = "secret:messaging-feishu:verification-token";

/** The settings section a Feishu channel's record lives under. */
export const FEISHU_SETTINGS_SECTION = "messagingFeishu";

/** The record format and version this build writes and reads. */
export const FEISHU_FORMAT = "pi-desktop-messaging-feishu";
export const FEISHU_FORMAT_VERSION = 1;

/** The message limit Feishu's own `text` message type accepts, in characters. */
export const FEISHU_SEND_LIMIT = 4_000;

/** A non-blank string, or `null`. */
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The event id Feishu keeps stable across a redelivery.
 *
 * `header.event_id` is the 2.0 schema's id; the older shape carries `uuid`. A
 * body with neither falls back to the message id, and a body with neither id
 * is filtered rather than given a synthetic key — without a stable id, a
 * redelivery would run the same command twice.
 */
function eventKey(header: Record<string, unknown> | null, body: Record<string, unknown>): string | null {
  return text(header?.event_id) ?? text(body.uuid) ?? null;
}

/** The conversation id from either schema. */
function chatIdOf(message: Record<string, unknown>): string | null {
  return text(message.chat_id) ?? text(message.chatId) ?? text(message.open_chat_id);
}

/** The message id from either schema. */
function messageIdOf(message: Record<string, unknown>): string | null {
  return text(message.message_id) ?? text(message.messageId) ?? text(message.open_message_id);
}

/**
 * The text a message carries.
 *
 * Feishu's `content` is a JSON *string* (`"{\"text\":\"hi\"}"`), not an object,
 * for the `text` message type. A body that carries it already parsed (some
 * bridges do) is accepted too.
 */
function textOf(message: Record<string, unknown>): string | null {
  const content = message.content;
  if (typeof content === "string") {
    try {
      const parsed: unknown = JSON.parse(content);
      if (isRecord(parsed)) return text(parsed.text);
    } catch {
      return null;
    }
    return null;
  }
  if (isRecord(content)) return text(content.text);
  return null;
}

/** The sender's identity from either schema. */
function senderOf(event: Record<string, unknown>): { id: string; name?: string } | null {
  const sender = isRecord(event.sender) ? event.sender : null;
  if (!sender) return null;
  const ids = isRecord(sender.sender_id) ? sender.sender_id : null;
  const id =
    text(ids?.open_id) ?? text(ids?.user_id) ?? text(ids?.union_id) ?? text(sender.senderId) ?? null;
  if (!id) return null;
  const name = text(sender.sender_name) ?? text(sender.name) ?? undefined;
  return name ? { id, name } : { id };
}

/**
 * The Feishu adapter.
 *
 * Pure: one parsed body in, one projection out. Everything a chat platform can
 * post — a challenge, a read receipt, a bot's own echo, an encrypted envelope —
 * is a typed `filtered` outcome with a reason, never a throw.
 */
export function createFeishuAdapter(): WebhookIngressAdapter {
  return {
    kind: "webhook",
    platform: MESSAGING_FEISHU_PLATFORM,
    messageLimit: FEISHU_INBOUND_MESSAGE_LIMIT,
    normalise(raw: unknown): IngressNormalisation {
      if (!isRecord(raw)) {
        return { kind: "filtered", reason: "the event body is not a JSON object" };
      }

      // The handshake. It is not a message, but the platform will not deliver
      // anything until it is answered with the challenge it just sent.
      const type = text(raw.type);
      if (type === "url_verification") {
        const challenge = text(raw.challenge);
        if (!challenge) {
          return { kind: "filtered", reason: "the verification request carries no challenge" };
        }
        return { kind: "filtered", reason: "url verification", ack: { challenge } };
      }

      // An encrypted envelope carries no readable event. Refused with the
      // reason a person can act on rather than silently dropped.
      if (text(raw.encrypt)) {
        return {
          kind: "filtered",
          reason: "the event is encrypted; this build reads plaintext events only",
        };
      }

      const header = isRecord(raw.header) ? raw.header : null;
      const eventType = text(header?.event_type) ?? text(raw.event_type) ?? text(raw.eventType);
      if (eventType && eventType !== "im.message.receive_v1") {
        return { kind: "filtered", reason: `event type ${eventType} is not a message` };
      }

      const event = isRecord(raw.event) ? raw.event : null;
      if (!event) {
        return { kind: "filtered", reason: "the event carries no payload" };
      }

      const sender = isRecord(event.sender) ? event.sender : null;
      const senderType = text(sender?.sender_type);
      if (senderType && senderType !== "user") {
        // A bot's own message, or another app's. Acting on it would answer
        // ourselves in a loop.
        return { kind: "filtered", reason: `sender type ${senderType} is not a person` };
      }

      const message = isRecord(event.message) ? event.message : null;
      if (!message) {
        return { kind: "filtered", reason: "the event carries no message" };
      }

      const messageType = text(message.message_type) ?? text(message.messageType);
      if (messageType && messageType !== "text") {
        // A card, an image, a file: nothing this channel can read as a command.
        return { kind: "filtered", reason: `message type ${messageType} carries no text` };
      }

      const body = textOf(message);
      if (!body) {
        return { kind: "filtered", reason: "the message carries no text" };
      }

      const chatId = chatIdOf(message);
      if (!chatId) {
        return { kind: "filtered", reason: "the message names no conversation" };
      }

      const messageId = messageIdOf(message);
      const key = eventKey(header, raw);
      if (!messageId || !key) {
        return { kind: "filtered", reason: "the event carries no stable id" };
      }

      const chatType = text(message.chat_type) ?? text(message.chatType);
      const senderIdentity = senderOf(event);
      const created = Number(text(header?.create_time) ?? text(raw.create_time) ?? "");
      const sentAt = Number.isFinite(created) && created > 0 ? created : undefined;

      const inbound: IngressMessage = {
        messageId,
        chatId,
        text: body,
        ...(senderIdentity ? { sender: senderIdentity } : {}),
        ...(sentAt !== undefined ? { sentAt } : {}),
        ...(chatType === "p2p" ? { chatKind: "private" as const } : {}),
        ...(chatType === "group" ? { chatKind: "group" as const } : {}),
      };

      return {
        kind: "message",
        message: inbound,
        key: ingressMessageKey(chatId, key),
      };
    },
  };
}

/**
 * How a Feishu request is authenticated: the verification token in the body.
 *
 * Feishu does not sign plaintext events. What it does is repeat the app's
 * verification token inside every body, so a request that carries the right
 * token came from Feishu (or from someone who knows the token, which is the
 * same guarantee every shared-secret scheme gives). The comparison is
 * constant-time so a wrong token cannot be recovered by timing.
 *
 * The timestamp is the event's own `create_time`; without one the window has
 * nothing to measure, so the request is accepted with the current instant and
 * the replay guard does the deduplication on the event id, which is the part
 * that actually prevents a command running twice.
 */
export function createFeishuVerifier(verificationToken: string): IngressVerifier {
  const expected = Buffer.from(verificationToken.trim(), "utf8");
  return {
    scheme: "feishu-verification-token",
    verify(rawBody: Buffer): IngressVerification {
      if (expected.length === 0) {
        return { ok: false, reason: "signature-mismatch" };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return { ok: false, reason: "signature-mismatch" };
      }
      if (!isRecord(parsed)) return { ok: false, reason: "signature-mismatch" };
      const header = isRecord(parsed.header) ? parsed.header : null;
      const token = text(header?.token) ?? text(parsed.token);
      if (!token) return { ok: false, reason: "missing-signature" };

      const presented = Buffer.from(token, "utf8");
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        return { ok: false, reason: "signature-mismatch" };
      }

      const deliveryId =
        text(header?.event_id) ?? text(parsed.uuid) ?? text(parsed.challenge) ?? null;
      if (!deliveryId) return { ok: false, reason: "missing-delivery-id" };

      // The instant reported is *now*, not the event's `create_time`.
      //
      // The receiver's replay window exists to bound a captured request that
      // carries a valid signature; Feishu signs nothing, so there is no signed
      // time to enforce and using the body's own `create_time` would refuse a
      // legitimate redelivery (Feishu retries for ten minutes and longer) while
      // proving nothing. The guard that actually stops a command running twice
      // is the delivery id below, which the durable store already holds.
      return { ok: true, timestampMs: Date.now(), deliveryId };
    },
  };
}
