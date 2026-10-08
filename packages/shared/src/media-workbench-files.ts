/**
 * Moving a finished render out of the session's scratch directory.
 *
 * The renderer names the file and the session; the main process decides whether
 * the path is one it wrote, using the same containment rule the generation path
 * applies to its output directory. A path outside that root is refused, so these
 * channels cannot be used as a general file copier.
 */
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
