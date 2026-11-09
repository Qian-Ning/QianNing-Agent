/**
 * Microsoft Graph inbound: change notifications, and the message they point at.
 *
 * # Everything about this channel is one step removed
 *
 * Teams' own channel (Bot Framework) posts an activity containing the text.
 * Graph posts a *notification*: a resource path, a change type and the shared
 * `clientState`. The text is a second request, made with the app's own
 * credentials. So this module has three parts the simpler channels do not: a
 * verifier that reads the batch, a projection that fetches, and a URL validation
 * that arrives as a POST.
 *
 * # One POST can carry several notifications
 *
 * Graph batches. This projection takes the first entry that is a channel
 * message and refuses the delivery otherwise, because the gate applies one
 * command per event; a second notification in the same batch is Graph's to
 * redeliver, and it does.
 */

import type { GraphClient } from "./messaging-graph-client.js";
import {
  ingressMessageKey,
  type IngressMessage,
  type IngressNormalisation,
  type WebhookIngressAdapter,
} from "./messaging-ingress.js";
import type { IngressHandshake } from "./messaging-ingress-receiver.js";
import type { IngressVerification, IngressVerifier } from "./messaging-ingress-verify.js";

/** The path segment this platform is served under: `/webhooks/microsoft-graph`. */
export const MESSAGING_GRAPH_PLATFORM = "microsoft-graph";

/** The settings section a Graph channel's record lives under. */
export const GRAPH_SETTINGS_SECTION = "messagingMicrosoftGraph";

/** The record format and version this build writes and reads. */
export const GRAPH_FORMAT = "pi-desktop-messaging-microsoft-graph";
export const GRAPH_FORMAT_VERSION = 1;

/** The app registration, the tenant it lives in, and the shared client state. */
export const GRAPH_TENANT_ID_SECRET_REF = "secret:messaging-microsoft-graph:tenant-id";
export const GRAPH_CLIENT_ID_SECRET_REF = "secret:messaging-microsoft-graph:client-id";
export const GRAPH_CLIENT_SECRET_SECRET_REF = "secret:messaging-microsoft-graph:client-secret";
export const GRAPH_CLIENT_STATE_SECRET_REF = "secret:messaging-microsoft-graph:client-state";
/** The public URL Graph posts to; it must be reachable from Microsoft. */
export const GRAPH_PUBLIC_URL_SECRET_REF = "secret:messaging-microsoft-graph:public-url";

/** Teams' own limit for a channel message, in characters. */
export const GRAPH_MESSAGE_LIMIT = 28_000;

/** The most delivery ids the durable replay guard remembers. */
export const GRAPH_HANDLED_CAPACITY = 2_048;

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Turn a Graph message body into plain text.
 *
 * Graph sends `contentType: "html"` for anything composed in the Teams client.
 * The tags are stripped rather than escaped because the reader is an agent, not
 * a browser: `<p>hello</p>` should arrive as `hello`, and a link's text is worth
 * more than its markup.
 */
export function graphText(content: string, contentType: string | null): string {
  if (contentType !== "html") return content.trim();
  return content
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** One notification inside the batch, as far as this module reads it. */
type GraphNotification = {
  subscriptionId?: string;
  clientState?: string;
  changeType?: string;
  resource?: string;
  tenantId?: string;
  lifecycleEvent?: string;
  resourceData?: Record<string, unknown>;
};

/** The notifications a body carries, or an empty list. */
export function graphNotifications(raw: Buffer | string | unknown): GraphNotification[] {
  let parsed: unknown = raw;
  if (Buffer.isBuffer(raw)) {
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      return [];
    }
  } else if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.value)) return [];
  return parsed.value.filter(isRecord) as GraphNotification[];
}

/**
 * The verifier: every notification in the batch must carry this channel's
 * `clientState`.
 *
 * Graph has no signature over the body — the shared value *is* the credential,
 * so it is compared in constant time and the whole batch is refused when any
 * entry disagrees. A partially trusted batch is not a thing worth having.
 */
export function createGraphVerifier(options: { clientState: string }): IngressVerifier {
  const expected = options.clientState.trim();
  return {
    scheme: "graph-client-state",
    async verify(rawBody: Buffer): Promise<IngressVerification> {
      if (expected === "") return { ok: false, reason: "signature-mismatch" };
      const entries = graphNotifications(rawBody);
      if (entries.length === 0) return { ok: false, reason: "missing-delivery-id" };
      for (const entry of entries) {
        const presented = text(entry.clientState) ?? "";
        const left = Buffer.from(presented, "utf8");
        const right = Buffer.from(expected, "utf8");
        if (left.length !== right.length || !timingSafeEqualBytes(left, right)) {
          return { ok: false, reason: "signature-mismatch" };
        }
      }
      const first = entries[0];
      const resourceId =
        text(first.resourceData?.id) ??
        (text(first.resource)?.split("/").filter(Boolean).pop() ?? null);
      if (!resourceId) return { ok: false, reason: "missing-delivery-id" };
      return {
        ok: true,
        timestampMs: Date.now(),
        deliveryId: `${text(first.subscriptionId) ?? "sub"}:${resourceId}`,
      };
    },
  };
}

/** `timingSafeEqual`, without importing the whole crypto module at call sites. */
function timingSafeEqualBytes(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

/**
 * The adapter: one notification in, one fetched message out.
 *
 * `prepare` rather than `normalise`, because reading the text is a request. The
 * fetch failure is answered as `filtered` with a reason rather than thrown: the
 * receiver has already acknowledged the delivery to Graph, and a throw there
 * would be reported as a processing failure with no channel to blame.
 */
export function createGraphAdapter(options: { client: GraphClient }): WebhookIngressAdapter {
  return {
    kind: "webhook",
    platform: MESSAGING_GRAPH_PLATFORM,
    messageLimit: GRAPH_MESSAGE_LIMIT,
    normalise(): IngressNormalisation {
      // Unreachable: the transport uses `prepare` when it is present.
      return { kind: "filtered", reason: "this channel reads its messages with a request" };
    },
    async prepare(raw: unknown): Promise<IngressNormalisation> {
      const entries = graphNotifications(raw);
      if (entries.length === 0) return { kind: "filtered", reason: "the body carries no notification" };

      const entry = entries.find((candidate) => {
        if (text(candidate.lifecycleEvent)) return false;
        const resource = text(candidate.resource);
        return resource !== null && resource.includes("/messages");
      });
      if (!entry) {
        const lifecycle = entries.find((candidate) => text(candidate.lifecycleEvent));
        if (lifecycle) {
          return {
            kind: "filtered",
            reason: `lifecycle event ${text(lifecycle.lifecycleEvent) ?? "unknown"} is not a message`,
          };
        }
        return { kind: "filtered", reason: "the notification is not a channel message" };
      }

      const resource = text(entry.resource);
      if (!resource) return { kind: "filtered", reason: "the notification names no resource" };

      let message: unknown;
      try {
        message = await options.client.get(resource);
      } catch (error) {
        return {
          kind: "filtered",
          reason: `the message could not be read: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (!isRecord(message)) return { kind: "filtered", reason: "the message could not be read" };

      const messageType = text(message.messageType);
      if (messageType && messageType !== "message") {
        return { kind: "filtered", reason: `message type ${messageType} is not a message` };
      }
      const messageBody = isRecord(message.body) ? message.body : null;
      const rawContent = typeof messageBody?.content === "string" ? messageBody.content : "";
      const content = graphText(rawContent, text(messageBody?.contentType));
      if (content === "") return { kind: "filtered", reason: "the message carries no text" };

      const messageId = text(message.id) ?? text(entry.resourceData?.id);
      if (!messageId) return { kind: "filtered", reason: "the message carries no id" };

      const from = isRecord(message.from) ? message.from : null;
      const user = from && isRecord(from.user) ? from.user : null;
      const senderId = text(user?.id) ?? null;
      const senderName = text(user?.displayName) ?? undefined;

      // The conversation is the channel the subscription names. A channel
      // message resource ends in `/messages/{id}`, so the channel is the path
      // without those two segments; one record still describes what it watches.
      const segments = resource.split("/").filter(Boolean);
      const conversation = segments.includes("messages")
        ? `/${segments.slice(0, segments.lastIndexOf("messages")).join("/")}`
        : resource;
      const inbound: IngressMessage = {
        messageId,
        chatId: conversation,
        text: content,
        ...(senderId ? { sender: { id: senderId, ...(senderName ? { name: senderName } : {}) } } : {}),
        chatKind: "group",
      };
      return {
        kind: "message",
        message: inbound,
        key: ingressMessageKey(conversation, messageId),
      };
    },
  };
}

/**
 * The URL validation, which arrives as a POST with `?validationToken=`.
 *
 * Graph proves the URL by posting the token it was given and reading it back as
 * plain text, within ten seconds. Nothing else in the request is read.
 */
export function createGraphValidation(): (url: URL) => IngressHandshake | null {
  return (url: URL) => {
    const token = url.searchParams.get("validationToken");
    if (token === null) return null;
    return { status: 200, body: token, contentType: "text/plain; charset=utf-8" };
  };
}

/** What this channel answers an accepted notification with. */
export const GRAPH_ACCEPT_REPLY = {
  status: 202,
  body: "",
  contentType: "text/plain; charset=utf-8",
} as const;
