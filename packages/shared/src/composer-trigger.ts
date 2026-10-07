/**
 * Trigger detection and completion insertion for the composer autocomplete
 * (D123–D125, D673). Pure string/cursor math so the exact "/"+"@" grammar is
 * unit tested away from React and IME timing.
 *
 * Grammar mirrors the pi CLI editor, with the slash rule broadened so a
 * command can be summoned from inside running prose:
 * - "/" opens the command menu from *any* position in the token under the
 *   cursor — after Latin text, after CJK text, at the start of the draft, or
 *   after whitespace. Only URL/path noise stays out: a slash directly after
 *   "/", ":" or "\" is part of an address, never a command. A later
 *   whitespace-delimited slash token offers Skills only; app commands still
 *   require the first token.
 * - "、" (U+3001) opens the same menu when a Chinese IME just delivered it as
 *   the last character of the token, without rewriting the draft: accepting a
 *   row replaces the mark. A draft that is *only* the mark is still rewritten
 *   to "/" up front (D405).
 * - "@" opens file mode when the token containing the cursor starts with
 *   "@" and the character before it is start-of-input, whitespace, or one
 *   of the pi delimiters (" ' =). A `@"` prefix starts a quoted token that
 *   may contain spaces until its closing quote.
 *
 * A broad trigger must not turn prose into a popup: `commandPosition` marks
 * the slashes that unambiguously ask for a command (start of the draft, or
 * right after whitespace / the ideographic comma). The menu keeps its
 * "no matches" state only there; elsewhere it opens while the typed query
 * still matches something and closes itself once it cannot.
 */

export type ComposerTriggerMode = "slash" | "file";

export type ComposerTrigger = {
  mode: ComposerTriggerMode;
  /** Filter text (after "/" or "@", quotes stripped). */
  query: string;
  /** Index of the trigger character ("/" or "@") in the draft. */
  tokenStart: number;
  /** End of the replaced region — always the cursor position. */
  tokenEnd: number;
  /**
   * Slash mode only: the trigger sits where a command is unambiguously
   * intended — start of the draft, after whitespace, or after CJK text /
   * the ideographic comma (D673). Left unset otherwise, so a slash that only
   * looks command-ish while the query still matches something stays quiet.
   */
  commandPosition?: true;
};

export const DEFAULT_LARGE_PASTE_THRESHOLD = 600;
export const MIN_LARGE_PASTE_THRESHOLD = 1;
export const MAX_LARGE_PASTE_THRESHOLD = 1_000_000;

/** Normalize the user-configured text-paste threshold at the renderer edge. */
export function normalizeLargePasteThreshold(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_LARGE_PASTE_THRESHOLD ||
    value > MAX_LARGE_PASTE_THRESHOLD
  ) {
    return DEFAULT_LARGE_PASTE_THRESHOLD;
  }
  return value;
}

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
/** Characters that end the token scan-back, per pi's autocomplete. */
const DELIMITERS = new Set([" ", "\t", "\n", "\r", '"', "'", "="]);
/**
 * A slash directly after one of these belongs to an address (`https://`,
 * `C:\`, `//host`), never to a command (D673).
 */
const SLASH_BLOCKING_PREFIX = new Set(["/", ":", "\\"]);

/**
 * Provider URL / filesystem noise: a token that already carries a drive
 * colon, a backslash, or a "//" is an address, and its slashes are
 * separators (D673).
 */
const ADDRESS_PREFIX = /[:\\]|\/\//;

/** U+3001 IDEOGRAPHIC COMMA — the mark a Chinese IME gives for "/" (D405). */
export const IDEOGRAPHIC_COMMA = "、";

/**
 * A Chinese IME types "、" where an ASCII "/" is meant, and switching input
 * methods to reach the slash menu breaks the flow of writing (issue #65). The
 * first character of an otherwise empty draft is rewritten to "/" so the
 * ordinary command menu opens; a mark anywhere later in the draft is text and
 * is left untouched.
 */
export function rewriteIdeographicCommaTrigger(value: string): string {
  return value.startsWith(IDEOGRAPHIC_COMMA)
    ? `/${value.slice(1)}`
    : value;
}

function isBoundary(value: string, index: number): boolean {
  if (index <= 0) return true;
  return DELIMITERS.has(value[index - 1]);
}

/**
 * CJK script or full-width punctuation (D673). A slash or ideographic comma
 * after one of these is a deliberate command summon — Chinese prose has no
 * word spaces, so the whitespace boundary rule alone never fires there.
 */
const CJK_BOUNDARY = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

function isCjkBoundary(ch: string | undefined): boolean {
  return ch !== undefined && CJK_BOUNDARY.test(ch);
}

/**
 * Whether a character ends a "word" for command purposes: start of input is
 * handled by the caller, everything else is whitespace or CJK. The composer's
 * draft painter reads the same predicate, so a token styled in the input is
 * always a token the trigger would also open on (D673).
 */
export function isComposerCommandBoundary(ch: string | undefined): boolean {
  if (ch === undefined) return true;
  return WHITESPACE.has(ch) || isCjkBoundary(ch);
}

/**
 * Whether the slash at `index` may open a command rather than being a path or
 * address separator (D673). The character right before it and the token it
 * lives in decide, so a summon typed after a sentence needs no space: Chinese
 * prose has none, and demanding one just to style a command is friction. The
 * menu trigger, the draft painter, and the send-time resolver all read this one
 * rule, so a token styled in the input is always a command that would also
 * resolve when the turn is sent.
 */
export function isComposerCommandSlash(value: string, index: number): boolean {
  if (value[index] !== "/") return false;
  const previous = index > 0 ? value[index - 1] : undefined;
  if (previous !== undefined && SLASH_BLOCKING_PREFIX.has(previous)) return false;
  let tokenStart = index;
  while (tokenStart > 0 && !WHITESPACE.has(value[tokenStart - 1]!)) tokenStart -= 1;
  const token = value.slice(tokenStart, index);
  // An `@path` owns its slashes as separators — the same precedence the trigger
  // gives file mode — so a directory named like a Skill is not a summon.
  if (token.startsWith("@")) return false;
  return !ADDRESS_PREFIX.test(token);
}

/** Detect the active autocomplete trigger for a draft + cursor, if any. */
export function detectTrigger(
  value: string,
  cursor: number,
): ComposerTrigger | null {
  if (cursor < 0 || cursor > value.length) return null;

  // File mode comes first: an "@path" token owns its slashes as path
  // separators, so completing a path is never mistaken for a command summon.
  // Quoted form: @"query with spaces — scan back for a `@"` whose "@" sits at a
  // boundary with no closing quote between the opening one and the cursor.
  for (let i = cursor - 1; i >= 0; i -= 1) {
    const ch = value[i];
    if (ch === '"') {
      // A bare closing quote before the cursor ends any quoted token.
      if (i > 0 && value[i - 1] === "@" && isBoundary(value, i - 1)) {
        const query = value.slice(i + 1, cursor);
        if (!query.includes('"') && !query.includes("\n")) {
          return {
            mode: "file",
            query,
            tokenStart: i - 1,
            tokenEnd: cursor,
          };
        }
      }
      break;
    }
    if (ch === "\n") break;
  }

  // File mode, plain token: scan back to the nearest delimiter.
  let start = cursor;
  while (start > 0 && !DELIMITERS.has(value[start - 1])) start -= 1;
  const token = value.slice(start, cursor);
  if (token.startsWith("@") && isBoundary(value, start)) {
    return {
      mode: "file",
      query: token.slice(1),
      tokenStart: start,
      tokenEnd: cursor,
    };
  }

  // Slash mode (D673). Only the token under the cursor can open the menu, and
  // the *nearest* marker in it wins: a later slash is a Skill reference, not a
  // second app command. The slash no longer has to start the token or follow a
  // space — "继续/qn" summons the menu exactly like "hi /cmd" does.
  let regionStart = cursor;
  while (regionStart > 0 && !WHITESPACE.has(value[regionStart - 1])) regionStart -= 1;
  const region = value.slice(regionStart, cursor);
  const commaJustTyped =
    region.length > 0 && region[region.length - 1] === IDEOGRAPHIC_COMMA;

  let slashStart = -1;
  const slashIndex = region.lastIndexOf("/");
  if (slashIndex !== -1) {
    const absolute = regionStart + slashIndex;
    if (isComposerCommandSlash(value, absolute)) slashStart = absolute;
  }
  // A command-consuming IME types "、" where "/" is meant (D405). Mid-draft the
  // mark is only a trigger while it is the last thing typed, so prose after a
  // 顿号 is never held hostage by a menu: accepting a row replaces the mark.
  if (slashStart === -1 && commaJustTyped) {
    slashStart = regionStart + region.length - 1;
  }

  if (slashStart !== -1) {
    let tokenEnd = cursor;
    if (slashStart > 0) {
      while (tokenEnd < value.length && !WHITESPACE.has(value[tokenEnd])) tokenEnd += 1;
    }
    const trigger: ComposerTrigger = {
      mode: "slash",
      query: value.slice(slashStart + 1, cursor),
      tokenStart: slashStart,
      tokenEnd,
    };
    const previous = slashStart > 0 ? value[slashStart - 1] : undefined;
    if (isComposerCommandBoundary(previous)) {
      trigger.commandPosition = true;
    }
    return trigger;
  }

  return null;
}

export type SkillMention = { start: number; end: number; id: string };

/**
 * Resolve complete slash tokens against the active Skill catalog at send time
 * (D673). A summon is a slash that may open a command followed by a known Skill
 * name, and it counts wherever it sits: forcing a space before the slash left
 * `继续/qn-novel-write` looking right in the input while the sent turn invoked
 * nothing at all. Names resolve longest-first so `/qn-novel-write` never
 * answers for a longer word, and an address keeps its slashes.
 */
export function findSkillMentions(
  content: string,
  skillIds: ReadonlyMap<string, string>,
): SkillMention[] {
  const mentions: SkillMention[] = [];
  const names = [...skillIds.keys()]
    .filter((name) => name.length > 0)
    .sort((left, right) => right.length - left.length);
  let slash = content.indexOf("/");
  while (slash !== -1) {
    if (isComposerCommandSlash(content, slash)) {
      const name = names.find((candidate) => {
        if (!content.startsWith(candidate, slash + 1)) return false;
        const next = content[slash + candidate.length + 1];
        return next === undefined || WHITESPACE.has(next);
      });
      const id = name === undefined ? undefined : skillIds.get(name);
      if (name !== undefined && id !== undefined) {
        mentions.push({ start: slash, end: slash + name.length + 1, id });
      }
    }
    slash = content.indexOf("/", slash + 1);
  }
  return mentions;
}

/** Insertion text for an accepted slash command: `/name ` ready for args. */
export function formatCommandInsert(name: string): string {
  return `/${name} `;
}

/**
 * Insertion text for an accepted file entry. Files end with a space so the
 * prompt continues naturally; directories end with "/" (quote left open for
 * spaced paths) so completion continues into the directory (D124).
 */
export function formatFileInsert(path: string, kind: "dir" | "file"): string {
  const needsQuote = /\s/.test(path);
  if (kind === "dir") {
    return needsQuote ? `@"${path}/` : `@${path}/`;
  }
  return needsQuote ? `@"${path}" ` : `@${path} `;
}

/** Return a compact leaf label without changing the canonical reference path. */
export function fileReferenceLabel(path: string, preferredName?: string): string {
  const candidate = preferredName?.trim() || path;
  const normalized = candidate.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || candidate;
}

/**
 * Serialize renderer-owned file references only at send time. The textarea can
 * stay compact while the persisted/model-facing prompt keeps exact @ paths.
 */
export function serializeComposerFileReferences(
  draft: string,
  references: ReadonlyArray<{ path: string; token?: string }>,
): string {
  const content = serializeInlineComposerFileReferences(draft, references);
  const paths = references
    .filter((reference) => !reference.token)
    .map((reference) => formatFileInsert(reference.path, "file"))
    .join("")
    .trim();
  if (!content) return paths;
  if (!paths) return content;
  return `${content}\n${paths}`;
}

/**
 * Resolve only inline generated tokens (legacy @name strings or single
 * sentinel characters backing atomic chips). Each resolved token keeps one
 * separating space so adjacent chips never fuse their @paths together.
 */
export function serializeInlineComposerFileReferences(
  draft: string,
  references: ReadonlyArray<{ path: string; token?: string }>,
): string {
  let content = draft;
  for (const reference of references) {
    const token = reference.token?.trim();
    if (!token || !content.includes(token)) continue;
    const insert = formatFileInsert(reference.path, "file").trim();
    let index = content.indexOf(token);
    while (index !== -1) {
      const nextChar = content[index + token.length];
      const separator = nextChar && !/\s/.test(nextChar) ? " " : "";
      content =
        content.slice(0, index) +
        insert +
        separator +
        content.slice(index + token.length);
      index = content.indexOf(token, index + insert.length + separator.length);
    }
  }
  return content.trim();
}

/** Remove renderer-only inline reference tokens before text-only enhancement. */
export function stripInlineComposerFileReferenceTokens(
  draft: string,
  references: ReadonlyArray<{ token?: string }>,
): string {
  const tokens = references
    .map((reference) => reference.token?.trim())
    .filter((token): token is string => Boolean(token))
    .sort((a, b) => b.length - a.length);
  let content = draft;
  for (const token of tokens) content = content.replaceAll(token, "");
  return content;
}

/**
 * Restore inline reference chips around an enhanced text-only draft. The
 * model must never be trusted to preserve private renderer sentinels; tokens
 * keep their order and approximate relative text position instead.
 */
export function restoreInlineComposerFileReferenceTokens(
  sourceDraft: string,
  enhancedDraft: string,
  references: ReadonlyArray<{ token?: string }>,
): string {
  const tokens = references
    .map((reference) => reference.token?.trim())
    .filter((token): token is string => Boolean(token))
    .sort((a, b) => b.length - a.length);
  if (!tokens.length) return enhancedDraft;

  const occurrences: Array<{ sourceIndex: number; token: string; textOffset: number }> = [];
  for (const token of tokens) {
    let sourceIndex = sourceDraft.indexOf(token);
    while (sourceIndex !== -1) {
      occurrences.push({
        sourceIndex,
        token,
        textOffset: Array.from(
          stripInlineComposerFileReferenceTokens(sourceDraft.slice(0, sourceIndex), references),
        ).length,
      });
      sourceIndex = sourceDraft.indexOf(token, sourceIndex + token.length);
    }
  }
  if (!occurrences.length) return enhancedDraft;
  occurrences.sort((a, b) => a.sourceIndex - b.sourceIndex);

  const cleanEnhanced = stripInlineComposerFileReferenceTokens(enhancedDraft, references);
  const enhancedChars = Array.from(cleanEnhanced);
  const sourceTextLength = Array.from(
    stripInlineComposerFileReferenceTokens(sourceDraft, references),
  ).length;
  const insertions = new Map<number, string[]>();
  let previousTarget = 0;
  for (const occurrence of occurrences) {
    const target = sourceTextLength
      ? Math.round((occurrence.textOffset / sourceTextLength) * enhancedChars.length)
      : 0;
    const insertionIndex = Math.max(previousTarget, Math.min(enhancedChars.length, target));
    const group = insertions.get(insertionIndex) ?? [];
    group.push(occurrence.token);
    insertions.set(insertionIndex, group);
    previousTarget = insertionIndex;
  }

  const result: string[] = [];
  for (let index = 0; index <= enhancedChars.length; index += 1) {
    const group = insertions.get(index);
    if (group) result.push(...group);
    if (index < enhancedChars.length) result.push(enhancedChars[index]!);
  }
  return result.join("");
}

/** Replace the trigger token with `insert`, returning the new draft+cursor. */
export function applyCompletion(
  value: string,
  trigger: ComposerTrigger,
  insert: string,
): { value: string; cursor: number } {
  const before = value.slice(0, trigger.tokenStart);
  const after = value.slice(trigger.tokenEnd);
  return { value: before + insert + after, cursor: before.length + insert.length };
}
