/**
 * The pairing link, read back into its two halves.
 *
 * The desktop card copies one string — `https://<ip>:<port>/app#t=<token>` —
 * carrying both the address the phone dials and the credential it presents.
 * Keeping the reader here means the desktop that writes the link and the phone
 * that consumes it share one definition of the format, instead of two parsers
 * drifting apart by a fragment key.
 */

export type PairingTarget = {
  /** Origin only: `https://192.168.1.8:6838`. */
  url: string;
  /** The device token from the fragment. */
  token: string;
};

/**
 * Reads a pairing link, or returns null when the text is something else.
 *
 * Null is the normal answer for a paste that is not a link — the field shows
 * "that is not a pairing link" — so nothing here throws on bad input. Plaintext
 * origins are refused for the same reason the listener refuses to serve them:
 * the token must never travel unencrypted.
 */
export function parsePairingLink(input: string): PairingTarget | null {
  const text = input.trim();
  if (!text) return null;

  if (/^https?:\/\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    if (url.protocol !== "https:") return null;
    if (!url.port) return null;

    const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
    const token = fragment.get("t") ?? fragment.get("token") ?? "";
    if (!token) return null;
    return { url: `${url.protocol}//${url.host}`, token };
  }

  // `192.168.1.8:6838 pdt1.…` — a link split by a chat client's line wrapping.
  const parts = text.split(/\s+/);
  if (parts.length !== 2) return null;
  const [address, token] = parts as [string, string];
  if (!token) return null;
  try {
    const url = new URL(`https://${address}`);
    if (!url.port) return null;
    return { url: `${url.protocol}//${url.host}`, token };
  } catch {
    return null;
  }
}
