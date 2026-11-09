import { sign as signWith, createPrivateKey } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createQqbotAdapter,
  createQqbotValidation,
  createQqbotVerifier,
  qqbotChallengeSignature,
  qqbotSeed,
} from "./messaging-qqbot-inbound.js";

const SECRET = "naOC0ocQE3shWLAfffVLB1rhYPG7";

/** The seed QQ derives: repeated to 32 bytes, then used as an Ed25519 key. */
function signBody(timestamp: string, body: string): string {
  const seed = qqbotSeed(SECRET);
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  return signWith(null, Buffer.from(`${timestamp}${body}`, "utf8"), key).toString("hex");
}

function dispatch(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    op: 0,
    id: "event-1",
    t: "C2C_MESSAGE_CREATE",
    d: {
      id: "msg-1",
      content: "deploy please",
      author: { id: "user-openid-1" },
    },
    ...overrides,
  });
}

function verify(body: string, timestamp = "1725442341") {
  return createQqbotVerifier({ appSecret: SECRET }).verify(Buffer.from(body, "utf8"), {
    "x-signature-ed25519": signBody(timestamp, body),
    "x-signature-timestamp": timestamp,
  });
}

describe("the QQ seed", () => {
  it("repeats the secret to exactly 32 bytes", () => {
    expect(qqbotSeed("ab")).toHaveLength(32);
    expect(qqbotSeed("a".repeat(40))).toHaveLength(32);
    expect(qqbotSeed("ab").subarray(0, 4).toString()).toBe("abab");
  });
});

describe("the QQ verifier", () => {
  it("accepts a body signed with the secret's key", async () => {
    expect(await verify(dispatch())).toMatchObject({ ok: true, deliveryId: "event-1" });
  });

  it("refuses a body that changed after signing", async () => {
    const body = dispatch();
    const signature = signBody("1725442341", body);
    const tampered = body.replace("deploy please", "delete please");
    expect(
      await createQqbotVerifier({ appSecret: SECRET }).verify(Buffer.from(tampered, "utf8"), {
        "x-signature-ed25519": signature,
        "x-signature-timestamp": "1725442341",
      }),
    ).toMatchObject({ ok: false, reason: "signature-mismatch" });
  });

  it("refuses a signature made with another secret", async () => {
    const body = dispatch();
    expect(
      await createQqbotVerifier({ appSecret: "another-secret" }).verify(Buffer.from(body, "utf8"), {
        "x-signature-ed25519": signBody("1725442341", body),
        "x-signature-timestamp": "1725442341",
      }),
    ).toMatchObject({ ok: false, reason: "signature-mismatch" });
  });

  it("refuses a request with no signature header", async () => {
    expect(
      await createQqbotVerifier({ appSecret: SECRET }).verify(Buffer.from(dispatch(), "utf8"), {}),
    ).toMatchObject({ ok: false, reason: "missing-signature" });
  });

  it("measures freshness against the timestamp QQ signed", async () => {
    const result = await verify(dispatch());
    expect(result.ok && result.timestampMs).toBe(1725442341000);
  });
});

describe("the QQ op-13 validation", () => {
  const validate = createQqbotValidation({ appSecret: SECRET });

  it("echoes the token and signs the event timestamp with it", () => {
    const body = Buffer.from(
      JSON.stringify({ op: 13, d: { plain_token: "Arq0D5A61EgUu4OxUvOp", event_ts: "1725442341" } }),
      "utf8",
    );
    const answer = validate(new URL("https://host.test/webhooks/qqbot"), {}, body);
    expect(answer?.status).toBe(200);
    const parsed = JSON.parse(answer?.body ?? "{}") as Record<string, unknown>;
    expect(parsed.plain_token).toBe("Arq0D5A61EgUu4OxUvOp");
    expect(parsed.signature).toBe(qqbotChallengeSignature(SECRET, "1725442341", "Arq0D5A61EgUu4OxUvOp"));
  });

  it("lets a normal dispatch through to the verifier", () => {
    expect(
      validate(new URL("https://host.test/webhooks/qqbot"), {}, Buffer.from(dispatch(), "utf8")),
    ).toBeNull();
  });

  it("lets a body it cannot read through", () => {
    expect(
      validate(new URL("https://host.test/webhooks/qqbot"), {}, Buffer.from("not json", "utf8")),
    ).toBeNull();
  });
});

describe("the QQ adapter", () => {
  const adapter = createQqbotAdapter();

  it("projects a private message onto the shared shape", () => {
    const result = adapter.normalise(JSON.parse(dispatch()) as unknown);
    expect(result.kind).toBe("message");
    if (result.kind !== "message") return;
    expect(result.message).toMatchObject({
      messageId: "msg-1",
      chatId: "user-openid-1",
      text: "deploy please",
      chatKind: "private",
    });
  });

  it("addresses a group message by its group", () => {
    const result = adapter.normalise(
      JSON.parse(
        dispatch({
          t: "GROUP_AT_MESSAGE_CREATE",
          d: {
            id: "msg-2",
            content: "hi",
            group_openid: "group-1",
            author: { member_openid: "member-1" },
          },
        }),
      ) as unknown,
    );
    expect(result.kind).toBe("message");
    if (result.kind !== "message") return;
    expect(result.message.chatId).toBe("group-1");
    expect(result.message.chatKind).toBe("group");
    expect(result.message.sender?.id).toBe("member-1");
  });

  it("filters an event that is not a message", () => {
    const result = adapter.normalise(JSON.parse(dispatch({ t: "GROUP_ADD_ROBOT" })) as unknown);
    expect(result.kind).toBe("filtered");
  });

  it("filters an op that is not a dispatch", () => {
    const result = adapter.normalise({ op: 13, d: {} });
    expect(result.kind).toBe("filtered");
  });
});
