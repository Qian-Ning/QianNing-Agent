import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const sidebarSource = await readFile(
  new URL("../src/components/Sidebar.tsx", import.meta.url),
  "utf8",
);
const globalStyles = await loadStyles();
const zhLocale = await readFile(
  new URL("../../../packages/i18n/src/locales/zh-CN/index.ts", import.meta.url),
  "utf8",
);
const enLocale = await readFile(
  new URL("../../../packages/i18n/src/locales/en/index.ts", import.meta.url),
  "utf8",
);

test("the sidebar footer is an action bar, not a fabricated identity", () => {
  // The app has no accounts; an avatar with a name implied one that never existed.
  assert.doesNotMatch(sidebarSource, /footer-profile/);
  assert.doesNotMatch(sidebarSource, /profile-menu/);
  assert.doesNotMatch(sidebarSource, /sidebar-profile-menu/);
  assert.doesNotMatch(sidebarSource, /IconUser/);
  assert.doesNotMatch(globalStyles, /\.footer-profile/);
  assert.doesNotMatch(globalStyles, /\.profile-menu/);
  for (const locale of [zhLocale, enLocale]) {
    assert.doesNotMatch(locale, /localProfile:/);
    assert.doesNotMatch(locale, /openProfileMenu:/);
  }
});

test("footer exposes settings, plugins, scheduled tasks, usage stats and notifications in one row", () => {
  assert.match(sidebarSource, /className="footer-actions"/);
  assert.match(sidebarSource, /data-nav="settings"/);
  assert.match(sidebarSource, /data-nav="plugins"/);
  assert.match(sidebarSource, /data-nav="usage"/);
  const pluginsAction = sidebarSource.match(
    /<TooltipButton[\s\S]*?data-nav="plugins"[\s\S]*?<\/TooltipButton>/,
  )?.[0] ?? "";
  assert.match(pluginsAction, /<IconPlug size=\{14\} aria-hidden \/>/);
  // The usage-stats action (D631) sits to the right of the bell and opens the
  // Settings usage destination.
  const usageAction = sidebarSource.match(
    /<TooltipButton[\s\S]*?data-nav="usage"[\s\S]*?<\/TooltipButton>/,
  )?.[0] ?? "";
  assert.match(usageAction, /<IconChartColumn size=\{14\} aria-hidden \/>/);
  assert.match(usageAction, /setSettingsTab\("usage"\)/);
  // It renders after the notification trigger, so the bell keeps its slot.
  assert.ok(
    sidebarSource.indexOf("<NotificationCenter") <
      sidebarSource.indexOf('data-nav="usage"'),
  );
  assert.doesNotMatch(sidebarSource, /data-nav="theme"/);
  assert.match(
    sidebarSource,
    /<NotificationCenter onBeforeOpen=\{\(\) => closeMenus\(false\)\} \/>/,
  );
  // Logs live in Settings → About; the footer stays down to daily controls.
  assert.doesNotMatch(sidebarSource, /openLogs/);
  // Every action is icon-only, so each needs a label for pointer and AT users.
  const actions = sidebarSource
    .split("<TooltipButton")
    .filter((chunk) => /className=(?:"footer-action"|\{`footer-action )/.test(chunk));
  assert.equal(actions.length, 5);
  for (const action of actions) {
    const attrs = action.slice(0, action.indexOf(">"));
    assert.match(attrs, /tooltip=/);
    assert.match(attrs, /ariaLabel=/);
  }
  // All footer destinations report their active state to assistive tech; the
  // Plugins button also reports the Back toggle a second activation performs.
  const footerAttributes = (marker) => {
    const at = sidebarSource.indexOf(marker);
    if (at < 0) return "";
    return sidebarSource.slice(
      sidebarSource.lastIndexOf("<TooltipButton", at),
      sidebarSource.indexOf("</TooltipButton>", at),
    );
  };
  assert.match(
    footerAttributes('data-nav="settings"'),
    /aria-pressed=\{page === "settings"\}/,
  );
  assert.match(
    footerAttributes('data-nav="plugins"'),
    /aria-pressed=\{page === "plugins"\}/,
  );
  assert.match(footerAttributes('data-nav="scheduled"'), /aria-pressed=\{page === "scheduled"\}/);
});

test("footer sits on the sidebar content grid without a hairline", () => {
  const block = globalStyles.match(/\.sidebar-footer\s*\{[^}]+\}/)?.[0] ?? "";
  // Zero side padding keeps the chip text and trailing icon aligned with the
  // nav rows that .sidebar-body already insets by 8px. D297: the footer is set
  // apart from the nav by `margin-top: auto` and its own padding, not a rule.
  assert.match(block, /padding:\s*7px 0 2px/);
  assert.doesNotMatch(block, /border-top/);
  assert.doesNotMatch(sidebarSource, /footer-build|footer-build-version|footer-build-dot/);
  assert.doesNotMatch(globalStyles, /\.footer-build/);
});

test("footer action buttons share the notification trigger's hit target", () => {
  const block = globalStyles.match(/\.footer-action\s*\{[^}]+\}/)?.[0] ?? "";
  assert.match(block, /width:\s*32px/);
  assert.match(block, /height:\s*32px/);
  assert.match(block, /transition:[^;]*var\(--motion-duration-fast\)/);
});
