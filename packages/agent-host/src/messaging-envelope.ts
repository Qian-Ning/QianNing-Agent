/**
 * The context envelope: who sent an inbound message, from what kind of
 * conversation, and when — attached where the message becomes a turn.
 *
 * A chat message reaches the agent as bare text today, so a session that is
 * reachable from more than one channel cannot tell which one it is answering,
 * and a group message is indistinguishable from a private one. The platform
 * knows both facts at the moment it hands the message over; this module is
 * where they survive the crossing.
 *
 * Three rules the shape follows:
 *
 * - **The body is never rewritten.** The text between the tags is exactly the
 *   text the platform delivered. Escaping it would corrupt what the person
 *   actually said, and a prompt is not markup we get to repair.
 * - **The header degrades.** A channel that cannot say who sent a message still
 *   gets a channel line; a channel that knows everything gets every attribute.
 *   Nothing is invented to fill a slot.
 * - **Commands are read before this runs.** A body starting with `/stop` is
 *   mapped to an operation against the raw text upstream; the envelope is
 *   applied only to a turn's input, so `/stop` never becomes "a message that
 *   mentions /stop".
 */

import type { IngressMessage, IngressSender } from "./messaging-ingress.js";

/** One attribute value, safe to sit inside double quotes. */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/[\r\n]+/g, " ");
}

/** How the sender is named to the model: a name, a handle, or the raw id. */
function formatSender(sender: IngressSender | undefined): string | null {
  if (!sender) return null;
  const name = sender.name?.trim();
  const handle = sender.handle?.trim().replace(/^@/, "");
  if (name && handle) return `${name} (@${handle})`;
  if (name) return name;
  if (handle) return `@${handle}`;
  return sender.id.trim() || null;
}

/** The platform's timestamp, second precision, UTC — or null when unusable. */
function formatTime(sentAt: number | undefined): string | null {
  if (typeof sentAt !== "number" || !Number.isFinite(sentAt)) return null;
  const date = new Date(sentAt);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.toISOString().slice(0, 19)}Z`;
}

/**
 * The turn input for one inbound message.
 *
 * `channel` is the platform's own name (`telegram`, `slack`, …); it is always
 * known, so every message carries at least that. Everything else is added only
 * when the channel's projection filled it in.
 */
export function wrapInboundText(message: IngressMessage, channel: string): string {
  const sender = formatSender(message.sender);
  const time = formatTime(message.sentAt);
  const thread = message.threadId?.trim() || null;

  // A body that closes the tag early would end the envelope before the message
  // does, so a message containing it takes the header-line form instead. The
  // check is on the raw body: escaping is not available to us here.
  if (message.text.includes("</msg")) {
    const parts = [channel, message.chatKind ?? null, sender, time, thread]
      .filter((part): part is string => typeof part === "string" && part.length > 0);
    return `[${parts.join(" · ")}]\n${message.text}`;
  }

  const attributes = [`channel="${escapeAttribute(channel)}"`];
  if (message.chatKind) attributes.push(`chat="${escapeAttribute(message.chatKind)}"`);
  if (sender) attributes.push(`sender="${escapeAttribute(sender)}"`);
  if (time) attributes.push(`time="${time}"`);
  if (thread) attributes.push(`thread="${escapeAttribute(thread)}"`);

  return `<msg ${attributes.join(" ")}>\n${message.text}\n</msg>`;
}
