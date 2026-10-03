import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [
  ciWorkflowSource,
  releaseWorkflowSource,
  desktopPackageSource,
  linuxPackageWorkflowSource,
  mirrorToCnbWorkflowSource,
  agentRuntimePackageSource,
  i18nPackageSource,
  pluginSdkPackageSource,
  sharedPackageSource,
  releaseMacScriptSource,
  releaseAsarScriptSource,
  verifyMacScriptSource,
  notarizeMacScriptSource,
  macSigningDiagnosticsScriptSource,
] = await Promise.all([
  read("../../../.github/workflows/ci.yml"),
  read("../../../.github/workflows/release.yml"),
  read("../package.json"),
  read("../../../.github/workflows/linux-package.yml"),
  read("../../../.github/workflows/mirror-to-cnb.yml"),
  read("../../../packages/agent-runtime/package.json"),
  read("../../../packages/i18n/package.json"),
  read("../../../packages/plugin-sdk/package.json"),
  read("../../../packages/shared/package.json"),
  read("../../../scripts/release-macos.sh"),
  read("../../../scripts/export-linux-asar.mjs"),
  read("../../../scripts/verify-macos-release.sh"),
  read("../../../scripts/notarize-and-staple-macos-release-dmg.sh"),
  read("../../../scripts/macos-signing-diagnostics.sh"),
]);

const macSigningScripts = [
  { name: "release-macos.sh", source: releaseMacScriptSource },
  { name: "verify-macos-release.sh", source: verifyMacScriptSource },
  {
    name: "notarize-and-staple-macos-release-dmg.sh",
    source: notarizeMacScriptSource,
  },
  {
    name: "macos-signing-diagnostics.sh",
    source: macSigningDiagnosticsScriptSource,
  },
];

test("CI skips documentation-only pushes and pull requests", () => {
  assert.equal(
    (ciWorkflowSource.match(/- 'docs\/\*\*'/g) ?? []).length,
    2,
    "docs path is ignored by push and pull_request triggers",
  );
  assert.equal(
    (ciWorkflowSource.match(/- '\*\*\/\*\.md'/g) ?? []).length,
    2,
    "Markdown files are ignored by push and pull_request triggers",
  );
  assert.match(ciWorkflowSource, /^  workflow_dispatch:/m);
});

test("CI does not typecheck workspace dependencies twice", () => {
  for (const source of [
    agentRuntimePackageSource,
    i18nPackageSource,
    pluginSdkPackageSource,
    sharedPackageSource,
  ]) {
    assert.match(JSON.parse(source).scripts.build, /^tsc\b/);
  }

  assert.match(
    ciWorkflowSource,
    /run: pnpm --filter @pi-desktop\/desktop typecheck/,
  );
  assert.doesNotMatch(ciWorkflowSource, /run: pnpm typecheck/);
});

test("release runners validate tags without a separate job barrier", () => {
  assert.doesNotMatch(releaseWorkflowSource, /^  validate:/m);
  assert.doesNotMatch(releaseWorkflowSource, /^    needs: validate$/m);
  assert.match(
    releaseWorkflowSource,
    /TAG_VERSION="\$\{GITHUB_REF_NAME#v\}"/,
  );
  assert.match(
    releaseWorkflowSource,
    /Tag v\$TAG_VERSION does not match apps\/desktop\/package\.json version \$APP_VERSION/,
  );
});

test("release preparation overlaps independent work and avoids duplicate builds", () => {
  assert.match(
    releaseWorkflowSource,
    /cargo build --release --locked -p host-core &/,
  );
  assert.match(releaseWorkflowSource, /wait "\$host_build_pid"/);
  assert.match(
    releaseWorkflowSource,
    /pnpm --filter '@pi-desktop\/desktop\^\.\.\.' --fail-if-no-match build/,
  );
  // The full JS build belongs to the verify gate; the build matrix only
  // builds the desktop app's workspace dependencies.
  const buildJob = releaseWorkflowSource.match(/^  build:\n[\s\S]*?(?=^  publish:)/m)?.[0];
  assert.ok(buildJob, "release build job is missing");
  assert.doesNotMatch(buildJob, /run: pnpm build:js/);
});

test("release builds are gated on the CI checks and least-privilege permissions", () => {
  assert.match(releaseWorkflowSource, /^permissions:\n  contents: read$/m);
  assert.match(releaseWorkflowSource, /^  verify:/m);
  assert.match(
    releaseWorkflowSource,
    /^  build:\n[\s\S]*?^    needs: \[verify, macos-signing\]$/m,
  );
  const verifyJob = releaseWorkflowSource.match(/^  verify:\n[\s\S]*?(?=^  build:)/m)?.[0];
  assert.ok(verifyJob, "release verify job is missing");
  for (const step of [
    /run: pnpm build:js/,
    /run: pnpm --filter @pi-desktop\/desktop typecheck/,
    /run: pnpm lint/,
    /run: pnpm -r --if-present test/,
    /run: cargo test -p host-core --locked/,
  ]) {
    assert.match(verifyJob, step);
  }
  const publishJob = releaseWorkflowSource.match(/^  publish:\n[\s\S]*$/m)?.[0];
  assert.ok(publishJob, "release publish job is missing");
  assert.match(publishJob, /^    permissions:\n      contents: write$/m);
});

test("release artifacts bypass redundant Actions compression", () => {
  assert.match(
    releaseWorkflowSource,
    /uses: actions\/upload-artifact@v7[\s\S]*?compression-level: 0/,
  );
});

test("manual Linux package validation covers the RPM desktop identity", () => {
  assert.match(linuxPackageWorkflowSource, /^on:\s*\n\s+workflow_dispatch:/m);
  assert.match(linuxPackageWorkflowSource, /runs-on: ubuntu-22\.04/);
  assert.match(
    linuxPackageWorkflowSource,
    /run: pnpm --filter @pi-desktop\/desktop run dist:linux -- --x64/,
  );
  assert.match(
    linuxPackageWorkflowSource,
    /name: Install RPM inspection tools[\s\S]*apt-get install[\s\S]*cpio rpm/,
  );
  assert.match(
    linuxPackageWorkflowSource,
    /find apps\/desktop\/release[\s\S]*-name '\*\.rpm'/,
  );
  assert.match(linuxPackageWorkflowSource, /rpm -qpl "\$rpm_package"/);
  assert.match(linuxPackageWorkflowSource, /build-id/);
  assert.match(
    linuxPackageWorkflowSource,
    /usr\/share\/applications\/pi-desktop\.desktop/,
  );
  assert.match(linuxPackageWorkflowSource, /Icon=pi-desktop/);
  assert.match(linuxPackageWorkflowSource, /StartupWMClass=pi-desktop/);
  assert.match(
    linuxPackageWorkflowSource,
    /uses: actions\/upload-artifact@v7[\s\S]*path: apps\/desktop\/release\/\*\.rpm/,
  );
});

test("release workflow publishes the Linux ASAR beside installers", () => {
  assert.match(
    releaseWorkflowSource,
    /if: matrix\.platform == 'linux'[\s\S]*?node scripts\/export-linux-asar\.mjs/,
  );
  assert.match(releaseWorkflowSource, /apps\/desktop\/release\/\*\.asar/);
  assert.match(
    releaseAsarScriptSource,
    /linux-unpacked\/resources\/app\.asar/,
  );
  assert.match(
    releaseAsarScriptSource,
    /QianNing-Agent-\$\{releaseVersion\}-linux-x64\.asar/,
  );
});

test("release matrix packages the fork's Windows, Linux, and macOS lanes", () => {
  assert.match(
    releaseWorkflowSource,
    /name: Windows x64[\s\S]*?os: windows-latest[\s\S]*?arch: x64[\s\S]*?dist: dist:win/,
  );
  assert.match(
    releaseWorkflowSource,
    /name: Linux x64[\s\S]*?os: ubuntu-22\.04[\s\S]*?arch: x64[\s\S]*?dist: dist:linux/,
  );
  // Both macOS architectures run on native runners: a mislabelled runner would
  // wrap one architecture's Electron app around the other's Rust sidecar.
  assert.match(
    releaseWorkflowSource,
    /name: macOS arm64[\s\S]*?os: macos-15\b[\s\S]*?runner_arch: arm64[\s\S]*?dist: dist:mac/,
  );
  assert.match(
    releaseWorkflowSource,
    /name: macOS Intel x64[\s\S]*?os: macos-15-intel[\s\S]*?runner_arch: x86_64[\s\S]*?dist: dist:mac/,
  );
  assert.match(releaseWorkflowSource, /name: Verify native runner architecture/);
  // The macOS artifact naming contract: the ZIP name comes from the mac
  // pattern and the DMG name from the dmg target override, both labelling the
  // architecture so the two lanes never collide in the merged release.
  assert.equal(
    JSON.parse(desktopPackageSource).build.mac.artifactName,
    "QianNing-Agent-${version}-${arch}-mac.${ext}",
    "macOS ZIP names include the target architecture",
  );
  assert.equal(
    JSON.parse(desktopPackageSource).build.dmg.artifactName,
    "QianNing-Agent-${version}-${arch}.${ext}",
    "macOS DMG names include the target architecture",
  );
  assert.doesNotMatch(
    releaseWorkflowSource,
    /-c\.(?:dmg|zip)\.artifactName/,
    "release workflow does not pass unsupported target overrides",
  );
  assert.match(
    releaseWorkflowSource,
    /name: Verify Windows artifact names[\s\S]*?QianNing-Agent-Portable-\*\.zip[\s\S]*?Expected exactly one NSIS setup EXE/,
    "the Windows lane rejects ambiguous or missing artifact names",
  );
  assert.match(
    releaseWorkflowSource,
    /name: Verify macOS artifact names[\s\S]*?QianNing-Agent-\*-\$\{\{ matrix\.arch \}\}\.dmg[\s\S]*?Expected exactly one/,
    "the macOS lane rejects ambiguous or missing artifact names",
  );
  // Each lane renames its updater feed, so the publish job's merge cannot let
  // one architecture's latest-mac.yml overwrite the other's.
  assert.match(
    releaseWorkflowSource,
    /if: matrix\.platform == 'macos'\s*\n\s*run: mv apps\/desktop\/release\/latest-mac\.yml apps\/desktop\/release\/latest-mac-\$\{\{ matrix\.arch \}\}\.yml/,
  );
});

test("release macOS signing is detected, optional, and never pinned to one team", () => {
  // The fork has no Apple Developer account today, and upstream's lanes pinned
  // the upstream maintainer's team id. Pinning one here again would both tie
  // the repository to someone else's account and turn every tag build red.
  assert.doesNotMatch(releaseWorkflowSource, /DUV63RKYTW/);
  assert.doesNotMatch(releaseWorkflowSource, /XingYu/);

  // Signing material is looked up in a preflight job rather than assumed, so
  // the macOS lane can run either way.
  assert.match(releaseWorkflowSource, /^  macos-signing:/m);
  assert.match(releaseWorkflowSource, /name: Detect macOS signing credentials/);
  assert.match(
    releaseWorkflowSource,
    /^      signed: \$\{\{ steps\.detect\.outputs\.signed \}\}$/m,
  );
  assert.match(
    releaseWorkflowSource,
    /^      identity: \$\{\{ steps\.detect\.outputs\.identity \}\}$/m,
  );
  for (const secret of [
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
  ]) {
    assert.ok(
      releaseWorkflowSource.includes(`secrets.${secret}`),
      `the preflight reads ${secret}`,
    );
  }
  // The certificate's common name is not a secret, so it is a repository
  // variable; electron-builder rejects the prefixed form on CSC_NAME, so the
  // preflight strips it and every downstream step uses the bare name.
  assert.ok(releaseWorkflowSource.includes("vars.MAC_SIGNING_IDENTITY"));
  assert.match(
    releaseWorkflowSource,
    /identity="\$\{identity#Developer ID Application: \}"/,
    "the preflight strips the identity prefix electron-builder rejects",
  );
  // All or nothing: a partial configuration fails rather than silently
  // publishing unsigned artifacts.
  assert.match(
    releaseWorkflowSource,
    /Incomplete macOS signing configuration; missing:/,
  );
  // The unsigned lane must ad-hoc sign rather than skip signing, because an
  // arm64 app with no signature does not launch.
  assert.match(
    releaseWorkflowSource,
    /name: Package unsigned macOS installer[\s\S]*?-c\.mac\.identity=-/,
  );
  assert.match(
    releaseWorkflowSource,
    /if: matrix\.platform == 'macos' && needs\.macos-signing\.outputs\.signed != 'true'/,
  );
  assert.match(
    releaseWorkflowSource,
    /if: matrix\.platform == 'macos' && needs\.macos-signing\.outputs\.signed == 'true'/,
  );
});

test("the signed local macOS lane takes its identity from the environment", () => {
  assert.match(releaseMacScriptSource, /DEFAULT_MAC_ARCH/);
  assert.match(releaseMacScriptSource, /MAC_ARCH="\$\{MAC_ARCH:-\$DEFAULT_MAC_ARCH\}"/);
  assert.match(releaseMacScriptSource, /must match the host/);
  assert.match(releaseMacScriptSource, /electron-builder --mac "--\$\{MAC_ARCH\}"/);
  // No baked-in certificate: the identity belongs to whoever owns the account.
  assert.doesNotMatch(releaseMacScriptSource, /DUV63RKYTW|XingYu/);
  assert.match(
    releaseMacScriptSource,
    /MAC_SIGNING_IDENTITY="\$\{MAC_SIGNING_IDENTITY#Developer ID Application: \}"/,
    "the local lane strips the prefix electron-builder rejects",
  );
  assert.match(
    releaseMacScriptSource,
    /MAC_SIGNING_IDENTITY is required/,
    "an unset identity is a configuration error, not a silent fallback",
  );
  // The team id is validated by shape, so the lane is not tied to one account.
  assert.match(releaseMacScriptSource, /\^\[A-Z0-9\]\{10\}\$/);
  assert.doesNotMatch(
    releaseMacScriptSource,
    /-c\.(?:dmg|zip)\.artifactName/,
    "the signed local macOS lane uses the shared artifact naming config",
  );
  // The local lane documents itself as Developer ID + mandatory
  // notarization, so it must pass both flags and must not publish.
  assert.match(releaseMacScriptSource, /-c\.mac\.notarize=true/);
  assert.match(releaseMacScriptSource, /-c\.mac\.forceCodeSigning=true/);
  assert.match(releaseMacScriptSource, /--publish never/);
  assert.doesNotMatch(
    releaseMacScriptSource,
    /DEBUG="\$\{DEBUG:-[^}]*electron-builder/,
    "the local lane must not enable builder-util's executing debug line",
  );
  assert.match(
    releaseMacScriptSource,
    /node scripts\/macos-signing-watchdog\.mjs --label "release-macos-\$\{MAC_ARCH\}" --/,
    "the local signed macOS lane runs under the signing watchdog",
  );
  assert.match(
    releaseMacScriptSource,
    /node scripts\/macos-bundle-inventory\.mjs apps\/desktop\/release/,
  );
  // The DMG is submitted, stapled, and validated once, and the release is
  // verified exactly once.
  assert.match(
    releaseMacScriptSource,
    /scripts\/notarize-and-staple-macos-release-dmg\.sh apps\/desktop\/release/,
  );
  assert.equal(
    (releaseMacScriptSource.match(/scripts\/verify-macos-release\.sh/g) ?? []).length,
    1,
    "the local signed macOS lane verifies the release exactly once",
  );
  assert.doesNotMatch(releaseMacScriptSource, /scripts\/staple-macos-release-dmg\.sh/);
});

/**
 * The regression that broke the local signed lane: a rewrite replaced the
 * electron-builder flags with two commands but kept the line continuation, so
 * one command became a positional argument while the other still pointed at a
 * deleted script. Every script path the release or the local macOS lane
 * references must exist.
 */
test("every script the release and macOS lanes reference exists", async () => {
  const referenced = new Set();
  for (const source of [releaseMacScriptSource, releaseWorkflowSource]) {
    for (const match of source.matchAll(/(?<![\w./-])scripts\/[A-Za-z0-9._-]+\.(?:sh|mjs)/g)) {
      referenced.add(match[0]);
    }
  }
  assert.ok(referenced.size >= 6, "the macOS lanes reference their scripts");
  const missing = [];
  for (const relPath of referenced) {
    try {
      await access(new URL(`../../../${relPath}`, import.meta.url));
    } catch {
      missing.push(relPath);
    }
  }
  assert.deepEqual(missing, []);
});

test("the release workflow detects macOS signing instead of assuming it", () => {
  assert.match(releaseWorkflowSource, /^\s{2}macos-signing:$/m);
  assert.match(
    releaseWorkflowSource,
    /needs:\s*\[verify,\s*macos-signing\]/,
  );

  const signingJob =
    releaseWorkflowSource.match(/^ {2}macos-signing:[^]*?(?=\n {2}\S)/m)?.[0] ??
    "";
  assert.ok(signingJob, "the macos-signing job block is missing");
  assert.match(signingJob, /signed=true/);
  assert.match(signingJob, /signed=false/);

  // The absence of a signing configuration selects the ad-hoc lane; the
  // presence of one selects the signed lane. Both are explicit.
  assert.match(
    releaseWorkflowSource,
    /needs\.macos-signing\.outputs\.signed != 'true'/,
  );
  assert.match(
    releaseWorkflowSource,
    /needs\.macos-signing\.outputs\.signed == 'true'/,
  );
  assert.match(releaseWorkflowSource, /-c\.mac\.identity=-/);

  // A partial configuration is a hard failure rather than a silent downgrade.
  assert.match(releaseWorkflowSource, /missing\+=\(/);
});

test("macOS signing scripts carry no account-specific defaults", () => {
  for (const script of macSigningScripts) {
    assert.doesNotMatch(script.source, /DUV63RKYTW|XingYu/);
    // `${VAR:-}` (the empty-default idiom that keeps `set -u` happy) is fine;
    // a *literal* right-hand side is not — that is how an account gets baked
    // into a script that must work for any team.
    assert.doesNotMatch(
      script.source,
      /MAC_SIGNING_IDENTITY=(?:"|')?[^$"']/,
      `${script.name} must not default the signing identity`,
    );
    assert.doesNotMatch(
      script.source,
      /APPLE_TEAM_ID=(?:"|')?[A-Z0-9]{10}(?:"|')?/,
      `${script.name} must not default the Apple team id`,
    );
  }
});

test("macOS signing instrumentation runs only on the macOS lanes", () => {
  // The macOS lane owns the signing instrumentation, and it must stay off the
  // non-macOS steps: the watchdog, the diagnostics, the bundle inventory, and
  // the notarization/verification scripts only mean anything on macOS.
  const instrumentation =
    /macos-signing-watchdog|macos-signing-diagnostics|macos-bundle-inventory|notarize-and-staple-macos-release-dmg|verify-macos-release/;
  const stepBlock = (name) =>
    releaseWorkflowSource.match(new RegExp(`- name: ${name}[^]*?(?=\\n      - name:)`))?.[0] ?? "";
  for (const name of [
    "Package installers",
    "Verify Windows artifact names",
    "Verify Linux host-core glibc floor",
    "Export Linux ASAR release asset",
  ]) {
    const block = stepBlock(name);
    assert.ok(block, `${name} step is missing`);
    assert.doesNotMatch(block, instrumentation);
  }
  // The instrumentation is present, and every step that carries it is gated on
  // the macOS platform, so no other lane can grow a dependency on it.
  for (const name of [
    "Diagnose macOS signing environment",
    "Analyze the packaged macOS app bundle",
    "Notarize and staple the macOS DMG",
    "Verify signed and notarized macOS installer",
  ]) {
    const block = stepBlock(name);
    assert.ok(block, `${name} step is missing`);
    assert.match(block, /if: matrix\.platform == 'macos'/);
  }
  for (const name of [
    "Package unsigned macOS installer",
    "Package signed and notarized macOS installer",
  ]) {
    const block = stepBlock(name);
    assert.ok(block, `${name} step is missing`);
    assert.match(
      block,
      /if: matrix\.platform == 'macos' && needs\.macos-signing\.outputs\.signed/,
    );
  }
});

test("GitHub releases trigger the CNB mirror pipeline with a JSON payload", () => {
  assert.match(
    mirrorToCnbWorkflowSource,
    /release:\s+types:\s+\[published, edited\]/,
  );
  assert.match(
    mirrorToCnbWorkflowSource,
    /workflow_dispatch:\s+inputs:\s+tag:/,
  );
  assert.match(
    mirrorToCnbWorkflowSource,
    /if: github\.repository == 'vastsa\/PI-Desktop'/,
  );
  assert.match(
    mirrorToCnbWorkflowSource,
    /CNB_MIRROR_TOKEN: \$\{\{\s*secrets\.CNB_MIRROR_TOKEN\s*\}\}/,
  );
  assert.match(
    mirrorToCnbWorkflowSource,
    /Missing repository secret CNB_MIRROR_TOKEN/,
  );
  assert.match(
    mirrorToCnbWorkflowSource,
    /https:\/\/api\.cnb\.cool\/aixk\/Pi-Desktop\/-\/build\/start/,
  );
  assert.match(mirrorToCnbWorkflowSource, /event: "api_trigger_mirror"/);
  assert.match(mirrorToCnbWorkflowSource, /env: \{ MIRROR_TAGS: \$tag \}/);
  assert.match(mirrorToCnbWorkflowSource, /jq -n --arg tag "\$MIRROR_TAG"/);
  assert.match(mirrorToCnbWorkflowSource, /curl --fail-with-body/);
  assert.doesNotMatch(
    mirrorToCnbWorkflowSource,
    /-d ".*github\.event\.release\.tag_name/,
    "JSON payload must not interpolate the release tag through YAML string escaping",
  );
});
