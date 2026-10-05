import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const packageJson = JSON.parse(await read("../package.json"));
const hostProcess = await read("../electron/main/host-process.ts");
const feedbackSource = await read("../../../packages/shared/src/github-feedback.ts");
const pluginTemplatesSource = await read("../../../packages/plugin-devkit/src/templates.ts");
const pluginCheckSource = await read("../../../packages/plugin-devkit/src/check.ts");
const browserManifest = JSON.parse(
  await read("../resources/plugins/pi.browser/manifest.json"),
);
const pluginSkill = await read("../resources/skills/plugin-development.md");

const HOST_BASENAME = "QianNing-Agent-Host-Core";

test("packaged application and host binaries use the QianNing brand", () => {
  assert.equal(packageJson.build.productName, "QianNing Agent");
  assert.equal(packageJson.build.win.executableName, "QianNing Agent");
  assert.equal(packageJson.build.win.extraResources[0].to, `bin/${HOST_BASENAME}.exe`);
  assert.equal(packageJson.build.mac.extraResources[0].to, `bin/${HOST_BASENAME}`);
  assert.equal(packageJson.build.linux.extraResources[0].to, `bin/${HOST_BASENAME}`);
  assert.equal(packageJson.build.mac.artifactName, "QianNing-Agent-${version}-${arch}-mac.${ext}");
  assert.equal(packageJson.build.dmg.artifactName, "QianNing-Agent-${version}-${arch}.${ext}");
  assert.equal(packageJson.build.linux.executableName, "qianning-agent");
  assert.equal(packageJson.build.deb.packageName, "qianning-agent");
  assert.equal(packageJson.build.rpm.packageName, "qianning-agent");
  assert.match(hostProcess, /bin\/QianNing-Agent-Host-Core/);
});

test("user-visible packaged metadata does not expose the upstream brand", () => {
  assert.doesNotMatch(packageJson.build.mac.artifactName, /PI-Desktop/i);
  assert.doesNotMatch(packageJson.build.dmg.artifactName, /PI-Desktop/i);
  assert.doesNotMatch(packageJson.build.mac.extendInfo.NSLocalNetworkUsageDescription, /PI-Desktop/i);
  assert.doesNotMatch(packageJson.build.mac.extendInfo.NSMicrophoneUsageDescription, /PI-Desktop/i);
  assert.equal(browserManifest.author, "QianNing Agent");
  assert.doesNotMatch(pluginSkill, /PI-Desktop/i);
  assert.match(pluginSkill, /QianNing Agent/);
  assert.match(feedbackSource, /QianNing Agent \$\{info\.version\}/);
  assert.doesNotMatch(pluginTemplatesSource, /PI-Desktop|PI Desktop/);
  assert.doesNotMatch(pluginCheckSource, /known PI-Desktop permission/);
});
