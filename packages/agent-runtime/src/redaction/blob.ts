/**
 * Whether an object carries binary payload rather than text.
 *
 * A multimodal message arrives as `{ type: "base64", data: "…" }` or with a
 * `media_type` of `image/*`, `audio/*`, `video/*`. Those bytes are the user's
 * image, not a credential: running a phone-number regex over base64 changes the
 * payload without removing a secret, and a corrupted blob fails the request.
 *
 * The decision is made per object, and only the `data` field of such an object
 * is left alone — surrounding text (`caption`, `name`) is still scanned.
 */

export function shouldSkipBlob(value: { [key: string]: unknown }): boolean {
  if (value.type === "base64" || value.type === "BASE64") return true;
  const mediaType = value.media_type;
  return typeof mediaType === "string" && /^(image|audio|video)\//i.test(mediaType);
}
