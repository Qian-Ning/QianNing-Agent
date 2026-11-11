import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The directory this module lives in, at runtime.
 *
 * Main is bundled as ESM, where the CommonJS `dirname` global does not exist.
 * electron-vite patches that with a per-chunk shim, but the shim can miss the
 * entry chunk when the chunk graph changes — and a missing shim takes the whole
 * app down before a window exists (backend boot fails with a bare
 * `ReferenceError`). Deriving the path here keeps Main independent of that
 * plugin, in both the bundled and the unbundled run.
 */
export const MAIN_DIR: string =
  typeof import.meta.dirname === "string"
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));
