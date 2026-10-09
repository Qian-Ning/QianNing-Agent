/**
 * The workbench history's library reasoning, at the layer a test can reach
 * without a browser.
 *
 * The removal, clear, and reveal channels belong to the main process and are
 * already exercised by `media-library.test.mjs`; what is new on the renderer
 * side is turning a recorded error code into a sentence, with a fallback that
 * keeps an unknown code from rendering as a blank row. That rule is pure, so it
 * is tested directly rather than through a rendered component.
 */
import assert from "node:assert/strict";
import test from "node:test";

const { LIBRARY_ERROR_KEYS, describeLibraryError } = await import(
  "../src/features/workbench/library-errors.ts"
);
// The English catalog is the type source; importing it here proves the keys the
// table points at actually exist, so a typo cannot ship and render as the key.
const { en } = await import("../../../packages/i18n/src/locales/en/index.ts");

function flatten(object, prefix = "") {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out[path] = value;
    else if (value && typeof value === "object") Object.assign(out, flatten(value, path));
  }
  return out;
}

const english = flatten(en);

/** A stand-in for i18next's `t`: the key itself when the catalog has no entry. */
function fakeT(map = {}) {
  return (key) => (key in map ? map[key] : key);
}

test("a recorded error code becomes a sentence, never a blank line", () => {
  const t = fakeT({
    "workbench.libraryErrorCancelled": "Cancelled",
    "workbench.libraryErrorTimeout": "Timed out",
    "workbench.libraryErrorGeneric": "The render didn't finish.",
    "errors.PROVIDER_RATE_LIMITED": "Rate limited",
    "errors.NETWORK_ERROR": "Network down",
  });

  // A media-specific code falls to its own line.
  assert.equal(describeLibraryError("VIDEO_CANCELLED", t), "Cancelled");
  assert.equal(describeLibraryError("IMAGE_TIMEOUT", t), "Timed out");
  // A provider or network code reuses the app-wide wording, not a second copy.
  assert.equal(describeLibraryError("PROVIDER_RATE_LIMITED", t), "Rate limited");
  assert.equal(describeLibraryError("NETWORK_ERROR", t), "Network down");
  // An unknown code still resolves to the generic line, not the raw key.
  assert.equal(describeLibraryError("SOMETHING_NEW", t), "The render didn't finish.");
  // No code at all (a bare cancellation) is the generic line too.
  assert.equal(describeLibraryError(undefined, t), "The render didn't finish.");
});

test("an unknown code never resolves to an empty string", () => {
  // This stub has no workbench.libraryErrorGeneric and no errors.* entries for
  // the codes below, so every branch bottoms out at a raw key — still a
  // non-empty string, which is what keeps the row from going blank.
  const t = fakeT({});
  for (const code of ["VIDEO_CANCELLED", "SOMETHING_NEW", undefined]) {
    const text = describeLibraryError(code, t);
    assert.equal(typeof text, "string", String(code));
    assert.notEqual(text.length, 0, String(code));
  }
});

test("every media error key names a real English catalog entry", () => {
  for (const key of Object.values(LIBRARY_ERROR_KEYS)) {
    assert.equal(typeof english[key], "string", `${key} is missing from the en catalog`);
    assert.notEqual(english[key].length, 0, `${key} is empty`);
  }
  assert.equal(typeof english["workbench.libraryErrorGeneric"], "string");
});
