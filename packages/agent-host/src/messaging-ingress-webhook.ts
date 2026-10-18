/**
 * The webhook transport: the platform calls in with one HTTP request per event,
 * and the Host answers inside that request.
 *
 * This is the third delivery shape, beside the socket the Host holds open and
 * the cursor the Host polls. Slack's HTTP mode is the channel that needs it, and
 * every callback-shaped channel after it has the same problem: a request that
 * must be parsed, projected, deduplicated and answered — with the answer sent
 * only once the event is durably recorded, so a platform that redelivers on a
 * non-2xx does not lose a command.
 *
 * The transport is deliberately passive. It binds no port and opens no listener:
 * the caller owns the HTTP surface, and hands the transport one already-read
 * request ([`IngressWebhookRequest`]). That keeps the acceptance precondition
 * "no inbound port is opened by this layer" true here too, and it means the
 * shared layer never grows a server.
 *
 * The reply body is the platform's acknowledgement spelling, supplied by the
 * adapter's normalisation where the platform needs one; the transport's own
 * `ack` shape is a plain `{ challenge }` echo or an empty 200.
 *
 * The HTTP surface this transport is called from is
 * [`IngressWebhookReceiver`](./messaging-ingress-receiver.js): it owns the
 * port, verifies the raw bytes, enforces the replay window and answers before
 * this `handle` resolves. `handle` itself stays awaitable and ordering-exact —
 * authenticate, parse, project, gate, then answer — which is what the receiver
 * relies on when it decides not to await it.
 */

import {
  IngressGate,
  ingressAudit,
  type IngressAudit,
  type IngressHandledStore,
  type IngressMessage,
  type IngressNormalise,
  type WebhookIngressAdapter,
} from "./messaging-ingress.js";

/** One inbound request, already read by whatever owns the HTTP surface. */
export type IngressWebhookRequest = {
  /** The raw request body; a malformed body is an outcome, not a throw. */
  body: string;
  /** The request's headers, lowercased by the caller. */
  headers?: Record<string, string>;
};

/** What to answer. `body` is JSON-serialised by the caller. */
export type IngressWebhookResponse = {
  status: number;
  body?: Record<string, unknown>;
};

export type WebhookIngressOptions = {
  /** The restart-durable guard; the same gate the socket channels use. */
  handled: IngressHandledStore;
  /** The routing path's one handler. */
  onMessage: (message: IngressMessage) => Promise<void>;
  /** Where audit records go; absent means they are dropped. */
  audit?: IngressAudit;
};

/**
 * The webhook transport for one adapter.
 *
 * `handle` applies the gate's ordering — a redelivery is answered without being
 * handled again, a handled message is recorded before the 200 goes out, and a
 * handler or record failure answers non-2xx so the platform redelivers.
 */
export class WebhookIngressTransport {
  private readonly adapter: WebhookIngressAdapter;
  private readonly gate: IngressGate;
  private readonly audit: IngressAudit;

  constructor(adapter: WebhookIngressAdapter, options: WebhookIngressOptions) {
    this.adapter = adapter;
    this.gate = new IngressGate({
      handled: options.handled,
      onMessage: options.onMessage,
      ...(options.audit ? { audit: options.audit } : {}),
    });
    this.audit = ingressAudit(options.audit);
  }

  /** The platform's message limit, for a caller that needs to chunk a reply. */
  get messageLimit(): number {
    return this.adapter.messageLimit;
  }

  /** Apply one request; the answer describes what happened, never its text. */
  async handle(request: IngressWebhookRequest): Promise<IngressWebhookResponse> {
    let raw: unknown;
    try {
      raw = JSON.parse(request.body);
    } catch {
      this.audit({ kind: "malformed", reason: "the body is not JSON" });
      return { status: 400 };
    }
    const normalisation = this.adapter.normalise(raw);
    if (normalisation.kind !== "message") {
      // A filtered or malformed event is answered 200: the platform should not
      // redeliver something this channel will never act on.
      this.audit({
        kind: "filtered",
        reason: normalisation.reason,
        ...(normalisation.channelId ? { channelId: normalisation.channelId } : {}),
      });
      return { status: 200 };
    }
    const outcome = await this.gate.ingest(normalisation.message, normalisation.key);
    if (outcome === "delivered" || outcome === "duplicate") return { status: 200 };
    // A handler or record failure is answered non-2xx, so the platform
    // redelivers and the command is re-applied rather than lost.
    return { status: 500 };
  }
}
