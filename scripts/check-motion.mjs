#!/usr/bin/env node
/**
 * Motion guard: keeps the design-system §8 motion rules mechanical instead of
 * prose. Every rule here is one a later change can silently break.
 *
 * Checked (see docs/spec/04-ux/07-ui-design-system.md §8):
 *  - `transition: all` — names no property, so a later declaration animates by
 *    accident. §8.1 requires the animating properties to be listed.
 *  - `scale(0)` / `scaleX(0)` / `scaleY(0)` as an enter state — §8.6: nothing
 *    appears out of nothing; start from a near-one scale.
 *  - a `:hover` rule outside `@media (hover: hover) and (pointer: fine)` —
 *    §8.7: a touch tap latches `:hover` until the next tap, so an ungated
 *    reveal sticks to the finger that caused it. Exempt: rules that pair
 *    `:hover` with `:focus`/`:focus-within`/`:active` in one selector list
 *    (gating those would drop the keyboard state on touch, and the pairing is
 *    asserted by style contract tests), scrollbar pseudos, and the window-blur
 *    overrides — none of which a touch tap can reach.
 *  - an `infinite` animation with no `animation: none` companion in a
 *    `prefers-reduced-motion: reduce` block — §8.5. The global net at the tail
 *    of the cascade only collapses durations, and a near-zero *infinite*
 *    animation still repaints every frame, so the loop has to be switched off.
 *    The companion is looked up across the whole style set, because it usually
 *    lives in responsive.css, and it has to actually win: a guard that precedes
 *    its declaration loses the tie on source order, so the guard must sit later
 *    in the cascade or state `!important`.
 *  - a raw 150 / 200 / 300ms duration where §8.1 defines a token: those three
 *    values are `--motion-duration-fast` / `-normal` / `-slow`. Delays and
 *    bespoke one-off durations are left alone.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const STYLES_DIR = join(root, "apps/desktop/src/styles");

const HOVER_QUERY = "@media (hover: hover) and (pointer: fine)";
const COMMENT = /\/\*[\s\S]*?\*\//g;
const NOT_PSEUDO = /:not\((?:[^()]|\([^()]*\))*\)/g;
const TOKEN_DURATIONS = {
  "150ms": "--motion-duration-fast",
  "200ms": "--motion-duration-normal",
  "300ms": "--motion-duration-slow",
};

/** Selector shapes that make a `:hover` pairing deliberate rather than sticky. */
const PAIRED_STATE = [
  ":focus", ":active", ":checked", ":target", "::-webkit-scrollbar",
  "[aria-expanded", "[data-scrolling", "[data-window-blur", "[aria-pressed]",
];

const collapse = (value) => value.replace(/\s+/g, " ").trim();
const bare = (value) => value.replace(COMMENT, "").trim();
const inReducedMotion = (rule) => rule.ancestors.some((a) => a.includes("prefers-reduced-motion"));

/** Brace-matched walk: every declaration rule with its at-rule chain. */
export function rules(source) {
  const frames = [];
  const out = [];
  let i = 0;
  let start = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "{") {
      const prelude = source.slice(start, i);
      frames.push({ at: bare(prelude).startsWith("@"), prelude, start, body: i });
      start = i + 1;
    } else if (ch === "}") {
      const frame = frames.pop();
      if (frame && !frame.at) {
        out.push({
          selector: frame.prelude.trim(),
          body: source.slice(frame.body + 1, i),
          line: source.slice(0, frame.start).split("\n").length,
          ancestors: frames.filter((f) => f.at).map((f) => bare(f.prelude)),
        });
      }
      start = i + 1;
    }
    i += 1;
  }
  return out;
}

function hoverOnly(selector) {
  const cleaned = bare(selector);
  const stripped = cleaned.replace(NOT_PSEUDO, "");
  if (!stripped.includes(":hover") || PAIRED_STATE.some((t) => stripped.includes(t))) return false;
  return cleaned.split(",").every((part) => part.replace(NOT_PSEUDO, "").includes(":hover"));
}

const hoverGated = (rule) => rule.ancestors.some((a) => a.includes("hover: hover"));

const classesOf = (selector) => new Set(selector.match(/\.([\w-]+)/g) ?? []);

/**
 * The partials in the order the renderer concatenates them. Import order is the
 * cascade, so a guard's position in that order decides whether it beats the
 * rule it switches off.
 */
export function readSources(dir = STYLES_DIR) {
  const all = readdirSync(dir).filter((n) => n.endsWith(".css") && n !== "globals.css").sort();
  let imported = [];
  try {
    imported = [...readFileSync(join(dir, "globals.css"), "utf8")
      .matchAll(/@import\s+"\.\/([\w-]+\.css)"/g)].map((m) => m[1]);
  } catch {
    imported = [];
  }
  const ordered = [...imported, ...all.filter((n) => !imported.includes(n))];
  return ordered.map((name) => [name, readFileSync(join(dir, name), "utf8")]);
}

/**
 * Guard context for the whole style set: `animation: none` companions usually
 * live in responsive.css while the loop is declared in the owning partial, so
 * both the lookup and the cascade position have to be global.
 */
export function buildContext(sources) {
  const guards = [];
  let reducedText = "";
  sources.forEach(([file, source], fileOrder) => {
    rules(source).forEach((rule, ruleOrder) => {
      if (!inReducedMotion(rule)) return;
      reducedText += `${rule.body}\n`;
      if (!/(?:^|;|\n)\s*animation\s*:\s*none/.test(rule.body)) return;
      for (const part of bare(rule.selector).split(",")) {
        const key = collapse(part);
        if (!key) continue;
        guards.push({
          key,
          file,
          classes: classesOf(key),
          order: [fileOrder, ruleOrder],
          important: /animation\s*:\s*none\s*!important/.test(rule.body),
        });
      }
    });
  });
  return { guards, reducedText };
}

export function checkSource(source, file, context) {
  const violations = [];
  const entries = rules(source);
  const push = (line, message) => violations.push({ file, line, message });
  const offsetLine = (rule, body, index) => rule.line + body.slice(0, index).split("\n").length - 1;
  const fileOrder = context.order.get(file) ?? 0;

  entries.forEach((rule, ruleOrder) => {
    const reduced = inReducedMotion(rule);
    const position = [fileOrder, ruleOrder];

    if (/(?:^|;|\n)\s*transition\s*:\s*all\b/.test(rule.body)) {
      push(rule.line, "`transition: all` — name the properties the rule animates");
    }
    for (const hit of rule.body.matchAll(/\bscale[XY]?\(\s*0\s*\)/g)) {
      push(offsetLine(rule, rule.body, hit.index), "`scale(0)` enter state — start from a near-one scale (§8.6)");
    }
    // A hover-only rule must be gated. A rule that pairs `:hover` with a
    // keyboard state in one selector list stays whole on purpose: gating it
    // would drop the focus state on touch, and the pairing is what the style
    // contract tests assert.
    if (!reduced && hoverOnly(rule.selector) && !hoverGated(rule)) {
      push(rule.line, `\`:hover\` outside \`${HOVER_QUERY}\``);
    }
    if (reduced) return;

    for (const hit of rule.body.matchAll(/(?:^|;|\n)\s*animation\s*:\s*([A-Za-z][\w-]*)([^;]*)/g)) {
      if (!/\binfinite\b/.test(hit[2])) continue;
      const covers = (key) => context.guards.some((guard) => {
        const matches = guard.key === key ||
          (guard.classes.size > 0 && [...guard.classes].every((c) => classesOf(key).has(c)));
        if (!matches) return false;
        // The guard must come later in the cascade, or say `!important`:
        // otherwise the base rule re-declares the loop and wins the tie.
        return guard.important || guard.order[0] > position[0] ||
          (guard.order[0] === position[0] && guard.order[1] > position[1]);
      });
      const parts = bare(rule.selector).split(",").map(collapse).filter(Boolean);
      const covered = parts.every(covers) || context.reducedText.includes(hit[1]);
      if (!covered) {
        push(offsetLine(rule, rule.body, hit.index),
          `\`${hit[1]}\` is \`infinite\` with no later \`animation: none\` in a reduced-motion block`);
      }
    }
    for (const hit of rule.body.matchAll(/(?:^|;|\n)\s*(animation-duration|transition-duration)\s*:\s*(\d+)ms/g)) {
      const token = TOKEN_DURATIONS[`${hit[2]}ms`];
      if (token) {
        push(offsetLine(rule, rule.body, hit.index), `raw \`${hit[2]}ms\` — use \`var(${token})\``);
      }
    }
  });
  return violations;
}

export function checkDirectory(dir = STYLES_DIR) {
  const sources = readSources(dir);
  const context = buildContext(sources);
  context.order = new Map(sources.map(([name], i) => [name, i]));
  return sources.flatMap(([name, source]) => checkSource(source, name, context));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const violations = checkDirectory();
  if (violations.length) {
    console.error("Motion violations:\n" +
      violations.map((v) => `  apps/desktop/src/styles/${v.file}:${v.line} ${v.message}`).join("\n"));
    console.error(`\n${violations.length} violation(s). See docs/spec/04-ux/07-ui-design-system.md §8.`);
    process.exit(1);
  }
  console.log("motion OK");
}
