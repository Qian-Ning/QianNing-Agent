import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DESKTOP_PACKAGE_JSON,
  INSTALL_PREFIX,
  desktopFileBasename,
  loadLinuxPackagePaths,
  readPngSize,
  resolveIconPath,
  sanitizeFileName,
} from "../../../scripts/linux-package-paths.mjs";

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(join(REPOSITORY_ROOT, "apps/desktop/package.json"));

// electron-builder is a dependency of apps/desktop, so resolution is anchored
// there — the same place the packaging build resolves it from.
const appBuilderLibOut = dirname(require.resolve("app-builder-lib"));
const workspaceFileName = require("builder-util/out/filename");
const { LinuxTargetHelper, installPrefix } = require(
  join(appBuilderLibOut, "targets/LinuxTargetHelper.js"),
);
// getPngSize reads a PNG's IHDR at the same fixed offset this module does, so
// it is the reference for "the size electron-builder will see".
const { getPngSize } = require(join(appBuilderLibOut, "util/iconConverter.js"));

const packageJson = JSON.parse(readFileSync(DESKTOP_PACKAGE_JSON, "utf8"));
const { paths } = loadLinuxPackagePaths();

/**
 * The whole point of `scripts/linux-package-paths.mjs` is that its derivation
 * matches electron-builder's. These cases prove that per function against the
 * real implementations, so a change on either side fails here rather than at a
 * `workflow_dispatch` + RPM build nobody is watching.
 */
test("sanitizeFileName matches builder-util's implementation", () => {
  for (const input of [
    packageJson.build.productName,
    "QianNing Agent",
    "PI-Desktop",
    "a/b:c",
    "trailing. ",
    "con",
    ".hidden",
    "正常 名字",
  ]) {
    assert.equal(
      sanitizeFileName(input),
      workspaceFileName.sanitizeFileName(input),
      `sanitizeFileName(${JSON.stringify(input)})`,
    );
  }
});

test("the install prefix matches electron-builder's own constant", () => {
  assert.equal(INSTALL_PREFIX, installPrefix);
});

test("desktopFileBasename matches LinuxTargetHelper#getDesktopFileName", () => {
  const cases = [
    { desktopName: "qianning-agent.desktop", executableName: "exe", syncDesktopName: true },
    { desktopName: "qianning-agent", executableName: "exe", syncDesktopName: true },
    { desktopName: "  qianning-agent.desktop  ", executableName: "exe", syncDesktopName: true },
    { desktopName: undefined, executableName: "exe", syncDesktopName: true },
    { desktopName: "   ", executableName: "exe", syncDesktopName: true },
    { desktopName: "qianning-agent.desktop", executableName: "exe", syncDesktopName: false },
  ];
  for (const { desktopName, executableName, syncDesktopName } of cases) {
    const helper = new LinuxTargetHelper({
      executableName,
      platformSpecificBuildOptions: { syncDesktopName },
      info: { metadata: { desktopName } },
    });
    const expected = helper.getDesktopFileName(executableName);
    assert.equal(
      desktopFileBasename({ desktopName, executableName, syncDesktopName }),
      expected,
      `desktopName=${JSON.stringify(desktopName)} syncDesktopName=${syncDesktopName}`,
    );
  }
});

test("a desktopName that would escape its directory is rejected", () => {
  for (const desktopName of ["../evil.desktop", "a/b.desktop", "a\\b.desktop"]) {
    assert.throws(() =>
      desktopFileBasename({
        desktopName,
        executableName: "qianning-agent",
        syncDesktopName: true,
      }),
    );
  }
});

/**
 * Build the real `.desktop` body with electron-builder's own
 * `computeDesktopEntry` from this repository's configuration, and require the
 * derived entry keys to be exactly what it contains.
 */
test("the derived desktop entry matches electron-builder's output", async () => {
  const linux = packageJson.build.linux;
  const packager = {
    executableName: linux.executableName,
    appInfo: {
      productName: packageJson.build.productName,
      sanitizedProductName: workspaceFileName.sanitizeFileName(
        packageJson.build.productName,
      ),
      description: packageJson.description,
    },
    platformSpecificBuildOptions: linux,
    config: packageJson.build,
    info: { metadata: packageJson },
    fileAssociations: [],
  };
  const entry = await new LinuxTargetHelper(packager).computeDesktopEntry(
    linux,
    null,
    {},
  );
  const key = (name) => entry.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1];

  assert.equal(key("Exec"), paths.execLine);
  assert.equal(key("Icon"), paths.iconKey);
  assert.equal(key("StartupWMClass"), paths.wmClass);
  assert.equal(key("Name"), paths.productName);
  // The install directory electron-builder derives is the one the assertion set
  // uses for every packaged path.
  assert.ok(
    paths.execLine.includes(`/${packager.appInfo.sanitizedProductName}/`),
    paths.execLine,
  );
});

test("every packaged path is derived from the product configuration", () => {
  const productName = workspaceFileName.sanitizeFileName(
    packageJson.build.productName,
  );
  const executableName = packageJson.build.linux.executableName;
  const desktopBasename = packageJson.desktopName.replace(/\.desktop$/, "");
  const appDir = `${installPrefix}/${productName}`;

  assert.equal(paths.productName, packageJson.build.productName);
  assert.equal(paths.appDir, appDir);
  assert.equal(paths.appAsar, `${appDir}/resources/app.asar`);
  assert.equal(paths.desktopBasename, desktopBasename);
  assert.equal(paths.desktopFile, `/usr/share/applications/${desktopBasename}.desktop`);
  assert.equal(paths.desktopEntryPath, `./usr/share/applications/${desktopBasename}.desktop`);
  assert.equal(paths.iconKey, executableName);
  assert.equal(paths.wmClass, desktopBasename);
  assert.equal(paths.execLine, `"${appDir}/${executableName}" %U`);

  // The sidecar is the platform-specific extraResources entry, not a literal.
  const sidecar = packageJson.build.linux.extraResources.find((entry) =>
    /host-core/i.test(entry.from),
  );
  assert.ok(sidecar, "linux.extraResources ships the host-core sidecar");
  assert.equal(paths.sidecar, `${appDir}/resources/${sidecar.to}`);
});

/**
 * `FpmTarget.js` names the hicolor directory from the size it reads out of the
 * source PNG (`${icon.size}x${icon.size}`), because a `.png` source is handed to
 * the `set` format unchanged. The two readers therefore have to agree, and the
 * assertion has to follow the file rather than a number someone typed.
 */
test("the icon assertion tracks the size electron-builder reads", async () => {
  const iconPath = join(REPOSITORY_ROOT, "apps/desktop", packageJson.build.linux.icon);
  const theirs = await getPngSize(iconPath);
  const ours = readPngSize(readFileSync(iconPath));
  assert.equal(ours.width, theirs.width);
  assert.equal(ours.height, theirs.height);
  assert.equal(ours.width, ours.height, "the canonical icon is square");
  assert.equal(
    paths.iconEntry,
    `/usr/share/icons/hicolor/${theirs.width}x${theirs.width}/apps/${paths.iconName}.png`,
  );
});

test("the icon resolves the way electron-builder resolves it", () => {
  const projectDir = join(REPOSITORY_ROOT, "apps/desktop");
  assert.equal(
    resolveIconPath(packageJson),
    join(projectDir, packageJson.build.linux.icon),
  );

  // electron-builder also accepts a build-resources-relative name; this
  // repository spells the prefix out, so cover the other form too.
  const buildResourcesRelative = {
    ...packageJson,
    build: {
      ...packageJson.build,
      linux: { ...packageJson.build.linux, icon: "icon.png" },
    },
  };
  assert.equal(
    resolveIconPath(buildResourcesRelative),
    join(projectDir, "build", "icon.png"),
  );
});

test("the RPM workflow asserts the derived layout instead of literals", () => {
  const workflow = readFileSync(
    join(REPOSITORY_ROOT, ".github/workflows/linux-package.yml"),
    "utf8",
  );

  // Rot guard: the previous revision of this workflow asserted the pre-rebrand
  // names, and the workflow's `workflow_dispatch`-only trigger meant nothing
  // ever failed. No packaged path may be written as a literal again.
  //
  // `pi-desktop-host-core` is deliberately not in this list: it is the Cargo
  // binary the build produces, not the name the package ships it under, so it
  // stays a build-artifact path (see the assertion at the end of this test).
  for (const stale of [
    "/opt/PI-Desktop",
    "pi-desktop.desktop",
    "Icon=pi-desktop",
    "StartupWMClass=pi-desktop",
  ]) {
    assert.doesNotMatch(workflow, new RegExp(stale.replace(/[.]/g, "\\.")), stale);
  }

  assert.match(
    workflow,
    /node scripts\/linux-package-paths\.mjs[^\n]*>> "\$GITHUB_ENV"/,
    "the workflow derives the layout from the product configuration",
  );

  // Every package assertion has to read a derived variable, not a literal path.
  for (const variable of [
    "LINUX_APP_ASAR",
    "LINUX_SIDECAR",
    "LINUX_DESKTOP_FILE",
    "LINUX_ICON_FILE",
    "LINUX_DESKTOP_ENTRY_PATH",
    "LINUX_ICON_KEY",
    "LINUX_WM_CLASS",
  ]) {
    assert.match(
      workflow,
      new RegExp(`\\$\\{?${variable}\\}?`),
      `${variable} is asserted`,
    );
  }

  // The host-core binary name stays a build artifact path: it is the Cargo
  // target output, not the shipped name, so it is not part of the derived set.
  assert.match(workflow, /scripts\/check-linux-host-glibc\.mjs target\/release\/pi-desktop-host-core/);
});
