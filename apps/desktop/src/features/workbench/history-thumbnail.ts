/**
 * Which image a history row shows, if any.
 *
 * The history is how the user finds an old render by eye, so a row leads with a
 * small picture. A row is a *run*, however, and a run may hold several outputs —
 * including partial failures. This picks exactly one of them: the first item that
 * succeeded and actually has something the renderer can load, so the row shows the
 * same first-good item every time it is rendered rather than jumping between
 * outputs. Kept out of the component and pure so the choice is a fact a test pins,
 * not a line of JSX re-derived on each render.
 *
 * An image row leads with the small copy the main process wrote beside the render
 * (`thumbUrl`), falling back to the render itself when no copy was ever written:
 * the element decodes whatever it points at, so the copy is what keeps a 32px box
 * from decoding a full-size picture.
 *
 * A clip row is the other way round. The only picture it can have is a poster frame
 * taken from the clip, so it shows that and nothing else — pointing an `<img>` at a
 * clip would decode nothing and leave the row empty. A clip with no poster (one
 * recorded before posters existed, or one whose frame could not be taken) renders
 * as it did before any of this: just the row.
 */
import type { Run } from "./useWorkbenchRuns";

/**
 * The URL of the first succeeded result that carries one, or `undefined` when the
 * row has no such output.
 *
 * A missing `results` array, an empty array, a run whose only outputs failed or
 * were cancelled, or a clip row without a poster all answer `undefined` — the row
 * then renders exactly as it did before this feature, with no broken element.
 */
export function pickRowThumbnail(run: Run): string | undefined {
  const first = run.results?.find(
    (item) => item.status === "succeeded" && typeof item.url === "string" && item.url.length > 0,
  );
  if (!first) return undefined;
  // The results are a union with video, and only an image result carries a copy
  // of its own, so the field is read only when the value actually has one.
  const copy = "thumbUrl" in first && typeof first.thumbUrl === "string" ? first.thumbUrl : "";
  if (copy.length > 0) return copy;
  return run.capability === "image" ? first.url : undefined;
}
