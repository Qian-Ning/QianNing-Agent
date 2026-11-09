/**
 * Google Chat inbound: a JWT signed by Google, and the event body it guards.
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
 * # The key set is fetched, and cached
 *
 * Keys rotate, so the set is fetched lazily and kept for an hour, refetched when
 * a `kid` is unknown. A fetch failure refuses the request rather than accepting
 * an unverified one: a verifier that falls open is not a verifier.
 */

import { createPublicKey, verify as verifySignature } from "node:crypto";

import {
  ingressMessageKey,
  type IngressMessage,
  type IngressNormalisation,
  type WebhookIngressAdapter,
} from "./messaging-ingress.js";
import type { IngressVerification, IngressVerifier } from "./messaging-ingress-verify.js";

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

/** How long a fetched key set is reused before it is fetched again. */
const KEY_SET_TTL_MS = 60 * 60 * 1000;

/** The tolerance applied to `exp` and `iat`, in seconds. */
const CLOCK_SKEW_SECONDS = 300;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One JWK, as far as this module needs it. */
type Jwk = { kid?: string; kty?: string; n?: string; e?: string; alg?: string };

/** Fetch a set of keys; injected so tests never touch the network. */
export type GoogleChatKeyFetcher = (url: string) => Promise<{ keys?: Jwk[] }>;

/** The default fetcher: plain HTTPS through `fetch`. */
async function fetchKeys(url: string): Promise<{ keys?: Jwk[] }> {
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) throw new Error(`the key set answered ${response.status}`);
  return (await response.json()) as { keys?: Jwk[] };
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
  fetchKeys?: GoogleChatKeyFetcher;
  now?: () => number;
}): IngressVerifier {
  const expectedAudience = options.audience.trim();
  const fetcher = options.fetchKeys ?? fetchKeys;
  const now = options.now ?? (() => Date.now());
  let cached: { keys: Jwk[]; at: number } | null = null;

  const keys = async (force: boolean): Promise<Jwk[]> => {
    if (!force && cached && now() - cached.at < KEY_SET_TTL_MS) return cached.keys;
    const answer = await fetcher(GOOGLE_CHAT_JWKS_URL);
    const set = Array.isArray(answer.keys) ? answer.keys : [];
    if (set.length === 0) throw new Error("the key set carries no keys");
    cached = { keys: set, at: now() };
    return set;
  };

  return {
    scheme: "google-jwt-rs256",
    async verify(_rawBody: Buffer, headers): Promise<IngressVerification> {
      if (expectedAudience === "") return { ok: false, reason: "signature-mismatch" };
      const authorization = text(headers.authorization ?? null);
      if (!authorization || !/^bearer /i.test(authorization)) {
        return { ok: false, reason: "missing-signature" };
      }
      const token = authorization.slice(7).trim();
      const parts = token.split(".");
      if (parts.length !== 3) return { ok: false, reason: "malformed-timestamp" };
      const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];

      let header: Record<string, unknown>;
      let payload: Record<string, unknown>;
      try {
        header = JSON.parse(Buffer.from(rawHeader, "base64url").toString("utf8")) as Record<string, unknown>;
        payload = JSON.parse(Buffer.from(rawPayload, "base64url").toString("utf8")) as Record<string, unknown>;
      } catch {
        return { ok: false, reason: "malformed-timestamp" };
      }

      if (text(payload.iss) !== GOOGLE_CHAT_ISSUER) return { ok: false, reason: "signature-mismatch" };
      const audience = Array.isArray(payload.aud) ? payload.aud.map(String) : [String(payload.aud ?? "")];
      if (!audience.includes(expectedAudience)) return { ok: false, reason: "signature-mismatch" };

      const expires = Number(payload.exp);
      const seconds = Math.floor(now() / 1000);
      if (!Number.isFinite(expires) || expires + CLOCK_SKEW_SECONDS < seconds) {
        return { ok: false, reason: "malformed-timestamp" };
      }
      const issued = Number(payload.iat);
      if (Number.isFinite(issued) && issued - CLOCK_SKEW_SECONDS > seconds) {
        return { ok: false, reason: "malformed-timestamp" };
      }

      const kid = text(header.kid);
      const signature = Buffer.from(rawSignature, "base64url");
      const signed = Buffer.from(`${rawHeader}.${rawPayload}`, "utf8");
      let verified = false;
      try {
        for (const candidate of [false, true]) {
          const set = await keys(candidate);
          const key = kid ? set.find((entry) => entry.kid === kid) : set[0];
          if (!key) continue;
          const publicKey = createPublicKey({ key: key as never, format: "jwk" });
          if (verifySignature("RSA-SHA256", signed, publicKey, signature)) {
            verified = true;
            break;
          }
        }
      } catch {
        // A key set that cannot be fetched proves nothing, so the request is
        // refused rather than accepted unverified.
        return { ok: false, reason: "signature-mismatch" };
      }
      if (!verified) return { ok: false, reason: "signature-mismatch" };

      const deliveryId = text(payload.jti) ?? text(payload.exp) ?? null;
      if (!deliveryId) return { ok: false, reason: "missing-delivery-id" };
      return { ok: true, timestampMs: now(), deliveryId };
    },
  };
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
