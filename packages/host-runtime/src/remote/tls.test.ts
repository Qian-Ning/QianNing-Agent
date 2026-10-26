import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildCertificate, ensureCertificate } from "./tls.js";

const TARGET = { hostnames: ["localhost"], addresses: ["127.0.0.1", "192.168.1.42"] };

/**
 * The two things a phone actually rejects: a lifetime longer than iOS allows,
 * and a SAN that does not name the address the phone connected to. Both fail at
 * handshake time with a message that says nothing useful, so they are pinned
 * here instead of discovered on a device.
 */
describe("the LAN certificate", () => {
  it("is valid, self-signed, and names every address it will be served on", () => {
    const { cert, key } = buildCertificate(TARGET);
    const parsed = new X509Certificate(cert);

    expect(parsed.subject).toBe(parsed.issuer);
    expect(parsed.subjectAltName).toContain("DNS:localhost");
    expect(parsed.subjectAltName).toContain("IP Address:192.168.1.42");
    expect(parsed.subjectAltName).toContain("IP Address:127.0.0.1");
    expect(parsed.checkIssued(parsed)).toBe(true);

    const days = (Date.parse(parsed.validTo) - Date.parse(parsed.validFrom)) / 86_400_000;
    expect(days).toBeGreaterThan(700);
    expect(days).toBeLessThanOrEqual(825);
    expect(key).toContain("BEGIN PRIVATE KEY");
  });

  it("refuses a lifetime longer than iOS accepts instead of minting one", () => {
    expect(() => buildCertificate(TARGET, { days: 900 })).toThrow(/825/);
  });

  it("is reused while it still names the machine", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qianning-tls-"));
    const first = await ensureCertificate(directory, TARGET);
    const again = await ensureCertificate(directory, TARGET);

    expect(again.cert).toBe(first.cert);
    expect(await readFile(join(directory, "cert.pem"), "utf8")).toBe(first.cert);
  });

  it("regenerates when the machine moves, rather than serving the wrong SAN", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qianning-tls-"));
    const first = await ensureCertificate(directory, TARGET);
    const moved = await ensureCertificate(directory, {
      hostnames: ["localhost"],
      addresses: ["127.0.0.1", "10.0.0.7"],
    });

    expect(moved.cert).not.toBe(first.cert);
    expect(new X509Certificate(moved.cert).subjectAltName).toContain("IP Address:10.0.0.7");
  });
});
