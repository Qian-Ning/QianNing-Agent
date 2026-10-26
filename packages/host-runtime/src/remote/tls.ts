/**
 * A self-signed certificate for the LAN listener.
 *
 * ADR 0333 §4 makes TLS a prerequisite for any non-loopback bind, and the
 * desktop has no certificate story today. Rather than depend on a CA the user
 * would have to install on a phone, the Host mints one leaf certificate per
 * machine and keeps it in its data directory. Phones show the usual
 * untrusted-certificate prompt the first time and trust it from then on.
 *
 * The encoding is written out here instead of pulled from a library because
 * this is the only X.509 the product ever emits: a single v3 leaf with a
 * `serverAuth` EKU, a two-year validity, and a SAN carrying the addresses the
 * listener actually binds. iOS rejects anything longer than 825 days and
 * anything without a SAN, so both are enforced rather than assumed.
 */

import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type SelfSignedCertificate = {
  /** PEM. */
  cert: string;
  /** PEM, PKCS#8. */
  key: string;
};

export type CertificateTarget = {
  /** DNS names to place in the SAN, e.g. `localhost` and the machine name. */
  hostnames: readonly string[];
  /** IPv4 addresses to place in the SAN, loopback included. */
  addresses: readonly string[];
};

/** iOS refuses a leaf valid for longer than this, so the default stays under it. */
const MAX_VALIDITY_DAYS = 825;

// ── DER primitives ──────────────────────────────────────────────────────────

function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

const sequence = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));

function integer(value: Buffer): Buffer {
  // DER integers are signed and minimal: a leading zero keeps a high-bit value
  // positive rather than turning it into a negative serial number.
  const body = value[0] & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value;
  return tlv(0x02, body);
}

function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const body: number[] = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [part & 0x7f];
    let rest = part >>> 7;
    while (rest > 0) {
      chunk.unshift((rest & 0x7f) | 0x80);
      rest >>>= 7;
    }
    body.push(...chunk);
  }
  return tlv(0x06, Buffer.from(body));
}

const utf8 = (value: string): Buffer => tlv(0x0c, Buffer.from(value, "utf8"));
const ia5 = (value: string): Buffer => tlv(0x16, Buffer.from(value, "ascii"));
const octetString = (value: Buffer): Buffer => tlv(0x04, value);
const bitString = (value: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), value]));
const boolean = (value: boolean): Buffer => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));

/** `[n] EXPLICIT` — used for version and extensions. */
const explicit = (n: number, content: Buffer): Buffer => tlv(0xa0 + n, content);
/** `[n] IMPLICIT` primitive — used inside GeneralName. */
const implicitPrimitive = (n: number, content: Buffer): Buffer => tlv(0x80 + n, content);

function utcTime(date: Date): Buffer {
  const iso = date.toISOString(); // 2026-10-27T05:00:00.000Z
  const stamp = iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10) + iso.slice(11, 13) + iso.slice(14, 16) + iso.slice(17, 19);
  return tlv(0x17, Buffer.from(`${stamp}Z`, "ascii"));
}

function name(commonName: string): Buffer {
  return sequence(set(sequence(oid("2.5.4.3"), utf8(commonName))));
}

// ── Certificate ─────────────────────────────────────────────────────────────

/** `ecdsa-with-SHA256`: small, fast, and universally accepted for TLS leaves. */
const ECDSA_WITH_SHA256 = sequence(oid("1.2.840.10045.4.3.2"));

function subjectAltName(target: CertificateTarget): Buffer {
  const names: Buffer[] = [];
  for (const host of target.hostnames) names.push(implicitPrimitive(2, Buffer.from(host, "ascii")));
  for (const address of target.addresses) {
    const parts = address.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      throw new Error(`not an IPv4 address: ${address}`);
    }
    names.push(implicitPrimitive(7, Buffer.from(parts)));
  }
  if (names.length === 0) throw new Error("a certificate needs at least one SAN entry");
  return sequence(...names);
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return sequence(...(critical ? [oid(id), boolean(true), octetString(value)] : [oid(id), octetString(value)]));
}

export function buildCertificate(
  target: CertificateTarget,
  options: { commonName?: string; days?: number; now?: Date } = {},
): SelfSignedCertificate {
  const days = options.days ?? 730;
  if (days > MAX_VALIDITY_DAYS) {
    throw new Error(`validity of ${days} days exceeds the ${MAX_VALIDITY_DAYS}-day ceiling iOS enforces`);
  }
  const notBefore = new Date((options.now ?? new Date()).getTime() - 60_000);
  const notAfter = new Date(notBefore.getTime() + days * 86_400_000);
  const commonName = options.commonName ?? "QianNing Agent";

  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = (publicKey as KeyObject).export({ type: "spki", format: "der" }) as Buffer;

  const extensions = explicit(
    3,
    sequence(
      // CA:TRUE is deliberate. This certificate is its own trust anchor: a
      // phone trusts it by installing it, and a trust anchor that is not a CA
      // fails validation on both Android and iOS. It is a leaf in practice —
      // nothing is signed under it — but the flag is what makes it usable.
      extension("2.5.29.19", true, sequence(boolean(true))),
      extension("2.5.29.15", true, bitString(Buffer.from([0x84]))), // digitalSignature + keyCertSign
      extension("2.5.29.37", false, sequence(oid("1.3.6.1.5.5.7.3.1"))), // extKeyUsage: serverAuth
      extension("2.5.29.17", false, subjectAltName(target)),
    ),
  );

  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x40; // positive and non-zero, no leading-zero padding needed

  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))), // v3
    integer(serial),
    ECDSA_WITH_SHA256,
    name(commonName), // issuer == subject: self-signed
    sequence(utcTime(notBefore), utcTime(notAfter)),
    name(commonName),
    spki,
    extensions,
  );

  const signatureValue = sign("sha256", tbs, privateKey);
  const certificate = sequence(tbs, ECDSA_WITH_SHA256, bitString(signatureValue));

  return {
    cert: toPem("CERTIFICATE", certificate),
    key: (privateKey as KeyObject).export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function toPem(label: string, der: Buffer): string {
  const body = der.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

/**
 * Reads the certificate this machine already minted, or mints one.
 *
 * A certificate is bound to the addresses it names, so a machine that moves
 * between networks would otherwise present a certificate for the wrong SAN and
 * fail every TLS handshake without an obvious reason. Callers pass the current
 * target set; a mismatch regenerates rather than silently reusing.
 */
export async function ensureCertificate(
  directory: string,
  target: CertificateTarget,
  now: Date = new Date(),
): Promise<SelfSignedCertificate> {
  const certPath = join(directory, "cert.pem");
  const keyPath = join(directory, "key.pem");
  try {
    const [cert, key] = await Promise.all([readFile(certPath, "utf8"), readFile(keyPath, "utf8")]);
    if (cert.includes("BEGIN CERTIFICATE") && key.includes("PRIVATE KEY") && namesEveryTarget(cert, target)) {
      return { cert, key };
    }
  } catch {
    // First use, or an unreadable pair: mint a new one.
  }
  const minted = buildCertificate(target, { now });
  await mkdir(directory, { recursive: true });
  await writeFile(certPath, minted.cert, { encoding: "utf8", mode: 0o600 });
  await writeFile(keyPath, minted.key, { encoding: "utf8", mode: 0o600 });
  return minted;
}

/**
 * Whether the stored PEM already covers every address in `target`.
 *
 * The SAN is DER inside the PEM, so this searches the decoded bytes for the
 * ASCII host names and the four raw address octets instead of parsing X.509.
 * Cheap, and the only failure mode is a needless regeneration.
 */
function namesEveryTarget(certPem: string, target: CertificateTarget): boolean {
  const base64 = certPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  let der: Buffer;
  try {
    der = Buffer.from(base64, "base64");
  } catch {
    return false;
  }
  for (const hostname of target.hostnames) {
    if (!der.includes(Buffer.from(hostname, "ascii"))) return false;
  }
  for (const address of target.addresses) {
    const octets = Buffer.from(address.split(".").map(Number));
    if (!der.includes(octets)) return false;
  }
  return true;
}
