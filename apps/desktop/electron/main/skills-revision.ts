/**
 * A fingerprint for the skills a session runs with.
 *
 * The shipped skill documents are read from disk every session, so an upgrade
 * changes what the model is told without leaving any trace in the transcript.
 * When an answer looks different from last week's, there is nothing to compare
 * against — the only way to know which documents produced it is to guess.
 *
 * The revision is that comparison point: a short digest over the file names and
 * their contents, stable across machines and runs, and changed by any edit.
 *
 * It is a fingerprint, not a snapshot: it does not keep the old documents, so it
 * cannot restore them. Its one job is to make "same revision?" answerable.
 */
import { createHash } from "node:crypto";

export type SkillDigestInput = {
  /** Path relative to the skill root, already normalised to forward slashes. */
  path: string;
  content: string;
};

/**
 * Digest of the whole shipped skill set.
 *
 * Sorted by path so the value does not depend on directory order — `readdir`
 * order differs between filesystems, and a fingerprint that changes when nothing
 * changed is worse than none. Length-prefixed so that moving a byte from one
 * file to the next cannot produce the same digest.
 */
export function computeSkillsRevision(entries: readonly SkillDigestInput[]): string {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = createHash("sha256");
  for (const entry of sorted) {
    const path = entry.path.split("\\").join("/");
    hash.update(`${path.length}:${path}\n`);
    hash.update(`${entry.content.length}:`);
    hash.update(entry.content, "utf8");
    hash.update("\n");
  }
  return hash.digest("hex").slice(0, 16);
}

/** Short form for a status line: `skills 3f9a…`. */
export function formatSkillsRevision(revision: string): string {
  return `skills ${revision}`;
}
