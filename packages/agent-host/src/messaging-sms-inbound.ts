/**
 * SMS inbound through Twilio: a form-encoded body, signed with HMAC-SHA1 over
 * the request URL and every parameter.
 *
 * # Three things Twilio does that no other channel here does
 *
 * 1. **The body is a form, not JSON.** `application/x-www-form-urlencoded`, so
 *    the adapter supplies its own `parse` and the transport never sees JSON.
 * 2. **The signature covers the URL.** `X-Twilio-Signature` is
 *    Base64(HMAC-SHA1(auth token, url + sorted key/value pairs)), which means
 *    the verifier has to know the exact address Twilio called. Behind a reverse
 *    proxy the Host header names it; the scheme is the one part the request
 *    cannot say, so both are tried.
 * 3. **No delivery id in a header.** The `MessageSid` in the body is the stable
 *    id, and Twilio retries with the same one.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import {
  ingressMessageKey,
  type IngressMessage,
  type IngressNormalisation,
  type WebhookIngressAdapter,
} from "./messaging-ingress.js";
import type { IngressVerification, IngressVerifier } from "./messaging-ingress-verify.js";

/** The path segment this platform is served under: `/webhooks/twilio`. */
export const MESSAGING_SMS_PLATFORM = "twilio";

/** The settings section an SMS channel's record lives under. */
export const SMS_SETTINGS_SECTION = "messagingSms";

/** The record format and version this build writes and reads. */
export const SMS_FORMAT = "pi-desktop-messaging-sms";
export const SMS_FORMAT_VERSION = 1;

/** Where the two credentials live. */
export const SMS_ACCOUNT_SID_SECRET_REF = "secret:messaging-sms:account-sid";
export const SMS_AUTH_TOKEN_SECRET_REF = "secret:messaging-sms:auth-token";
export const SMS_FROM_NUMBER_SECRET_REF = "secret:messaging-sms:from-number";

/** The segment count a plain SMS reply is chunked to; 1600 characters. */
export const SMS_MESSAGE_LIMIT = 1_600;

/** The most delivery ids the durable replay guard remembers. */
export const SMS_HANDLED_CAPACITY = 2_048;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Twilio's form body, as a record.
 *
 * Repeated keys (Twilio sends none today) keep their last value: the inbound
 * shape is one message, and a repeated key would be a sender error rather than
 * something to model.
 */
export function parseTwilioForm(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(body)) fields[key] = value;
  return fields;
}

/**
 * The adapter.
 *
 * Twilio sends one message per request, so the projection is direct: `Body` is
 * the text, `From` is the conversation (a reply goes back to the sender), and
 * `MessageSid` is the platform's own id.
 */
export function createSmsAdapter(): WebhookIngressAdapter {
  return {
    kind: "webhook",
    platform: MESSAGING_SMS_PLATFORM,
    messageLimit: SMS_MESSAGE_LIMIT,
    parse: parseTwilioForm,
    normalise(raw: unknown): IngressNormalisation {
      if (typeof raw !== "object" || raw === null) {
        return { kind: "filtered", reason: "the form body could not be read" };
      }
      const fields = raw as Record<string, string>;
      const body = text(fields.Body);
      if (!body) return { kind: "filtered", reason: "the message carries no text" };
      const from = text(fields.From);
      if (!from) return { kind: "filtered", reason: "the message names no sender" };
      const sid = text(fields.MessageSid) ?? text(fields.SmsSid);
      if (!sid) return { kind: "filtered", reason: "the message carries no id" };

      const inbound: IngressMessage = {
        messageId: sid,
        chatId: from,
        text: body,
        sender: { id: from },
        chatKind: "private",
      };
      return { kind: "message", message: inbound, key: ingressMessageKey(from, sid) };
    },
  };
}

/**
 * The signature: Base64(HMAC-SHA1(auth token, url + sorted pairs)).
 *
 * The URL is rebuilt from the `host` header and the request path, in both
 * schemes, because a TLS-terminating proxy is the normal deployment and the
 * request itself cannot say which one Twilio used.
 */
export function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const sorted = Object.keys(params).sort();
  const joined = sorted.reduce((acc, key) => `${acc}${key}${params[key]}`, url);
  return createHmac("sha1", authToken).update(joined, "utf8").digest("base64");
}

/**
 * The Twilio verifier.
 *
 * A blank auth token authenticates nobody, so it refuses every request rather
 * than accepting them.
 */
export function createSmsVerifier(authToken: string): IngressVerifier {
  const token = authToken.trim();
  return {
    scheme: "twilio-hmac-sha1-url",
    verify(rawBody: Buffer, headers, url?: URL): IngressVerification {
      if (token === "") return { ok: false, reason: "signature-mismatch" };
      const presented = text(headers["x-twilio-signature"] ?? null);
      if (!presented) return { ok: false, reason: "missing-signature" };

      const params = parseTwilioForm(rawBody.toString("utf8"));
      const host = text(headers.host ?? null);
      const path = url?.pathname ?? "/";
      const query = url?.search ?? "";
      const candidates: string[] = [];
      if (host) {
        candidates.push(`https://${host}${path}${query}`, `http://${host}${path}${query}`);
      }
      if (url) candidates.push(`${url.origin}${path}${query}`);

      for (const candidate of candidates) {
        const expected = twilioSignature(token, candidate, params);
        const a = Buffer.from(expected, "utf8");
        const b = Buffer.from(presented, "utf8");
        if (a.length === b.length && timingSafeEqual(a, b)) {
          const sid = text(params.MessageSid) ?? text(params.SmsSid);
          if (!sid) return { ok: false, reason: "missing-delivery-id" };
          return { ok: true, timestampMs: Date.now(), deliveryId: sid };
        }
      }
      return { ok: false, reason: "signature-mismatch" };
    },
  };
}

/** What this channel answers an accepted message with: an empty 200. */
export const SMS_ACCEPT_REPLY = {
  status: 200,
  body: "",
  contentType: "text/plain; charset=utf-8",
} as const;
