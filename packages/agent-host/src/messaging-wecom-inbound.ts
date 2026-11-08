/**
 * WeCom (企业微信) inbound: the encrypted callback envelope, its XML body, and the
 * GET handshake the platform insists on before it will deliver anything.
 *
 * # Three things WeCom does that no other channel here does
 *
 * 1. **The signature is in the query string.** `msg_signature` covers the app's
 *    Token, a timestamp, a nonce and the encrypted payload — all of them in the
 *    URL except the payload, which is in the body. So the verifier reads both.
 * 2. **The body is XML, and it is encrypted.** `parse` decrypts it (the AES
 *    half lives in `messaging-wecom-crypto.ts`) and then reads the flat tags.
 * 3. **The URL is verified with a GET** carrying `echostr`, which must come back
 *    decrypted as plain text. That is `handshake`.
 *
 * # What is refused
 *
 * An event whose `MsgType` is not `text`, an event with no `MsgId`, an encrypted
 * payload addressed to a different corp — each is a typed `filtered` outcome
 * with a reason. A body that cannot be decrypted throws, which the receiver
 * turns into a 401: it is authentication, not content.
 */

import { timingSafeEqual } from "node:crypto";

import {
  ingressMessageKey,
  type IngressMessage,
  type IngressNormalisation,
  type WebhookIngressAdapter,
} from "./messaging-ingress.js";
import type { IngressVerification, IngressVerifier } from "./messaging-ingress-verify.js";
import { decryptWecomPayload, wecomSignature, wecomSignatureMatches } from "./messaging-wecom-crypto.js";

/** The path segment this platform is served under: `/webhooks/wecom`. */
export const MESSAGING_WECOM_PLATFORM = "wecom";

/** The settings section a WeCom app record lives under. */
export const WECOM_SETTINGS_SECTION = "messagingWecom";

/**
 * The settings section a WeCom **group robot** record lives under.
 *
 * It is a different channel from the app above: a robot is a webhook URL with a
 * key, it only accepts a push, and it belongs to a group chat rather than to a
 * person. The two share a platform and nothing else.
 */
export const WECOM_GROUP_SETTINGS_SECTION = "messagingWecomGroup";

/** The group robot's own record format and version. */
export const WECOM_GROUP_FORMAT = "pi-desktop-messaging-wecom-group";
export const WECOM_GROUP_FORMAT_VERSION = 1;

/** The record format and version this build writes and reads. */
export const WECOM_FORMAT = "pi-desktop-messaging-wecom";
export const WECOM_FORMAT_VERSION = 1;

/** The credential refs the app's two directions read. */
export const WECOM_CORP_ID_SECRET_REF = "secret:messaging-wecom:corp-id";
export const WECOM_CORP_SECRET_SECRET_REF = "secret:messaging-wecom:corp-secret";
export const WECOM_AGENT_ID_SECRET_REF = "secret:messaging-wecom:agent-id";
export const WECOM_TOKEN_SECRET_REF = "secret:messaging-wecom:token";
export const WECOM_AES_KEY_SECRET_REF = "secret:messaging-wecom:encoding-aes-key";

/** WeCom's text message ceiling, in characters. */
export const WECOM_MESSAGE_LIMIT = 2_048;

/** The most delivery ids the durable replay guard remembers. */
export const WECOM_HANDLED_CAPACITY = 2_048;

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The flat XML WeCom posts, as a record.
 *
 * WeCom's payloads are one level deep: a single `<xml>` root and plain scalar
 * children, some in CDATA. A general XML parser would be a dependency and a
 * surface this channel does not need, so this reads exactly that shape and
 * ignores anything nested.
 */
export function parseWecomXml(xml: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const pattern = /<([A-Za-z_][\w.-]*)>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))\s*<\/\1>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    const name = match[1];
    const value = match[2] ?? match[3] ?? "";
    if (name) fields[name] = value;
  }
  return fields;
}

/** The encrypted payload inside a callback body, when it carries one. */
export function wecomEncrypted(body: string): string | null {
  const match = /<Encrypt>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))\s*<\/Encrypt>/.exec(body);
  return text(match?.[1] ?? match?.[2]);
}

/**
 * The WeCom adapter.
 *
 * Constructed with the app's AES key and corp id, because reading the body at
 * all takes the key and trusting it takes the id: an envelope decrypted with
 * the right key but addressed to another corp is a misconfiguration, not a
 * message for this Host.
 */
export function createWecomAdapter(options: {
  encodingAesKey: string;
  corpId: string;
}): WebhookIngressAdapter {
  const corpId = options.corpId.trim();

  return {
    kind: "webhook",
    platform: MESSAGING_WECOM_PLATFORM,
    messageLimit: WECOM_MESSAGE_LIMIT,
    /** Decrypt the envelope and read the XML inside it. */
    parse(body: string): unknown {
      const encrypted = wecomEncrypted(body);
      if (!encrypted) {
        // An unencrypted callback is legal in WeCom's "plaintext" mode; there is
        // nothing to decrypt, and the tags are already readable.
        return { fields: parseWecomXml(body), encrypted: false };
      }
      const payload = decryptWecomPayload(options.encodingAesKey, encrypted);
      return { fields: parseWecomXml(payload.message), encrypted: true, receiverId: payload.receiverId };
    },
    normalise(raw: unknown): IngressNormalisation {
      if (typeof raw !== "object" || raw === null) {
        return { kind: "filtered", reason: "the callback body could not be read" };
      }
      const envelope = raw as { fields?: unknown; encrypted?: unknown; receiverId?: unknown };
      const fields =
        typeof envelope.fields === "object" && envelope.fields !== null
          ? (envelope.fields as Record<string, string>)
          : null;
      if (!fields) return { kind: "filtered", reason: "the callback carries no fields" };

      if (envelope.encrypted === true && corpId !== "") {
        const receiverId = text(envelope.receiverId);
        if (receiverId !== null && receiverId !== corpId) {
          return { kind: "filtered", reason: "the callback is addressed to another corp" };
        }
      }

      const messageType = text(fields.MsgType);
      if (messageType === "event") {
        return { kind: "filtered", reason: `event ${text(fields.Event) ?? "unknown"} is not a command` };
      }
      if (messageType !== "text") {
        return { kind: "filtered", reason: `message type ${messageType ?? "unknown"} carries no text` };
      }

      const body = text(fields.Content);
      if (!body) return { kind: "filtered", reason: "the message carries no text" };

      const sender = text(fields.FromUserName);
      if (!sender) return { kind: "filtered", reason: "the message names no sender" };

      const messageId = text(fields.MsgId);
      if (!messageId) return { kind: "filtered", reason: "the message carries no id" };

      const created = Number(text(fields.CreateTime) ?? "");
      const sentAt = Number.isFinite(created) && created > 0 ? created * 1000 : undefined;

      const inbound: IngressMessage = {
        messageId,
        chatId: sender,
        text: body,
        sender: { id: sender },
        ...(sentAt !== undefined ? { sentAt } : {}),
        chatKind: "private",
      };
      return { kind: "message", message: inbound, key: ingressMessageKey(sender, messageId) };
    },
  };
}

/**
 * The signature check: `msg_signature` over the encrypted body, in the query.
 *
 * WeCom timestamps in seconds, so the value is converted once here instead of
 * leaving every caller to remember which unit it holds.
 */
export function createWecomVerifier(token: string): IngressVerifier {
  const expectedToken = token.trim();
  return {
    scheme: "wecom-msg-signature-sha1",
    verify(rawBody: Buffer, _headers, url?: URL): IngressVerification {
      if (expectedToken === "") return { ok: false, reason: "signature-mismatch" };
      const params = url?.searchParams;
      const signature = text(params?.get("msg_signature") ?? null);
      const timestamp = text(params?.get("timestamp") ?? null);
      const nonce = text(params?.get("nonce") ?? null);
      if (!signature) return { ok: false, reason: "missing-signature" };
      if (!timestamp) return { ok: false, reason: "missing-timestamp" };
      if (!nonce) return { ok: false, reason: "missing-delivery-id" };

      const encrypted = wecomEncrypted(rawBody.toString("utf8"));
      if (!encrypted) return { ok: false, reason: "signature-mismatch" };

      const computed = wecomSignature(expectedToken, timestamp, nonce, encrypted);
      if (!wecomSignatureMatches(computed, signature.toLowerCase())) {
        return { ok: false, reason: "signature-mismatch" };
      }

      const seconds = Number(timestamp);
      if (!Number.isFinite(seconds)) return { ok: false, reason: "malformed-timestamp" };
      return { ok: true, timestampMs: seconds * 1000, deliveryId: signature.toLowerCase() };
    },
  };
}

/**
 * The GET handshake: verify the signature over `echostr` and answer its
 * plaintext.
 *
 * WeCom will not deliver an event to a URL that fails this, so a failure here
 * is the difference between a configured channel and a silent one.
 */
export function createWecomHandshake(options: {
  token: string;
  encodingAesKey: string;
}): (url: URL) => { status: number; body: string; contentType: string } {
  const expectedToken = options.token.trim();
  return (url: URL) => {
    const params = url.searchParams;
    const signature = text(params.get("msg_signature"));
    const timestamp = text(params.get("timestamp"));
    const nonce = text(params.get("nonce"));
    const echo = text(params.get("echostr"));
    if (!signature || !timestamp || !nonce || !echo) {
      return { status: 400, body: "", contentType: "text/plain; charset=utf-8" };
    }
    const computed = wecomSignature(expectedToken, timestamp, nonce, echo);
    const presented = Buffer.from(signature.toLowerCase(), "utf8");
    const expected = Buffer.from(computed, "utf8");
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      return { status: 401, body: "", contentType: "text/plain; charset=utf-8" };
    }
    const plain = decryptWecomPayload(options.encodingAesKey, echo);
    return { status: 200, body: plain.message, contentType: "text/plain; charset=utf-8" };
  };
}

/**
 * What this channel answers an accepted event with: nothing.
 *
 * WeCom reads the reply body as an encrypted message; a JSON `{"ok":true}`
 * would be logged as a malformed answer. An empty body means "received, no
 * reply", which is exactly right — the turn runs asynchronously and its answer
 * leaves through the send API.
 */
export const WECOM_ACCEPT_REPLY = {
  status: 200,
  body: "",
  contentType: "text/plain; charset=utf-8",
} as const;
