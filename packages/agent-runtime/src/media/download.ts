import { lookup } from "node:dns/promises";
import {
  classifyIpLiteral,
  isAcceptableUserEndpointAddress,
  isCloudMetadataAddress,
  isProxyFakeIpAddress,
} from "@pi-desktop/shared";
import { Agent, fetch as fetchPinned } from "undici";

/**
 * Shared download core for generated media.
 *
 * Images and videos fetch their bytes from a URL the provider returned, from an
 * endpoint the user configured. That single rule — how a provider-supplied URL
 * is dialed — lives here once, so the two capabilities cannot drift apart; the
 * per-capability pieces (size cap, stable error codes, signature sniffing) stay
 * with their capability.
 *
 * `@pi-desktop/agent-runtime` has no access to the app's network policy (it
 * must not import Electron main-process modules), so a plaintext hop to a
 * private address cannot be gated on the user's choice here; the trade-off is
 * accepted because the endpoint this dials is the one the user configured, and
 * the response is still size-capped and stripped of provider-supplied headers.
 */

/** Stable error codes, one set per capability. */
export type MediaErrorCodes = {
  invalidUrl: string;
  unsafeUrl: string;
  downloadFailed: string;
  tooLarge: string;
  emptyResponse: string;
};

export type MediaDownloadOptions = {
  /** Explicitly permits router/TUN benchmark fake-IP answers. */
  allowFakeIp?: boolean;
  /** Proxy-aware transport used when a fake-IP answer must be resolved by the proxy. */
  fetchImpl?: typeof fetch;
};

export function mediaError(code: string): Error & { errorCode: string } {
  return Object.assign(new Error(code), { errorCode: code });
}

export async function mediaBoundedBytes(
  response: Pick<Response, "headers" | "body">,
  max: number,
  codes: MediaErrorCodes,
): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > max) {
    await response.body?.cancel();
    throw mediaError(codes.tooLarge);
  }
  if (!response.body) throw mediaError(codes.emptyResponse);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > max) throw mediaError(codes.tooLarge);
      chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

/**
 * Whether a resolved address may be dialed for generated media.
 *
 * The URL comes from the provider's own response, but the provider is an
 * endpoint the user configured, and a self-hosted one (ComfyUI, SD-WebUI) hands
 * back its own LAN address. Judging it by the third-party rule made those setups
 * unusable, so loopback, RFC1918, CGNAT, link-local, ULA and site-local are all
 * reachable here, and the address classes are taken from `@pi-desktop/shared`
 * rather than re-derived so they cannot drift. Cloud metadata stays refused on
 * every input, as do the classes that name no destination at all (unspecified,
 * multicast, reserved, documentation, benchmark — a fake-IP answer is a proxy
 * placeholder, not a host this process dials).
 */
export function publicMediaAddress(address: string): boolean {
  if (typeof address !== "string" || !address) return false;
  if (isCloudMetadataAddress(address)) return false;
  return isAcceptableUserEndpointAddress(address, classifyIpLiteral(address), "direct");
}

export function hasFakeIpAddress(address: string): boolean {
  return isProxyFakeIpAddress(classifyIpLiteral(address));
}

/**
 * Pin the checked DNS answer to the connection; never forward provider headers.
 *
 * Plain `http` and any port are accepted because the realistic target is a
 * self-hosted generator on the user's own machine or LAN, where TLS and port
 * 443 are the exception.
 *
 * An explicitly opted-in fake-IP answer is the one exception: it goes through the
 * global fetch instead, which resolves the hostname again at connect time.
 */
export async function downloadPublicMedia(
  raw: string,
  signal: AbortSignal,
  maxBytes: number,
  codes: MediaErrorCodes,
  options: MediaDownloadOptions = {},
): Promise<Uint8Array> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw mediaError(codes.invalidUrl);
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password
  ) {
    throw mediaError(codes.invalidUrl);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const answers = await lookup(hostname, { all: true });
  signal.throwIfAborted();
  const hasUnsafeAddress = answers.some((answer) => !publicMediaAddress(answer.address));
  const hasFakeIp = answers.some((answer) => hasFakeIpAddress(answer.address));
  const onlyFakeIp = answers.length > 0 && answers.every((answer) => hasFakeIpAddress(answer.address));
  if (
    !answers.length ||
    (hasUnsafeAddress && !(options.allowFakeIp === true && hasFakeIp && onlyFakeIp))
  )
    throw mediaError(codes.unsafeUrl);
  if (options.allowFakeIp === true && hasFakeIp) {
    const response = await (options.fetchImpl ?? fetch)(url, {
      signal,
      redirect: "error",
    });
    if (!response.ok) throw mediaError(codes.downloadFailed);
    return await mediaBoundedBytes(response, maxBytes, codes);
  }
  const address = answers[0];
  const dispatcher = new Agent({
    connect: {
      lookup: (_name, options, callback) => {
        if (options.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
    },
  });
  try {
    const response = await fetchPinned(url, { signal, redirect: "error", dispatcher });
    if (!response.ok) throw mediaError(codes.downloadFailed);
    return await mediaBoundedBytes(response as unknown as Response, maxBytes, codes);
  } finally {
    await dispatcher.destroy();
  }
}
