import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  collectStateCompanions,
  findLiteralSurfaceColors,
  findShadowedStateRules,
  findShadowedStateRulesAcross,
} from "../../../scripts/style-surface-tokens.mjs";

test("surface guard catches literal fills on base, theme, and focus rules", () => {
  const violations = findLiteralSurfaceColors(`
.settings-search { background: #fff; }
:root[data-theme="dark"] .composer-shell { background-color: rgba(33, 33, 33, .96); }
@media (min-width: 600px) {
  :root[data-theme="light"] .plugins-search:focus-visible {
    background: color-mix(in oklab, var(--ds-text-primary) 5%, white);
  }
}`);
  assert.deepEqual(violations.map(({ line }) => line), [2, 3, 6]);
});

test("surface guard preserves tokens and the enumerated exemptions", () => {
  assert.deepEqual(
    findLiteralSurfaceColors(`
:root { --ds-settings-field-bg: #fff; }
/* .settings-search { background: #fff; } */
.settings-search { background: var(--ds-settings-field-bg); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2); }
.plugins-search:focus-visible { background: color-mix(in oklab, var(--ds-text-primary) 7%, transparent); }
.settings-search-clear { background: #fff; }
.search-overlay { background: color-mix(in oklab, #000 45%, transparent); }
.code-block-lang { color: color-mix(in oklab, #383a42 62%, transparent); }
.prose { background: rgb(255, 255, 255); }
`),
    [],
  );
});

test("surface guard holds every theme override to the token contract", () => {
  /*
    Issue #341: a literal inside a :root[data-theme] rule raises specificity
    above the base token rule and does not read a variable, so that surface drops
    out of every contributed theme's reach. The Shiki syntax palette, a
    black-alpha shadow, and the token blocks themselves stay exempt.
  */
  const violations = findLiteralSurfaceColors(`
:root[data-theme="light"] .prose-chat h5 { color: color-mix(in oklab, #1a1c1f 62%, transparent); }
:root[data-theme="light"] .prose-chat pre { background: #fafafa; color: #383a42; }
:root[data-theme="dark"] .overlay { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.22); }
:root[data-theme="dark"] .toast { box-shadow: 0 1px 2px rgba(20, 20, 20, 0.22); }
:root[data-theme="light"] .code-block { --code-block-bg: #1a1c1f; }
:root[data-theme="light"] { --ds-bg-primary: #ffffff; }
:root[data-theme="light"] .plugins-search { background: var(--ds-field-inset-bg); }`);
  assert.deepEqual(
    violations.map(({ line, property }) => [line, property]),
    [
      [2, "color"],
      [5, "box-shadow"],
      [6, "--code-block-bg"],
    ],
  );
});

test("surface guard covers the tokenized families and every opaque colour form", () => {
  /*
    The migrated families are a fixed list that includes the code-card and
    Mermaid variants tokenized in issue #341, and the checked property set spans
    shorthand borders, background images, text shadows and filters — so a literal
    cannot slip back in through a property nobody listed.
  */
  const violations = findLiteralSurfaceColors(`
.code-block-head { background: #123456; }
.mermaid-block-body { background: rgb(255, 255, 255); }
.search-overlay .search-dialog { border: 1px solid #000; }
.overlay { background-image: linear-gradient(#fff, #000); }
.tool-row-content { text-shadow: 0 1px 2px #101010; }
:root[data-theme="dark"] .prose-chat kbd { filter: drop-shadow(#336699 0 1px 2px); }
:root[data-theme="dark"] .toast { box-shadow: 0 0 0 1px #ffffff; }
.plugins-modal-backdrop { background: var(--ds-modal-veil); }
:root[data-theme="light"] .mermaid-block-body { background: var(--ds-mermaid-canvas); }`);
  assert.deepEqual(
    violations.map(({ line, property }) => [line, property]),
    [
      [2, "background"],
      [3, "background"],
      [4, "border"],
      [5, "background-image"],
      [6, "text-shadow"],
      [7, "filter"],
      [8, "box-shadow"],
    ],
  );
});

test("surface guard rejects static non-token variable references", () => {
  /*
    The gray/accent scales are static root literals and the legacy color-*
    family never existed, so a declaration riding those variables is pinned
    out of every contributed theme's reach. Theme roots (where the scales are
    defined) and the enumerated fixed-palette rules stay exempt.
    the enumerated fixed-palette rules stay exempt.
  */
  const violations = findLiteralSurfaceColors(`
.send-btn { background: var(--gray-0); color: var(--gray-1000); }
:root[data-theme="dark"] .composer-input { color: var(--gray-0); }
.voice-error { color: var(--color-danger, #ef4444); }
:root { --ds-bg-hover: color-mix(in oklab, var(--gray-0) 6%, transparent); }
.composer-image-preview button:hover { background: var(--gray-700); }
.projects-glyph { color: var(--gray-0); }`);
  assert.deepEqual(
    violations.map(({ line, property }) => [line, property]),
    [
      [2, "background"],
      [2, "color"],
      [3, "color"],
      [4, "color"],
    ],
  );
});

test("state-shadow guard names the interaction state a theme rule outranks", () => {
  /*
    `:root[data-theme="light"] .send-btn` carries one attribute more than
    `.send-btn:disabled`, so the theme wins on specificity and the disabled chip
    paints exactly like the enabled one. That shape reached the shipped light
    composer because the theme-surfaces probe is not part of CI; the guard is
    what makes the fast suite catch it instead of a rendered cascade run.
  */
  const violations = findShadowedStateRules(`
.send-btn { background: var(--ds-accent); }
:root[data-theme="light"] .send-btn { background: var(--ds-bg-inset); }
.send-btn:disabled { background: var(--ds-send-disabled-bg); }`);
  assert.deepEqual(
    violations.map(({ line, element, properties }) => [line, element, properties]),
    [[3, ".send-btn:disabled", ["background"]]],
  );
});

test("state-shadow guard accepts a companion, a :not() exemption, and a base !important", () => {
  /*
    Three shapes settle the cascade on purpose, so none of them is a shadow: a
    theme-qualified companion that re-states the property, a theme rule that
    excludes the state, and a state rule whose own `!important` outranks the
    theme. The companion may live in another partial — that is why the guard
    takes the collectors' map rather than comparing each file with itself.
  */
  const violations = findShadowedStateRules(`
:root[data-theme="light"] .send-btn { background: var(--ds-bg-inset); }
.send-btn:disabled { background: var(--ds-send-disabled-bg); }
.mode-chip:focus-visible { color: var(--ds-text-secondary); }
:root[data-theme="light"] .mode-chip:not(:focus-visible) { color: var(--ds-text-primary); }
:root[data-theme="light"] .icon-btn { color: var(--ds-text-primary); }
.icon-btn:focus-within { color: var(--ds-text-secondary) !important; }
`, collectStateCompanions([`
:root[data-theme="light"] .send-btn:disabled { background: var(--ds-send-disabled-bg); }
`]));
  assert.deepEqual(violations, []);
});

test("state-shadow guard reports an !important theme pin that silences the state", () => {
  /*
    `!important` on the theme declaration wins outright, so the state rule can
    never paint — the same loss of an affordance as a plain specificity shadow,
    reached by a different route. The theme must still carry the companion (or
    exclude the state) for the guard to stay quiet.
  */
  const violations = findShadowedStateRules(`
:root[data-theme="light"] .icon-btn { color: var(--ds-text-primary) !important; }
.icon-btn:focus-within { color: var(--ds-text-secondary); }`);
  assert.deepEqual(
    violations.map(({ line, properties }) => [line, properties]),
    [[2, ["color"]]],
  );
});

test("state-shadow guard holds the shipped stylesheets", () => {
  const stylesDir = join(dirname(fileURLToPath(import.meta.url)), "../src/styles");
  const sources = readdirSync(stylesDir)
    .filter((name) => name.endsWith(".css"))
    .sort()
    .map((name) => ({ path: name, css: readFileSync(join(stylesDir, name), "utf8") }));
  assert.deepEqual(findShadowedStateRulesAcross(sources), []);
});
