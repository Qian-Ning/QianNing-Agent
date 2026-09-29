import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const [readme, englishReadme, security, contributing, privacy, docsIndex, docsConfig] =
  await Promise.all([
    read("README.md"),
    read("README.en.md"),
    read("SECURITY.md"),
    read("CONTRIBUTING.md"),
    read("docs/privacy-policy.md"),
    read("docs/index.md"),
    read("docs/.vitepress/config.mts"),
  ]);

const publicDocuments = [
  ["README.md", readme],
  ["README.en.md", englishReadme],
  ["SECURITY.md", security],
  ["CONTRIBUTING.md", contributing],
  ["docs/privacy-policy.md", privacy],
  ["docs/index.md", docsIndex],
  ["docs/.vitepress/config.mts", docsConfig],
];

test("repository entry documents present the QianNing product", () => {
  for (const [name, source] of publicDocuments) {
    assert.match(source, /QianNing Agent/, name);
  }
  assert.match(readme, /千凝/);
  assert.match(readme, /Qian-Ning\/QianNing-Agent/);
  assert.match(englishReadme, /Qian-Ning\/QianNing-Agent/);
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
