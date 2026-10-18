/**
 * Email message parsing: the header block, RFC 2047 encoded words, the charset
 * of a text body, and the one thing this channel will deliver — the plain text.
 *
 * This module is pure: it takes the bytes an IMAP `FETCH` returned and answers
 * either the text of the message or a typed refusal. Nothing here opens a
 * socket, so every rule below is testable from a fixture string.
 *
 * # Why the plain text is extracted rather than assumed
 *
 * A mail body is not a string. It is a MIME tree whose leaves are bytes in some
 * charset, and the parts this channel can act on are the `text/plain` ones.
 * Delivering the raw body of a multipart message would deliver boundaries,
 * base64 and HTML as if they were a command; delivering an encoded-word subject
 * raw would show `=?UTF-8?B?...?=` in the audit record. So the rules are:
 *
 * - a `text/plain` body is decoded by its `Content-Transfer-Encoding` and then
 *   by its charset;
 * - a `multipart/*` message is walked, and the first `text/plain` leaf is
 *   delivered — the shape almost every mail client produces for a reply;
 * - a multipart message with no `text/plain` leaf, and a message whose body is
 *   `text/html`, are **refused** with a reason rather than delivered as noise;
 * - an unknown charset never throws: the bytes are decoded as UTF-8 and the
 *   message is delivered, because losing a message is worse than a mojibake
 *   character.
 *
 * # RFC 2047
 *
 * A header may carry `=?charset?B?base64?=` or `=?charset?Q?quoted?=` words.
 * Adjacent encoded words are separated by whitespace that is not part of the
 * value (it exists only to fold the header), so it is dropped — the rule the
 * standard states and the one a naive `replace` gets wrong.
 */

/** One header block: every value, in arrival order, keyed by lowercase name. */
export type EmailHeaders = Map<string, string[]>;

/** A message split into its header block and its body bytes. */
export type ParsedEmail = {
  headers: EmailHeaders;
  /** The body exactly as it arrived: not decoded, not trimmed. */
  body: Buffer;
  /** The whole message, for callers that need a length or a hash. */
  source: Buffer;
};

const CRLF = Buffer.from("\r\n\r\n", "latin1");
const LF = Buffer.from("\n\n", "latin1");

/** The first header value for `name`, or `""`. */
export function emailHeader(headers: EmailHeaders, name: string): string {
  const values = headers.get(name.toLowerCase());
  return values && values.length > 0 ? values[0]! : "";
}

/**
 * Split a message into headers and body.
 *
 * The blank line is `CRLF CRLF` in a well-formed message and `LF LF` in one a
 * broken client wrote; both are accepted, because refusing the second would
 * lose a message that every mail client can read.
 */
export function parseEmailMessage(source: Buffer): ParsedEmail {
  const crlfAt = source.indexOf(CRLF);
  const lfAt = source.indexOf(LF);
  let split = -1;
  let width = 0;
  if (crlfAt !== -1 && (lfAt === -1 || crlfAt <= lfAt)) {
    split = crlfAt;
    width = 4;
  } else if (lfAt !== -1) {
    split = lfAt;
    width = 2;
  }
  if (split === -1) {
    return { headers: new Map<string, string[]>(), body: Buffer.alloc(0), source };
  }
  const headerText = source.subarray(0, split).toString("latin1");
  return {
    headers: parseEmailHeaders(headerText),
    body: source.subarray(split + width),
    source,
  };
}

/**
 * Parse one header block.
 *
 * A folded header (a continuation line beginning with space or tab) is joined
 * to the header above it, because a long `References` header is folded by every
 * client and an unfolded one would not match the ids inside it.
 */
export function parseEmailHeaders(headerText: string): EmailHeaders {
  const headers: EmailHeaders = new Map();
  for (const rawLine of headerText.split(/\r?\n/)) {
    if (rawLine === "") continue;
    if (/^[ \t]/.test(rawLine)) {
      const keys = [...headers.keys()];
      const last = keys[keys.length - 1];
      if (last === undefined) continue;
      const values = headers.get(last)!;
      values[values.length - 1] = `${values[values.length - 1]} ${rawLine.trim()}`;
      continue;
    }
    const colon = rawLine.indexOf(":");
    if (colon <= 0) continue;
    const name = rawLine.slice(0, colon).trim().toLowerCase();
    const value = rawLine.slice(colon + 1).trim();
    const existing = headers.get(name);
    if (existing) existing.push(value);
    else headers.set(name, [value]);
  }
  return headers;
}

// ---------------------------------------------------------------------------
// RFC 2047 encoded words
// ---------------------------------------------------------------------------

const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?]*)\?=/g;

/**
 * Decode one charset's bytes.
 *
 * `us-ascii`, `utf-8` and the two Latin-1 spellings are decoded exactly. An
 * unknown charset is decoded as UTF-8 rather than refused: a message is never
 * lost to a label this build does not know, and a mojibake character is a
 * visible, recoverable defect where a dropped message is not.
 */
export function decodeEmailCharset(bytes: Buffer, charset: string): string {
  const name = charset.trim().toLowerCase().replace(/^"|"$/g, "");
  switch (name) {
    case "utf-8":
    case "utf8":
    case "us-ascii":
    case "ascii":
    case "":
      return bytes.toString("utf8");
    case "iso-8859-1":
    case "iso8859-1":
    case "latin1":
    case "latin-1":
    case "windows-1252":
    case "cp1252":
      return bytes.toString("latin1");
    default:
      return bytes.toString("utf8");
  }
}

/** RFC 2047 `Q` decoding: `_` is a space, `=XX` is a byte. */
function decodeEncodedWordQ(text: string): Buffer {
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "_") {
      bytes.push(0x20);
      continue;
    }
    if (char === "=") {
      const hex = text.slice(index + 1, index + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        index += 2;
        continue;
      }
    }
    bytes.push(char.charCodeAt(0));
  }
  return Buffer.from(bytes);
}

/**
 * Decode every encoded word in a header value.
 *
 * Whitespace between two adjacent encoded words is dropped (RFC 2047 §6.2);
 * whitespace around an encoded word that stands alone is kept, because that is
 * ordinary text. A word whose encoding this build cannot apply is left as it
 * arrived rather than replaced by an empty string.
 */
export function decodeEmailHeaderValue(value: string): string {
  if (!value.includes("=?")) return value;
  const pattern = new RegExp(ENCODED_WORD.source, "g");
  let out = "";
  let lastIndex = 0;
  let previousWasWord = false;
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0;
    const between = value.slice(lastIndex, start);
    let decoded: string | null = null;
    try {
      const bytes =
        match[2]!.toUpperCase() === "B"
          ? Buffer.from(match[3]!, "base64")
          : decodeEncodedWordQ(match[3]!);
      decoded = decodeEmailCharset(bytes, match[1]!);
    } catch {
      decoded = null;
    }
    if (decoded === null) {
      // An encoded word this build cannot apply stays exactly as it arrived.
      out += between + match[0];
      previousWasWord = false;
    } else if (previousWasWord && /^[ \t\r\n]*$/.test(between)) {
      // Folding whitespace between two encoded words is not content.
      out += decoded;
    } else {
      out += between + decoded;
    }
    if (decoded !== null) previousWasWord = true;
    lastIndex = start + match[0].length;
  }
  return out + value.slice(lastIndex);
}

/** Whether a header value carries an RFC 2047 encoded word. */
export function hasEncodedWords(value: string): boolean {
  return /=\?([^?\s]+)\?([BbQq])\?([^?]*)\?=/.test(value);
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

const ADDRESS = /^[^\s@<>",;]+@[^\s@<>",;]+$/;

/**
 * Extract the bare addresses from a `From`/`To` value.
 *
 * `"Ops" <ops@example.org>` and `ops@example.org` both answer
 * `ops@example.org`, lowercased — addresses are case-insensitive and the
 * allowlist must not be defeated by a capital letter. An entry that is not an
 * address is dropped rather than guessed at.
 */
export function parseEmailAddresses(value: string): string[] {
  const decoded = decodeEmailHeaderValue(value);
  const out: string[] = [];
  for (const piece of splitAddressList(decoded)) {
    const angled = /<([^<>]+)>/.exec(piece);
    const candidate = (angled ? angled[1]! : piece).trim().replace(/^["']|["']$/g, "");
    if (!ADDRESS.test(candidate)) continue;
    const lower = candidate.toLowerCase();
    if (!out.includes(lower)) out.push(lower);
  }
  return out;
}

/** Split an address list on commas that are not inside quotes or brackets. */
function splitAddressList(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    if (!quoted && char === "<") angled = true;
    if (!quoted && char === ">") angled = false;
    if (char === "," && !quoted && !angled) {
      out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim() !== "") out.push(current);
  return out.map((entry) => entry.trim()).filter((entry) => entry !== "");
}

/** Every `Message-ID`-shaped token in a header, angle brackets stripped. */
export function parseMessageIds(value: string): string[] {
  return [...value.matchAll(/<([^<>]+)>/g)].map((match) => match[1]!.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// The body
// ---------------------------------------------------------------------------

/** One content type: the media type and its parameters, lowercased keys. */
export type EmailContentType = { type: string; params: Record<string, string> };

/** Parse a `Content-Type` value; an absent one is the RFC default, text/plain. */
export function parseContentType(value: string): EmailContentType {
  if (value.trim() === "") return { type: "text/plain", params: {} };
  const [head, ...rest] = value.split(";");
  const params: Record<string, string> = {};
  for (const entry of rest) {
    const eq = entry.indexOf("=");
    if (eq === -1) continue;
    const key = entry.slice(0, eq).trim().toLowerCase();
    const raw = entry.slice(eq + 1).trim().replace(/^"|"$/g, "");
    if (key !== "") params[key] = raw;
  }
  return { type: (head ?? "").trim().toLowerCase() || "text/plain", params };
}

/**
 * Split a multipart body into its parts' bytes.
 *
 * The delimiter is `--boundary` at the start of a line, and the closing one is
 * `--boundary--`. Everything between two delimiters is one part, including its
 * own header block. A boundary that never appears yields no parts, which the
 * caller reports rather than guessing at.
 */
export function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const delimiter = `--${boundary}`;
  const parts: Buffer[] = [];
  let current: string[] | null = null;
  const flush = (): void => {
    if (current === null) return;
    // The blank line that separates a part's headers from its body is part of
    // the bytes; only a trailing CRLF before the next delimiter is dropped.
    parts.push(Buffer.from(current.join("\r\n"), "latin1"));
    current = null;
  };
  for (const line of body.toString("latin1").split(/\r?\n/)) {
    const trimmed = line.replace(/[ \t]+$/, "");
    if (trimmed === `${delimiter}--`) {
      flush();
      break;
    }
    if (trimmed === delimiter) {
      flush();
      current = [];
      continue;
    }
    if (current !== null) current.push(line);
  }
  flush();
  return parts;
}

/** RFC 2045 quoted-printable decoding, soft line breaks included. */
export function decodeQuotedPrintable(text: string): Buffer {
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "=") {
      const hex = text.slice(index + 1, index + 3);
      if (hex === "\r\n") {
        index += 2;
        continue;
      }
      if (hex === "\n") {
        index += 1;
        continue;
      }
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        index += 2;
        continue;
      }
    }
    bytes.push(char.charCodeAt(0));
  }
  return Buffer.from(bytes);
}

/** Apply a part's `Content-Transfer-Encoding` to its bytes. */
function decodeTransferEncoding(body: Buffer, encoding: string): Buffer {
  const name = encoding.trim().toLowerCase();
  if (name === "base64") {
    const cleaned = body.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, "");
    return Buffer.from(cleaned, "base64");
  }
  if (name === "quoted-printable") {
    return decodeQuotedPrintable(body.toString("latin1"));
  }
  return body;
}

/** The outcome of asking a message for its text. */
export type EmailBodyResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

/** The most MIME nesting this build will walk before refusing a message. */
const MAX_MIME_DEPTH = 3;

/**
 * The plain text of a message, or the reason there is none.
 *
 * Every refusal names a structural fact — multipart with no text/plain leaf,
 * an HTML-only body, a part whose encoding produced nothing — never the
 * message's content, so a refusal is safe to record.
 */
export function extractEmailBody(headers: EmailHeaders, body: Buffer): EmailBodyResult {
  return textFromPart(headers, body, 0);
}

function textFromPart(headers: EmailHeaders, body: Buffer, depth: number): EmailBodyResult {
  if (depth > MAX_MIME_DEPTH) {
    return { ok: false, reason: "the message nests MIME parts too deeply" };
  }
  const contentType = parseContentType(emailHeader(headers, "content-type"));
  if (contentType.type.startsWith("multipart/")) {
    const boundary = contentType.params.boundary ?? "";
    if (boundary === "") {
      return { ok: false, reason: "the multipart message names no boundary" };
    }
    const parts = splitMultipart(body, boundary);
    if (parts.length === 0) {
      return { ok: false, reason: "the multipart message has no parsable parts" };
    }
    for (const part of parts) {
      const parsed = parseEmailMessage(part);
      const partType = parseContentType(emailHeader(parsed.headers, "content-type"));
      // A part with no Content-Type is text/plain by the RFC's default.
      if (partType.type !== "text/plain" && partType.type !== "") continue;
      if (partType.type.startsWith("multipart/")) continue;
      const text = decodeTextPart(parsed.headers, parsed.body);
      if (text.ok) return text;
    }
    return { ok: false, reason: "the message has no text/plain part" };
  }
  if (contentType.type === "text/html") {
    return { ok: false, reason: "the message is HTML, not plain text" };
  }
  if (contentType.type !== "text/plain" && contentType.type !== "") {
    return { ok: false, reason: "the message carries no plain-text body" };
  }
  return decodeTextPart(headers, body);
}

function decodeTextPart(headers: EmailHeaders, body: Buffer): EmailBodyResult {
  const contentType = parseContentType(emailHeader(headers, "content-type"));
  const charset = contentType.params.charset ?? "utf-8";
  const decoded = decodeTransferEncoding(
    body,
    emailHeader(headers, "content-transfer-encoding"),
  );
  const text = decodeEmailCharset(decoded, charset).replace(/\r\n/g, "\n").trimEnd();
  if (text.trim() === "") {
    return { ok: false, reason: "the message carries no text" };
  }
  return { ok: true, text };
}

/** A `Date` header as milliseconds, or `null` when it does not parse. */
export function parseEmailDate(value: string): number | null {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}
