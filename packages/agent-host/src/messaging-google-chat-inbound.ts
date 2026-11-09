/**
 * Google Chat inbound: the event body, and the assertion Google signs over it.
 *
 * # The credential is not ours
 *
 * Every other channel here authenticates with a secret the user stored. Google
 * Chat signs its request with a JWT issued by `chat@system.gserviceaccount.com`,
 * so the check is the opposite: fetch Google's public keys, verify the
 * signature, and confirm the assertion was minted for *this* app (`aud`) and has
 * not expired. Nothing secret is stored for the inbound direction at all — the
 * only value the record carries is the audience it expects.
 *
 * The verification itself lives in `messaging-openid-jwt.ts`, shared with Teams:
 * same bearer token, same key-set caching, same refusal when the keys cannot be
 * fetched.
 */

import { createJwtVerifier, type JsonFetcher } from "./messaging-openid-jwt.js";
import {
  ingressMessageKey,
  type IngressMessage,
  type IngressNormalisation,
  type WebhookIngressAdapter,
} from "./messaging-ingress.js";
import type { IngressVerifier } from "./messaging-ingress-verify.js";

/** The path segment this platform is served under: `/webhooks/google-chat`. */
export const MESSAGING_GOOGLE_CHAT_PLATFORM = "google-chat";

/** The settings section a Google Chat channel's record lives under. */
export const GOOGLE_CHAT_SETTINGS_SECTION = "messagingGoogleChat";

/** The record format and version this build writes and reads. */
export const GOOGLE_CHAT_FORMAT = "pi-desktop-messaging-google-chat";
export const GOOGLE_CHAT_FORMAT_VERSION = 1;

/** The service account's key, and the audience the app expects. */
export const GOOGLE_CHAT_SERVICE_ACCOUNT_SECRET_REF = "secret:messaging-google-chat:service-account";
export const GOOGLE_CHAT_AUDIENCE_SECRET_REF = "secret:messaging-google-chat:audience";

/** The issuer every Chat assertion carries. */
export const GOOGLE_CHAT_ISSUER = "chat@system.gserviceaccount.com";

/** Where Google publishes the keys that issuer signs with. */
export const GOOGLE_CHAT_JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/chat@system.gserviceaccount.com";

/** Google Chat's text ceiling, in characters. */
export const GOOGLE_CHAT_MESSAGE_LIMIT = 4_000;

/** The most delivery ids the durable replay guard remembers. */
export const GOOGLE_CHAT_HANDLED_CAPACITY = 2_048;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The JWT verifier.
 *
 * `audience` is the value Google put in `aud` when it signed: the app's project
 * number, or the full app URL depending on how the app was configured. The
 * record carries whichever one the user's app was registered with.
 */
export function createGoogleChatVerifier(options: {
  audience: string;
  fetchKeys?: JsonFetcher;
  now?: () => number;
}): IngressVerifier {
  return createJwtVerifier({
    jwksUrl: GOOGLE_CHAT_JWKS_URL,
    issuer: GOOGLE_CHAT_ISSUER,
    audience: options.audience,
    scheme: "google-jwt-rs256",
    ...(options.fetchKeys ? { fetchJson: options.fetchKeys } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}

/**
 * The adapter.
 *
 * Google Chat posts one event per request. `MESSAGE` is the only type that
 * carries a command; `ADDED_TO_SPACE`, `REMOVED_FROM_SPACE` and `CARD_CLICKED`
 * are filtered with their own reason.
 */
export function createGoogleChatAdapter(): WebhookIngressAdapter {
  return {
    kind: "webhook",
    platform: MESSAGING_GOOGLE_CHAT_PLATFORM,
    messageLimit: GOOGLE_CHAT_MESSAGE_LIMIT,
    normalise(raw: unknown): IngressNormalisation {
      if (!isRecord(raw)) {
        return { kind: "filtered", reason: "the event body is not a JSON object" };
      }
      const type = text(raw.type);
      if (type !== "MESSAGE") {
        return { kind: "filtered", reason: `event type ${type ?? "unknown"} is not a message` };
      }
      const message = isRecord(raw.message) ? raw.message : null;
      if (!message) return { kind: "filtered", reason: "the event carries no message" };

      const body = text(message.text) ?? text(message.argumentText);
      if (!body) return { kind: "filtered", reason: "the message carries no text" };

      const space = isRecord(raw.space) ? raw.space : null;
      const messageSpace: Record<string, unknown> | null = isRecord(message.space)
        ? message.space
        : null;
      const chatId = text(space?.name) ?? text(messageSpace?.name) ?? null;
      if (!chatId) return { kind: "filtered", reason: "the message names no space" };

      const messageId = text(message.name) ?? text(message.messageId);
      if (!messageId) return { kind: "filtered", reason: "the message carries no id" };

      const sender = isRecord(raw.user) ? raw.user : null;
      const senderId = text(sender?.name) ?? null;
      const senderName = text(sender?.displayName) ?? undefined;

      const inbound: IngressMessage = {
        messageId,
        chatId,
        text: body,
        ...(senderId ? { sender: { id: senderId, ...(senderName ? { name: senderName } : {}) } } : {}),
        chatKind: chatId.startsWith("spaces/") ? "group" : "private",
      };
      return { kind: "message", message: inbound, key: ingressMessageKey(chatId, messageId) };
    },
  };
}

/** What this channel answers an accepted event with: an empty 200. */
export const GOOGLE_CHAT_ACCEPT_REPLY = {
  status: 200,
  body: "",
  contentType: "text/plain; charset=utf-8",
} as const;
