/**
 * Surface-colour guard for the renderer stylesheets (issue #341, extends #339).
 *
 * Four rules:
 *
 *  1. THEME OVERRIDE RULE — inside a `:root[data-theme="…"]` rule every colour
 *     declaration in `COLOR_PROPERTIES` (plus `box-shadow`) must resolve through
 *     a custom property. A literal there both raises specificity above the base
 *     token rule and skips the variable, so the surface is pinned out of every
 *     contributed theme's reach (D419). Custom-property definitions are allowed
 *     when the rule *is* a theme root (`:root`, `:root[data-theme="…"]`): the
 *     token blocks are exactly where literal values belong. A custom property
 *     holding a literal colour on any other selector is a violation, because it
 *     shadows the root token for that subtree.
 *
 *  2. CHROME FAMILY RULE — the base rules of the chrome families migrated in
 *     #339/#341 (settings rail, settings search, settings nav item, switch
 *     thumb, agent-capability search, plugin search, composer shell, and the
 *     prose / code-card / Mermaid / scrim / tool-row / send-button /
 *     placeholder families tokenized in this batch) must not paint a literal
 *     colour either. This rule covers that fixed family list, not every
 *     selector in the renderer: it catches a regression in a migrated surface,
 *     not a brand-new literal on a selector nobody has reviewed yet.
 *
 *  3. NON-TOKEN VARIABLE RULE — a colour declaration that references
 *     `var(--gray-*)`, `var(--accent-*)` or `var(--color-*)` escapes the
 *     theme system no matter which rule carries it: the gray/accent scales
 *     are static root literals, and the `--color-*` family is not defined at
 *     all (its consumers silently paint hardcoded fallbacks). Colour-bearing
 *     declarations must resolve through a `--ds-*` surface token. The theme
 *     root blocks are exempt — they are where the tokens themselves are
 *     defined.
 *
 *  4. STATE SHADOWING RULE — a theme-qualified rule carries one attribute more
 *     than the plain rule it mirrors, so `:root[data-theme="light"] .x`
 *     (0,3,0) outranks `.x:disabled` (0,2,0) and the state stops painting.
 *     `fc45db811` documents the shape of the answer: the theme must carry a
 *     state-qualified companion (`:root[data-theme="light"] .x:disabled`) or
 *     exclude the state (`:not(:disabled)`), or the state rule's own
 *     `!important` must outrank it. Without one of the three the state silently
 *     keeps the theme's paint, which is how the light composer's disabled send
 *     chip came to look enabled. Scoped to the affordance-bearing states
 *     (`:disabled`, `:checked`, `:focus-visible`, `:focus-within`).
 *
 * Exemptions are enumerated here with reasons instead of being invisible gaps:
 *
 *  - `SHIKI_PALETTE` — the `one-dark-pro` / `one-light` syntax plate and its
 *    ink are authored by the Shiki theme the renderer selects
 *    (`apps/desktop/src/lib/shiki.ts`: `THEMES = { light: "one-light",
 *    dark: "one-dark-pro" }`) and are emitted as inline colours on the
 *    highlighted markup. A CSS token could only move the plate and leave the
 *    token colours behind, so the pair has to move together (through the Shiki
 *    theme), not through `--ds-*`.
 *  - `BOX_SHADOW_ALPHA` — a shadow only offsets darkness, so a black- or
 *    white-alpha shadow value is allowed. A background/scrim that is a black
 *    mix still paints a surface and is checked.
 *  - `ALLOWED_LITERALS` — base-rule fills the guard deliberately allows, each
 *    with the decision it answers to.
 *  - `ALLOWED_NON_DS_VARS` — base rules that deliberately track a fixed,
 *    non-theme palette (the image-viewer lightbox chrome, the project-tile
 *    glyph ink over the fixed tile colours), each with the reason.
 *
 * Known boundary: this guard is static CSS text analysis. A cascade conflict
 * between two token rules is now covered by rule 4; a plugin's own stylesheet
 * is not; and `pnpm test:e2e:theme-surfaces` still owns the rendered cascade.
 */

/** Selectors whose base rules must not paint a literal colour (rule 2). */
const CHROME_FAMILY =
  /\.(?:settings-nav|settings-search|settings-nav-item|settings-toggle-thumb|agent-capability-search-wrap|plugins-search|composer-shell|prose-chat|thinking-prose|code-block|code-block-head|code-block-lang|mermaid-block|mermaid-block-body|mermaid-block-head|mermaid-block-title|mermaid-block-error|mermaid-source|overlay|search-overlay|plugins-modal-backdrop|tool-row-content|send-btn|empty-hero|composer-placeholder|composer-input|mode-chip|composer-toolbar)(?![\w-])/;

/** A selector that is a theme root: `:root` or `:root[data-theme="…"]`. */
const THEME_ROOT = /^:root(?:\[data-theme=["'][^"']*["']\])?$/;

/** References to variables that contributed themes cannot move (rule 3). */
const NON_DS_VAR = /var\(\s*--(?:gray|accent|color)-/;

/** Colour literals: hex, colour functions, and the `white` / `black` keywords. */
const LITERAL = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(|\b(?:white|black)\b/i;

/** Shadow colours that only offset darkness, so they carry no palette. */
const BOX_SHADOW_ALPHA =
  /#(?:0{6}|f{6})(?!f{2})[\da-f]{2}\b|\b(?:rgba|rgb)\(\s*0\s*[, ]\s*0\s*[, ]\s*0\s*[,/]\s*[\d.]+%?\s*\)|\b(?:rgba|rgb)\(\s*255\s*[, ]\s*255\s*[, ]\s*255\s*[,/]\s*[\d.]+%?\s*\)/gi;

/** one-dark-pro / one-light plate and ink (see the file header). */
const SHIKI_PALETTE = /#(?:282c34|abb2bf|383a42|fafafa|d7dae0)\b/gi;

const KEYWORDS = /\b(?:transparent|currentcolor|inherit|initial|unset|revert|none)\b/gi;

const COLOR_PROPERTIES =
  /^(?:color|background|background-color|background-image|text-decoration-color|-webkit-text-fill-color|border|border-(?:top|right|bottom|left)|border-color|border-(?:top|right|bottom|left)-color|outline|outline-color|fill|stroke|text-shadow|filter|accent-color|caret-color)$/;

/**
 * Literals the guard deliberately allows, each with the reason it answers to.
 * Keyed by the selector text the declaration appears in.
 */
export const ALLOWED_LITERALS = [
  {
    selector: /\.search-overlay/,
    property: "background",
    reason:
      "The ⌘K spotlight has never had a light override and keeps the dark 45% black veil in both palettes. §8.4/D148 give the light scrim ~28% #1a1c1f 'so white dialogs do not sit under a heavy veil', and .search-dialog is --ds-bg-elevated-opaque white, so tokenizing this value either changes built-in light paint or records a value the design system does not own. A maintainer call, recorded here instead of guessed (issue #341).",
  },
];

/**
 * Rules that deliberately track a fixed, non-theme palette (rule 3). Keyed by
 * the selector text the declaration appears in.
 */
export const ALLOWED_NON_DS_VARS = [
  {
    selector: /\.composer-image-preview/,
    reason:
      "The full-screen image viewer keeps a fixed dark lightbox chrome in every palette — backdrop scrim, controls bar, and focus ring travel together — so its paint is deliberately theme-independent. Tokenizing would tint the scrim and wash out image viewing.",
  },
  {
    selector: /\.projects-glyph/,
    reason:
      "The glyph is the ink for the fixed project-tile palette (lib/recent-projects COLORS) that is painted inline beside it; white stays legible over every tile colour in both modes, so the ink tracks the tile, not the theme.",
  },
];

function allowedNonDsVar(selector) {
  return ALLOWED_NON_DS_VARS.some((entry) => entry.selector.test(selector));
}

function replaceAll(value, patterns) {
  let out = value;
  for (const pattern of patterns) out = out.replace(pattern, " ");
  return out;
}

/** Drop everything that is not a bare colour literal, then test what remains. */
function residualLiterals(value, { shadow }) {
  let out = value;
  let previous;
  do {
    previous = out;
    out = out.replace(/var\([^()]*\)/g, " ");
  } while (out !== previous);
  out = replaceAll(out, [SHIKI_PALETTE, KEYWORDS]);
  if (shadow) out = out.replace(BOX_SHADOW_ALPHA, " ");
  // `color-mix(...)` is only a container: the colours it mixes have already
  // been kept or stripped above.
  return out;
}

function allowed(selector, property) {
  return ALLOWED_LITERALS.some(
    (entry) => entry.selector.test(selector) && entry.property === property,
  );
}
/**
 * Report theme-escaping surface colours in a stylesheet.
 * @param {string} css
 * @returns {Array<{line: number, property: string, value: string, reason: string}>}
 */
export function findLiteralSurfaceColors(css) {
  // Retain newlines so diagnostics keep their source line numbers.
  const source = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const violations = [];
  for (const rule of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1].trim();
    const isThemeOverride = /data-theme/.test(selector);
    // Plain `:root` blocks count as theme roots too: they are where tokens
    // and their static scales are defined.
    const isThemeRootSelector = selector.split(",").some((part) => THEME_ROOT.test(part.trim()));
    const isThemeRoot = isThemeOverride && isThemeRootSelector;
    const inChromeFamily = CHROME_FAMILY.test(selector);
    const inLiteralScope = isThemeOverride || inChromeFamily;
    if (!inLiteralScope && !NON_DS_VAR.test(rule[2])) continue;
    for (const declaration of rule[2].matchAll(/([-\w]+)\s*:\s*([^;{}]+)/g)) {
      const [, property, raw] = declaration;
      const value = raw.trim();
      const isCustomProperty = property.startsWith("--");
      if (isCustomProperty && isThemeRoot) continue; // the token blocks own literals
      const isShadow = property === "box-shadow" || property === "text-shadow" || property === "filter";
      const checkable = COLOR_PROPERTIES.test(property) || isShadow || isCustomProperty;
      if (!checkable) continue;
      const offset = rule.index + rule[1].length + 1 + declaration.index;
      const line = source.slice(0, offset).split("\n").length;
      // Rule 3 — a reference to a static (or undefined) non-`--ds-*` variable
      // is a theme escape regardless of which rule carries it.
      if (!isThemeRootSelector && NON_DS_VAR.test(value) && !allowedNonDsVar(selector)) {
        violations.push({
          line,
          property,
          value: value.replace(/\s+/g, " "),
          reason:
            "references a static --gray-*/--accent-*/--color-* variable that contributed themes cannot move — use a --ds-* surface token",
        });
        continue;
      }
      if (!inLiteralScope) continue;
      const residual = residualLiterals(value, { shadow: isShadow });
      if (!LITERAL.test(residual)) continue;
      if (allowed(selector, property)) continue;
      violations.push({
        line,
        property,
        value: value.replace(/\s+/g, " "),
        reason: isCustomProperty
          ? "a component-local custom property holding a literal colour shadows the root token"
          : "use a surface token",
      });
    }
  }
  return violations;
}

/**
 * Interaction states a theme-qualified rule can silently outrank (rule 4).
 *
 * Scoped to the states that carry an *affordance*: a control that looks
 * pressable while disabled, or a field that never shows its focus ring, is a
 * bug a mechanical guard can call without taste. `:hover` / `:active` ink drift
 * is left out — the tree holds deliberate theme-level `!important` ink pins on
 * hover, so judging those is a design pass, not a guard (see the `.mode-chip`
 * note in the delivery report).
 */
export const STATE_SUFFIXES = [
  ":disabled",
  ":focus-visible",
  ":focus-within",
  ":checked",
];

/** `:root[data-theme="…"] .thing` → the theme name and the part after it. */
const THEME_SCOPED = /^(?::root)?\[data-theme=["']([^"']+)["']\]\s*(.*)$/;

/** Property names a declaration block sets, mapped to whether they say `!important`. */
function declaredProperties(body) {
  const declared = new Map();
  for (const match of body.matchAll(/(?:^|;|\n)\s*([-\w]+)\s*:([^;{}]*)/g)) {
    declared.set(match[1], /!\s*important/i.test(match[2]));
  }
  return declared;
}

/** [ids, classes+attributes+pseudo-classes, elements] — enough to rank two selectors. */
function specificity(selector) {
  const bare = selector.replace(/:not\(([^)]*)\)/g, "$1");
  const pseudoElements = (bare.match(/::[\w-]+/g) ?? []).length;
  const rest = bare.replace(/::[\w-]+/g, " ");
  return [
    (rest.match(/#[\w-]+/g) ?? []).length,
    (rest.match(/\.[\w-]+/g) ?? []).length +
      (rest.match(/\[[^\]]*\]/g) ?? []).length +
      (rest.match(/:[\w-]+/g) ?? []).length,
    (rest.match(/(?:^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length + pseudoElements,
  ];
}

/** Lexicographic rank: specificity first, source order to break a tie. */
const rank = ([ids, classes, elements], index) => [ids, classes, elements, index];

/** True when the left side wins the cascade against the right side. */
const outranks = (left, right) => {
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  return false;
};

/** Rules in a stylesheet, with comment text blanked so line numbers hold. */
function parseRules(css) {
  // Retain newlines so diagnostics keep their source line numbers.
  const source = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const rules = [];
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    // A rule nested in `@media` keeps the at-rule prelude in the capture, so
    // drop it and compare selector text only.
    const selector = match[1].replace(/@[^{}]*|\{/g, " ").replace(/\s+/g, " ").trim();
    if (!selector) continue;
    rules.push({
      selector,
      properties: declaredProperties(match[2]),
      line: source.slice(0, match.index + match[1].length + 1).split("\n").length,
    });
  }
  return rules;
}

/** Theme-qualified parts of a selector list that already carry a tracked state. */
function themeStateSelectors(selector) {
  return selector
    .split(",")
    .map((part) => part.trim())
    .flatMap((part) => {
      const scoped = THEME_SCOPED.exec(part);
      if (!scoped?.[2]) return [];
      const state = STATE_SUFFIXES.find((value) => scoped[2].endsWith(value));
      return state ? [{ theme: scoped[1], selector: scoped[2] }] : [];
    });
}

const stateCompanionKey = (theme, selector) => `${theme}\u0000${selector}`;

/**
 * Collect every theme-qualified state rule across the stylesheets the renderer
 * concatenates. A companion normally sits beside the rule it backs, but nothing
 * requires that, so rule 4 checks each file against the whole set.
 * @param {string[]} sources
 * @returns {Map<string, Set<string>>}
 */
export function collectStateCompanions(sources) {
  const companions = new Map();
  for (const css of sources) {
    for (const rule of parseRules(css)) {
      for (const { theme, selector } of themeStateSelectors(rule.selector)) {
        const key = stateCompanionKey(theme, selector);
        const properties = companions.get(key) ?? new Set();
        for (const property of rule.properties.keys()) properties.add(property);
        companions.set(key, properties);
      }
    }
  }
  return companions;
}

/**
 * Report theme-qualified rules that outrank an interaction state on the same
 * element without a state-qualified companion (rule 4).
 *
 * `:root[data-theme="light"] .x` carries one attribute more than `.x:disabled`,
 * so the theme wins on specificity and the state stops painting. The sanctioned
 * shapes are a theme-qualified companion that re-states the same properties, or
 * a `:not(<state>)` on the theme rule.
 *
 * @param {string} css
 * @param {Map<string, Set<string>>} [companions] from `collectStateCompanions`
 * @returns {Array<{line: number, theme: string, element: string, properties: string[], reason: string}>}
 */
export function findShadowedStateRules(css, companions = collectStateCompanions([css])) {
  const rules = parseRules(css);

  const violations = [];
  for (const [index, rule] of rules.entries()) {
    const parts = rule.selector.split(",").map((part) => part.trim()).filter(Boolean);
    for (const part of parts) {
      const scoped = THEME_SCOPED.exec(part);
      if (!scoped) continue;
      const [, theme, inner] = scoped;
      // A theme root block defines tokens; it shadows no element rule.
      if (!inner) continue;
      for (const state of STATE_SUFFIXES) {
        // `:not(:disabled)` is the other sanctioned shape: the theme simply
        // stops applying to the state it would have broken.
        if (inner.includes(`:not(${state})`)) continue;
        const mirrored = `${inner}${state}`;
        for (const base of rules) {
          if (base.selector !== mirrored) continue;
          const shared = [];
          for (const [property, themeImportant] of rule.properties) {
            if (!base.properties.has(property)) continue;
            const baseImportant = base.properties.get(property);
            // A disagreement on `!important` is settled by importance alone;
            // only a tie reaches specificity and source order.
            const themeWins =
              themeImportant !== baseImportant
                ? themeImportant
                : outranks(rank(specificity(part), index), rank(specificity(mirrored), base.index));
            if (themeWins) shared.push(property);
          }
          if (!shared.length) continue;
          const companion = companions.get(stateCompanionKey(theme, mirrored));
          if (companion && shared.every((property) => companion.has(property))) continue;
          violations.push({
            line: rule.line,
            theme,
            element: mirrored,
            properties: [...shared].sort(),
            reason:
              `\`${mirrored}\` loses ${[...shared].sort().join(" / ")} to \`${part}\` in the ` +
              `${theme} palette — add \`:root[data-theme="${theme}"] ${mirrored}\` or ` +
              `exclude the state with \`:not(${state})\``,
          });
        }
      }
    }
  }
  return violations;
}

/**
 * Rule 4 across the stylesheets the renderer concatenates. A theme rule in one
 * partial can shadow a state rule in another — the light `.composer-shell`
 * override in `theme-overrides.css` flattened `.composer-shell:focus-within`
 * from `composer.css` — so the tree is compared as one cascade, and each
 * violation is mapped back to the file that owns it.
 *
 * @param {Array<{path: string, css: string}>} sources in load order
 * @returns {Array<{path: string, line: number, theme: string, element: string, properties: string[], reason: string}>}
 */
export function findShadowedStateRulesAcross(sources) {
  const companions = collectStateCompanions(sources.map(({ css }) => css));
  const offsets = [];
  let lines = 0;
  for (const { path, css } of sources) {
    offsets.push({ path, start: lines });
    lines += css.split("\n").length;
  }
  const violations = findShadowedStateRules(
    sources.map(({ css }) => css).join("\n"),
    companions,
  );
  return violations.map((violation) => {
    const owner = offsets.findLast((entry) => entry.start < violation.line);
    return { ...violation, path: owner.path, line: violation.line - owner.start };
  });
}

