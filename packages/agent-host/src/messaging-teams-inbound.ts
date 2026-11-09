/**
 * Microsoft Teams inbound: the Bot Framework activity, and its bearer token.
 *
 * # A different issuer, the same shape
 *
 * Teams does not call this Host directly — the Bot Framework Connector does, on
 * the bot's behalf, with a JWT from Azure AD whose `iss` is
 * `https://api.botframework.com` and whose `aud` is the bot's own app id. The
 * key set is published behind the Bot Framework's OpenID configuration, so the
 * verification is the same one Google Chat uses, one metadata document away.
 *
 * # The activity is the message
 *
 * Every delivery is one `Activity`. `message` carries text; `conversationUpdate`,
 * `typing` and the rest are filtered with their own reason. The reply URL is not
 * in the record: it travels in each activity's `serviceUrl`, which is why the
 * outbound channel stores a service URL and a conversation id rather than a
 * fixed endpoint.
 */

import { createJwtVerifier, type JsonFetcher } from "./messaging-openid-jwt.js";
import {
  ingressMessageKey,
  type IngressMessage,
  type IngressNormalisation,
  type WebhookIngressAdapter,
} from "./messaging-ingress.js";
import type { IngressVerifier } from "./messaging-ingress-verify.js";

/** The path segment this platform is served under: `/webhooks/teams`. */
export const MESSAGING_TEAMS_PLATFORM = "teams";

/** The settings section a Teams channel's record lives under. */
export const TEAMS_SETTINGS_SECTION = "messagingTeams";

/** The record format and version this build writes and reads. */
export const TEAMS_FORMAT = "pi-desktop-messaging-teams";
export const TEAMS_FORMAT_VERSION = 1;

/** The bot's registration: the app id is also the inbound audience. */
export const TEAMS_APP_ID_SECRET_REF = "secret:messaging-teams:app-id";
export const TEAMS_APP_PASSWORD_SECRET_REF = "secret:messaging-teams:app-password";

/** What the Connector stamps as the issuer. */
export const TEAMS_ISSUER = "https://api.botframework.com";

/** Where the Bot Framework publishes its signing keys. */
export const TEAMS_METADATA_URL =
  "https://login.botframework.com/v1/.well-known/openidconfiguration";

/** Teams' own limit for a single message, in characters. */
export const TEAMS_MESSAGE_LIMIT = 28_000;

/** The most delivery ids the durable replay guard remembers. */
export const TEAMS_HANDLED_CAPACITY = 2_048;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The JWT verifier: Bot Framework metadata, this bot's app id as the audience.
 */
export function createTeamsVerifier(options: {
  appId: string;
  fetchJson?: JsonFetcher;
  now?: () => number;
}): IngressVerifier {
  return createJwtVerifier({
    metadataUrl: TEAMS_METADATA_URL,
    issuer: TEAMS_ISSUER,
    audience: options.appId,
    scheme: "botframework-jwt-rs256",
    ...(options.fetchJson ? { fetchJson: options.fetchJson } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}

/**
 * The adapter.
 *
 * `text` is plain text on Teams only when the user typed text; `textFormat` can
 * be `markdown`, in which case the same field carries it. Both are taken as
 * written — the agent reads markdown fine, and stripping it would lose content.
 */
export function createTeamsAdapter(): WebhookIngressAdapter {
  return {
    kind: "webhook",
    platform: MESSAGING_TEAMS_PLATFORM,
    messageLimit: TEAMS_MESSAGE_LIMIT,
    normalise(raw: unknown): IngressNormalisation {
      if (!isRecord(raw)) {
        return { kind: "filtered", reason: "the activity is not a JSON object" };
      }
      const type = text(raw.type);
      if (type !== "message") {
        return { kind: "filtered", reason: `activity type ${type ?? "unknown"} is not a message` };
      }
      const body = text(raw.text);
      if (!body) return { kind: "filtered", reason: "the activity carries no text" };

      const conversation = isRecord(raw.conversation) ? raw.conversation : null;
      const chatId = text(conversation?.id) ?? null;
      if (!chatId) return { kind: "filtered", reason: "the activity names no conversation" };

      const messageId = text(raw.id);
      if (!messageId) return { kind: "filtered", reason: "the activity carries no id" };

      const sender = isRecord(raw.from) ? raw.from : null;
      const senderId = text(sender?.id) ?? null;
      const senderName = text(sender?.name) ?? undefined;
      const conversationType = text(conversation?.conversationType);

      const inbound: IngressMessage = {
        messageId,
        chatId,
        text: body,
        ...(senderId ? { sender: { id: senderId, ...(senderName ? { name: senderName } : {}) } } : {}),
        chatKind: conversationType === "personal" ? "private" : "group",
      };
      return { kind: "message", message: inbound, key: ingressMessageKey(chatId, messageId) };
    },
  };
}

/**
 * What this channel answers an accepted activity with.
 *
 * Teams accepts an empty 200; a body would be read as a reply activity, which
 * this channel does not send from the receiver.
 */
export const TEAMS_ACCEPT_REPLY = {
  status: 200,
  body: "",
  contentType: "text/plain; charset=utf-8",
} as const;
