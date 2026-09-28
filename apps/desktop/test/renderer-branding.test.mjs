import { readAppSource, readComposerSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [
  english,
  chinese,
  brandLogo,
  icons,
  sidebar,
  app,
  chatSurface,
  composer,
  styles,
  mascotLogo,
  appLanguage,
] = await Promise.all([
    read("../../../packages/i18n/src/locales/en/index.ts"),
    read("../../../packages/i18n/src/locales/zh-CN/index.ts"),
    read("../src/components/BrandLogo.tsx"),
    read("../src/components/icons.tsx"),
    read("../src/components/Sidebar.tsx"),
    readAppSource(),
    read("../src/components/ChatSurface.tsx"),
    readComposerSource(),
    loadStyles(),
    read("../src/components/HomeMascotLogo.tsx"),
    read("../src/lib/app-language.ts"),
  ]);

test("renderer surfaces the QianNing Agent brand instead of the Codex shell brand", () => {
  assert.match(english, /shellName:\s*"QianNing Agent"/);
  assert.match(chinese, /shellName:\s*"QianNing Agent"/);
  assert.match(english, /placeholder:\s*"Ask QianNing Agent to help with anything"/);
  assert.match(chinese, /placeholder:\s*"让 QianNing Agent 帮你做任何事"/);
  assert.doesNotMatch(english, /shellName:\s*"Codex"/);
  assert.doesNotMatch(chinese, /shellName:\s*"Codex"/);
  // Codex remains a supported external import source, not the app identity.
  assert.match(english, /importSourceCodex:\s*"Codex"/);
  assert.match(chinese, /importSourceCodex:\s*"Codex"/);
});

test("app chrome uses a single transparent brand mark that needs no theme adaptation", async () => {
  // One transparent-background cutout, no per-theme/appearance variants: the PNG
  // carries real alpha so it reads on any theme, appearance, or skin wallpaper.
  assert.match(brandLogo, /import brandLogoUrl from\s*"\.\.\/assets\/brand\/logo\.png"/);
  assert.doesNotMatch(brandLogo, /logo-(light|dark|fox)\.png/);
  assert.doesNotMatch(brandLogo, /\.\.\/\.\.\/build\//);
  assert.match(brandLogo, /export function BrandLogo/);
  assert.match(brandLogo, /src=\{brandLogoUrl\}/);
  // No theme/appearance observation: the transparent mark never swaps per look.
  assert.doesNotMatch(brandLogo, /data-appearance|data-theme|attributeFilter|MutationObserver|useState|useEffect/);
  assert.match(icons, /export const IconNewSession/);
  assert.doesNotMatch(icons, /IconCodexHome|IconCompose|IconPiMark|IconPiHome/);
  // Single shared transparent assets exist; the old themed plates are gone.
  await access(new URL("../src/assets/home-mascot.png", import.meta.url));
  await access(new URL("../src/assets/brand/logo.png", import.meta.url));
  await assert.rejects(
    () => access(new URL("../src/assets/home-mascot-dark.gif", import.meta.url)),
  );
  await assert.rejects(
    () => access(new URL("../src/assets/home-mascot-still-fox.png", import.meta.url)),
  );
  await assert.rejects(
    () => access(new URL("../src/assets/brand/logo-dark.png", import.meta.url)),
  );
  await assert.rejects(
    () => access(new URL("../src/assets/home-mascot-groups.png", import.meta.url)),
  );
  assert.match(chatSurface, /<HomeMascotLogo \/>/);
  assert.match(mascotLogo, /import mascotUrl from\s*"\.\.\/assets\/home-mascot\.png"/);
  assert.doesNotMatch(mascotLogo, /home-mascot-(dark|light|fox)\.gif|home-mascot-still/);
  assert.match(mascotLogo, /className="home-mascot-logo"/);
  assert.match(mascotLogo, /className="home-mascot-mark"/);
  assert.match(mascotLogo, /aria-hidden="true"/);
  assert.match(mascotLogo, /src=\{mascotUrl\}/);
  assert.doesNotMatch(mascotLogo, /<svg/);
  assert.doesNotMatch(
    mascotLogo,
    /home-mascot-groups\.png|home-mascot-orbit|home-mascot-motion|home-mascot-still|Math\.random\(\)|setTimeout|backgroundPosition|onMouseEnter|onMouseLeave|useState|useEffect|matchMedia|data-appearance/,
  );
  assert.doesNotMatch(chatSurface, /<BrandLogo/);
  assert.match(styles, /\.empty-hero-icon\s*\{[\s\S]*?height:\s*100px;[\s\S]*?width:\s*100px;/);
  assert.match(
    styles,
    /\.home-mascot-logo\s*\{[\s\S]*?display:\s*block;[\s\S]*?width:\s*100px;[\s\S]*?height:\s*100px;/,
  );
  assert.match(styles, /\.home-mascot-logo \.home-mascot-mark\s*\{/);
  // No per-theme mascot swap rules or sprite animation survive the transparent redesign.
  assert.doesNotMatch(styles, /\.home-mascot-motion|\.home-mascot-still/);
  assert.match(appLanguage, /document\.documentElement\.lang\s*=\s*target/);
  assert.doesNotMatch(styles, /@keyframes home-mascot-orbit|@keyframes home-mascot-breathe|@keyframes home-mascot-blink/);
  assert.doesNotMatch(styles, /background-size:\s*5000px 100px|image-rendering:\s*pixelated/);
  assert.doesNotMatch(composer, /<BrandLogo/);
  assert.doesNotMatch(composer, /composer-thread-mark/);
  assert.doesNotMatch(styles, /\.composer-thread-mark/);
  assert.doesNotMatch(styles, /\.composer-input-wrap\s*\{[^}]*\bgap:/s);
  assert.doesNotMatch(composer, /infinity-mark|∞/);
  assert.match(sidebar, /<BrandLogo\s+size=\{20\}/);
  assert.match(sidebar, /IconNewSession/);
  assert.match(app, /<IconNewSession\s+size=\{15\}/);
  assert.doesNotMatch(sidebar, /IconCompose|IconPiMark|IconPiHome/);
});
