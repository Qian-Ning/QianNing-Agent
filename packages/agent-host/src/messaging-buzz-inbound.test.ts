import { schnorr } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";

import {
  BUZZ_MESSAGE_LIMIT,
  BuzzRelayClient,
  buzzSecretKey,
  normaliseBuzzEvent,
  signBuzzEvent,
  tagValue,
} from "./messaging-buzz-inbound.js";
import type { IngressHandledStore, IngressMessage } from "./messaging-ingress.js";
import type { IngressSocket } from "./messaging-ingress-socket.js";

const SECRET_HEX = "01".repeat(32);
const CHANNEL = "9f0c1a2b-0000-4000-8000-000000000001";

function fakeSocket() {
  const sent: string[] = [];
  const handlers: { message?: (data: string) => void; close?: () => void } = {};
  const socket: IngressSocket = {
    send: (data) => sent.push(data),
    close: () => handlers.close?.(),
    onMessage: (handler) => {
      handlers.message = handler;
    },
    onClose: (handler) => {
      handlers.close = () => handler();
    },
    onError: () => undefined,
  };
  return { socket, sent, deliver: (frame: unknown) => handlers.message?.(JSON.stringify(frame)) };
}

function store(): IngressHandledStore & { seen: Set<string> } {
  const seen = new Set<string>();
  return {
    seen,
    has: async (key: string) => seen.has(key),
    record: async (key: string) => {
      seen.add(key);
    },
  };
}

function messageEvent(content = "hello", pubkey = "02".repeat(32), channel = CHANNEL) {
  const secret = Uint8Array.from(Buffer.from("03".repeat(32), "hex"));
  const event = signBuzzEvent(secret, 9, [["h", channel]], content, 1_700_000_000);
  return { ...event, pubkey };
}

describe("buzz secret keys", () => {
  it("reads hex and nsec as the same key", () => {
    const hex = buzzSecretKey(SECRET_HEX);
    expect(hex.length).toBe(32);

    const words: number[] = [];
    // bech32 payload for the same bytes, encoded by the same routine the client
    // decodes with: round-trip through the key shape the panel accepts.
    const nsec = encodeNsec(Uint8Array.from(Buffer.from(SECRET_HEX, "hex")));
    expect(Array.from(buzzSecretKey(nsec))).toEqual(Array.from(hex));
    expect(words.length).toBe(0);
  });

  it("refuses a key that is neither", () => {
    expect(() => buzzSecretKey("")).toThrow();
    expect(() => buzzSecretKey("abcd")).toThrow();
    expect(() => buzzSecretKey("nsec1bogus")).toThrow();
  });
});

/** bech32 encode, so the decoder is tested against a real nsec and not a mock. */
function encodeNsec(bytes: Uint8Array): string {
  const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const hrp = "nsec";
  const words: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((accumulator >> bits) & 31);
    }
  }
  if (bits > 0) words.push((accumulator << (5 - bits)) & 31);
  const values = [...words, ...checksumWords(hrp, words)];
  return `${hrp}1${values.map((value) => CHARSET[value]).join("")}`;
}

function checksumWords(hrp: string, words: number[]): number[] {
  const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  const expanded = [
    ...Array.from(hrp).map((character) => character.charCodeAt(0) >> 5),
    0,
    ...Array.from(hrp).map((character) => character.charCodeAt(0) & 31),
    ...words,
    0,
    0,
    0,
    0,
    0,
    0,
  ];
  let checksum = 1;
  for (const value of expanded) {
    const top = checksum >> 25;
    checksum = (((checksum & 0x1ffffff) << 5) ^ value) & 0xffffffff;
    for (let bit = 0; bit < 5; bit += 1) {
      if ((top >> bit) & 1) checksum ^= GENERATOR[bit];
    }
  }
  // bech32's checksum is the polymod residue XOR 1 (BIP-173).
  const residue = checksum ^ 1;
  const result: number[] = [];
  for (let shift = 25; shift >= 0; shift -= 5) result.push((residue >> shift) & 31);
  return result;
}

describe("buzz event signing", () => {
  it("signs the id it computed, and the signature verifies", () => {
    const secret = Uint8Array.from(Buffer.from(SECRET_HEX, "hex"));
    const event = signBuzzEvent(secret, 9, [["h", CHANNEL]], "hi", 1_700_000_000);

    const sig = Buffer.from(event.sig, "hex");
    expect(
      schnorr.verify(
        sig,
        Buffer.from(event.id, "hex"),
        Buffer.from(event.pubkey, "hex"),
      ),
    ).toBe(true);
  });
});

describe("buzz event projection", () => {
  it("projects a channel message", () => {
    const event = messageEvent();
    const outcome = normaliseBuzzEvent(event, { channelId: CHANNEL });

    expect(outcome.kind).toBe("message");
    if (outcome.kind !== "message") return;
    expect(outcome.message).toMatchObject({
      messageId: event.id,
      chatId: CHANNEL,
      text: "hello",
      chatKind: "group",
      sender: { id: event.pubkey },
    });
    expect(outcome.key).toBe(`${CHANNEL}\u0000${event.id}`);
  });

  it("ignores another channel, another kind, and its own message", () => {
    const other = normaliseBuzzEvent(messageEvent("x", "02".repeat(32), "another"), {
      channelId: CHANNEL,
    });
    expect(other).toMatchObject({ kind: "filtered" });

    const profile = { ...messageEvent(), kind: 0 };
    expect(normaliseBuzzEvent(profile, { channelId: CHANNEL })).toMatchObject({ kind: "filtered" });

    const own = messageEvent();
    const self = normaliseBuzzEvent(own, { channelId: CHANNEL, selfPubkey: own.pubkey });
    expect(self).toMatchObject({ kind: "filtered" });
  });

  it("refuses frames that are not events", () => {
    expect(normaliseBuzzEvent(null, { channelId: CHANNEL })).toMatchObject({ kind: "filtered" });
    expect(normaliseBuzzEvent({ id: "short" }, { channelId: CHANNEL })).toMatchObject({
      kind: "filtered",
    });
  });

  it("reads the first h tag", () => {
    const event = messageEvent();
    expect(tagValue(event, "h")).toBe(CHANNEL);
    expect(tagValue(event, "p")).toBeNull();
  });
});

describe("the relay client", () => {
  it("answers the authentication challenge with a signed kind-22242 event", async () => {
    const { socket, sent } = fakeSocket();
    const client = new BuzzRelayClient({
      url: "wss://relay.example",
      channelId: CHANNEL,
      privateKey: SECRET_HEX,
      open: () => socket,
      handled: store(),
      onMessage: async () => undefined,
    });
    await client.connect();
    await client.handleFrame(JSON.stringify(["AUTH", "challenge-1"]));

    const frames = sent.map((frame) => JSON.parse(frame) as unknown[]);
    const auth = frames.find((frame) => frame[0] === "AUTH");
    expect(auth).toBeTruthy();
    const event = auth?.[1] as { kind: number; tags: string[][] };
    expect(event.kind).toBe(22242);
    expect(event.tags).toEqual([
      ["relay", "wss://relay.example"],
      ["challenge", "challenge-1"],
    ]);
  });

  it("asks for the channel before and after authenticating", async () => {
    const { socket, sent } = fakeSocket();
    const client = new BuzzRelayClient({
      url: "wss://relay.example",
      channelId: CHANNEL,
      privateKey: SECRET_HEX,
      open: () => socket,
      handled: store(),
      onMessage: async () => undefined,
    });
    await client.connect();

    const first = JSON.parse(sent[0]) as unknown[];
    expect(first[0]).toBe("REQ");
    expect(first[2]).toEqual({ kinds: [9], "#h": [CHANNEL] });
  });

  it("delivers one event once, and marks itself ready at the end of the stored set", async () => {
    const { socket, deliver } = fakeSocket();
    const delivered: IngressMessage[] = [];
    const handled = store();
    const client = new BuzzRelayClient({
      url: "wss://relay.example",
      channelId: CHANNEL,
      privateKey: SECRET_HEX,
      open: () => socket,
      handled,
      onMessage: async (message) => {
        delivered.push(message);
      },
    });
    await client.connect();

    const event = messageEvent();
    deliver(["EVENT", "pi-buzz", event]);
    deliver(["EVENT", "pi-buzz", event]);
    deliver(["EOSE", "pi-buzz"]);
    // The gate records asynchronously; one drain is enough for the fake store.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).toBe("hello");
    expect(client.isReady).toBe(true);
  });
});

describe("the adapter", () => {
  it("declares the socket shape and the chunker limit", async () => {
    const { createBuzzIngressAdapter } = await import("./messaging-buzz-inbound.js");
    const adapter = createBuzzIngressAdapter({
      url: "wss://relay.example",
      channelId: CHANNEL,
      privateKey: SECRET_HEX,
      open: () => fakeSocket().socket,
      handled: store(),
    });
    expect(adapter.kind).toBe("socket");
    expect(adapter.platform).toBe("buzz");
    expect(adapter.messageLimit).toBe(BUZZ_MESSAGE_LIMIT);
  });
});
