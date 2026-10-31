/**
 * The inbound Telegram channel — the adapter half, split out of the driver.
 *
 * Telegram is the channel whose *connect* is a poll: each call opens one
 * outbound HTTPS request and returns the updates it carried, so no inbound port
 * is bound and no public callback URL is needed (ADR 0326). The poll loop, its
 * cursor and its retry floor are the shared polling transport's
 * (`messaging-ingress-polling.ts`); the driver in `messaging-inbound.ts` keeps
 * only the routing decision. This module supplies what is Telegram's own:
 *
 * - **connect** — one `getUpdates` call from a cursor;
 * - **normalise** — [`normaliseTelegramUpdate`]: one update, with the update id
 *   as the cursor and the shared replay key derived from the chat and message;
 * - **limit** — [`TELEGRAM_MESSAGE_LIMIT`], for the shared chunker. Replies
 *   leave through host-core's sender, so this module declares the limit without
 *   growing a second send path, and declares no `deliver`.
 *
 * It imports only types from `messaging-inbound.ts`: the driver re-exports this
 * module's symbols, so a caller that has always imported them from the driver
 * still can, and there is no runtime cycle between the two.
 */

import {
  ingressMessageKey,
  type IngressNormalisation,
  type IngressSender,
  type PollIngressAdapter,
} from "./messaging-ingress.js";
import type { TelegramInboundTransport } from "./messaging-inbound.js";

/**
 * Telegram's message size limit, in characters, for the shared reply chunker.
 * The send path itself is host-core's (`crates/host-core/src/messaging_telegram`),
 * so this adapter declares the limit without growing a second sender.
 */
export const TELEGRAM_MESSAGE_LIMIT = 4096;


/** The conversation kinds the shared shape names, read from a raw value. */
function chatKindOf(value: unknown): "private" | "group" | "channel" | undefined {
  return value === "private" || value === "group" || value === "channel" ? value : undefined;
}

/**
 * Telegram's answer to who sent the message, in what kind of chat, and when.
 *
 * Every field is optional and independently checked: a payload missing `from`
 * still contributes its date, and a chat with an unknown `type` contributes no
 * kind rather than a guessed one. A group's message and a private one are
 * otherwise identical on the wire, which is why the envelope needs this.
 */
function telegramMetadata(message: Record<string, unknown>): {
  sender?: IngressSender;
  sentAt?: number;
  chatKind?: "private" | "group" | "channel";
  threadId?: string;
} {
  const metadata: {
    sender?: IngressSender;
    sentAt?: number;
    chatKind?: "private" | "group" | "channel";
    threadId?: string;
  } = {};

  const from = isRecord(message.from) ? message.from : undefined;
  if (from) {
    const id =
      typeof from.id === "number" || typeof from.id === "string" ? String(from.id) : "";
    if (id) {
      const name = [from.first_name, from.last_name]
        .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
        .join(" ");
      metadata.sender = {
        id,
        ...(name ? { name } : {}),
        ...(typeof from.username === "string" && from.username ? { handle: from.username } : {}),
      };
    }
  }

  // Telegram's `date` is Unix seconds; the shared shape carries milliseconds.
  if (typeof message.date === "number" && Number.isFinite(message.date)) {
    metadata.sentAt = message.date * 1000;
  }

  const chat = isRecord(message.chat) ? message.chat : undefined;
  if (chat?.type === "private") metadata.chatKind = "private";
  else if (chat?.type === "group" || chat?.type === "supergroup") metadata.chatKind = "group";
  else if (chat?.type === "channel") metadata.chatKind = "channel";

  if (
    typeof message.message_thread_id === "number" ||
    typeof message.message_thread_id === "string"
  ) {
    metadata.threadId = String(message.message_thread_id);
  }

  return metadata;
}

/**
 * Project one Telegram update onto the shared shape.
 *
 * The update id is the poll cursor, so an update the cursor can advance past is
 * reported even when it carries nothing this path may act on: `ignored` means
 * the entry is not an update at all (no numeric id), while a message-less update
 * still moves the cursor and is projected as `filtered`.
 */
export type TelegramUpdateNormalisation =
  | { kind: "update"; updateId: number; normalisation: IngressNormalisation }
  | { kind: "ignored" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Project one Telegram update onto the shared shape, or report it unusable. */
export function normaliseTelegramUpdate(entry: unknown): TelegramUpdateNormalisation {
  if (!isRecord(entry)) return { kind: "ignored" };
  const updateId = typeof entry.update_id === "number" ? entry.update_id : null;
  if (updateId === null) return { kind: "ignored" };
  const message = entry.message;
  if (!isRecord(message)) {
    return {
      kind: "update",
      updateId,
      normalisation: { kind: "filtered", reason: "update carries no message" },
    };
  }
  const messageId = typeof message.message_id === "number" ? String(message.message_id) : "";
  const chat = isRecord(message.chat) ? message.chat : undefined;
  const chatId = typeof chat?.id === "number" || typeof chat?.id === "string" ? String(chat.id) : "";
  if (!messageId || !chatId) {
    return {
      kind: "update",
      updateId,
      normalisation: { kind: "filtered", reason: "message names no chat or id" },
    };
  }
  const text = typeof message.text === "string" ? message.text : "";
  return {
    kind: "update",
    updateId,
    normalisation: {
      kind: "message",
      message: { messageId, chatId, text, ...telegramMetadata(message) },
      key: ingressMessageKey(chatId, messageId),
    },
  };
}

/**
 * The Telegram ingress adapter: the platform-specific seams and nothing else.
 *
 * A long poll is the channel's *connect*: each call opens one outbound HTTPS
 * request and returns the updates it carried. The platform parses its own
 * envelope — the cursor rides in the same body, so the poll result is already
 * projected — and [`normaliseTelegramUpdate`] is the one projection both the
 * transport and the conformance suite use.
 */
export function createTelegramIngressAdapter(options: {
  transport: TelegramInboundTransport;
  messageLimit?: number;
}): PollIngressAdapter {
  return {
    platform: "telegram",
    kind: "poll",
    messageLimit: options.messageLimit ?? TELEGRAM_MESSAGE_LIMIT,
    normalise: (raw) => {
      // A poll result is already projected (its cursor came from the same
      // envelope), so a message is accepted as itself and an update is
      // projected the way the transport projects it.
      if (isRecord(raw) && typeof raw.messageId === "string" && typeof raw.chatId === "string") {
        // The poll result is already projected, so its metadata is carried
        // through as it arrived rather than re-derived from a shape it no
        // longer has.
        const chatKind = chatKindOf(raw.chatKind);
        const message = {
          messageId: raw.messageId,
          chatId: raw.chatId,
          text: typeof raw.text === "string" ? raw.text : "",
          ...(isRecord(raw.sender) ? { sender: raw.sender as IngressSender } : {}),
          ...(typeof raw.sentAt === "number" ? { sentAt: raw.sentAt } : {}),
          ...(chatKind ? { chatKind } : {}),
          ...(typeof raw.threadId === "string" ? { threadId: raw.threadId } : {}),
        };
        return { kind: "message", message, key: ingressMessageKey(message.chatId, message.messageId) };
      }
      const projected = normaliseTelegramUpdate(raw);
      if (projected.kind === "ignored") {
        return { kind: "filtered", reason: "entry is not a Telegram update" };
      }
      return projected.normalisation;
    },
    poll: async (cursor, signal) => {
      const result = await options.transport.poll(cursor, signal);
      return result.ok
        ? { ok: true, events: result.messages, nextCursor: result.nextOffset }
        : result;
    },
  };
}
