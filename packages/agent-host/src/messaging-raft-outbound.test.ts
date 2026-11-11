import { describe, expect, it } from "vitest";

import { createRaftSender, type RaftSendClient } from "./messaging-raft-outbound.js";

type Sent = { target: string; content: string; idempotencyKey: string };

function client(options: {
  joinOk?: boolean;
  sendOk?: boolean;
  throwOnSend?: boolean;
  id?: string | null;
}): { client: RaftSendClient; sent: Sent[]; joins: string[] } {
  const sent: Sent[] = [];
  const joins: string[] = [];
  return {
    sent,
    joins,
    client: {
      channels: {
        async join({ target }) {
          joins.push(target);
          return options.joinOk === false
            ? { ok: false, error: { message: "no such channel" } }
            : { ok: true };
        },
      },
      messages: {
        async send(request) {
          if (options.throwOnSend) throw new Error("socket closed");
          sent.push(request);
          return options.sendOk === false
            ? { ok: false, error: { message: "held: read the conversation first" } }
            : { ok: true, data: { id: options.id === undefined ? "msg_9" : options.id } };
        },
      },
    },
  };
}

describe("createRaftSender", () => {
  it("carries the delivery id as the idempotency key and returns the message id", async () => {
    const fake = client({});
    const sender = createRaftSender(fake.client);

    const result = await sender.send({ target: "#general", text: "hi", idempotencyKey: "d-1" });

    expect(result).toEqual({ ok: true, messageId: "msg_9" });
    expect(fake.sent[0]).toEqual({ target: "#general", content: "hi", idempotencyKey: "d-1" });
  });

  it("treats a refused send as terminal, because retrying would be held again", async () => {
    const fake = client({ sendOk: false });
    const sender = createRaftSender(fake.client);

    const result = await sender.send({ target: "#general", text: "hi", idempotencyKey: "d-2" });

    expect(result).toEqual({
      ok: false,
      reason: "held: read the conversation first",
      retryable: false,
    });
  });

  it("treats a transport failure as retryable", async () => {
    const fake = client({ throwOnSend: true });
    const sender = createRaftSender(fake.client);

    const result = await sender.send({ target: "#general", text: "hi", idempotencyKey: "d-3" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(true);
  });

  it("joins once per target for the life of the sender", async () => {
    const fake = client({});
    const sender = createRaftSender(fake.client);

    await sender.join("#general");
    await sender.join("#general");
    await sender.join("#random");

    expect(fake.joins).toEqual(["#general", "#random"]);
  });

  it("reports a refused join as terminal", async () => {
    const fake = client({ joinOk: false });
    const sender = createRaftSender(fake.client);

    const result = await sender.join("#secret");

    expect(result).toEqual({ ok: false, reason: "no such channel", retryable: false });
    expect(fake.joins).toEqual(["#secret"]);
  });

  it("returns no message id when the server names none", async () => {
    const fake = client({ id: null });
    const sender = createRaftSender(fake.client);

    const result = await sender.send({ target: "dm:@ada", text: "hi", idempotencyKey: "d-4" });

    expect(result).toEqual({ ok: true, messageId: null });
  });
});
