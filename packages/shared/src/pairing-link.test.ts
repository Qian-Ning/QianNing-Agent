import { describe, expect, it } from "vitest";

import { parsePairingLink } from "./pairing-link.js";

describe("parsePairingLink", () => {
  it("reads the link the desktop copies", () => {
    expect(parsePairingLink("https://192.168.1.8:6838/app#t=pdt1.abcDEF123")).toEqual({
      url: "https://192.168.1.8:6838",
      token: "pdt1.abcDEF123",
    });
  });

  it("accepts the same link without the shell path", () => {
    expect(parsePairingLink("https://10.0.0.2:7000/#t=tok")?.url).toBe("https://10.0.0.2:7000");
  });

  it("decodes a token that was escaped into the fragment", () => {
    expect(parsePairingLink("https://10.0.0.2:7000/app#t=a%2Bb")?.token).toBe("a+b");
  });

  it("reads two values a chat client left on one line", () => {
    expect(parsePairingLink("  192.168.1.8:6838   pdt1.abc123  ")).toEqual({
      url: "https://192.168.1.8:6838",
      token: "pdt1.abc123",
    });
  });

  it("refuses a plaintext origin", () => {
    expect(parsePairingLink("http://192.168.1.8:6838/app#t=tok")).toBeNull();
  });

  it("refuses a link without a port, a token, or anything at all", () => {
    expect(parsePairingLink("https://192.168.1.8/app#t=tok")).toBeNull();
    expect(parsePairingLink("https://192.168.1.8:6838/app")).toBeNull();
    expect(parsePairingLink("   ")).toBeNull();
    expect(parsePairingLink("not a link")).toBeNull();
  });
});
