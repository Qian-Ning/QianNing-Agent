/**
 * Keeping a long phone conversation inside the window.
 *
 * The desktop hands this to the runtime, which keeps a compaction checkpoint and
 * shows it in the transcript. The phone has the same problem and no such
 * machinery, so this is the smallest honest version of it: when a turn leaves the
 * context nearly full, the older half is summarized once, the summary takes the
 * old messages' place, and the recent tail is kept verbatim. The visible
 * transcript is never touched — only what the model is sent.
 */

/** How full the window may get before the next turn summarizes. */
export const COMPACTION_THRESHOLD = 0.8;

/** Turns kept verbatim; enough that the current work survives a summary. */
export const KEEP_RECENT_MESSAGES = 8;

/** pi's models on a phone are served through one endpoint; assume the common window. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

export function shouldCompact(
  usedTokens: number,
  windowTokens = DEFAULT_CONTEXT_WINDOW,
  threshold = COMPACTION_THRESHOLD,
): boolean {
  if (!Number.isFinite(usedTokens) || usedTokens <= 0) return false;
  const window = Number.isFinite(windowTokens) && windowTokens > 0 ? windowTokens : DEFAULT_CONTEXT_WINDOW;
  return usedTokens / window >= threshold;
}

type PlainMessage = { role?: string; content?: unknown; toolName?: string; timestamp?: number };

function textOf(message: PlainMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
          ? (block as { text: string }).text
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** The transcript the summarizer reads: speaker-labelled, tool results shortened. */
export function compactableText(messages: readonly PlainMessage[]): string {
  return messages
    .map((message) => {
      const role = (message.role ?? "user").toUpperCase();
      const body = textOf(message).trim();
      if (!body) return "";
      return `${role}: ${body.length > 1200 ? body.slice(0, 1200) + " …" : body}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

export const COMPACTION_PROMPT = [
  "You are compacting the earlier part of a conversation so work can continue without those messages.",
  "Write a dense summary that keeps: what the user asked for, constraints and preferences, decisions taken,",
  "concrete facts and identifiers (names, paths, numbers, versions), what was already done, and what is still open.",
  "Do not invent anything, do not give advice, do not ask questions. Plain prose, no headings, under 300 words.",
].join(" ");

/** The single message that replaces everything older than the tail. */
export function summaryMessage(summary: string, dropped: number): PlainMessage {
  return {
    role: "user",
    content:
      `[Earlier conversation — ${dropped} messages compacted]\n` +
      summary.trim(),
    timestamp: Date.now(),
  };
}

/**
 * Returns the message list to send next: a summary of the old part, then the
 * recent tail untouched. A conversation shorter than the tail is left alone.
 */
export function compactMessages<T extends PlainMessage>(
  messages: readonly T[],
  summary: string,
): { messages: Array<T | PlainMessage>; dropped: number } {
  if (messages.length <= KEEP_RECENT_MESSAGES) return { messages: [...messages], dropped: 0 };
  const cut = messages.length - KEEP_RECENT_MESSAGES;
  return {
    messages: [summaryMessage(summary, cut), ...messages.slice(cut)],
    dropped: cut,
  };
}
