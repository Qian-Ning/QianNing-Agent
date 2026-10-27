/**
 * The phone draws with the desktop's tokens. This test is what keeps that true.
 *
 * Without it "same design system" is a claim in a commit message; with it, a raw
 * hex or a hand-picked 14px fails the suite the moment it is written.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const file = join(here, "styles.css");
const css = readFileSync(file, "utf8");

/** Comments explain; they are not stylesheet content. */
const body = css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("mobile stylesheet", () => {
  it("uses no raw colours", () => {
    const hex = body.match(/#[0-9a-f]{3,8}\b/gi) ?? [];
    const fn = body.match(/\b(?:rgb|rgba|hsl|hsla)\s*\(/gi) ?? [];
    expect([...hex, ...fn]).toEqual([]);
  });

  it("takes every radius and type size from the token scale", () => {
    const literal = (prop: string): string[] =>
      [...body.matchAll(new RegExp(`${prop}\\s*:\\s*([^;]+);`, "g"))]
        .map((match) => (match[1] ?? "").trim())
        .filter((value) => !/^var\(--/.test(value) && !/^(0|inherit|initial|none)$/.test(value));

    expect(literal("border-radius")).toEqual([]);
    expect(literal("font-size")).toEqual([]);
  });

  it("mirrors the desktop's radius and type scales exactly", () => {
    const tokens = readFileSync(
      join(here, "..", "..", "desktop", "src", "styles", "tokens.css"),
      "utf8",
    );
    const theme = tokens.slice(tokens.indexOf("@theme"));
    const declared = new Map<string, string>();
    for (const match of theme.matchAll(/--((?:radius|text|font)-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      declared.set(match[1] as string, (match[2] as string).trim());
    }
    const scales = readFileSync(join(here, "scales.css"), "utf8");
    const mirrored = new Map<string, string>();
    for (const match of scales.matchAll(/--((?:radius|text|font)-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      mirrored.set(match[1] as string, (match[2] as string).trim());
    }

    expect(declared.size).toBeGreaterThan(20);
    for (const [name, value] of declared) {
      // Weights are numbers the phone never reads; only sizes, fonts and radii matter here.
      if (name === "font-scale" || name.startsWith("font-weight")) continue;
      // calc() references may carry a fallback on the phone; compare the shape.
      const normalise = (input: string) => input.replace(/\s+/g, " ").replace(/, 1\)/, ")");
      expect(mirrored.get(name), name).toBeDefined();
      expect(normalise(mirrored.get(name) ?? ""), name).toBe(normalise(value));
    }
  });

  it("keeps the token file as the only palette", () => {
    const tokens = readFileSync(
      join(here, "..", "..", "desktop", "src", "styles", "tokens.css"),
      "utf8",
    );
    // The two surfaces must not fork: the import in main.tsx is the contract.
    expect(tokens).toContain("--ds-bg-primary");
    const main = readFileSync(join(here, "main.tsx"), "utf8");
    expect(main).toContain("desktop/src/styles/tokens.css");
  });
});
