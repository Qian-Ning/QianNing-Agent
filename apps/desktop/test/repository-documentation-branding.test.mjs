import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const [readme, englishReadme, security, contributing, privacy, docsIndex, docsZhIndex, docsConfig, homeComponent, docsLayout] =
  await Promise.all([
    read("README.md"),
    read("README.en.md"),
    read("SECURITY.md"),
    read("CONTRIBUTING.md"),
    read("docs/privacy-policy.md"),
    read("docs/index.md"),
    read("docs/zh-CN/index.md"),
    read("docs/.vitepress/config.mts"),
    read("docs/.vitepress/theme/components/DocumentationHome.vue"),
    read("docs/.vitepress/theme/Layout.vue"),
  ]);

const publicDocuments = [
  ["README.md", readme],
  ["README.en.md", englishReadme],
  ["SECURITY.md", security],
  ["CONTRIBUTING.md", contributing],
  ["docs/privacy-policy.md", privacy],
  ["docs/index.md", docsIndex],
  ["docs/zh-CN/index.md", docsZhIndex],
  ["docs/.vitepress/config.mts", docsConfig],
];

test("repository entry documents present the QianNing product", () => {
  for (const [name, source] of publicDocuments) {
    assert.match(source, /QianNing Agent/, name);
  }
  // The maintainer is credited by name in the README.
  assert.match(readme, /千凝/);
  // The Chinese entry document names the product too, and must not present the
  // maintainer's name as the product: that is the D671 naming contract.
  assert.match(docsZhIndex, /QianNing Agent/);
  assert.doesNotMatch(docsZhIndex, /title:.*千凝/);
  // Two near-miss homophones the product name has actually been misread as.
  assert.doesNotMatch(
    `${readme}\n${englishReadme}\n${docsIndex}\n${docsZhIndex}\n${docsConfig}\n${homeComponent}\n${docsLayout}`,
    /乾宁|千宁/,
  );
  assert.match(readme, /Qian-Ning\/QianNing-Agent/);
  assert.match(englishReadme, /Qian-Ning\/QianNing-Agent/);
});

test("the documentation home mounts the maintained product module and states the real secret boundary", () => {
  // The home page cannot carry a component tag in its markdown: this site
  // renders markdown with `html: false`, which escapes the tag into text. The
  // page declares `qnHome` instead and the theme's Layout mounts the component.
  assert.match(docsIndex, /^qnHome:\s*en\s*$/m);
  assert.match(docsZhIndex, /^qnHome:\s*zh-CN\s*$/m);
  assert.match(docsLayout, /<DocumentationHome\b/);
  assert.match(docsLayout, /frontmatter\.qnHome/);
  assert.match(
    homeComponent,
    /OS keychain backend is not implemented|尚未接入操作系统钥匙串/,
  );
  // The home body must stay empty: markdown here is rendered with
  // `html: false`, so a raw tag or an HTML comment written into these files is
  // escaped and printed as visible page text instead of being interpreted.
  for (const [name, source] of [
    ["docs/index.md", docsIndex],
    ["docs/zh-CN/index.md", docsZhIndex],
  ]) {
    assert.equal(
      source.replace(/^---[\s\S]*?\n---/, "").trim(),
      "",
      `${name} must carry frontmatter only`,
    );
  }
  assert.doesNotMatch(
    homeComponent,
    /Credentials live in the OS keychain|凭据进系统钥匙串/,
  );
});

test("repository entry documents do not advertise upstream releases or community metrics", () => {
  for (const [name, source] of publicDocuments) {
    assert.doesNotMatch(source, /github\.com\/vastsa\/PI-Desktop\/releases/, name);
    assert.doesNotMatch(source, /pi-docs\.aiuo\.net/, name);
  }
  assert.doesNotMatch(readme, /github\/downloads\/vastsa|github\/stars\/vastsa|r%2FAIUO/);
  assert.doesNotMatch(readme, /trendshift\.io/);
});

test("upstream attribution remains explicit without presenting it as the product", () => {
  assert.match(readme, /derived|二次开发/);
  assert.match(readme, /vastsa\/PI-Desktop/);
  assert.match(englishReadme, /derivative/);
  assert.match(englishReadme, /vastsa\/PI-Desktop/);
  assert.match(readme, /LGPL/);
});
