/**
 * The email channel, proven against a fake IMAP server and a fake SMTP server
 * that are both *real* TCP servers on loopback.
 *
 * # Why real sockets
 *
 * The two rules that matter most in this channel are wire rules: an IMAP literal
 * is not a line, and a header is not free text. A double that hands the client
 * pre-split strings would skip both — the splitter would never see a body with
 * CRLF in it, and the injection guard would never be reached by a value that
 * came off a socket. So the servers below listen on `127.0.0.1:0` and speak
 * bytes; the client is given a factory that connects to them. No dependency, no
 * TLS, nothing leaving the process.
 *
 * # What is asserted where
 *
 * - `messaging-email-imap.ts` — framing, the literal splitter, `BODY.PEEK`.
 * - `messaging-email-message.ts` — RFC 2047, MIME, the refusals.
 * - `messaging-email-smtp.ts` — DATA assembly, injection, reply codes.
 * - `messaging-email-inbound.ts` — the allowlist, own echo, the UID cursor.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  ALLOWED,
  CRLF_BODY,
  FakeImap,
  FakeSmtp,
  IMAP_TARGET,
  PASSWORD,
  SMTP_TARGET,
  plainMessage,
} from "./messaging-email-test-servers.js";

import {
  ImapClient,
  ImapWireReader,
  literalLengthAtLineEnd,
  parseFetchResponse,
} from "./messaging-email-imap.js";
import {
  decodeEmailHeaderValue,
  extractEmailBody,
  parseEmailAddresses,
  parseEmailHeaders,
  parseEmailMessage,
} from "./messaging-email-message.js";
import {
  EMAIL_OWN_MESSAGE_ID_PREFIX,
  SmtpSender,
  buildOwnMessageId,
  buildSmtpMessage,
  headerInjectionReason,
  isEmailAddress,
} from "./messaging-email-smtp.js";
import {
  EMAIL_MESSAGE_LIMIT_BYTES,
  classifyEmailEvent,
  createEmailInboundPushTransport,
  createEmailIngressAdapter,
  emailWireBytes,
  isOwnMessageId,
  type EmailInboundAuditEntry,
} from "./messaging-email-inbound.js";


const stopHandles: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (stopHandles.length > 0) await stopHandles.pop()!();
});

async function startImap(options: ConstructorParameters<typeof FakeImap>[0] = {}): Promise<FakeImap> {
  const server = new FakeImap(options);
  await server.start();
  stopHandles.push(() => server.close());
  return server;
}

async function startSmtp(options: ConstructorParameters<typeof FakeSmtp>[0] = {}): Promise<FakeSmtp> {
  const server = new FakeSmtp(options);
  await server.start();
  stopHandles.push(() => server.close());
  return server;
}

async function fetchFrom(
  server: FakeImap,
  cursor = 0,
): Promise<{ uid: number; source: Buffer }[]> {
  const client = new ImapClient({
    target: IMAP_TARGET,
    username: "bot@example.org",
    password: PASSWORD,
    connect: server.factory,
  });
  await client.connect();
  await client.capability();
  await client.login();
  await client.select();
  const uids = (await client.searchUnseen(cursor)).filter((uid) => uid > cursor);
  const fetched = await client.fetchPeek(uids);
  await client.logout();
  return fetched;
}

// ---------------------------------------------------------------------------
// IMAP framing
// ---------------------------------------------------------------------------

describe("the IMAP wire reader", () => {
  it("treats a literal as bytes, so a body containing CRLF is one response", () => {
    const reader = new ImapWireReader();
    const body = Buffer.from("one\r\ntwo\r\n\r\nthree", "latin1");
    const frame = Buffer.concat([
      Buffer.from(`* 1 FETCH (UID 7 BODY[] {${body.length}}\r\n`, "latin1"),
      body,
      Buffer.from(")\r\n", "latin1"),
    ]);
    const responses = reader.push(frame);
    expect(responses).toHaveLength(1);
    const literal = responses[0]!.segments.find((segment) => "literal" in segment);
    expect(literal && "literal" in literal ? literal.literal.toString("latin1") : "").toBe(
      body.toString("latin1"),
    );
    const parsed = parseFetchResponse(responses[0]!);
    expect(parsed?.uid).toBe(7);
    expect(parsed?.source.toString("latin1")).toBe(body.toString("latin1"));
  });

  it("reassembles a response whose literal arrives in two reads", () => {
    const reader = new ImapWireReader();
    const body = Buffer.from("abcdef", "latin1");
    const frame = Buffer.concat([
      Buffer.from("* 1 FETCH (UID 9 BODY[] {6}\r\n", "latin1"),
      body,
      Buffer.from(")\r\n", "latin1"),
    ]);
    expect(reader.push(frame.subarray(0, 24))).toHaveLength(0);
    const responses = reader.push(frame.subarray(24));
    expect(responses).toHaveLength(1);
    expect(parseFetchResponse(responses[0]!)).toEqual({ uid: 9, source: body });
  });

  it("reads the non-synchronising literal spelling", () => {
    expect(literalLengthAtLineEnd("* 1 FETCH (BODY[] {12+}")).toBe(12);
    expect(literalLengthAtLineEnd("* OK ready")).toBeNull();
  });
});

describe("the IMAP client over a real socket", () => {
  it("runs CAPABILITY, LOGIN, SELECT, UID SEARCH, UID FETCH and LOGOUT", async () => {
    const server = await startImap({
      uids: [40, 42],
      messages: new Map([[42, plainMessage({})]]),
    });
    await fetchFrom(server, 40);
    const verbs = server.commands.map((line) => line.replace(/^A\d+ /, "").split(" ")[0]);
    expect(verbs.slice(0, 3)).toEqual(["CAPABILITY", "LOGIN", "SELECT"]);
    expect(server.commands.some((line) => line.endsWith("UID SEARCH UNSEEN UID 41:*"))).toBe(true);
    expect(server.commands.some((line) => line.endsWith("LOGOUT"))).toBe(true);
  });

  it("fetches with BODY.PEEK and never with BODY[]", async () => {
    const server = await startImap({
      uids: [40, 42],
      messages: new Map([
        [40, plainMessage({ messageId: "<m-40@example.org>" })],
        [42, plainMessage({ messageId: "<m-42@example.org>" })],
      ]),
    });
    await fetchFrom(server, 0);
    const fetch = server.commands.filter((line) => / UID FETCH /.test(line));
    expect(fetch).toHaveLength(1);
    // The whole command, not a substring: `BODY[]` is a prefix of `BODY.PEEK[]`
    // and a substring assertion would pass while the mailbox was being marked.
    expect(fetch[0]).toMatch(/^A\d+ UID FETCH 40,42 \(BODY\.PEEK\[\] UID\)$/);
    expect(server.commands.some((line) => /BODY\[\]/.test(line))).toBe(false);
  });

  it("parses a body containing CRLF through a real FETCH", async () => {
    const body = plainMessage({ body: CRLF_BODY });
    const server = await startImap({ uids: [42], messages: new Map([[42, body]]) });
    const fetched = await fetchFrom(server, 0);
    expect(fetched).toHaveLength(1);
    expect(fetched[0]!.uid).toBe(42);
    expect(fetched[0]!.source.equals(body)).toBe(true);
    const parsed = parseEmailMessage(fetched[0]!.source);
    expect(extractEmailBody(parsed.headers, parsed.body)).toEqual({
      ok: true,
      text: "first line\nsecond line\n\nfourth line",
    });
  });

  it("finds the uid when the server puts it after the literal", async () => {
    const server = await startImap({
      uids: [42],
      messages: new Map([[42, plainMessage({})]]),
      uidAfterBody: true,
    });
    const fetched = await fetchFrom(server, 0);
    expect(fetched.map((message) => message.uid)).toEqual([42]);
  });

  it("refuses a login the server rejects, without echoing the password", async () => {
    const server = await startImap({ loginOk: false });
    const client = new ImapClient({
      target: IMAP_TARGET,
      username: "bot@example.org",
      password: PASSWORD,
      connect: server.factory,
    });
    await client.connect();
    await client.capability();
    let failure: unknown = null;
    try {
      await client.login();
    } catch (error) {
      failure = error;
    }
    expect(failure).not.toBeNull();
    expect(JSON.stringify(failure)).toContain("AUTHENTICATIONFAILED");
    expect(JSON.stringify(failure)).not.toContain(PASSWORD);
    client.close();
  });
});

// ---------------------------------------------------------------------------
// Message parsing
// ---------------------------------------------------------------------------

describe("the email message parser", () => {
  it("decodes RFC 2047 base64 and quoted-printable words", () => {
    expect(decodeEmailHeaderValue("=?UTF-8?B?SGVsbG8gd29ybGQ=?=")).toBe("Hello world");
    expect(decodeEmailHeaderValue("=?UTF-8?Q?caf=C3=A9?=")).toBe("café");
    expect(decodeEmailHeaderValue("=?UTF-8?Q?a_b?=")).toBe("a b");
  });

  it("drops only the folding whitespace between two encoded words", () => {
    expect(decodeEmailHeaderValue("=?UTF-8?B?SGVsbG8=?= =?UTF-8?B?d29ybGQ=?=")).toBe("Helloworld");
    expect(decodeEmailHeaderValue("Re: =?UTF-8?B?SGVsbG8=?= there")).toBe("Re: Hello there");
  });

  it("delivers an unknown encoding as it arrived rather than losing the value", () => {
    expect(decodeEmailHeaderValue("=?x-unknown?B?SGVsbG8=?=")).toBe("Hello");
    expect(decodeEmailHeaderValue("=?x-unknown?Z?SGVsbG8=?=")).toBe("=?x-unknown?Z?SGVsbG8=?=");
  });

  it("reads an address out of a display name, lowercased", () => {
    expect(parseEmailAddresses('"Alice" <Alice@Example.ORG>')).toEqual(["alice@example.org"]);
    expect(parseEmailAddresses("not an address")).toEqual([]);
  });

  it("finds the text/plain leaf of a multipart message", () => {
    const source = Buffer.from(
      [
        "From: alice@example.org",
        'Content-Type: multipart/alternative; boundary="b1"',
        "",
        "--b1",
        'Content-Type: text/html; charset="utf-8"',
        "",
        "<p>ignored</p>",
        "--b1",
        'Content-Type: text/plain; charset="utf-8"',
        "",
        "the plain part",
        "--b1--",
        "",
      ].join("\r\n"),
      "utf8",
    );
    const parsed = parseEmailMessage(source);
    expect(extractEmailBody(parsed.headers, parsed.body)).toEqual({
      ok: true,
      text: "the plain part",
    });
  });

  it("refuses a multipart message with no extractable text part", () => {
    const source = Buffer.from(
      [
        "From: alice@example.org",
        'Content-Type: multipart/mixed; boundary="b1"',
        "",
        "--b1",
        "Content-Type: application/pdf",
        "Content-Transfer-Encoding: base64",
        "",
        "JVBERi0xLjQK",
        "--b1--",
        "",
      ].join("\r\n"),
      "utf8",
    );
    const parsed = parseEmailMessage(source);
    const result = extractEmailBody(parsed.headers, parsed.body);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toBe("the message has no text/plain part");
  });

  it("refuses an HTML-only body rather than delivering markup", () => {
    const source = Buffer.from(
      ["From: a@b.test", "Content-Type: text/html", "", "<p>hi</p>"].join("\r\n"),
      "utf8",
    );
    const parsed = parseEmailMessage(source);
    expect(extractEmailBody(parsed.headers, parsed.body)).toEqual({
      ok: false,
      reason: "the message is HTML, not plain text",
    });
  });

  it("survives a charset it does not know instead of throwing", () => {
    const headers = parseEmailHeaders(
      'Content-Type: text/plain; charset="x-made-up"\r\nContent-Transfer-Encoding: 8bit',
    );
    const result = extractEmailBody(headers, Buffer.from("hello", "utf8"));
    expect(result).toEqual({ ok: true, text: "hello" });
  });
});

// ---------------------------------------------------------------------------
// SMTP
// ---------------------------------------------------------------------------

const CRLF = "\r\n";

describe("the SMTP message assembly", () => {
  it("keeps the subject and the body apart and stamps an own Message-ID", () => {
    const messageId = buildOwnMessageId("bot@example.org", new Date(1_760_000_000_000));
    const built = buildSmtpMessage({
      from: "bot@example.org",
      to: "alice@example.org",
      subject: "a reply",
      text: "the body",
      messageId,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const [head, body] = built.message.split(`${CRLF}${CRLF}`);
    expect(head).toContain("Subject: a reply");
    expect(head).toContain(`Message-ID: ${messageId}`);
    expect(head).toContain("Content-Type: text/plain");
    expect(head).not.toContain("the body");
    expect(body).toBe("the body");
    expect(messageId.startsWith(`<${EMAIL_OWN_MESSAGE_ID_PREFIX}`)).toBe(true);
  });

  it("refuses a subject containing CRLF, before any socket is opened", () => {
    const built = buildSmtpMessage({
      from: "bot@example.org",
      to: "alice@example.org",
      subject: "hello\r\nRCPT TO: <attacker@example.org>",
      text: "body",
      messageId: "<x@example.org>",
    });
    expect(built.ok).toBe(false);
    expect(built.ok ? "" : built.reason).toContain("line break");
  });

  it("refuses a recipient containing CRLF", () => {
    const built = buildSmtpMessage({
      from: "bot@example.org",
      to: "alice@example.org>\r\nRCPT TO: <attacker@example.org>",
      text: "body",
      subject: "hi",
      messageId: "<x@example.org>",
    });
    expect(built.ok).toBe(false);
    expect(headerInjectionReason("a\r\nb", "recipient address")).toContain("line break");
    expect(isEmailAddress("a\r\nb@example.org")).toBe(false);
  });

  it("dot-stuffs a body line that is a single dot", async () => {
    const server = await startSmtp();
    const sender = new SmtpSender({
      target: SMTP_TARGET,
      username: "bot@example.org",
      password: PASSWORD,
      from: "bot@example.org",
      connect: server.factory,
    });
    const result = await sender.send({
      to: "alice@example.org",
      subject: "hi",
      text: "before\r\n.\r\nafter",
    });
    expect(result.ok).toBe(true);
    expect(server.dataPayloads).toHaveLength(1);
    expect(server.dataPayloads[0]).toContain("before\r\n.\r\nafter");
  });

  it("assembles DATA with the headers, the blank line and the CRLF body", async () => {
    const server = await startSmtp();
    const sender = new SmtpSender({
      target: SMTP_TARGET,
      username: "bot@example.org",
      password: PASSWORD,
      from: "bot@example.org",
      connect: server.factory,
    });
    const result = await sender.send({
      to: "alice@example.org",
      subject: "the subject",
      text: "line one\nline two",
    });
    expect(result.ok).toBe(true);
    const payload = server.dataPayloads[0]!;
    expect(payload.startsWith("From: <bot@example.org>\r\n")).toBe(true);
    expect(payload).toContain("Subject: the subject\r\n");
    expect(payload).toContain("\r\n\r\nline one\r\nline two");
    expect(server.commands.some((line) => line.startsWith("MAIL FROM:<bot@example.org>"))).toBe(true);
    expect(server.commands.some((line) => line.startsWith("RCPT TO:<alice@example.org>"))).toBe(true);
  });

  it("surfaces a 535 refusal without the password", async () => {
    const server = await startSmtp({ authCode: 535 });
    const sender = new SmtpSender({
      target: SMTP_TARGET,
      username: "bot@example.org",
      password: PASSWORD,
      from: "bot@example.org",
      connect: server.factory,
    });
    const result = await sender.send({ to: "alice@example.org", subject: "hi", text: "x" });
    expect(result.ok).toBe(false);
    const error = result.ok ? "" : result.error;
    expect(error).toContain("535");
    expect(error).not.toContain(PASSWORD);
    expect(server.dataPayloads).toHaveLength(0);
  });

  it("surfaces a 421 refusal", async () => {
    const server = await startSmtp({ mailFromCode: 421 });
    const sender = new SmtpSender({
      target: SMTP_TARGET,
      username: "bot@example.org",
      password: PASSWORD,
      from: "bot@example.org",
      connect: server.factory,
    });
    const result = await sender.send({ to: "alice@example.org", subject: "hi", text: "x" });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("421");
  });
});

// ---------------------------------------------------------------------------
// The adapter: allowlist, own echo, cursor
// ---------------------------------------------------------------------------

function adapterFor(
  server: FakeImap,
  options: { audit?: (entry: EmailInboundAuditEntry) => void; smtp?: FakeSmtp } = {},
) {
  return createEmailIngressAdapter({
    imap: IMAP_TARGET,
    smtp: SMTP_TARGET,
    username: "bot@example.org",
    password: PASSWORD,
    allowedSenders: ALLOWED,
    subjectPrefix: "[pi]",
    connect: server.factory,
    ...(options.smtp ? { connectSmtp: options.smtp.factory } : {}),
    ...(options.audit ? { audit: options.audit } : {}),
  });
}

describe("the email adapter", () => {
  it("turns an allowlisted message into exactly one inbound message", async () => {
    const server = await startImap({
      uids: [42],
      messages: new Map([[42, plainMessage({})]]),
    });
    const adapter = adapterFor(server);
    const polled = await adapter.poll(40);
    expect(polled.ok).toBe(true);
    if (!polled.ok) return;
    expect(polled.events).toHaveLength(1);
    const normalised = adapter.normalise(polled.events[0]);
    expect(normalised).toEqual({
      kind: "message",
      message: { messageId: "<m-1@example.org>", chatId: "alice@example.org", text: "first line\nsecond line\n\nfourth line" },
      key: "alice@example.org\u0000<m-1@example.org>",
    });
  });

  it("drops a sender who is not on the allowlist, and records why", async () => {
    const audit: EmailInboundAuditEntry[] = [];
    const server = await startImap({
      uids: [42],
      messages: new Map([
        [42, plainMessage({ from: "Stranger <stranger@example.net>", messageId: "<m-x@example.net>" })],
      ]),
    });
    const adapter = adapterFor(server, { audit: (entry) => audit.push(entry) });
    const polled = await adapter.poll(40);
    expect(polled.ok).toBe(true);
    if (!polled.ok) return;
    expect(adapter.normalise(polled.events[0])).toEqual({
      kind: "filtered",
      reason: "the sender is not on the allowlist",
    });
    expect(audit).toEqual([{ kind: "filtered", reason: "the sender is not on the allowlist" }]);
  });

  it("drops a message from its own account", async () => {
    const server = await startImap({
      uids: [42],
      messages: new Map([
        [42, plainMessage({ from: "bot@example.org", messageId: "<own@example.org>" })],
      ]),
    });
    const adapter = adapterFor(server);
    const classification = adapter.normalise({ uid: 42, source: plainMessage({ from: "bot@example.org" }) });
    expect(classification.kind).toBe("filtered");
    expect(classification.kind === "filtered" ? classification.reason : "").toBe(
      "the message is this channel's own mail",
    );
  });

  it("drops a reply whose In-Reply-To names this channel's own Message-ID", () => {
    const own = buildOwnMessageId("bot@example.org");
    const source = plainMessage({ extra: `In-Reply-To: ${own}`, messageId: "<reply@example.org>" });
    const classification = classifyEmailEvent(
      { uid: 42, source },
      { allowedSenders: ALLOWED, ownAddresses: ["bot@example.org"] },
    );
    expect(classification.accepted).toBe(false);
    expect(classification.accepted ? "" : classification.reason).toBe(
      "the message replies to this channel's own mail",
    );
    expect(isOwnMessageId(own)).toBe(true);
  });

  it("drops a reply whose References names one of them", () => {
    const own = buildOwnMessageId("bot@example.org");
    const source = plainMessage({ extra: `References: <other@x.test> ${own}` });
    const classification = classifyEmailEvent(
      { uid: 42, source },
      { allowedSenders: ALLOWED },
    );
    expect(classification.accepted).toBe(false);
  });

  it("starts at the newest unread message on the first poll, delivering none", async () => {
    const audit: EmailInboundAuditEntry[] = [];
    const server = await startImap({
      uids: [10, 20, 30],
      messages: new Map([[30, plainMessage({})]]),
    });
    const adapter = adapterFor(server, { audit: (entry) => audit.push(entry) });
    const polled = await adapter.poll(0);
    expect(polled.ok).toBe(true);
    if (!polled.ok) return;
    expect(polled.events).toEqual([]);
    expect(polled.nextCursor).toBe(30);
    expect(audit).toEqual([
      { kind: "filtered", reason: "the first poll starts after the newest unread message" },
    ]);
  });

  it("delivers nothing for a uid the cursor has already passed", async () => {
    const server = await startImap({
      uids: [40, 42],
      messages: new Map([[42, plainMessage({})]]),
    });
    const adapter = adapterFor(server);
    const polled = await adapter.poll(42);
    expect(polled).toEqual({ ok: true, events: [], nextCursor: 42 });
  });

  it("reports a refused login and never leaks the password", async () => {
    const audit: EmailInboundAuditEntry[] = [];
    const server = await startImap({ loginOk: false });
    const adapter = adapterFor(server, { audit: (entry) => audit.push(entry) });
    const polled = await adapter.poll(5);
    expect(polled.ok).toBe(false);
    const observed = JSON.stringify({ polled, audit });
    expect(observed).not.toContain(PASSWORD);
    expect(audit.some((entry) => entry.kind === "auth-failed")).toBe(true);
  });

  it("chunks a long reply and never exceeds the byte limit", async () => {
    const imap = await startImap({});
    const smtp = await startSmtp();
    const adapter = adapterFor(imap, { smtp });
    const text = `${"a reply line with words in it\n".repeat(2_000)}end`;
    const result = await adapter.deliver!("alice@example.org", text);
    expect(result.ok).toBe(true);
    expect(smtp.dataPayloads.length).toBeGreaterThan(1);
    const bodies = smtp.dataPayloads.map((payload) => payload.slice(payload.indexOf("\r\n\r\n") + 4));
    for (const body of bodies) {
      // The wire form, not the LF form: this is the number a mail server counts.
      expect(emailWireBytes(body)).toBeLessThanOrEqual(EMAIL_MESSAGE_LIMIT_BYTES);
    }
    expect(bodies.map((body) => body.replace(/\r\n/g, "\n")).join("")).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// The full loop, over the fake servers
// ---------------------------------------------------------------------------

describe("the email inbound loop", () => {
  it("applies an allowlisted message once and advances the cursor", async () => {
    const server = await startImap({
      uids: [42],
      messages: new Map([[42, plainMessage({})]]),
    });
    const applied: string[] = [];
    const saved: number[] = [];
    const controller = new AbortController();
    const audit: EmailInboundAuditEntry[] = [];
    const transport = createEmailInboundPushTransport({
      imap: IMAP_TARGET,
      smtp: SMTP_TARGET,
      username: "bot@example.org",
      password: PASSWORD,
      allowedSenders: ALLOWED,
      connect: server.factory,
      handled: { has: async () => false, record: async () => {} },
      cursor: { load: async () => 40, save: async (value) => void saved.push(value) },
      wait: async () => controller.abort(),
      audit: (entry) => audit.push(entry),
    });
    await transport.start(async (message) => void applied.push(message.messageId), controller.signal);
    expect(applied).toEqual(["<m-1@example.org>"]);
    expect(saved).toEqual([42]);
    expect(audit.some((entry) => entry.kind === "processed")).toBe(true);
  });

  it("produces no turn and one audit line for a stranger, over the loop", async () => {
    const server = await startImap({
      uids: [42],
      messages: new Map([[42, plainMessage({ from: "eve@example.net", messageId: "<eve@example.net>" })]]),
    });
    const applied: string[] = [];
    const audit: EmailInboundAuditEntry[] = [];
    const controller = new AbortController();
    const transport = createEmailInboundPushTransport({
      imap: IMAP_TARGET,
      smtp: SMTP_TARGET,
      username: "bot@example.org",
      password: PASSWORD,
      allowedSenders: ALLOWED,
      connect: server.factory,
      handled: { has: async () => false, record: async () => {} },
      cursor: { load: async () => 40, save: async () => {} },
      wait: async () => controller.abort(),
      audit: (entry) => audit.push(entry),
    });
    await transport.start(async (message) => void applied.push(message.messageId), controller.signal);
    expect(applied).toEqual([]);
    expect(audit).toEqual([
      { kind: "filtered", reason: "the sender is not on the allowlist" },
    ]);
  });
});
