/**
 * SimpleX inbound: a WebSocket to the `simplex-chat` daemon the user runs.
 *
 * # The daemon is the client
 *
 * SimpleX has no server to register a bot with: the user runs `simplex-chat -p
 * 5225`, that process owns the identity, and it exposes a JSON command/event
 * socket. This channel is a client of *that* socket — the same arrangement as
 * every other SimpleX integration, and the reason nothing here needs a public
 * URL.
 *
 * # Two things the protocol requires and are easy to miss
 *
 * 1. `/_start` must be sent before the daemon pushes any event. Without it the
 *    daemon stores messages and tells this Host nothing.
 * 2. Sends address a chat by id (`@<contactId>`, `#<groupId>`), not by display
 *    name: a name is a lookup that silently resolves to nothing.
 */

import {
  SocketIngressClient,
  type IngressSocket,
  type IngressSocketFactory,
  type SocketIngressClientOptions,
} from "./messaging-ingress-socket.js";
import {
  ingressMessageKey,
  type IngressMessage,
  type IngressNormalisation,
  type SocketIngressAdapter,
} from "./messaging-ingress.js";

/** The path segment this platform is served under: `/webhooks/simplex` (unused: socket). */
export const MESSAGING_SIMPLEX_PLATFORM = "simplex";

/** The settings section a SimpleX channel's record lives under. */
export const SIMPLEX_SETTINGS_SECTION = "messagingSimplex";

/** The record format and version this build writes and reads. */
export const SIMPLEX_FORMAT = "pi-desktop-messaging-simplex";
export const SIMPLEX_FORMAT_VERSION = 1;

/** SimpleX has no hard limit; this is a chunking sanity bound. */
export const SIMPLEX_MESSAGE_LIMIT = 8_000;

/** The most delivery ids the durable replay guard remembers. */
export const SIMPLEX_HANDLED_CAPACITY = 2_048;

/** The command that turns the event stream on. */
export const SIMPLEX_START_COMMAND = "/_start";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** The chat a `chatItem` belongs to, and whether it is a group. */
function chatOf(chatInfo: Record<string, unknown>): { id: string; group: boolean } | null {
  const kind = text(chatInfo.type);
  if (kind === "direct") {
    const contact = isRecord(chatInfo.contact) ? chatInfo.contact : null;
    const id = contact && typeof contact.contactId === "number" ? String(contact.contactId) : null;
    return id ? { id, group: false } : null;
  }
  if (kind === "group") {
    const group = isRecord(chatInfo.groupInfo) ? chatInfo.groupInfo : null;
    const id = group && typeof group.groupId === "number" ? String(group.groupId) : null;
    return id ? { id: `group:${id}`, group: true } : null;
  }
  return null;
}

/**
 * Project one `newChatItems` event onto the shared shape.
 *
 * Only received text is a command: `chatDir.type` ends in `Rcv` for a message
 * this Host received, and anything else is this Host's own send coming back.
 */
export function projectSimplexEvent(raw: unknown): IngressNormalisation | null {
  if (!isRecord(raw)) return null;
  const resp = isRecord(raw.resp) ? raw.resp : null;
  if (!resp) return null;
  if (text(resp.type) !== "newChatItems") return null;
  const items = Array.isArray(resp.chatItems) ? resp.chatItems : [];
  if (items.length === 0) return { kind: "filtered", reason: "the event carries no chat item" };

  for (const entry of items) {
    if (!isRecord(entry)) continue;
    const chatInfo = isRecord(entry.chatInfo) ? entry.chatInfo : null;
    const chatItem = isRecord(entry.chatItem) ? entry.chatItem : null;
    if (!chatInfo || !chatItem) continue;

    const chat = chatOf(chatInfo);
    if (!chat) continue;

    const direction = isRecord(chatItem.chatDir) ? text(chatItem.chatDir.type) : null;
    if (direction && !direction.endsWith("Rcv")) {
      return { kind: "filtered", reason: "the message is this channel's own" };
    }

    const content = isRecord(chatItem.content) ? chatItem.content : null;
    const message = content && isRecord(content.msgContent) ? content.msgContent : null;
    const kind = message ? text(message.type) : null;
    if (kind !== "text") {
      return { kind: "filtered", reason: `content type ${kind ?? "unknown"} is not text` };
    }
    const body = message ? text(message.text) : null;
    if (!body) return { kind: "filtered", reason: "the message carries no text" };

    const meta = isRecord(chatItem.meta) ? chatItem.meta : null;
    const itemId = meta && typeof meta.itemId === "number" ? String(meta.itemId) : null;
    if (!itemId) return { kind: "filtered", reason: "the message carries no id" };

    const sender = isRecord(chatInfo.contact) ? chatInfo.contact : null;
    const senderId = sender && typeof sender.contactId === "number" ? String(sender.contactId) : chat.id;

    const inbound: IngressMessage = {
      messageId: itemId,
      chatId: chat.id,
      text: body,
      sender: { id: senderId },
      chatKind: chat.group ? "group" : "private",
    };
    return { kind: "message", message: inbound, key: ingressMessageKey(chat.id, itemId) };
  }
  return { kind: "filtered", reason: "the event carries no usable chat item" };
}

/** The adapter: a socket channel whose projection is the daemon's event shape. */
export function createSimplexAdapter(options: {
  openClient: (onMessage: (message: IngressMessage) => Promise<void>) => SimplexClient;
}): SocketIngressAdapter {
  return {
    kind: "socket",
    platform: MESSAGING_SIMPLEX_PLATFORM,
    messageLimit: SIMPLEX_MESSAGE_LIMIT,
    normalise(raw: unknown): IngressNormalisation {
      return projectSimplexEvent(raw) ?? { kind: "filtered", reason: "the frame is not a chat event" };
    },
    openClient: options.openClient,
  };
}

/**
 * The client: one socket, `/_start` once it opens, and every frame routed
 * through the adapter's projection.
 *
 * `handleFrame` reports its own audit entries for frames it cannot use — a
 * daemon sends plenty of them (contact updates, group changes, delivery
 * receipts) and none of them are errors.
 */
export class SimplexClient extends SocketIngressClient {
  private readonly connect_: () => IngressSocket;
  private readonly onMessage: (message: IngressMessage) => Promise<void>;

  constructor(options: {
    open: () => IngressSocket;
    onMessage: (message: IngressMessage) => Promise<void>;
    audit?: SocketIngressClientOptions["audit"];
  }) {
    super(options.audit ? { audit: options.audit } : {});
    this.connect_ = options.open;
    this.onMessage = options.onMessage;
  }

  async connect(): Promise<void> {
    const socket = this.connect_();
    this.attach(socket);
    // The daemon is reachable the moment the socket opens; it starts pushing
    // events only after `/_start`, which this sends without waiting for a
    // greeting because there is none.
    this.sendText(JSON.stringify({ corrId: "pi-start", cmd: SIMPLEX_START_COMMAND }));
    this.markReady();
  }

  async handleFrame(raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.audit({ kind: "malformed", reason: "the frame is not JSON" });
      return;
    }
    const normalisation = projectSimplexEvent(parsed);
    if (!normalisation) return;
    if (normalisation.kind !== "message") {
      if (normalisation.reason !== "the event carries no chat item") {
        this.audit({ kind: "filtered", reason: normalisation.reason });
      }
      return;
    }
    try {
      await this.onMessage(normalisation.message);
    } catch (error) {
      this.audit({
        kind: "process-failed",
        eventId: normalisation.key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** The production socket factory, kept out of the client so tests need no `ws`. */
export async function createSimplexSocketFactory(): Promise<IngressSocketFactory> {
  const { WebSocket } = await import("ws");
  return (url: string) => {
    const socket = new WebSocket(url);
    return {
      send(data: string) {
        socket.send(data);
      },
      close() {
        socket.close();
      },
      onMessage(handler: (data: string) => void) {
        socket.on("message", (data: unknown) => handler(String(data)));
      },
      onClose(handler: (code?: number, reason?: string) => void) {
        socket.on("close", (code: number, reason: Buffer) => handler(code, reason.toString()));
      },
      onError(handler: (error: unknown) => void) {
        socket.on("error", (error: Error) => handler(error));
      },
    };
  };
}
