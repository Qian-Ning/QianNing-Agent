import { describe, expect, it } from "vitest";

import type { IngressSocket } from "./messaging-ingress-socket.js";
import { SimplexClient, projectSimplexEvent, SIMPLEX_START_COMMAND } from "./messaging-simplex-inbound.js";

function directEvent(text: string, overrides: Record<string, unknown> = {}) {
  return {
    corrId: "evt-1",
    resp: {
      type: "newChatItems",
      chatItems: [
        {
          chatInfo: {
            type: "direct",
            contact: { contactId: 7, localDisplayName: "ann", profile: { displayName: "Ann" } },
          },
          chatItem: {
            chatDir: { type: "directRcv" },
            meta: { itemId: 42, itemStatus: { type: "rcvNew" }, createdAt: 1700000000000 },
            content: { type: "rcvMsgContent", msgContent: { type: "text", text } },
          },
        },
      ],
      ...overrides,
    },
  };
}

function groupEvent(text: string) {
  return {
    corrId: "evt-2",
    resp: {
      type: "newChatItems",
      chatItems: [
        {
          chatInfo: {
            type: "group",
            groupInfo: { groupId: 3, localDisplayName: "team", profile: { displayName: "Team" } },
          },
          chatItem: {
            chatDir: { type: "groupRcv" },
            meta: { itemId: 9 },
            content: { type: "rcvMsgContent", msgContent: { type: "text", text } },
          },
        },
      ],
    },
  };
}

describe("the SimpleX projection", () => {
  it("reads a direct message", () => {
    const result = projectSimplexEvent(directEvent("deploy please"));
    expect(result?.kind).toBe("message");
    if (!result || result.kind !== "message") return;
    expect(result.message).toMatchObject({
      messageId: "42",
      chatId: "7",
      text: "deploy please",
      chatKind: "private",
      sender: { id: "7" },
    });
  });

  it("addresses a group message by its group", () => {
    const result = projectSimplexEvent(groupEvent("hi all"));
    expect(result?.kind).toBe("message");
    if (!result || result.kind !== "message") return;
    expect(result.message.chatId).toBe("group:3");
    expect(result.message.chatKind).toBe("group");
  });

  it("ignores the daemon's other events", () => {
    expect(projectSimplexEvent({ resp: { type: "contactSubscribed" } })).toBeNull();
  });

  it("filters this channel's own send coming back", () => {
    const event = directEvent("echo");
    (event.resp.chatItems[0]!.chatItem.chatDir as { type: string }).type = "directSnd";
    const result = projectSimplexEvent(event);
    expect(result?.kind).toBe("filtered");
    expect(result && result.kind === "filtered" && result.reason).toContain("own");
  });

  it("filters a non-text content", () => {
    const event = directEvent("");
    (event.resp.chatItems[0]!.chatItem.content.msgContent as { type: string }).type = "image";
    const result = projectSimplexEvent(event);
    expect(result?.kind).toBe("filtered");
  });
});

/** A socket double: records frames, lets the test push one back. */
function fakeSocket() {
  const sent: string[] = [];
  let onMessage: ((data: string) => void) | null = null;
  let onClose: ((code?: number, reason?: string) => void) | null = null;
  const socket: IngressSocket = {
    send(data: string) {
      sent.push(data);
    },
    close() {
      onClose?.(1000, "closed");
    },
    onMessage(handler) {
      onMessage = handler;
    },
    onClose(handler) {
      onClose = handler;
    },
    onError() {},
  };
  return {
    socket,
    sent,
    push(data: string) {
      onMessage?.(data);
    },
    close: () => onClose?.(1000, "closed"),
  };
}

describe("the SimpleX client", () => {
  it("sends /_start once the socket opens", async () => {
    const fake = fakeSocket();
    const client = new SimplexClient({ open: () => fake.socket, onMessage: async () => {} });
    await client.connect();
    expect(fake.sent).toHaveLength(1);
    expect(JSON.parse(fake.sent[0]!)).toEqual({ corrId: "pi-start", cmd: SIMPLEX_START_COMMAND });
    expect(client.isReady).toBe(true);
  });

  it("delivers a projected message to the handler", async () => {
    const fake = fakeSocket();
    const seen: string[] = [];
    const client = new SimplexClient({
      open: () => fake.socket,
      onMessage: async (message) => {
        seen.push(message.text);
      },
    });
    await client.connect();
    fake.push(JSON.stringify(directEvent("hello")));
    await Promise.resolve();
    expect(seen).toEqual(["hello"]);
  });

  it("drops a frame it cannot read without throwing", async () => {
    const fake = fakeSocket();
    const audits: string[] = [];
    const client = new SimplexClient({
      open: () => fake.socket,
      onMessage: async () => {},
      audit: (entry) => audits.push(entry.kind),
    });
    await client.connect();
    fake.push("not json");
    await Promise.resolve();
    expect(audits).toContain("malformed");
  });

  it("ends the wait when the socket closes", async () => {
    const fake = fakeSocket();
    const client = new SimplexClient({ open: () => fake.socket, onMessage: async () => {} });
    await client.connect();
    const waiting = client.waitForClose();
    fake.close();
    await expect(waiting).resolves.toBeUndefined();
  });
});
