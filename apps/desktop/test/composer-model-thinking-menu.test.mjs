import { readComposerModule } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const [modelMenuSource, pickerSource, sliderSource] = await Promise.all([
  readComposerModule("hooks/useComposerModelMenu.ts"),
  readComposerModule("ComposerModelPicker.tsx"),
  readComposerModule("ThinkingLevelSlider.tsx"),
]);
const listSource = await readComposerModule("ComposerModelList.tsx");
const composerSource = `${modelMenuSource}\n${pickerSource}\n${sliderSource}\n${listSource}`;
const stylesSource = await loadStyles();

test("Composer renders two independent pills sharing one controller (D629)", () => {
  // Left model pill and right reasoning pill are separate AnchoredMenus, each
  // with its own open flag, so one can be open while the other is closed.
  assert.match(modelMenuSource, /const \[modelOpen, setModelOpen\] = useState\(false\)/);
  assert.match(modelMenuSource, /const \[reasoningOpen, setReasoningOpen\] = useState\(false\)/);
  assert.match(pickerSource, /composer-model-thinking-chip composer-model-chip/);
  assert.match(pickerSource, /composer-model-thinking-chip composer-reasoning-chip/);
  assert.match(pickerSource, /menuClassName="composer-model-menu composer-model-thinking-menu"/);
  // The reasoning pill is ALWAYS shown so the control is never hidden (D630);
  // a model without a published ladder still gets the full canonical ladder.
  assert.match(modelMenuSource, /const hasReasoning = true/);
  assert.match(modelMenuSource, /const modelPublishesReasoning = availableThinkingLevels\.length > 0/);
  // The heading switches copy by real capability, but the pill itself is shown either way (D630).
  assert.match(pickerSource, /modelPublishesReasoning\s*\n?\s*\? t\("chat\.reasoningSupportedBy"/);
  assert.match(pickerSource, /: t\("chat\.reasoningUnavailableFor", \{ model: modelLabel \}\)/);
  assert.match(pickerSource, /\{hasReasoning \? \(/);
  // No leftover combined-popover scaffolding.
  assert.doesNotMatch(pickerSource, /ComposerMenuView|showView|setView\(|composer-menu-back|IconChevronLeft/);
});

test("model and reasoning selection each close only their own pill", () => {
  // Selecting a model configures the session and closes the model pill; the
  // reasoning pill is unaffected and vice versa.
  assert.match(modelMenuSource, /const selectModel = async/);
  assert.match(modelMenuSource, /await configureActiveSession\(\{[\s\S]*?thinkingLevel: nextThinkingLevel/);
  assert.match(modelMenuSource, /setQuery\(""\);\s*\n\s*setModelOpen\(false\)/);
  assert.match(modelMenuSource, /const selectThinkingLevel = async/);
  assert.match(modelMenuSource, /setReasoningOpen\(false\);\s*\n\s*setThinkingHighlight\(-1\)/);
  assert.match(modelMenuSource, /const thinkingMenuLevels = reasoningPickerLevels\(availableThinkingLevels\)/);
  // closeMenus drops both at once for the mode/permission chips.
  assert.match(modelMenuSource, /const closeMenus = \(\) => \{\s*\n\s*setModelOpen\(false\);\s*\n\s*setReasoningOpen\(false\);/);
});
test("the reasoning pill carries a localized radio list and the drag slider", () => {
  // The radio list uses the localized reasoning-level labels (D629); the wire
  // value stays canonical, only the display label is translated.
  assert.match(pickerSource, /role="menuitemradio"/);
  assert.match(pickerSource, /aria-checked=\{thinkingLevel === level\}/);
  assert.match(pickerSource, /\{t\(reasoningLevelLabelKey\(level\)\)\}/);
  assert.match(pickerSource, /className="composer-thinking-list" ref=\{thinkingListRef\}/);
  // The slider mirrors the same localized labels through labelFor.
  assert.match(pickerSource, /\{thinkingMenuLevels\.length > 1 \? \(/);
  assert.match(pickerSource, /labelFor=\{\(level\) => t\(reasoningLevelLabelKey\(level\)\)\}/);
  assert.match(pickerSource, /commit=\{commitThinkingLevel\}/);
  assert.match(sliderSource, /"--stop-count": levels\.length/);
  assert.match(sliderSource, /type="range"/);
  assert.match(sliderSource, /className="composer-thinking-range"/);
  assert.match(sliderSource, /aria-label=\{label\}/);
  assert.match(sliderSource, /aria-valuetext=\{tickLabel\(levels\[index\] \?\? \(level as SessionThinkingLevel\)\)\}/);
  assert.match(modelMenuSource, /const commitThinkingLevel = /);
  assert.match(modelMenuSource, /if \(!\(await commitThinkingLevel\(level\)\)\) return;/);
  assert.match(sliderSource, /if \(SLIDER_KEYS\.has\(event\.key\)\) event\.stopPropagation\(\);/);
  assert.match(sliderSource, /className=\{`composer-thinking-tick /);
  assert.match(modelMenuSource, /createLatestCommitQueue/);
  assert.match(modelMenuSource, /thinkingQueueRef\.current\?\.invalidate\(\)/);
  assert.match(sliderSource, /tabIndex=\{-1\}/);
  assert.match(sliderSource, /className="composer-thinking-ticks" aria-hidden="true"/);
  assert.match(stylesSource, /\.composer-thinking-range::-webkit-slider-runnable-track/);
  assert.match(stylesSource, /\.composer-thinking-range::-webkit-slider-thumb/);
  assert.match(stylesSource, /\.composer-thinking-range::-moz-range-thumb/);
  assert.match(stylesSource, /\.composer-thinking-tick\.active\s*\{/);
});

test("the reasoning slider aligns each track dot and label to the thumb", () => {
  // The dots row and the labels row are separate full-width n-column grids
  // keyed to --stop-count; the range input overlays the dots row at full
  // width and is inset by half a column minus the thumb radius, which moves
  // the native thumb's stops onto the same column centers for every n.
  assert.match(sliderSource, /className="composer-thinking-rail"/);
  assert.match(sliderSource, /className="composer-thinking-dots" aria-hidden="true"/);
  assert.match(sliderSource, /className="composer-thinking-ticks" aria-hidden="true"/);

  // Rail, dots and labels all key off --stop-count; the dots and labels are
  // full-width grids and the input carries the inset.
  assert.match(stylesSource, /--thinking-thumb-radius: 7px/);
  assert.match(stylesSource, /--thinking-inset: calc\(100% \/ \(2 \* var\(--stop-count, 1\)\) - var\(--thinking-thumb-radius\)\)/);
  assert.match(stylesSource, /\.composer-thinking-dots \{[\s\S]*?grid-template-columns: repeat\(var\(--stop-count, 1\), minmax\(0, 1fr\)\)/);
  assert.match(stylesSource, /\.composer-thinking-ticks \{[\s\S]*?grid-template-columns: repeat\(var\(--stop-count, 1\), minmax\(0, 1fr\)\)/);
  assert.match(stylesSource, /\.composer-thinking-range \{[\s\S]*?padding: 0 var\(--thinking-inset\)/);

  // Track dots sit on the rail (accent for the selected, muted for the rest)
  // and labels stay visible; the input's own track is transparent.
  assert.match(stylesSource, /\.composer-thinking-dot\.active/);
  assert.match(stylesSource, /\.composer-thinking-range::-webkit-slider-runnable-track \{\s*height: var\(--thinking-track-height\);\s*background: transparent;/);
});

test("opening the model pill preloads model metadata", () => {
  assert.match(
    modelMenuSource,
    /useEffect\(\(\) => \{\n    if \(!modelOpen\) return;\n    for \(const candidate of providers\)\s*\{/,
  );
  assert.match(modelMenuSource, /void loadProviderModels\(candidate\.id\);/);
  assert.match(modelMenuSource, /\}, \[loadProviderModels, modelOpen, providers\]\);/);
});

test("both pills meet the compact accessible visual contract", () => {
  assert.match(pickerSource, /aria-haspopup="menu"/);
  assert.match(pickerSource, /aria-expanded=\{modelOpen\}/);
  assert.match(pickerSource, /aria-expanded=\{reasoningOpen\}/);
  assert.match(pickerSource, /role="menuitemradio"/);
  assert.match(modelMenuSource, /event\.key === "Escape"/);
  assert.match(modelMenuSource, /event\.key === "ArrowDown"/);
  assert.match(stylesSource, /\.composer-model-thinking-menu\s*\{[\s\S]*?position:\s*fixed;/);
  assert.match(stylesSource, /\.composer-model-thinking-menu\s*\{[\s\S]*?top:\s*0;/);
  assert.match(stylesSource, /\.composer-model-thinking-menu\s*\{[\s\S]*?width:\s*min\(280px,\s*calc\(100vw - 24px\)\)/);
  assert.match(pickerSource, /className="composer-model-thinking-icon"[\s\S]*?<IconBot size=\{14\} \/>/);
  assert.match(stylesSource, /@media \(prefers-reduced-motion: reduce\)/);
});

test("model options share the compact provider heading inset", () => {
  assert.match(composerSource, /composer-plus-item composer-model-option/);
  assert.match(
    stylesSource,
    /\.composer-model-group \.composer-model-option\s*\{[\s\S]*?padding-left:\s*8px/,
  );
});

test("model groups use the account-aware display name", () => {
  assert.match(composerSource, /providerDisplayName: providerDisplayName\(candidate\)/);
  assert.match(composerSource, /providerSearchText: providerSearchText\(candidate\)/);
  assert.match(composerSource, /aria-label=\{group\.providerDisplayName\}/);
  assert.match(composerSource, /\{group\.providerDisplayName\}/);
});

test("provider headings establish a stronger type level than model rows", () => {
  assert.match(
    stylesSource,
    /\.composer-model-group-label\s*\{[^}]*font-size:\s*var\(--text-xs-plus\)[^}]*font-weight:\s*var\(--font-weight-strong\)/,
  );
  assert.match(
    stylesSource,
    /\.composer-model-group \.composer-model-option\s*\{[^}]*font-size:\s*var\(--text-sm\)[^}]*font-weight:\s*var\(--font-weight-normal\)/,
  );
  assert.match(
    stylesSource,
    /:lang\(zh-CN\) \.composer-model-group-label\s*\{[\s\S]*?text-transform:\s*none/,
  );
});

test("Composer uses alias labels while preserving the exact selected wire id", async () => {
  const chipSource = await readFile(new URL("../src/components/Composer.tsx", import.meta.url), "utf8");
  assert.match(chipSource, /composerModelDisplayName\(provider, modelId, selectedModelInfo\?\.displayName\)/);
  assert.match(listSource, /const optionTitle = model\.modelId/);
  assert.match(listSource, /sameComposerModelId\(selectedModelId \?\? "", model\.modelId\)/);
  assert.match(modelMenuSource, /modelId: nextModelId/);
  assert.match(modelMenuSource, /sameComposerModelId\(entry\.id, nextModelId\)/);
  assert.match(modelMenuSource, /sameComposerModelId\(entry\.model\.modelId, modelId \?\? ""\)/);
});

test("reasoning projection uses the selected exact catalog row and binding", async () => {
  const source = await readComposerModule("model.ts");
  assert.match(source, /sameComposerModelId\(candidate\.modelId, modelId\)/);
  assert.match(source, /sameComposerModelId\(candidate\.id, modelId\)/);
});

test("the reasoning-level label helper maps every canonical level to an i18n key", async () => {
  const source = await readComposerModule("model.ts");
  // The picker and slider render labels through reasoningLevelLabelKey so the
  // level ladder is localized while the wire value stays canonical (D629).
  assert.match(source, /export function reasoningLevelLabelKey/);
  assert.match(source, /REASONING_LEVEL_LABEL_KEYS/);
  for (const [level, key] of [
    ["off", "chat.reasoningLevelOff"],
    ["minimal", "chat.reasoningLevelMinimal"],
    ["low", "chat.reasoningLevelLow"],
    ["medium", "chat.reasoningLevelMedium"],
    ["high", "chat.reasoningLevelHigh"],
    ["xhigh", "chat.reasoningLevelXhigh"],
    ["max", "chat.reasoningLevelMax"],
    ["omit", "chat.reasoningLevelOmit"],
  ]) {
    assert.match(source, new RegExp(`${level}:\\s*"${key.replace(".", "\\.")}"`));
  }
});
