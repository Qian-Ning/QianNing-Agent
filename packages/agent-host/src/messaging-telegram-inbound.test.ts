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

/**
 * What a Telegram message carries when it is not text.
 *
 * The projection read only `text`, so a photo with a caption arrived as an empty
 * turn and a sticker arrived as an empty turn too — the agent was handed a
 * message with nothing in it and no sign that anything had been sent. The
 * caption is the body for media, and the bracket is what names the attachment.
 */
describe("media messages", () => {
  const chat = { id: 42, type: "private" };
  const from = { id: 7, first_name: "Ann" };

  it("reads a photo's caption as its body", () => {
    const outcome = normaliseTelegramUpdate({
      update_id: 1,
      message: {
        message_id: 10,
        chat,
        from,
        date: 1_700_000_000,
        photo: [{ file_id: "small" }, { file_id: "large" }],
        caption: "what is in this picture",
      },
    });

    expect(outcome.kind).toBe("update");
    if (outcome.kind !== "update") return;
    expect(outcome.normalisation).toMatchObject({
      kind: "message",
      message: { text: "[photo] what is in this picture" },
    });
  });

  it("names a captionless sticker rather than projecting an empty turn", () => {
    const outcome = normaliseTelegramUpdate({
      update_id: 2,
      message: { message_id: 11, chat, from, date: 1_700_000_001, sticker: { file_id: "s" } },
    });

    expect(outcome.kind).toBe("update");
    if (outcome.kind !== "update") return;
    expect(outcome.normalisation).toMatchObject({ kind: "message", message: { text: "[sticker]" } });
  });

  it("names a voice message, which has neither text nor caption", () => {
    const outcome = normaliseTelegramUpdate({
      update_id: 3,
      message: { message_id: 12, chat, from, date: 1_700_000_002, voice: { file_id: "v", duration: 3 } },
    });

    expect(outcome.kind).toBe("update");
    if (outcome.kind !== "update") return;
    expect(outcome.normalisation).toMatchObject({ kind: "message", message: { text: "[voice message]" } });
  });

  it("leaves a plain text message exactly as it was", () => {
    const outcome = normaliseTelegramUpdate({
      update_id: 4,
      message: { message_id: 13, chat, from, date: 1_700_000_003, text: "hello" },
    });

    expect(outcome.kind).toBe("update");
    if (outcome.kind !== "update") return;
    expect(outcome.normalisation).toMatchObject({ kind: "message", message: { text: "hello" } });
  });

  it("refuses a service message that carries nothing to answer", () => {
    const outcome = normaliseTelegramUpdate({
      update_id: 5,
      message: {
        message_id: 14,
        chat,
        date: 1_700_000_004,
        new_chat_members: [{ id: 9, first_name: "Bo" }],
      },
    });

    expect(outcome.kind).toBe("update");
    if (outcome.kind !== "update") return;
    expect(outcome.normalisation).toMatchObject({ kind: "filtered" });
  });
});
