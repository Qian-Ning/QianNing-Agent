/**
 * Moving a finished render out of the session's scratch directory.
 *
 * The renderer names the file and the session; the main process decides whether
 * the path is one it wrote, using the same containment rule the generation path
 * applies to its output directory. A path outside that root is refused, so these
 * channels cannot be used as a general file copier.
 */
import type { MediaWorkbenchCapability } from "./media-workbench";

export type MediaWorkbenchFileRequest = {
  sessionId: string;
  /** Absolute path of the generated file. */
  path: string;
};

export type MediaWorkbenchFileResult = {
  ok: boolean;
  /** True when the user dismissed the save dialog. */
  cancelled?: boolean;
  /** Where the copy landed, or the file that was revealed. */
  path?: string;
};

/**
 * A poster frame the renderer took from a finished clip.
 *
 * The frame is decoded on the renderer's side, because that is the only side with
 * a video decoder; the bytes travel here so the main process can keep them, since
 * only the main process writes into the library. `path` names the render the frame
 * came from, and the copy lands beside it under the capability's own thumbs
 * directory — the shape the image copies already have.
 */
export type MediaWorkbenchThumbnailRequest = {
  capability: MediaWorkbenchCapability;
  /** Absolute path of the library render the frame belongs to. */
  path: string;
  /** The frame as a PNG `data:` URL, the way a canvas encodes one. */
  dataUrl: string;
};
