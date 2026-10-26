import type { PluginSkillDef } from "./plugin-skills.js";

/**
 * Lexical relevance between a user prompt and the advertised skill catalog.
 *
 * The catalog tells the model what exists; this module answers the narrower
 * question the host asks on every prompt: is there one skill so clearly on
 * topic that its body should arrive with the first turn instead of waiting for
 * a `Skill` call? It is deliberately dumb — no model, no embedding, no extra
 * dependency — and deliberately conservative: a wrong guess spends context on
 * instructions for a task nobody asked for, which is worse than letting the
 * model pick from the catalog.
 *
 * Words are weighted by how rare they are across the catalog (IDF), so a hit on
 * `debugpy` or `spectrogram` counts far more than a hit on `code` or `file`.
 * A prompt must clear both an absolute score and a margin over the runner-up;
 * two plausible skills means the choice is the model's, not ours.
 */

/**
 * Grammar and filler that appears everywhere and distinguishes nothing.
 *
 * Three-letter entries are here so the token floor can sit at three without
 * letting `add` or `new` vote: short technical terms — `sql`, `esp`, `git`,
 * `pdf`, `gpu` — are exactly the signals worth keeping at that length.
 */
const STOP_WORDS = new Set([
  "the", "this", "that", "these", "those", "with", "from", "have", "has", "had",
  "will", "would", "should", "could", "can", "your", "you", "and", "for", "not",
  "are", "was", "were", "been", "being", "into", "when", "what", "which", "while",
  "their", "there", "then", "than", "them", "they", "does", "did", "doing", "also",
  "just", "only", "about", "after", "before", "over", "under", "again", "more",
  "most", "some", "such", "very", "each", "other", "same", "both", "because",
  "but", "its", "our", "out", "own", "too", "use", "used", "using", "make",
  "made", "need", "needs", "want", "wants", "like", "please", "help", "here",
  "how", "why", "where", "who", "all", "any", "one", "two", "get", "got",
  "add", "fix", "new", "app", "set", "put", "run", "see", "let", "try", "way",
  "his", "her", "him", "she", "yes", "yet", "now", "end", "top", "big", "bad",
  "old", "even", "done", "via", "per", "day", "lot", "far", "few", "off",
]);

const MIN_TOKEN_LENGTH = 3;

/** Score a skill must reach before its body is worth preloading. */
export const SKILL_PRELOAD_MIN_SCORE = 5;

/** The runner-up must stay this far below the leader, or the choice is ambiguous. */
export const SKILL_PRELOAD_MARGIN = 0.9;

/**
 * IDF is measured against a fixed reference size rather than the catalog in
 * front of it, so the floor means the same thing for a two-skill test fixture
 * and the eighty-skill production catalog. A word in one document stays rare
 * (≈4.4) at every scale, which is what the floor is calibrated on.
 */
const IDF_REFERENCE_SIZE = 80;

/** A hit on the id slug is the author's own naming of the domain — weight it up. */
const SLUG_WEIGHT = 1.5;

export type SkillRelevance = {
  id: string;
  score: number;
};

function tokensOf(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return matches.filter((token) => token.length >= MIN_TOKEN_LENGTH && !STOP_WORDS.has(token));
}

function skillTokenWeights(skill: PluginSkillDef): Map<string, number> {
  const weights = new Map<string, number>();
  for (const token of tokensOf(skill.description ?? "")) weights.set(token, 1);
  for (const token of tokensOf(skill.name)) weights.set(token, 1);
  const slug = skill.id.slice(skill.id.lastIndexOf("/") + 1);
  for (const token of tokensOf(slug.replace(/-/g, " "))) weights.set(token, SLUG_WEIGHT);
  return weights;
}

/**
 * Every skill with a non-zero score, best first. Callers that need the ranked
 * list (diagnostics, tests) use this directly; preload uses the chooser below.
 */
export function rankSkillsForPrompt(
  prompt: string,
  skills: readonly PluginSkillDef[],
): SkillRelevance[] {
  const promptTokens = new Set(tokensOf(prompt));
  if (promptTokens.size === 0 || skills.length === 0) return [];

  const documents = skills.map((skill) => ({ id: skill.id, weights: skillTokenWeights(skill) }));
  const frequency = new Map<string, number>();
  for (const document of documents) {
    for (const token of document.weights.keys()) {
      frequency.set(token, (frequency.get(token) ?? 0) + 1);
    }
  }

  // log(1 + reference/df): a word in one of eighty descriptions scores ~4.4, a
  // word in forty of them ~1.1. Two rare hits clear the preload floor; generic
  // prose never does.
  const idf = (token: string) =>
    Math.log(1 + IDF_REFERENCE_SIZE / (frequency.get(token) ?? IDF_REFERENCE_SIZE));

  return documents
    .map((document) => {
      let score = 0;
      for (const token of promptTokens) {
        const weight = document.weights.get(token);
        if (weight !== undefined) score += idf(token) * weight;
      }
      return { id: document.id, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

/**
 * The one skill whose body should ride along with the first turn, if any.
 *
 * Returns undefined when nothing clears the floor, when the best score is below
 * `SKILL_PRELOAD_MIN_SCORE`, or when the runner-up is close enough that the
 * prompt plausibly belongs to either skill.
 */
export function chooseSkillToPreload(
  prompt: string,
  skills: readonly PluginSkillDef[],
): PluginSkillDef | undefined {
  const ranked = rankSkillsForPrompt(prompt, skills);
  const best = ranked[0];
  if (!best || best.score < SKILL_PRELOAD_MIN_SCORE) return undefined;
  const runnerUp = ranked[1];
  if (runnerUp && runnerUp.score >= best.score * SKILL_PRELOAD_MARGIN) return undefined;
  return skills.find((skill) => skill.id === best.id);
}

/**
 * Bodies above this size are left to the `Skill` tool. A preloaded document is
 * paid for whether or not the model needed it, and a very long one would trade
 * a cheap catalog line for a large block on a guess.
 */
export const SKILL_PRELOAD_MAX_BODY_CHARS = 12_000;
