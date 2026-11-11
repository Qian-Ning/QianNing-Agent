import { describe, expect, it, vi } from "vitest";

import {
  projectRaftMessage,
  runRaftInbound,
  type RaftBatchLike,
  type RaftInboxClient,
  type RaftMessageLike,
} from "./messaging-raft-inbound.js";
import type { IngressMessage } from "./messaging-ingress.js";

function message(overrides: Partial<RaftMessageLike> = {}): RaftMessageLike {
  return {
    id: "msg_1",
    shortId: "msg_1",
    seq: 1,
    target: "#general",
    timestamp: "2026-11-12T10:00:00.000Z",
    sender: { type: "human", name: "ada" },
    content: "hello",
    ...overrides,
  };
}

function batches(...pages: RaftBatchLike[]): RaftInboxClient {
  const queue = [...pages];
  const commits: Array<{ cursor: number | null } | undefined> = [];
  return {
    inbox: {
      async check() {
        const next = queue.shift();
        if (next === undefined) {
          return { ok: true, state: "empty", data: { messages: [], cursor: null, hasMore: false } };
        }
        return { ok: true, state: "batch", data: next };
      },
      async commit(target) {
        commits.push(target);
        return {};
      },
    },
  };
}

describe("projectRaftMessage", () => {
  it("keeps the reply target as the conversation and names the sender", () => {
    const projected = projectRaftMessage(message());
    expect(projected?.chatId).toBe("#general");
    expect(projected?.text).toBe("hello");
    expect(projected?.sender?.name).toBe("ada");
    expect(projected?.sentAt).toBe(Date.parse("2026-11-12T10:00:00.000Z"));
  });

  it("drops a message with no text rather than starting an empty turn", () => {
    expect(projectRaftMessage(message({ content: "   " }))).toBeNull();
  });

  it("falls back to the sequence when the server sent no id", () => {
    const projected = projectRaftMessage(message({ id: null, seq: 42 }));
    expect(projected?.messageId).toBe("seq-42");
  });

  it("reads a direct conversation and a thread target", () => {
    expect(projectRaftMessage(message({ target: "dm:@ada" }))?.chatKind).toBe("private");
    const threaded = projectRaftMessage(message({ target: "#general:abc123" }));
    expect(threaded?.chatKind).toBe("channel");
    expect(threaded?.threadId).toBe("abc123");
  });
});

describe("runRaftInbound", () => {
  it("delivers every message in a batch before committing its cursor", async () => {
    const delivered: IngressMessage[] = [];
    const order: string[] = [];
    const client = batches({ messages: [message()], cursor: 7, hasMore: false });
    const commits: Array<{ cursor: number | null } | undefined> = [];
    const wrapped: RaftInboxClient = {
      inbox: {
        check: (request) => client.inbox.check(request),
        commit: async (target) => {
          order.push("commit");
          commits.push(target);
          return {};
        },
      },
    };

    const controller = new AbortController();
    const run = runRaftInbound({
      client: wrapped,
      idleMs: 1,
      signal: controller.signal,
      onMessage: (m) => {
        order.push("deliver");
        delivered.push(m);
      },
    });

    await vi.waitFor(() => expect(commits.length).toBe(1));
    controller.abort();
    await run;

    expect(delivered).toHaveLength(1);
    expect(order.slice(0, 2)).toEqual(["deliver", "commit"]);
    expect(commits[0]).toEqual({ cursor: 7 });
  });

  it("reports a refused pull and keeps the cursor where it was", async () => {
    const failures: string[] = [];
    let calls = 0;
    const client: RaftInboxClient = {
      inbox: {
        async check() {
          calls += 1;
          if (calls === 1) {
            return { ok: false, state: "error", error: { message: "rate limited" } };
          }
          return { ok: true, state: "empty", data: { messages: [], cursor: null, hasMore: false } };
        },
        async commit() {
          return {};
        },
      },
    };

    const controller = new AbortController();
    const run = runRaftInbound({
      client,
      idleMs: 1,
      signal: controller.signal,
      onMessage: () => {},
      onFailure: (error) => failures.push(error),
    });

    await vi.waitFor(() => expect(calls).toBeGreaterThan(1));
    controller.abort();
    await run;
    expect(failures).toEqual(["rate limited"]);
  });

  it("stops when the signal aborts even with an empty inbox", async () => {
    const controller = new AbortController();
    const run = runRaftInbound({
      client: batches(),
      idleMs: 1,
      signal: controller.signal,
      onMessage: () => {},
    });
    controller.abort();
    await expect(run).resolves.toBeUndefined();
  });
});
