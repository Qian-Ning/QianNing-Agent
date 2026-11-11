/**
 * Raft as an inbound channel.
 *
 * The service hands messages out through an inbox: one bounded pull, then a
 * commit of the batch's cursor, which the *next* pull acknowledges on the server.
 * That is the same shape as the other polling channels here, so this module is a
 * poll loop plus a projection, with no transport of its own.
 *
 * The client is injected rather than constructed, so the loop is tested against a
 * fake inbox without a Raft server or a credential.
 */

import type { IngressMessage } from "./messaging-ingress.js";

export const RAFT_SETTINGS_SECTION = "messagingRaft";
export const RAFT_FORMAT = "pi-desktop-messaging-raft";
export const RAFT_FORMAT_VERSION = 1;
export const RAFT_CREDENTIAL_SECRET_REF = "secret:messaging-raft:credential";

/** How often an idle inbox is asked again. */
export const RAFT_IDLE_INTERVAL_MS = 3_000;

/** The parts of the SDK this module uses. Structural, so a fake can stand in. */
export type RaftInboxClient = {
  inbox: {
    check(request?: { since?: number; limit?: number }): Promise<RaftCheckOutcome>;
    commit(target?: { cursor: number | null }): Promise<unknown>;
  };
};

export type RaftMessageLike = {
  id: string | null;
  shortId: string | null;
  seq: number | null;
  target: string;
  timestamp: string | null;
  sender: { type: string; name: string | null };
  content: string;
};

export type RaftBatchLike = {
  messages: RaftMessageLike[];
  cursor: number | null;
  hasMore: boolean;
};

export type RaftCheckOutcome =
  | { ok: true; state: string; data: RaftBatchLike }
  | { ok: false; state: string; error?: { message?: string } };

/**
 * One Raft message as the shared ingress shape, or `null` when there is nothing
 * to answer: Raft delivers system events and empty bodies through the same inbox,
 * and inventing a message for those would start a turn with no text in it.
 */
export function projectRaftMessage(message: RaftMessageLike): IngressMessage | null {
  const text = message.content.trim();
  if (text === "") return null;
  const id = message.id ?? (message.seq === null ? "" : `seq-${message.seq}`);
  if (id === "") return null;
  const name = message.sender.name ?? undefined;
  const sentAt = message.timestamp ? Date.parse(message.timestamp) : Number.NaN;
  return {
    messageId: id,
    // `target` is where a reply goes: `#channel`, `dm:@peer`, or a thread form.
    chatId: message.target,
    text: message.content,
    ...(name ? { sender: { id: name, name } } : {}),
    ...(Number.isFinite(sentAt) ? { sentAt } : {}),
    chatKind: message.target.startsWith("#")
      ? message.target.includes(":")
        ? "channel"
        : "channel"
      : "private",
    ...(message.target.includes(":") ? { threadId: message.target.split(":")[1] } : {}),
  };
}

export type RaftInboundOptions = {
  client: RaftInboxClient;
  /** Where accepted messages go. */
  onMessage: (message: IngressMessage) => Promise<void> | void;
  /** The poll interval while the inbox is empty. */
  idleMs?: number;
  /** The owner's abort signal; the loop leaves `run` once it aborts. */
  signal: AbortSignal;
  /** Reports a pull that failed; the cursor is not advanced, so nothing is lost. */
  onFailure?: (error: string) => void;
};

/**
 * Poll the inbox until the signal aborts.
 *
 * The order is deliberate: project and deliver first, commit second. Committing
 * before delivery would acknowledge a batch the runtime never saw, and the server
 * does not hand a batch out twice.
 */
export async function runRaftInbound(options: RaftInboundOptions): Promise<void> {
  const idle = options.idleMs ?? RAFT_IDLE_INTERVAL_MS;
  let cursor: number | null = null;

  while (!options.signal.aborted) {
    let outcome: RaftCheckOutcome;
    try {
      outcome = await options.client.inbox.check(cursor === null ? {} : { since: cursor });
    } catch (error) {
      options.onFailure?.(String(error));
      await pause(idle, options.signal);
      continue;
    }

    if (!outcome.ok) {
      options.onFailure?.(outcome.error?.message ?? "the inbox pull was refused");
      await pause(idle, options.signal);
      continue;
    }

    const batch = outcome.data;
    for (const raw of batch.messages) {
      const message = projectRaftMessage(raw);
      if (message === null) continue;
      await options.onMessage(message);
    }

    if (batch.cursor !== null) {
      cursor = batch.cursor;
      try {
        await options.client.inbox.commit({ cursor });
      } catch (error) {
        options.onFailure?.(String(error));
      }
    }

    // A trimmed batch means there is more waiting; go straight back for it.
    if (!batch.hasMore && batch.messages.length === 0) {
      await pause(idle, options.signal);
    }
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}
