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
  skillsCheckWorkflowSource,
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
  read("../../../.github/workflows/skills-check.yml"),
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

test("the poster-frame E2E job boots the built app with a display", () => {
  const start = ciWorkflowSource.indexOf("  media-poster-frame:");
  assert.notEqual(start, -1, "the media-poster-frame job is missing");
  const next = ciWorkflowSource.indexOf("\n  rust:", start);
  assert.notEqual(next, -1, "the rust job should follow the poster-frame job");
  const block = ciWorkflowSource.slice(start, next);
  // The scenario boots the built application with an empty
  // `ELECTRON_RENDERER_URL`, so both build outputs have to exist first; and it is
  // only ever green on a runner where the Electron binary is actually on disk,
  // which `pnpm install` alone does not guarantee.
  assert.match(block, /run: pnpm build:js/, "the job builds the app before probing");
  assert.match(
    block,
    /run: node apps\/desktop\/node_modules\/electron\/install\.js/,
    "the job installs the Electron binary before probing",
  );
  assert.match(
    block,
    /xvfb-run --auto-servernum pnpm test:e2e:media-poster-frame/,
    "the job runs the scenario under a virtual display",
  );
  assert.match(
    block,
    /ELECTRON_DISABLE_SANDBOX/,
    "the job disables the sandbox on a hosted runner",
  );
});

test("CI compiles and runs the host-core tests on Windows", () => {
  // `#[cfg(windows)]` test modules are removed before compilation on the Linux
  // runner, so nothing under them had ever been built for the platform it
  // targets: a test that fails to compile, or that races a native child
  // process, stayed invisible until the suite was run on Windows by hand.
  const start = ciWorkflowSource.indexOf("  rust-windows:");
  assert.notEqual(start, -1, "the rust-windows job is missing");
  const block = ciWorkflowSource.slice(start);
  assert.match(block, /^    runs-on: windows-latest$/m);
  // `cargo test` builds the platform-specific dependencies and every test
  // target, then runs them; the crate declares no optional features, so no
  // feature flag is needed to reach all of them.
  assert.match(block, /^        run: cargo test -p host-core --locked$/m);
  // Formatting and linting stay on the Linux leg.
  assert.doesNotMatch(block, /cargo (?:fmt|clippy)/);
});

test("CI runs the upstream sync audit after the unit tests", () => {
  // The audit's own `node --test scripts/*.test.mjs` file is not reached by
  // `pnpm -r --if-present test` (that only runs each workspace package's test
  // script), so the job has to invoke it explicitly or it would never run.
  const start = ciWorkflowSource.indexOf("  js:");
  assert.notEqual(start, -1, "the js job is missing");
  const end = ciWorkflowSource.indexOf("\n  theme-surfaces:");
  assert.notEqual(end, -1, "the theme-surfaces job is missing");
  const block = ciWorkflowSource.slice(start, end);
  assert.match(block, /^        run: node --test scripts\/upstream-sync-audit\.test\.mjs$/m);
  assert.ok(
    block.indexOf("pnpm -r --if-present test") <
      block.indexOf("node --test scripts/upstream-sync-audit.test.mjs"),
    "the audit runs after the workspace unit tests",
  );
});

test("the js job runs the workspace unit tests with a display and the Electron binary", () => {
  // One Desktop suite boots a real Electron window, and its own guard marks the
  // test skipped when Linux has no DISPLAY while the step still exits 0. A green
  // js job therefore reported that coverage as passing when it had not run at
  // all. The job now supplies both the display and the binary, which
  // `pnpm install` alone does not guarantee.
  const start = ciWorkflowSource.indexOf("  js:");
  assert.notEqual(start, -1, "the js job is missing");
  const end = ciWorkflowSource.indexOf("\n  theme-surfaces:");
  assert.notEqual(end, -1, "the theme-surfaces job is missing");
  const block = ciWorkflowSource.slice(start, end);
  assert.match(
    block,
    /run: node apps\/desktop\/node_modules\/electron\/install\.js/,
    "the job installs the Electron binary before testing",
  );
  assert.match(
    block,
    /xvfb-run --auto-servernum pnpm -r --if-present test/,
    "the job runs the unit tests under a virtual display",
  );
  assert.match(
    block,
    /ELECTRON_DISABLE_SANDBOX/,
    "the job disables the sandbox on a hosted runner",
  );
  assert.ok(
    block.indexOf("electron/install.js") < block.indexOf("pnpm -r --if-present test"),
    "the binary is installed before the tests run",
  );
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
  // The packaged paths and the desktop-entry keys are derived from
  // apps/desktop/package.json by scripts/linux-package-paths.mjs, because
  // writing them here as literals is exactly how they drifted away from the
  // build after the rename — and this workflow is `workflow_dispatch`-only, so
  // nothing failed. The derivation and its cross-check against electron-builder
  // live in linux-package-paths.test.mjs.
  assert.match(
    linuxPackageWorkflowSource,
    /node scripts\/linux-package-paths\.mjs/,
    "the workflow derives the layout instead of hardcoding it",
  );
  assert.match(
    linuxPackageWorkflowSource,
    /grep -Fx "Icon=\$LINUX_ICON_KEY" "\$desktop_entry"/,
  );
  assert.match(
    linuxPackageWorkflowSource,
    /grep -Fx "StartupWMClass=\$LINUX_WM_CLASS" "\$desktop_entry"/,
  );
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
  // The unsigned lane is the only place `-c.mac.identity=-` runs, and it once
  // failed silently: electron-builder logged `skipped macOS application code
  // signing` while the job still reported success, publishing a bundle with no
  // signature at all. Asserting on `Signature=adhoc` is the mechanical guard;
  // the signed lane's verify script cannot cover it because it is gated on
  // `signed == 'true'`.
  assert.match(
    releaseWorkflowSource,
    /name: Assert the macOS bundle is ad-hoc signed[\s\S]*?codesign -dv --verbose=4[\s\S]*?Signature=adhoc/,
    "the unsigned macOS lane proves the bundle is ad-hoc signed",
  );
  assert.match(
    releaseWorkflowSource,
    /Assert the macOS bundle is ad-hoc signed[\s\S]*?is not ad-hoc signed/,
    "the ad-hoc assertion fails the build when the signature is missing",
  );
  assert.match(
    releaseWorkflowSource,
    /Assert the macOS bundle is ad-hoc signed[\s\S]*?if: matrix\.platform == 'macos' && needs\.macos-signing\.outputs\.signed != 'true'/,
    "the ad-hoc assertion belongs to the unsigned lane only",
  );
  // Each lane renames its updater feed, so the publish job's merge cannot let
  // one architecture's latest-mac.yml overwrite the other's.
  assert.match(
    releaseWorkflowSource,
    /if: matrix\.platform == 'macos'\s*\n\s*run: mv apps\/desktop\/release\/latest-mac\.yml apps\/desktop\/release\/latest-mac-\$\{\{ matrix\.arch \}\}\.yml/,
  );
  // The rename above is only half the story. electron-updater requests
  // `latest-mac.yml` on every Mac (`Provider.getChannelFilePrefix` returns
  // "-mac" for darwin), so publishing only the arch-suffixed feeds leaves a Mac
  // with a 404 while Windows and Linux update normally. The publish job has to
  // merge them back before the release is created.
  assert.match(
    releaseWorkflowSource,
    /name: Merge the macOS update feed\n\s*#[\s\S]*?run: node scripts\/merge-mac-update-feed\.mjs dist/,
    "the publish job merges the per-architecture macOS feeds into latest-mac.yml",
  );
  const publishJobForMerge = releaseWorkflowSource.match(/^  publish:\n[\s\S]*$/m)?.[0] ?? "";
  const checkoutIndex = publishJobForMerge.indexOf("actions/checkout@");
  const mergeIndex = publishJobForMerge.indexOf("Merge the macOS update feed");
  const releaseIndex = publishJobForMerge.indexOf("Create GitHub Release");
  assert.ok(mergeIndex !== -1, "the merge step lives in the publish job");
  assert.ok(
    releaseIndex !== -1 && mergeIndex < releaseIndex,
    "the feed is merged before the release is published",
  );
  // The merge runs a repository script, and the publish job's other steps only
  // need build outputs from download-artifact. Skipping the checkout makes the
  // merge die on a missing module and publishes a release with no macOS feed —
  // exactly the failure the merge was added to fix.
  assert.ok(
    checkoutIndex !== -1 && checkoutIndex < mergeIndex,
    "the publish job checks the repository out before running scripts/",
  );
  assert.match(
    releaseWorkflowSource,
    /^  publish:\n[\s\S]*?actions\/checkout@v7[\s\S]*?actions\/download-artifact@v8/m,
    "the publish job checks out before downloading artifacts",
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
  // The ad-hoc override lives inside the npm script, not on the workflow's
  // command line: electron-builder treats everything after `pnpm run`'s `--`
  // as positional arguments, so a `-c.` override appended there is dropped and
  // the build silently publishes a completely unsigned app.
  assert.match(desktopPackageSource, /"dist:mac:unsigned":/);
  assert.match(desktopPackageSource, /dist:mac:unsigned":[^\n]*-c\.mac\.identity=-/);
  assert.match(desktopPackageSource, /"dist:mac:signed":/);
  assert.match(desktopPackageSource, /dist:mac:signed":[^\n]*-c\.mac\.forceCodeSigning=true/);
  assert.match(desktopPackageSource, /dist:mac:signed":[^\n]*-c\.mac\.notarize=true/);
  assert.match(releaseWorkflowSource, /run dist:mac:unsigned/);
  assert.match(releaseWorkflowSource, /run dist:mac:signed/);

  // No electron-builder option may be routed through `pnpm run ... -- ...`.
  for (const line of releaseWorkflowSource.split("\n")) {
    assert.doesNotMatch(
      line,
      /run\s+\S+\s+--\s/,
      `electron-builder options are dropped after \`--\`: ${line.trim()}`,
    );
  }

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

test("the skills workflow owns the surfaces CI ignores, and needs no install", async () => {
  assert.match(skillsCheckWorkflowSource, /^name: Skills check$/m);
  assert.match(skillsCheckWorkflowSource, /^  pull_request:$/m);
  assert.match(skillsCheckWorkflowSource, /^  workflow_dispatch:$/m);

  // A skill document is markdown and ci.yml ignores markdown, so this lane has
  // to trigger on the documents themselves. Triggering only on the scripts
  // would leave the rule unable to fire on the change it exists to police.
  assert.match(
    skillsCheckWorkflowSource,
    /^      - 'apps\/desktop\/resources\/skills\/\*\*'$/m,
    "the lane must trigger on the built-in skill documents",
  );
  assert.match(
    skillsCheckWorkflowSource,
    /^      - 'examples\/\*\*\/skills\/\*\*'$/m,
    "the lane must trigger on skill documents that ship with the examples",
  );
  assert.match(
    skillsCheckWorkflowSource,
    /^      - 'scripts\/check-skill-provenance\.mjs'$/m,
    "the lane must trigger on the gate itself",
  );

  // The discovery predicates in scripts/skill-provenance-check.mjs are broader
  // than the two shipped directories above: `isSkillDocumentPath` accepts any
  // markdown inside any `skills/` directory plus any `SKILL.md` anywhere, and
  // `isPluginManifestPath` accepts a `manifest.json` inside any `plugins/`
  // directory. The triggers have to name those same surfaces, or a document added
  // under a new directory is scanned by the gate and never triggers it — the gate
  // would pass while policing nothing.
  assert.match(
    skillsCheckWorkflowSource,
    /^      - '\*\*\/skills\/\*\*'$/m,
    "the lane must trigger on a skill document under any skills/ directory, matching isSkillDocumentPath",
  );
  assert.match(
    skillsCheckWorkflowSource,
    /^      - '\*\*\/SKILL\.md'$/m,
    "the lane must trigger on a SKILL.md anywhere, matching isSkillDocumentPath",
  );
  assert.match(
    skillsCheckWorkflowSource,
    /^      - '\*\*\/plugins\/\*\*'$/m,
    "the lane must trigger on a plugin manifest under any plugins/ directory, matching isPluginManifestPath",
  );

  // Guard the direction of the fix rather than the spelling of one glob: the
  // predicate really does accept a document under a directory neither shipped
  // surface mentions, so the generic triggers above are load-bearing and not
  // decorative.
  const { isSkillDocumentPath, isPluginManifestPath } = await import(
    "../../../scripts/skill-provenance-check.mjs"
  );
  assert.equal(
    isSkillDocumentPath("extras/tooling/skills/anything.md"),
    true,
    "isSkillDocumentPath is expected to accept a document under a new skills/ directory",
  );
  assert.equal(
    isSkillDocumentPath("extras/anything/SKILL.md"),
    true,
    "isSkillDocumentPath is expected to accept a SKILL.md outside a skills/ directory",
  );
  assert.equal(
    isPluginManifestPath("extras/tooling/plugins/manifest.json"),
    true,
    "isPluginManifestPath is expected to accept a manifest under a new plugins/ directory",
  );
  assert.equal(
    isSkillDocumentPath("apps/desktop/resources/skills/agent-capabilities.md"),
    true,
    "the shipped directory must stay covered",
  );

  assert.match(
    skillsCheckWorkflowSource,
    /^        run: node scripts\/check-skill-provenance\.mjs$/m,
  );
  assert.match(
    skillsCheckWorkflowSource,
    /^        run: node --test scripts\/skill-provenance-check\.test\.mjs$/m,
    "the lane must run the negative cases that prove the rule rejects a bad document",
  );

  // The check imports only node: builtins, so the lane deliberately skips the
  // install step that every other lane needs. Guard that: an added install would
  // put a dependency-resolution failure in front of a rule that cannot fail that
  // way, and would slow a seconds-long check into a minutes-long one.
  assert.doesNotMatch(
    skillsCheckWorkflowSource,
    /pnpm install/,
    "the provenance lane must stay dependency-free",
  );

  for (const script of [
    "../../../scripts/check-skill-provenance.mjs",
    "../../../scripts/skill-provenance-check.mjs",
    "../../../scripts/skill-provenance-check.test.mjs",
  ]) {
    await assert.doesNotReject(
      access(new URL(script, import.meta.url)),
      `the skills lane references a missing script: ${script}`,
    );
  }
});
