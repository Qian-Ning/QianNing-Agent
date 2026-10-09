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
 * Only the image capability gets a thumbnail. A video row's output is a clip,
 * and a still frame for it is a different problem entirely (there is no frame
 * extractor here), so this stays silent for video and returns `undefined`.
 */
import type { Run } from "./useWorkbenchRuns";

/**
 * The `url` of the first succeeded image result that carries one, or
 * `undefined` when the row has no such output.
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
  return first?.url;
}
