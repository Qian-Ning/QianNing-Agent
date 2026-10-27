// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { BUILTIN_SKINS } from "@pi-desktop/shared/skins";
import { applySkin, loadSkinId } from "./skin";

describe("the phone wears the desktop's skin", () => {
  it("paints 米纸 with the desktop's own variables", () => {
    applySkin("paper");

    const root = document.documentElement;
    expect(root.getAttribute("data-theme")).toBe("light");
    expect(root.getAttribute("data-skin")).toBe("paper");
    // The exact colours the desktop renders for the same skin.
    expect(root.style.getPropertyValue("--ds-bg-primary")).toBe("#f7f2ea");
    expect(root.style.getPropertyValue("--ds-bg-secondary")).toBe("#efe7db");
    expect(root.style.getPropertyValue("--ds-text-primary")).toBe("#2c2620");
    expect(root.style.getPropertyValue("--ds-accent")).toBe("#c2603a");
  });

  it("switches base scheme with the skin instead of keeping the last one", () => {
    applySkin("paper");
    const dark = BUILTIN_SKINS.find((skin) => skin.base === "dark" || skin.base === "fox");
    expect(dark).toBeDefined();
    applySkin(dark!.id);
    expect(document.documentElement.getAttribute("data-theme")).not.toBe("light");
  });

  it("falls back to the warm default when the stored id is unknown", () => {
    window.localStorage.setItem("qn.mobile.skin", "no-such-skin");
    expect(loadSkinId()).toBe("no-such-skin");
    applySkin("no-such-skin");
    expect(document.documentElement.getAttribute("data-skin")).toBe("paper");
  });
});
