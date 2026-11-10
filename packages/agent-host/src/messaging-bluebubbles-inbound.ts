/**
 * BlueBubbles inbound: the webhook the bridge posts, and the shared password.
 *
 * # The "server" is the user's Mac
 *
 * BlueBubbles is a bridge: a small server runs on a Mac signed into Messages and
 * exposes the conversation over HTTP. That is not a gap in this channel — it is
 * the same arrangement LINE's and WhatsApp's own SDKs assume, and it is how
 * every client that speaks iMessage from outside macOS works. This module is the
 * client side of that server's documented webhook.
 *
 * # The password travels in the query string
 *
 * BlueBubbles authenticates by a `guid`/`password`/`token` query parameter, not a
 * signature over the body — so the check is "does this caller know the password",
 * and the body is read only after it passes. A webhook URL is registered with the
 * password already in it, which is why the value arrives here rather than in a
 * header.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import {
  ingressMessageKey,
  type IngressMessage,
  type IngressNormalisation,
  type WebhookIngressAdapter,
} from "./messaging-ingress.js";
import type { IngressVerification, IngressVerifier } from "./messaging-ingress-verify.js";

/** The path segment this platform is served under: `/webhooks/bluebubbles`. */
export const MESSAGING_BLUEBUBBLES_PLATFORM = "bluebubbles";

/** The settings section a BlueBubbles channel's record lives under. */
export const BLUEBUBBLES_SETTINGS_SECTION = "messagingBluebubbles";

/** The record format and version this build writes and reads. */
export const BLUEBUBBLES_FORMAT = "pi-desktop-messaging-bluebubbles";
export const BLUEBUBBLES_FORMAT_VERSION = 1;

/** The bridge's server password, used for both directions. */
export const BLUEBUBBLES_PASSWORD_SECRET_REF = "secret:messaging-bluebubbles:password";

/** iMessage's practical ceiling for a single message, in characters. */
export const BLUEBUBBLES_MESSAGE_LIMIT = 20_000;

/** The most delivery ids the durable replay guard remembers. */
export const BLUEBUBBLES_HANDLED_CAPACITY = 2_048;

/** The query parameter names BlueBubbles accepts for its password. */
const PASSWORD_PARAMETERS = ["guid", "password", "token"] as const;

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The verifier: the password in the query string, compared in constant time.
 *
 * There is no signature over the body, so this proves only that the caller knows
 * the password. The bridge is expected to run on the same machine or a trusted
 * network; the panel says so.
 */
export function createBluebubblesVerifier(options: { password: string }): IngressVerifier {
  const expected = options.password.trim();
  return {
    scheme: "bluebubbles-password",
    async verify(rawBody: Buffer, _headers, url?: URL): Promise<IngressVerification> {
      if (expected === "" || !url) return { ok: false, reason: "signature-mismatch" };
      let presented: string | null = null;
      for (const name of PASSWORD_PARAMETERS) {
        presented = text(url.searchParams.get(name));
        if (presented) break;
      }
      if (!presented) return { ok: false, reason: "missing-signature" };
      const left = Buffer.from(presented, "utf8");
      const right = Buffer.from(expected, "utf8");
      if (left.length !== right.length || !timingSafeEqual(left, right)) {
        return { ok: false, reason: "signature-mismatch" };
      }
      // The bridge sends no per-delivery id, and its retries repeat the body, so
      // the digest is the only stable handle — the same one the message itself
      // would give, since a redelivery is byte-identical.
      const digest = createHash("sha256").update(rawBody).digest("hex").slice(0, 32);
      return { ok: true, timestampMs: Date.now(), deliveryId: digest };
    },
  };
}

/**
 * The adapter.
 *
 * One event per POST. `new-message` is the only type that carries a command;
 * delivered/read updates, typing indicators and chat changes are filtered with
 * their own reason. The bridge's own echoes are refused by `isFromMe`, which is
 * what stops a reply from being read back as a new command.
 */
export function createBluebubblesAdapter(): WebhookIngressAdapter {
  return {
    kind: "webhook",
    platform: MESSAGING_BLUEBUBBLES_PLATFORM,
    messageLimit: BLUEBUBBLES_MESSAGE_LIMIT,
    normalise(raw: unknown): IngressNormalisation {
      if (!isRecord(raw)) return { kind: "filtered", reason: "the body is not a JSON object" };
      const type = text(raw.type);
      if (type !== "new-message") {
        return { kind: "filtered", reason: `event type ${type ?? "unknown"} is not a message` };
      }
      const data = isRecord(raw.data) ? raw.data : null;
      if (!data) return { kind: "filtered", reason: "the event carries no data" };

      if (data.isFromMe === true) {
        return { kind: "filtered", reason: "the message is this channel's own" };
      }
      const body = text(data.text);
      if (!body) return { kind: "filtered", reason: "the message carries no text" };

      const messageId = text(data.guid);
      if (!messageId) return { kind: "filtered", reason: "the message carries no id" };

      const chats = Array.isArray(data.chats) ? data.chats : [];
      const chat = chats.find((candidate) => isRecord(candidate) && text(candidate.guid));
      const chatGuid = isRecord(chat) ? text(chat.guid) : null;
      const handle = isRecord(data.handle) ? data.handle : null;
      const address = text(handle?.address);

      const chatId = chatGuid ?? address;
      if (!chatId) return { kind: "filtered", reason: "the message names no conversation" };

      const inbound: IngressMessage = {
        messageId,
        chatId,
        text: body,
        ...(address ? { sender: { id: address } } : {}),
        // A chat guid is `service;-;identifier` for a direct message and
        // `service;+;guid` for a group.
        chatKind: chatGuid && chatGuid.includes(";+;") ? "group" : "private",
      };
      return { kind: "message", message: inbound, key: ingressMessageKey(chatId, messageId) };
    },
  };
}

/** What this channel answers an accepted webhook with. */
export const BLUEBUBBLES_ACCEPT_REPLY = {
  status: 200,
  body: "",
  contentType: "text/plain; charset=utf-8",
} as const;
