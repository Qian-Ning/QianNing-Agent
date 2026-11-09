/**
 * WeChat Official Account (公众号) inbound: the token signature, the GET
 * handshake, and the flat XML it posts.
 *
 * # A weaker signature than the others, and what that costs
 *
 * WeCom signs its ciphertext; Meta signs the body; the Official Account signs
 * only `token + timestamp + nonce`, all of which travel in the query string. So
 * the signature proves the request came from someone holding the token, not that
 * the body was untouched by anyone who does not. That is WeChat's design and it
 * cannot be tightened from this side — what this channel does instead is refuse
 * anything the signature does not cover: the body is read only after the query
 * signature matches, and the account id inside the body must match the one the
 * record carries, so a body replayed at this URL for another account is refused.
 *
 * # Replies go out through the customer-service API
 *
 * WeChat expects a passive reply inside five seconds, in XML, and the receiver
 * answers one fixed body per platform rather than one per message. So this
 * channel acknowledges with `success` and answers through host-core's send path
 * — which also means the 48-hour customer-service window applies: outside it
 * WeChat refuses the send and the delivery is terminal, not retryable.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { flatXmlField, parseFlatXml } from "./messaging-flat-xml.js";
import {
  ingressMessageKey,
  type IngressMessage,
  type IngressNormalisation,
  type WebhookIngressAdapter,
} from "./messaging-ingress.js";
import type { IngressHandshake } from "./messaging-ingress-receiver.js";
import type { IngressVerification, IngressVerifier } from "./messaging-ingress-verify.js";

/** The path segment this platform is served under: `/webhooks/weixin`. */
export const MESSAGING_WEIXIN_PLATFORM = "weixin";

/** The settings section a WeChat Official Account record lives under. */
export const WEIXIN_SETTINGS_SECTION = "messagingWeixin";

/** The record format and version this build writes and reads. */
export const WEIXIN_FORMAT = "pi-desktop-messaging-weixin";
export const WEIXIN_FORMAT_VERSION = 1;

/** The credentials: the app id names the account, the secret sends, the token signs. */
export const WEIXIN_APP_ID_SECRET_REF = "secret:messaging-weixin:app-id";
export const WEIXIN_APP_SECRET_SECRET_REF = "secret:messaging-weixin:app-secret";
export const WEIXIN_TOKEN_SECRET_REF = "secret:messaging-weixin:token";

/** WeChat's text ceiling for a customer-service message, in characters. */
export const WEIXIN_MESSAGE_LIMIT = 2_000;

/** The most delivery ids the durable replay guard remembers. */
export const WEIXIN_HANDLED_CAPACITY = 2_048;

/**
 * `signature` = SHA-1 over the token, timestamp and nonce in lexicographic order.
 *
 * Plain SHA-1, not an HMAC: WeChat concatenates and hashes with nothing secret
 * mixed in, so this is a check that the caller knows three values, not a
 * signature over content.
 */
export function weixinSignature(token: string, timestamp: string, nonce: string): string {
  const ordered = [token, timestamp, nonce].sort().join("");
  return createHash("sha1").update(ordered, "utf8").digest("hex");
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Does the query signature match this token? */
function signatureMatches(
  token: string,
  params: URLSearchParams | Record<string, string | string[] | undefined>,
): boolean {
  const read = (name: string): string | null => {
    if (params instanceof URLSearchParams) return text(params.get(name));
    const raw = params[name];
    return text(Array.isArray(raw) ? raw[0] : raw);
  };
  const signature = read("signature");
  const timestamp = read("timestamp");
  const nonce = read("nonce");
  if (!signature || !timestamp || !nonce) return false;
  const computed = weixinSignature(token, timestamp, nonce);
  const left = Buffer.from(signature.toLowerCase(), "utf8");
  const right = Buffer.from(computed, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The verifier.
 *
 * The signature lives in the query string, so the verifier reads the request URL
 * — the same seam WeCom added. Nothing in the body is covered by it.
 */
export function createWeixinVerifier(options: { token: string }): IngressVerifier {
  const token = options.token;
  return {
    scheme: "wechat-token-sha1-query",
    async verify(_rawBody: Buffer, _headers, url?: URL): Promise<IngressVerification> {
      if (token.trim() === "") return { ok: false, reason: "signature-mismatch" };
      if (!url || !signatureMatches(token, url.searchParams)) {
        return { ok: false, reason: "signature-mismatch" };
      }
      // WeChat sends no delivery id; the timestamp is the only replay handle it
      // offers, and it is coarse. The message id inside the body is what the
      // adapter keys on for dedupe.
      // The clock is this Host's, not WeChat's: WeChat redelivers with the
      // original timestamp, and a replay window measured against that would
      // refuse the retry it was meant to allow.
      const nonce = text(url.searchParams.get("nonce")) ?? "";
      const timestamp = text(url.searchParams.get("timestamp")) ?? "";
      return { ok: true, timestampMs: Date.now(), deliveryId: `wechat:${timestamp}:${nonce}` };
    },
  };
}

/**
 * The GET handshake: answer `echostr` when the signature matches.
 *
 * WeChat will not enable the URL until this succeeds, so a bad token here means
 * a channel that never receives anything.
 */
export function createWeixinHandshake(options: { token: string }): (url: URL) => IngressHandshake {
  const token = options.token;
  return (url: URL) => {
    const echo = url.searchParams.get("echostr") ?? "";
    if (!signatureMatches(token, url.searchParams)) {
      return { status: 403, body: "", contentType: "text/plain; charset=utf-8" };
    }
    return { status: 200, body: echo, contentType: "text/plain; charset=utf-8" };
  };
}

/**
 * The adapter.
 *
 * The body is XML, read by `parse`; `normalise` then works on the record. The
 * account id in `ToUserName` must equal the one the record carries — a body
 * addressed to another account is a misconfiguration or a replay, and neither is
 * a message for this Host.
 */
export function createWeixinAdapter(options: { accountId: string }): WebhookIngressAdapter {
  const accountId = options.accountId.trim();
  return {
    kind: "webhook",
    platform: MESSAGING_WEIXIN_PLATFORM,
    messageLimit: WEIXIN_MESSAGE_LIMIT,
    parse: (body: string) => parseFlatXml(body),
    normalise(raw: unknown): IngressNormalisation {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return { kind: "filtered", reason: "the body is not a flat XML record" };
      }
      const fields = raw as Record<string, string>;

      const addressedTo = flatXmlField(fields, "ToUserName");
      if (accountId !== "" && addressedTo && addressedTo !== accountId) {
        return { kind: "filtered", reason: "the message is addressed to another account" };
      }

      const messageType = flatXmlField(fields, "MsgType");
      if (messageType !== "text") {
        return { kind: "filtered", reason: `message type ${messageType ?? "unknown"} is not text` };
      }
      const body = flatXmlField(fields, "Content");
      if (!body) return { kind: "filtered", reason: "the message carries no text" };

      const openId = flatXmlField(fields, "FromUserName");
      if (!openId) return { kind: "filtered", reason: "the message names no sender" };

      const messageId = flatXmlField(fields, "MsgId");
      if (!messageId) return { kind: "filtered", reason: "the message carries no id" };

      const inbound: IngressMessage = {
        messageId,
        chatId: openId,
        text: body,
        sender: { id: openId },
        chatKind: "private",
      };
      return { kind: "message", message: inbound, key: ingressMessageKey(openId, messageId) };
    },
  };
}

/**
 * What this channel answers an accepted delivery with.
 *
 * `success` is WeChat's own acknowledgement for "received, replying later". Any
 * other body would be read as a passive reply, which this channel does not send
 * from the receiver.
 */
export const WEIXIN_ACCEPT_REPLY = {
  status: 200,
  body: "success",
  contentType: "text/plain; charset=utf-8",
} as const;
