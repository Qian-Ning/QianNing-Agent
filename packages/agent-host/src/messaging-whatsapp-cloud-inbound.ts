/**
 * WhatsApp Cloud API inbound: the Meta webhook, its signature, and its GET
 * handshake.
 *
 * # Same shape as LINE and Twilio, with Meta's furniture
 *
 * The signature is an HMAC over the raw body with the app secret, presented as
 * `x-hub-signature-256: sha256=<hex>`; nothing else has to be rebuilt, which is
 * why this channel needed no new capability in the receiver. What Meta adds is
 * the envelope: one POST can carry several `entry` objects, each with several
 * `changes`, each with a `value` that holds either messages or delivery
 * statuses. Statuses are the common case — a working channel receives far more
 * of them than messages — so they are filtered with their own reason rather than
 * counted as malformed.
 *
 * # The handshake is a GET
 *
 * Meta refuses to deliver anything until the URL answers `hub.challenge` for the
 * `hub.verify_token` it was configured with. That is `handshake`, and a channel
 * missing it is a silently dead one.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import {
  ingressMessageKey,
  type IngressMessage,
  type IngressNormalisation,
  type WebhookIngressAdapter,
} from "./messaging-ingress.js";
import type { IngressHandshake } from "./messaging-ingress-receiver.js";
import type { IngressVerification, IngressVerifier } from "./messaging-ingress-verify.js";

/** The path segment this platform is served under: `/webhooks/whatsapp-cloud`. */
export const MESSAGING_WHATSAPP_CLOUD_PLATFORM = "whatsapp-cloud";

/** The settings section a WhatsApp Cloud channel's record lives under. */
export const WHATSAPP_CLOUD_SETTINGS_SECTION = "messagingWhatsappCloud";

/** The record format and version this build writes and reads. */
export const WHATSAPP_CLOUD_FORMAT = "pi-desktop-messaging-whatsapp-cloud";
export const WHATSAPP_CLOUD_FORMAT_VERSION = 1;

/** The two credentials: the app secret signs, the access token sends. */
export const WHATSAPP_CLOUD_APP_SECRET_REF = "secret:messaging-whatsapp-cloud:app-secret";
export const WHATSAPP_CLOUD_ACCESS_TOKEN_REF = "secret:messaging-whatsapp-cloud:access-token";
export const WHATSAPP_CLOUD_VERIFY_TOKEN_SECRET_REF = "secret:messaging-whatsapp-cloud:verify-token";

/** WhatsApp's text ceiling for a single message, in characters. */
export const WHATSAPP_CLOUD_MESSAGE_LIMIT = 4_096;

/** The most delivery ids the durable replay guard remembers. */
export const WHATSAPP_CLOUD_HANDLED_CAPACITY = 2_048;

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `sha256=<hex>` over the raw body, as Meta presents it. */
export function whatsappCloudSignature(appSecret: string, rawBody: Buffer): string {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
}

/** The signature verifier: one HMAC over the body, compared in constant time. */
export function createWhatsappCloudVerifier(options: { appSecret: string }): IngressVerifier {
  const appSecret = options.appSecret;
  return {
    scheme: "meta-hub-signature-256",
    async verify(rawBody: Buffer, headers): Promise<IngressVerification> {
      if (appSecret.trim() === "") return { ok: false, reason: "signature-mismatch" };
      const presented = text(headers["x-hub-signature-256"] ?? null);
      if (!presented) return { ok: false, reason: "missing-signature" };
      const computed = whatsappCloudSignature(appSecret, rawBody);
      const left = Buffer.from(presented.toLowerCase(), "utf8");
      const right = Buffer.from(computed, "utf8");
      if (left.length !== right.length || !timingSafeEqual(left, right)) {
        return { ok: false, reason: "signature-mismatch" };
      }
      // Meta sends no per-delivery id on the envelope, and its own retries keep
      // the message ids, so the replay key is the id `normalise` chooses. The
      // verifier still has to name one: the body digest is stable across a
      // redelivery of the same event and changes with the content.
      const digest = createHmac("sha256", appSecret).update(rawBody).digest("hex");
      return { ok: true, timestampMs: Date.now(), deliveryId: digest };
    },
  };
}

/**
 * The GET handshake: answer the challenge when the verify token matches.
 *
 * `hub.verify_token` is a value the user picks in the Meta console, so it is
 * stored rather than derived. A mismatch answers 403 and Meta keeps the
 * subscription unverified, which is the outcome a wrong token should have.
 */
export function createWhatsappCloudHandshake(options: {
  verifyToken: string;
}): (url: URL) => IngressHandshake {
  const expected = options.verifyToken.trim();
  return (url: URL) => {
    const params = url.searchParams;
    const mode = text(params.get("hub.mode"));
    const presented = text(params.get("hub.verify_token"));
    const challenge = params.get("hub.challenge") ?? "";
    if (mode !== "subscribe" || !presented) {
      return { status: 400, body: "", contentType: "text/plain; charset=utf-8" };
    }
    const left = Buffer.from(presented, "utf8");
    const right = Buffer.from(expected, "utf8");
    if (expected === "" || left.length !== right.length || !timingSafeEqual(left, right)) {
      return { status: 403, body: "", contentType: "text/plain; charset=utf-8" };
    }
    return { status: 200, body: challenge, contentType: "text/plain; charset=utf-8" };
  };
}

/**
 * The adapter.
 *
 * Meta batches, so this walks the envelope until it finds the first text
 * message and refuses the whole delivery with the reason the walk stopped —
 * `normalise` projects one event, not a queue.
 */
export function createWhatsappCloudAdapter(): WebhookIngressAdapter {
  return {
    kind: "webhook",
    platform: MESSAGING_WHATSAPP_CLOUD_PLATFORM,
    messageLimit: WHATSAPP_CLOUD_MESSAGE_LIMIT,
    normalise(raw: unknown): IngressNormalisation {
      if (!isRecord(raw)) {
        return { kind: "filtered", reason: "the body is not a JSON object" };
      }
      const object = text(raw.object);
      if (object !== "whatsapp_business_account") {
        return { kind: "filtered", reason: `object ${object ?? "unknown"} is not a WhatsApp account` };
      }
      const entries = Array.isArray(raw.entry) ? raw.entry : [];
      if (entries.length === 0) return { kind: "filtered", reason: "the event carries no entry" };

      let sawStatus = false;
      for (const entry of entries) {
        if (!isRecord(entry)) continue;
        const changes = Array.isArray(entry.changes) ? entry.changes : [];
        for (const change of changes) {
          if (!isRecord(change)) continue;
          const value = isRecord(change.value) ? change.value : null;
          if (!value) continue;

          const messages = Array.isArray(value.messages) ? value.messages : [];
          if (messages.length === 0) {
            // A status event: delivered, read, failed. Working channels see
            // these constantly, and they are not errors.
            if (Array.isArray(value.statuses) && value.statuses.length > 0) sawStatus = true;
            continue;
          }
          for (const message of messages) {
            if (!isRecord(message)) continue;
            const messageId = text(message.id);
            const from = text(message.from);
            if (!messageId || !from) continue;
            const type = text(message.type);
            if (type !== "text") {
              return { kind: "filtered", reason: `message type ${type ?? "unknown"} is not text` };
            }
            const body = isRecord(message.text) ? text(message.text.body) : null;
            if (!body) return { kind: "filtered", reason: "the message carries no text" };

            const contacts = Array.isArray(value.contacts) ? value.contacts : [];
            const contact = contacts.find(
              (candidate) => isRecord(candidate) && text(candidate.wa_id) === from,
            );
            const profile =
              isRecord(contact) && isRecord(contact.profile) ? text(contact.profile.name) : null;

            const inbound: IngressMessage = {
              messageId,
              chatId: from,
              text: body,
              sender: { id: from, ...(profile ? { name: profile } : {}) },
              chatKind: "private",
            };
            return { kind: "message", message: inbound, key: ingressMessageKey(from, messageId) };
          }
        }
      }
      return {
        kind: "filtered",
        reason: sawStatus ? "the event carries delivery statuses, not messages" : "the event carries no message",
      };
    },
  };
}

/**
 * What this channel answers an accepted delivery with.
 *
 * Meta reads the status code and ignores the body; a 200 with an empty body is
 * the shape it documents.
 */
export const WHATSAPP_CLOUD_ACCEPT_REPLY = {
  status: 200,
  body: "",
  contentType: "text/plain; charset=utf-8",
} as const;
