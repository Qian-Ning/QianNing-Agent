/**
 * The inbound Buzz channel — the adapter half only.
 *
 * Buzz is a Nostr relay (NIP-29 groups). The Host opens a websocket to it, may
 * be asked to authenticate (NIP-42), then subscribes to one channel's messages
 * with a `REQ`. Everything the relay sends is an untrusted frame until it is
 * validated field by field.
 *
 * What is Buzz's own, and therefore here:
 *
 * - **connect** — the socket URL is the endpoint; the relay's `AUTH` challenge
 *   is answered with a signed kind-22242 event;
 * - **normalise** — one kind-9 event, tagged with the channel under `h`, whose
 *   id is the replay key and whose author is the sender;
 * - **limit** — declared for the shared chunker. Replies leave through
 *   host-core's sender, which signs its own publish.
 *
 * The signing here exists for one frame: the authentication challenge. A
 * published message is signed by host-core.
 */

import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";

import {
  IngressGate,
  ingressMessageKey,
  type IngressHandledStore,
  type IngressMessage,
  type IngressNormalisation,
  type SocketIngressAdapter,
} from "./messaging-ingress.js";
import {
  SocketIngressClient,
  type IngressSocket,
  type IngressSocketFactory,
  type SocketIngressClientOptions,
} from "./messaging-ingress-socket.js";

export const MESSAGING_BUZZ_PLATFORM = "buzz";

/**
 * The chunker's limit.
 *
 * A relay stores content of any length, but a client that renders one channel
 * message as a wall of text is worse than one that splits: this is the same
 * budget Telegram uses, chosen for reading rather than for the protocol.
 */
export const BUZZ_MESSAGE_LIMIT = 4096;

/** A group's chat event, and the authentication event NIP-42 answers with. */
const GROUP_MESSAGE_KIND = 9;
const AUTH_KIND = 22242;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A signed Nostr event, as the relay stores and returns it. */
export type BuzzEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

function readEvent(value: unknown): BuzzEvent | null {
  if (!isRecord(value)) return null;
  const { id, pubkey, created_at: createdAt, kind, tags, content, sig } = value;
  if (typeof id !== "string" || id.length !== 64) return null;
  if (typeof pubkey !== "string" || pubkey.length !== 64) return null;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  if (typeof kind !== "number" || !Number.isFinite(kind)) return null;
  if (typeof content !== "string") return null;
  if (typeof sig !== "string") return null;
  if (!Array.isArray(tags)) return null;
  const readTags: string[][] = [];
  for (const tag of tags) {
    if (!Array.isArray(tag)) continue;
    readTags.push(tag.filter((entry): entry is string => typeof entry === "string"));
  }
  return { id, pubkey, created_at: createdAt, kind, tags: readTags, content, sig };
}

/** The value of the first `name` tag, if the event carries one. */
export function tagValue(event: BuzzEvent, name: string): string | null {
  for (const tag of event.tags) {
    if (tag[0] === name && typeof tag[1] === "string" && tag[1] !== "") return tag[1];
  }
  return null;
}

/**
 * Project one relay event onto the shared shape.
 *
 * A channel message is kind 9 with the channel under `h`. Everything else the
 * relay streams — profiles, membership notices, reactions — is not a message
 * this channel answers, and the Host's own events are skipped so the agent never
 * answers itself.
 */
export function normaliseBuzzEvent(
  raw: unknown,
  options: { channelId: string; selfPubkey?: string | null },
): IngressNormalisation {
  const event = readEvent(raw);
  if (!event) return { kind: "filtered", reason: "frame carries no readable event" };
  if (event.kind !== GROUP_MESSAGE_KIND) {
    return { kind: "filtered", reason: `event kind ${event.kind} is not a channel message` };
  }
  const channel = tagValue(event, "h");
  if (channel === null) return { kind: "filtered", reason: "event names no channel" };
  if (channel !== options.channelId) {
    return { kind: "filtered", reason: "event belongs to another channel" };
  }
  if (options.selfPubkey && event.pubkey === options.selfPubkey) {
    return { kind: "filtered", reason: "event is the Host's own message" };
  }
  if (event.content.trim() === "") {
    return { kind: "filtered", reason: "event carries no text" };
  }
  const message: IngressMessage = {
    messageId: event.id,
    chatId: channel,
    text: event.content,
    sender: { id: event.pubkey },
    sentAt: event.created_at * 1000,
    chatKind: "group",
  };
  return {
    kind: "message",
    message,
    key: ingressMessageKey(channel, event.id),
  };
}

/** A Nostr secret key: `nsec1…` or 64 hex characters. */
export function buzzSecretKey(raw: string): Uint8Array {
  const trimmed = raw.trim();
  if (trimmed === "") throw new Error("the private key is empty");
  if (trimmed.startsWith("nsec1")) {
    // NIP-19: bech32 with the `nsec` hrp and a 32-byte payload.
    const [hrp, data] = decodeBech32(trimmed);
    if (hrp !== "nsec") throw new Error("the key is not an nsec key");
    if (data.length !== 32) throw new Error("the nsec key is not 32 bytes");
    return data;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) throw new Error("the private key is not 64 hex characters");
  return Uint8Array.from(Buffer.from(trimmed, "hex"));
}

/** Minimal bech32 decode (NIP-19 keys only carry a 32-byte payload). */
function decodeBech32(value: string): [string, Uint8Array] {
  const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const lower = value.toLowerCase();
  const split = lower.lastIndexOf("1");
  if (split <= 0 || split + 7 > lower.length) throw new Error("the nsec key is not bech32");
  const hrp = lower.slice(0, split);
  const words: number[] = [];
  for (const character of lower.slice(split + 1)) {
    const index = CHARSET.indexOf(character);
    if (index === -1) throw new Error("the nsec key is not bech32");
    words.push(index);
  }
  // The last six words are the checksum; verify it before trusting the payload.
  if (!bech32ChecksumOk(hrp, words)) throw new Error("the nsec checksum does not match");
  const payload = words.slice(0, -6);
  const bytes: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const word of payload) {
    accumulator = (accumulator << 5) | word;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 0xff);
    }
  }
  return [hrp, Uint8Array.from(bytes)];
}

function bech32ChecksumOk(hrp: string, words: number[]): boolean {
  const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  const expanded = [
    ...Array.from(hrp).map((character) => character.charCodeAt(0) >> 5),
    0,
    ...Array.from(hrp).map((character) => character.charCodeAt(0) & 31),
    ...words,
  ];
  let checksum = 1;
  for (const value of expanded) {
    const top = checksum >> 25;
    checksum = (((checksum & 0x1ffffff) << 5) ^ value) & 0xffffffff;
    for (let bit = 0; bit < 5; bit += 1) {
      if ((top >> bit) & 1) checksum ^= GENERATOR[bit];
    }
  }
  return checksum === 1;
}

/** Build and sign one event, in the order the canonical id fixes. */
export function signBuzzEvent(
  secret: Uint8Array,
  kind: number,
  tags: string[][],
  content: string,
  createdAt: number,
): BuzzEvent {
  const pubkey = Buffer.from(schnorr.getPublicKey(secret)).toString("hex");
  const canonical = JSON.stringify([0, pubkey, createdAt, kind, tags, content]);
  const id = createHash("sha256").update(canonical, "utf8").digest();
  const sig = Buffer.from(schnorr.sign(id, secret)).toString("hex");
  return {
    id: id.toString("hex"),
    pubkey,
    created_at: createdAt,
    kind,
    tags,
    content,
    sig,
  };
}

export type BuzzRelayClientOptions = SocketIngressClientOptions & {
  /** `ws://` or `wss://` relay address. */
  url: string;
  /** The channel id the subscription filters on. */
  channelId: string;
  /** The Host's Nostr secret key, used for the NIP-42 challenge. */
  privateKey: string;
  /** Opens the socket; injected so a suite needs no network. */
  open: IngressSocketFactory;
  /** The Host's own pubkey, so its own events are skipped. */
  selfPubkey?: string | null;
  /** The durable record of what has already been handled. */
  handled: IngressHandledStore;
  /** Where an accepted message goes — the one routing path. */
  onMessage: (message: IngressMessage) => Promise<void>;
};

/**
 * One relay connection: authenticate when asked, subscribe to one channel, and
 * route the events that arrive to the shared gate.
 */
export class BuzzRelayClient extends SocketIngressClient {
  private readonly options: BuzzRelayClientOptions;
  private readonly secret: Uint8Array;
  private readonly subscription = "pi-buzz";
  private readonly gate: IngressGate;
  private requested = false;
  /**
   * Ingestion is serialized.
   *
   * Two events can arrive in one tick, and the durable guard answers `has`
   * before the first one is recorded — so applying them concurrently would
   * deliver a duplicate the guard exists to refuse. Frames are ordered on the
   * wire, and they are applied in that order here.
   */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: BuzzRelayClientOptions) {
    super({ audit: options.audit });
    this.options = options;
    this.secret = buzzSecretKey(options.privateKey);
    // The replay guard and the routing path are the shared ones: a relay that
    // re-sends an event after a reconnect must not produce a second turn.
    this.gate = new IngressGate({
      handled: options.handled,
      onMessage: options.onMessage,
      audit: options.audit,
    });
  }

  /** Open the socket. The handshake continues in `handleFrame`. */
  async connect(): Promise<void> {
    this.requested = false;
    const socket: IngressSocket = this.options.open(this.options.url);
    this.attach(socket);
    // Ask at once: a relay that allows anonymous reads answers, and one that
    // requires auth sends its challenge and refuses this REQ — the challenge
    // handler asks again after it authenticates.
    this.subscribe();
  }

  private subscribe(): void {
    if (this.requested) return;
    this.requested = true;
    this.sendText(
      JSON.stringify([
        "REQ",
        this.subscription,
        { kinds: [GROUP_MESSAGE_KIND], "#h": [this.options.channelId] },
      ]),
    );
  }

  async handleFrame(raw: string): Promise<void> {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      this.audit({ kind: "malformed", reason: "frame is not JSON" });
      return;
    }
    if (!Array.isArray(frame) || typeof frame[0] !== "string") {
      this.audit({ kind: "malformed", reason: "frame is not a Nostr message" });
      return;
    }
    switch (frame[0]) {
      case "AUTH": {
        const challenge = typeof frame[1] === "string" ? frame[1] : "";
        if (!challenge) return;
        const createdAt = Math.floor(Date.now() / 1000);
        const event = signBuzzEvent(
          this.secret,
          AUTH_KIND,
          [
            ["relay", this.options.url],
            ["challenge", challenge],
          ],
          "",
          createdAt,
        );
        this.sendText(JSON.stringify(["AUTH", event]));
        return;
      }
      case "OK": {
        // The relay accepted the authentication; ask for the channel now.
        const accepted = frame[2] === true;
        if (accepted && !this.requested) this.subscribe();
        return;
      }
      case "EOSE": {
        this.markReady();
        return;
      }
      case "EVENT": {
        const event = frame[2];
        const normalisation = normaliseBuzzEvent(event, {
          channelId: this.options.channelId,
          selfPubkey: this.options.selfPubkey ?? null,
        });
        if (normalisation.kind === "filtered") {
          this.audit({ kind: "filtered", reason: normalisation.reason });
          return;
        }
        this.queue = this.queue.then(() =>
          this.gate.ingest(normalisation.message, normalisation.key).then(() => undefined),
        );
        await this.queue;
        return;
      }
      case "NOTICE": {
        const notice = typeof frame[1] === "string" ? frame[1] : "refused";
        this.audit({ kind: "rejected", reason: `the relay says: ${notice}` });
        return;
      }
      default:
        return;
    }
  }
}

export type BuzzIngressAdapterOptions = Omit<
  BuzzRelayClientOptions,
  "handled" | "onMessage"
> & {
  /** The durable record of handled event ids, from the driver. */
  handled: IngressHandledStore;
  messageLimit?: number;
};

/**
 * The Buzz adapter.
 *
 * `openClient` builds one connection per attempt; the shared transport owns the
 * reconnect loop, so a relay that drops the socket costs a reconnect and nothing
 * else.
 */
export function createBuzzIngressAdapter(
  options: BuzzIngressAdapterOptions,
): SocketIngressAdapter {
  return {
    platform: MESSAGING_BUZZ_PLATFORM,
    kind: "socket",
    messageLimit: options.messageLimit ?? BUZZ_MESSAGE_LIMIT,
    normalise: (raw) =>
      normaliseBuzzEvent(raw, {
        channelId: options.channelId,
        selfPubkey: options.selfPubkey ?? null,
      }),
    openClient: (onMessage) =>
      new BuzzRelayClient({
        ...options,
        // The driver's durable guard, not a second one: an event the relay
        // re-sends after a reconnect is recognised by the same record a
        // redelivered Telegram message is.
        handled: options.handled,
        onMessage,
      }),
  };
}
