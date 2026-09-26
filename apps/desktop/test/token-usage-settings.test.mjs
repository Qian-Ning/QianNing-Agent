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

// QianNing fork: the usage page estimates cost from an editable model pricing
// table. The renderer reaches it through four typed stats.* IPC methods; assert
// they exist so the UI's cost/pricing wiring cannot silently lose its backend.
test("api exposes the editable model-pricing surface", () => {
  assert.match(api, /getModelPricing/);
  assert.match(api, /updateModelPricing/);
  assert.match(api, /deleteModelPricing/);
  assert.match(api, /resetModelPricing/);
});

test("model pricing editor component exists", async () => {
  await access(
    new URL("../src/components/settings/ModelPricingEditor.tsx", import.meta.url),
    constants.F_OK,
  );
});

test("settings usage page component exists", async () => {
  await access(
    new URL("../src/components/settings/UsagePage.tsx", import.meta.url),
    constants.F_OK,
  );
});
