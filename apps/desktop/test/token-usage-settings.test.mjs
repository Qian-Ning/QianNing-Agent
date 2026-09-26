import { readSettingsSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

const search = await readFile(
  new URL("../src/lib/settings-search.ts", import.meta.url),
  "utf8",
);
const settingsPage = await readSettingsSource();
const api = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");

// QianNing fork (D631): a usage-statistics destination is added under Settings,
// reading the host-owned completed-turn token history (ADR 0171) plus a
// read-only per-provider/per-model breakdown. This deliberately reverses the
// upstream decision to keep that history host-only with no settings surface.
test("settings exposes the usage destination wired to host token history", () => {
  assert.match(search, /id: "usage"/);
  assert.match(search, /settings\.nav\.usage/);
  assert.match(settingsPage, /tab === "usage"/);
  assert.match(settingsPage, /UsagePage/);
  assert.match(api, /getTokenUsageHistory/);
  assert.match(api, /getUsageBreakdown/);
});

test("settings usage page component exists", async () => {
  await access(
    new URL("../src/components/settings/UsagePage.tsx", import.meta.url),
    constants.F_OK,
  );
});
