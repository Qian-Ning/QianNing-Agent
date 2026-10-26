/**
 * The generic webhook channel: the first callback-shaped channel this build
 * serves on the shared receiver (`/webhooks/<platform>`).
 *
 * # What it is, and what it deliberately is not
 *
 * The shared receiver ([`IngressWebhookReceiver`](./messaging-ingress-receiver.ts))
 * owns the HTTP surface: it binds the port, verifies a signed request against a
 * shared secret, enforces the replay window and answers. It knows nothing about
 * any product. This module supplies the one piece the receiver cannot: how *this*
 * channel's events project onto the shared inbound shape, and how a request is
 * authenticated.
 *
 * It is not a product integration. There is no per-vendor payload shape here,
 * no API base and no token exchange, because the channel exists for the systems
 * that speak plain Standard Webhooks: any sender that signs
 * `<timestamp>.<body>` with the shared secret in the `x-webhook-signature`
 * header can deliver an event. A future build that wants GitHub's or Stripe's
 * own envelope adds an adapter beside this one and registers it on the same
 * receiver; nothing in the receiver changes.
 *
 * # The body contract
 *
 * One JSON object per request. The text the agent acts on is the first non-blank
 * string among `text`, `message`, `content` and their `data.` equivalents — the
 * tolerant reading of an event body that has no schema of its own. The
 * conversation it belongs to is the first non-blank string among `chatId`,
 * `topic`, `channel`, `source` (and their `data.` equivalents), defaulting to
 * [`WEBHOOK_INBOUND_DEFAULT_CHAT`]: a channel that binds one conversation has no
 * use for a per-event conversation id, but the field lets a sender that *does*
 * carry one keep its messages apart.
 *
 * The deduplication key is the sender's own delivery id where it supplies one
 * (`id`, `messageId`, `eventId`, `delivery`, or their `data.` equivalents) and a
 * digest of the body otherwise. The digest is what makes a redelivery of an
 * id-less event recognisable: a receiver that redelivers on a non-2xx, or a
 * proxy that retries, must not run the same event twice.
 */

import { createHash } from "node:crypto";

import {
  ingressMessageKey,
  type IngressMessage,
  type IngressNormalisation,
  type WebhookIngressAdapter,
} from "./messaging-ingress.js";
import { createHmacTimestampVerifier, type IngressVerifier } from "./messaging-ingress-verify.js";
import type { Principal } from "./ports.js";

/**
 * The path segment this build serves, and the conversation an event that names
 * none belongs to.
 *
 * One segment, because one channel is registered. A sender posts to
 * `/webhooks/generic`; a future adapter registering a second segment does not
 * rename this one, so a URL written down today keeps working.
 */
export const WEBHOOK_INBOUND_PLATFORM = "generic";

/** The conversation an event that carries no `chatId`-like field belongs to. */
export const WEBHOOK_INBOUND_DEFAULT_CHAT = "webhook";

/**
 * The receiver record's self-identifying format and version.
 *
 * The record lives in the shared `messagingWebhookReceiver` section. The format
 * is what lets the start gate tell this build's record from one a different
 * build wrote, exactly as every channel's own format does.
 */
export const MESSAGING_WEBHOOK_INBOUND_FORMAT = "pi-desktop-messaging-webhook-receiver";
export const MESSAGING_WEBHOOK_INBOUND_VERSION = 1;

/**
 * The identity a webhook-delivered message acts as.
 *
 * The signing secret is the whole credential, so there is no per-sender identity
 * to derive: whoever holds the secret is the operator, and the `owner` role is
 * the one the Agent Host's session rule admits to every session. A narrower role
 * would make the channel refuse the very session it is bound to.
 */
export const MESSAGING_WEBHOOK_PRINCIPAL: Principal = {
  subject: "webhook",
  roles: ["owner"],
};

/**
 * The message size the interface requires every adapter to declare, in
 * characters.
 *
 * Replies leave through host-core's outbound webhook adapter, which owns its own
 * limits, so this number is not a wire limit: it is the ceiling a caller that
 * chunks a reply would use, and 4096 is the size every channel in this build
 * stays within.
 */
export const WEBHOOK_INBOUND_MESSAGE_LIMIT = 4_096;

/**
 * The most delivery ids the durable replay guard remembers before evicting the
 * oldest, matching every other push channel in this build.
 *
 * A webhook is the shape that needs it most: a sender that retries on a non-2xx,
 * or a proxy that redelivers after a timeout, must not run one event twice, and
 * the id it retries with is the one recorded here.
 */
export const WEBHOOK_HANDLED_CAPACITY = 2_048;

/** A non-blank string, or `null`. */
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The first non-blank string among the named fields of `source` and `source.data`. */
function pick(source: Record<string, unknown>, fields: readonly string[]): string | null {
  const data = isRecord(source.data) ? source.data : null;
  for (const field of fields) {
    const direct = text(source[field]);
    if (direct) return direct;
    const nested = data ? text(data[field]) : null;
    if (nested) return nested;
  }
  return null;
}

/** The fields a body may carry its text under, most specific first. */
const TEXT_FIELDS = ["text", "message", "content"] as const;

/** The fields a body may name its delivery under. */
const ID_FIELDS = ["id", "messageId", "eventId", "delivery"] as const;

/** The fields a body may name its conversation under. */
const CHAT_FIELDS = ["chatId", "topic", "channel", "source"] as const;

/**
 * A digest of the parsed body, for an event that names no delivery.
 *
 * `JSON.stringify` of the parsed object keeps the body's own key order, so two
 * identical bodies digest identically and a redelivery is recognised. It is a
 * fallback, not the preferred key: a sender that supplies an id gets that id,
 * because a digest changes the moment a sender adds a field.
 */
function bodyDigest(body: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex").slice(0, 32);
}

/**
 * The generic adapter.
 *
 * Pure: one parsed body in, one projection out. A body this channel cannot act
 * on is a typed `filtered` outcome with a reason — never a throw, because the
 * input is whatever a remote sender posted.
 */
export function createGenericWebhookAdapter(): WebhookIngressAdapter {
  return {
    kind: "webhook",
    platform: WEBHOOK_INBOUND_PLATFORM,
    messageLimit: WEBHOOK_INBOUND_MESSAGE_LIMIT,
    normalise(raw: unknown): IngressNormalisation {
      if (!isRecord(raw)) {
        return { kind: "filtered", reason: "the event body is not a JSON object" };
      }
      const body = pick(raw, TEXT_FIELDS);
      if (!body) {
        return { kind: "filtered", reason: "the event carries no message text" };
      }
      const chatId = pick(raw, CHAT_FIELDS) ?? WEBHOOK_INBOUND_DEFAULT_CHAT;
      const messageId = pick(raw, ID_FIELDS) ?? `digest-${bodyDigest(raw)}`;
      const message: IngressMessage = { messageId, chatId, text: body };
      return {
        kind: "message",
        message,
        key: ingressMessageKey(message.chatId, message.messageId),
      };
    },
  };
}

/**
 * How this channel authenticates a request: HMAC-SHA256 over
 * `<timestamp>.<body>`, keyed by the shared secret.
 *
 * The generic verifier is exactly Standard Webhooks' scheme, which is the point
 * of the channel: a sender that already signs this way needs no bespoke code.
 * The secret is read from the host's secret store by the wiring and handed here
 * once; it never leaves this closure.
 */
export function createWebhookInboundVerifier(secret: string): IngressVerifier {
  return createHmacTimestampVerifier({ secret });
}
