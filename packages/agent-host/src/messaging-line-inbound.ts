/**
 * LINE inbound: the Messaging API's webhook batch, signed with HMAC-SHA256 over
 * the raw body.
 *
 * # A batch, not an event
 *
 * LINE posts `{destination, events: [...]}` and may put several events in one
 * request. The shared shape is one message per call, so the adapter names the
 * first event that is a text message and filters the rest with a reason — a
 * request that carries only a "follow" event is an accepted delivery that
 * produces nothing.
 *
 * # The signature
 *
 * `x-line-signature` is Base64(HMAC-SHA256(channel secret, raw body)). There is
 * no timestamp and no delivery id in the request, so the replay guard keys on a
 * digest of the body: a redelivery of the same bytes is recognisable, which is
 * exactly what LINE's retries are.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  ingressMessageKey,
  type IngressMessage,
  type IngressNormalisation,
  type WebhookIngressAdapter,
} from "./messaging-ingress.js";
import type { IngressVerification, IngressVerifier } from "./messaging-ingress-verify.js";

/** The path segment this platform is served under: `/webhooks/line`. */
export const MESSAGING_LINE_PLATFORM = "line";

/** The settings section a LINE channel's record lives under. */
export const LINE_SETTINGS_SECTION = "messagingLine";

/** The record format and version this build writes and reads. */
export const LINE_FORMAT = "pi-desktop-messaging-line";
export const LINE_FORMAT_VERSION = 1;

/** Where the two credentials live. */
export const LINE_CHANNEL_SECRET_REF = "secret:messaging-line:channel-secret";
export const LINE_CHANNEL_TOKEN_REF = "secret:messaging-line:channel-token";

/** LINE's text message ceiling, in characters. */
export const LINE_MESSAGE_LIMIT = 5_000;

/** The most delivery ids the durable replay guard remembers. */
export const LINE_HANDLED_CAPACITY = 2_048;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The conversation a LINE event belongs to, in the order its sources nest. */
function chatIdOf(source: Record<string, unknown>): string | null {
  return text(source.groupId) ?? text(source.roomId) ?? text(source.userId);
}

/**
 * The LINE adapter.
 *
 * One request may carry several events; the first text message becomes the
 * projection and the rest are reported as filtered, so nothing is silently
 * dropped without a reason in the audit trail.
 */
export function createLineAdapter(): WebhookIngressAdapter {
  return {
    kind: "webhook",
    platform: MESSAGING_LINE_PLATFORM,
    messageLimit: LINE_MESSAGE_LIMIT,
    normalise(raw: unknown): IngressNormalisation {
      if (!isRecord(raw)) {
        return { kind: "filtered", reason: "the webhook body is not a JSON object" };
      }
      if (!Array.isArray(raw.events)) {
        return { kind: "filtered", reason: "the webhook body carries no events" };
      }
      if (raw.events.length === 0) {
        return { kind: "filtered", reason: "the webhook carried an empty batch" };
      }

      let reason = "the batch carries no text message";
      for (const candidate of raw.events) {
        if (!isRecord(candidate)) {
          reason = "an event is not a JSON object";
          continue;
        }
        const type = text(candidate.type);
        if (type !== "message") {
          // follow / unfollow / join / leave / postback / beacon: not a command.
          reason = `event type ${type ?? "unknown"} is not a message`;
          continue;
        }
        const message = isRecord(candidate.message) ? candidate.message : null;
        if (!message) {
          reason = "the message event carries no message";
          continue;
        }
        const messageType = text(message.type);
        if (messageType !== "text") {
          reason = `message type ${messageType ?? "unknown"} carries no text`;
          continue;
        }
        const body = text(message.text);
        if (!body) {
          reason = "the message carries no text";
          continue;
        }
        const source = isRecord(candidate.source) ? candidate.source : null;
        if (!source) {
          reason = "the event names no source";
          continue;
        }
        const chatId = chatIdOf(source);
        if (!chatId) {
          reason = "the source names no conversation";
          continue;
        }
        const messageId = text(message.id);
        if (!messageId) {
          reason = "the message carries no id";
          continue;
        }

        const senderId = text(source.userId);
        const timestamp = Number(candidate.timestamp);
        const chatKind = text(source.type);
        const inbound: IngressMessage = {
          messageId,
          chatId,
          text: body,
          ...(senderId ? { sender: { id: senderId } } : {}),
          ...(Number.isFinite(timestamp) && timestamp > 0 ? { sentAt: timestamp } : {}),
          ...(chatKind === "user"
            ? { chatKind: "private" as const }
            : chatKind === "group" || chatKind === "room"
              ? { chatKind: "group" as const }
              : {}),
        };
        return { kind: "message", message: inbound, key: ingressMessageKey(chatId, messageId) };
      }

      return { kind: "filtered", reason };
    },
  };
}

/** A digest of the body, used as the delivery id LINE does not send. */
function bodyDigest(rawBody: Buffer): string {
  return createHash("sha256").update(rawBody).digest("hex").slice(0, 32);
}

/**
 * The signature check: Base64(HMAC-SHA256(channel secret, raw body)).
 *
 * An absent secret authenticates nobody, so a blank one refuses every request
 * rather than accepting them.
 */
export function createLineVerifier(channelSecret: string): IngressVerifier {
  const secret = channelSecret.trim();
  return {
    scheme: "line-hmac-sha256-base64",
    verify(rawBody: Buffer, headers): IngressVerification {
      if (secret === "") return { ok: false, reason: "signature-mismatch" };
      const presented = text(headers["x-line-signature"] ?? null);
      if (!presented) return { ok: false, reason: "missing-signature" };
      const expected = createHmac("sha256", secret).update(rawBody).digest("base64");
      const a = Buffer.from(expected, "utf8");
      const b = Buffer.from(presented, "utf8");
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return { ok: false, reason: "signature-mismatch" };
      }
      // LINE signs no timestamp; the body is what it protects, and the digest is
      // what makes a redelivery of the same bytes recognisable.
      return { ok: true, timestampMs: Date.now(), deliveryId: bodyDigest(rawBody) };
    },
  };
}

/** What this channel answers an accepted batch with: an empty 200. */
export const LINE_ACCEPT_REPLY = {
  status: 200,
  body: "",
  contentType: "text/plain; charset=utf-8",
} as const;
