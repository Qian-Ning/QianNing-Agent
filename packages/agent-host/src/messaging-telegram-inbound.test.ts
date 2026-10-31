import { describe, expect, it } from "vitest";

import { normaliseTelegramUpdate } from "./messaging-telegram-inbound.js";

/** The projection under test, or a failure that says why it was not a message. */
function project(update: Record<string, unknown>) {
  const result = normaliseTelegramUpdate(update);
  if (result.kind !== "update") throw new Error("update was ignored");
  if (result.normalisation.kind !== "message") {
    throw new Error(`filtered: ${result.normalisation.reason}`);
  }
  return result.normalisation.message;
}

function update(message: Record<string, unknown>): Record<string, unknown> {
  return { update_id: 1, message: { message_id: 10, chat: { id: 99, type: "private" }, text: "hi", ...message } };
}

describe("normaliseTelegramUpdate · envelope metadata", () => {
  it("carries the sender's name and handle, the chat kind and the send time", () => {
    const message = project(
      update({
        from: { id: 42, first_name: "Alice", last_name: "Lee", username: "alice" },
        date: 1_800_000_000,
      }),
    );
    expect(message).toMatchObject({
      messageId: "10",
      chatId: "99",
      text: "hi",
      chatKind: "private",
      sentAt: 1_800_000_000_000,
      sender: { id: "42", name: "Alice Lee", handle: "alice" },
    });
  });

  it("treats a supergroup as a group and a channel as a channel", () => {
    expect(project(update({ chat: { id: 1, type: "supergroup" } })).chatKind).toBe("group");
    expect(project(update({ chat: { id: 1, type: "channel" } })).chatKind).toBe("channel");
    // An unrecognised type contributes nothing rather than a guess.
    expect(project(update({ chat: { id: 1, type: "forum" } }))).not.toHaveProperty("chatKind");
  });

  it("keeps the timestamp when the payload has no sender", () => {
    const message = project(update({ date: 1_800_000_000 }));
    expect(message.sentAt).toBe(1_800_000_000_000);
    expect(message).not.toHaveProperty("sender");
  });

  it("omits a sender that carries no id and a date that is not a number", () => {
    const message = project(update({ from: { first_name: "Nobody" }, date: "1800000000" }));
    expect(message).not.toHaveProperty("sender");
    expect(message).not.toHaveProperty("sentAt");
  });

  it("carries the thread a topic reply belongs to", () => {
    expect(project(update({ message_thread_id: 77 })).threadId).toBe("77");
  });
});
