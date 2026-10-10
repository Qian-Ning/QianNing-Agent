/**
 * Which image a history row shows, if any.
 *
 * The history is how the user finds an old render by eye, so a row leads with a
 * small picture. A row is a *run*, however, and a run may hold several outputs —
 * including partial failures. This picks exactly one of them: the first item
 * that succeeded and actually has something the renderer can load, so the row
 * shows the same first-good image every time it is rendered rather than jumping
 * between outputs. Kept out of the component and pure so the choice is a fact a
 * test pins, not a line of JSX re-derived on each render.
 *
 * The small copy the main process writes beside a render (`thumbUrl`) is what a
 * row wants: the element decodes whatever it points at, so pointing it at the
 * full file means decoding a full-size image into a 32px box. An item recorded
 * before copies existed carries no `thumbUrl`, and that row falls back to the full
 * file — the same picture, just bigger to decode, exactly as before.
 *
 * Only the image capability gets a thumbnail. A video row's output is a clip, and
 * a still frame for it is a different problem entirely (nothing writes one yet),
 * so this stays silent for video and returns `undefined`.
 */
import type { Run } from "./useWorkbenchRuns";

/**
 * The URL of the first succeeded image result that carries one, or `undefined`
 * when the row has no such output. Prefers the derived small copy when the item
 * has one.
 *
 * A missing `results` array, an empty array, a run whose only outputs failed or
 * were cancelled, or a non-image row all answer `undefined` — the row then
 * renders exactly as it did before this feature, with no broken element.
 */
export function pickRowThumbnail(run: Run): string | undefined {
  if (run.capability !== "image") return undefined;
  const first = run.results?.find(
    (item) => item.status === "succeeded" && typeof item.url === "string" && item.url.length > 0,
  );
  if (!first) return undefined;
  // The results are a union with video, and only an image result can carry the
  // copy, so the field is read only when the value actually has one.
  const copy = "thumbUrl" in first && typeof first.thumbUrl === "string" ? first.thumbUrl : "";
  return copy.length > 0 ? copy : first.url;
}
