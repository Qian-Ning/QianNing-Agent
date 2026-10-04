#!/usr/bin/env node
/**
 * Derive the Linux packaging layout electron-builder will produce from this
 * repository's product configuration.
 *
 * Why this exists: `.github/workflows/linux-package.yml` asserts on the RPM's
 * file list and on the generated `.desktop` entry, and those assertions used to
 * be string literals. The literals drifted away from the configuration — the
 * workflow still looked for `/opt/PI-Desktop`, `pi-desktop.desktop`, and
 * `Icon=pi-desktop` while the build had moved to `/opt/QianNing Agent`,
 * `qianning-agent.desktop`, and `Icon=qianning-agent`. The workflow only runs
 * on `workflow_dispatch`, so no push ever noticed.
 *
 * The derivation below mirrors electron-builder's own code, so the workflow can
 * compare the package against what the build is configured to emit rather than
 * against a value someone typed once:
 *
 *   app-builder-lib/out/appInfo.js              productName, sanitizedProductName
 *   app-builder-lib/out/targets/LinuxTargetHelper.js
 *                                               installPrefix, getDesktopFileName,
 *                                               computeDesktopEntry
 *   app-builder-lib/out/targets/FpmTarget.js    the deb/rpm install layout
 *   builder-util/out/filename.js                sanitizeFileName
 *
 * `apps/desktop/test/linux-package-paths.test.mjs` cross-checks every function
 * here against those electron-builder implementations, so a change on either
 * side fails the ordinary JS test job instead of silently diverging.
 *
 * Usage:
 *   node scripts/linux-package-paths.mjs          # KEY=value, for $GITHUB_ENV
 *   node scripts/linux-package-paths.mjs --json   # machine-readable
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = dirname(SCRIPT_DIR);
export const DESKTOP_PACKAGE_JSON = join(
  REPOSITORY_ROOT,
  "apps/desktop/package.json",
);

/** `app-builder-lib/out/targets/LinuxTargetHelper.js` exports.installPrefix */
export const INSTALL_PREFIX = "/opt";

// sanitize-filename's character classes, as builder-util/out/filename.js uses
// them: `sanitizeFileName` delegates to that package with no replacement string,
// so every match is deleted rather than substituted.
const ILLEGAL = /[/?<>\\:*|"]/g;
const CONTROL = /[\x00-\x1f\x80-\x9f]/g;
const RESERVED = /^\.+$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** sanitize-filename caps the result at 255 bytes and does not use a regex. */
const MAX_FILENAME_BYTES = 255;

/**
 * Characters that force an Exec argument to be double-quoted, per the
 * freedesktop Desktop Entry Specification.
 */
const EXEC_RESERVED = /[\s"'`\\<>~|&;$*?#()]/;

/**
 * Mirror of `desktopExecArgEscape`: field codes are never quoted, and an
 * argument is quoted only when it contains a character the freedesktop Exec
 * grammar reserves.
 */
export function desktopExecArgEscape(arg) {
  if (/^%[a-zA-Z]$/.test(arg)) return arg;
  if (EXEC_RESERVED.test(arg)) {
    return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return arg;
}

function stripTrailingDotsAndSpaces(value) {
  let end = value.length;
  while (end > 0 && (value[end - 1] === "." || value[end - 1] === " ")) end--;
  return end < value.length ? value.slice(0, end) : value;
}

/**
 * Mirror of `sanitizeFileName` from builder-util, which is `sanitize-filename`
 * with an empty replacement string. Spaces inside the name survive, which is
 * exactly why the product name's space reaches `/opt`.
 */
export function sanitizeFileName(input) {
  if (typeof input !== "string") {
    throw new TypeError("sanitizeFileName expects a string");
  }
  const sanitized = input
    .replace(ILLEGAL, "")
    .replace(CONTROL, "")
    .replace(RESERVED, "")
    .replace(WINDOWS_RESERVED, "");
  return stripTrailingDotsAndSpaces(sanitized);
}

function assertWithinFilenameLimit(label, value) {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > MAX_FILENAME_BYTES) {
    // sanitize-filename would truncate here. Truncation changes the install
    // directory silently, so a configuration that reaches this is an error
    // rather than something to paper over.
    throw new Error(
      `${label} "${value}" is ${bytes} bytes; sanitize-filename truncates above ` +
        `${MAX_FILENAME_BYTES}, which would move the install directory`,
    );
  }
}

/**
 * Mirror of `LinuxTargetHelper#getDesktopFileName()`. With
 * `linux.syncDesktopName` the file name comes from the package.json
 * `desktopName` field, minus its `.desktop` suffix; otherwise it is the
 * executable name.
 */
export function desktopFileBasename({
  desktopName,
  executableName,
  syncDesktopName,
}) {
  if (!syncDesktopName) return executableName;
  const trimmed = typeof desktopName === "string" ? desktopName.trim() : "";
  if (trimmed.length === 0) return executableName;
  const basename = trimmed.replace(/\.desktop$/, "");
  // electron-builder rejects a desktopName that would escape its directory.
  if (/[/\\]/.test(basename) || basename.includes("\0")) {
    throw new Error(
      `desktopName "${trimmed}" produces an invalid .desktop filename — ` +
        "remove any path separators or NUL characters",
    );
  }
  return basename;
}

/** Read a PNG's pixel dimensions from its IHDR chunk. */
export function readPngSize(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) {
    throw new Error("icon is not a PNG");
  }
  if (buffer.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("icon PNG has no IHDR chunk at offset 12");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * Resolve one extraResources entry the way FpmTarget lays the app out:
 * electron-builder copies `<appOutDir>` to `<installPrefix>/<sanitizedProductName>`
 * and every extraResources destination lands under `<appDir>/resources`.
 */
function resolveExtraResources(entries, appDir, platform) {
  return (entries ?? []).map((entry) => ({
    platform,
    from: entry.from,
    to: entry.to,
    dest: `${appDir}/resources/${entry.to}`,
  }));
}

/**
 * The packaged Linux layout implied by an electron-builder configuration.
 *
 * `iconSize` is the pixel size of the icon electron-builder installs as the
 * freedesktop application icon, which is what names the hicolor directory.
 * It is the source PNG's own size rather than a size the converter picks:
 * `app-builder-lib/out/util/iconConverter.js` returns a `.png` source for the
 * `set` format unchanged (`return [{ file: resolved, size: Math.max(width,
 * height) }]`), and `FpmTarget.js` then writes it to
 * `/usr/share/icons/hicolor/<size>x<size>/apps/<executableName><ext>`. This
 * module reads that size from the file, so replacing the icon keeps the
 * assertion true instead of silently pointing at a directory that no longer
 * exists.
 */
export function linuxPackagePaths({ packageJson, iconSize }) {
  const build = packageJson?.build;
  if (!build) throw new Error("package.json has no electron-builder `build` block");

  const linux = build.linux ?? {};
  const executableName = linux.executableName ?? build.executableName;
  if (typeof executableName !== "string" || executableName.length === 0) {
    throw new Error(
      "linux.executableName is unset; electron-builder would fall back to the " +
        "sanitized product name and every packaged path below would change",
    );
  }

  // app-builder-lib/out/appInfo.js: productName is config → metadata → name.
  const productName =
    build.productName ?? packageJson.productName ?? packageJson.name;
  const sanitizedProductName = sanitizeFileName(productName);
  assertWithinFilenameLimit("sanitized product name", sanitizedProductName);

  const appDir = `${INSTALL_PREFIX}/${sanitizedProductName}`;

  const desktopName = packageJson.desktopName;
  const desktopBasename = desktopFileBasename({
    desktopName,
    executableName,
    syncDesktopName: linux.syncDesktopName === true,
  });

  // computeDesktopEntry builds `${prefix}/${sanitizedProductName}/${executableName}`
  // and double-quotes it when it contains anything outside the safe set — the
  // product name's space is enough to trigger that. It then appends any
  // configured executableArgs and, unless one of them is already a field code,
  // the `%U` placeholder.
  const execPath = `${appDir}/${executableName}`;
  let execLine = /^[/0-9A-Za-z._-]+$/.test(execPath)
    ? execPath
    : `"${execPath}"`;
  const executableArgs = linux.executableArgs;
  if (Array.isArray(executableArgs) && executableArgs.length > 0) {
    execLine += ` ${executableArgs.map(desktopExecArgEscape).join(" ")}`;
  }
  const execCodes = ["%f", "%u", "%F", "%U"];
  if (
    !Array.isArray(executableArgs) ||
    !executableArgs.some((arg) => execCodes.includes(arg))
  ) {
    execLine += " %U";
  }

  // computeDesktopEntry sets StartupWMClass to the desktopName minus its
  // `.desktop` suffix whenever desktopName is set, and to the product name
  // otherwise. This is independent of `syncDesktopName`, which only governs the
  // file name.
  const trimmedDesktopName =
    typeof desktopName === "string" ? desktopName.trim() : "";
  const wmClass =
    trimmedDesktopName.length > 0
      ? trimmedDesktopName.replace(/\.desktop$/, "")
      : productName;

  // The sidecar is the platform-specific extraResources entry whose source is a
  // host-core binary; it is referenced by path rather than by a literal so the
  // shipped name can change in package.json alone.
  const extraResources = [
    ...resolveExtraResources(build.extraResources, appDir, null),
    ...resolveExtraResources(linux.extraResources, appDir, "linux"),
  ];
  const sidecarEntry = extraResources.find((entry) =>
    /host-core/i.test(entry.from ?? ""),
  );
  if (sidecarEntry === undefined) {
    throw new Error(
      "no extraResources entry ships a host-core binary; the RPM assertion " +
        "for the sidecar cannot be derived",
    );
  }

  const iconName = executableName;
  const iconEntry =
    iconSize === undefined
      ? null
      : `/usr/share/icons/hicolor/${iconSize}x${iconSize}/apps/${iconName}.png`;

  return {
    productName,
    sanitizedProductName,
    appDir,
    appAsar: `${appDir}/resources/app.asar`,
    sidecar: sidecarEntry.dest,
    extraResources,
    desktopBasename,
    desktopFile: `/usr/share/applications/${desktopBasename}.desktop`,
    desktopEntryPath: `./usr/share/applications/${desktopBasename}.desktop`,
    iconName,
    iconEntry,
    // computeDesktopEntry: Icon is the executable name.
    iconKey: iconName,
    wmClass,
    execLine,
  };
}

/**
 * Resolve the icon referenced by `linux.icon`, defaulting to build/icon.png.
 *
 * electron-builder resolves a relative icon against the build-resources
 * directory (`build` unless `directories.buildResources` says otherwise), while
 * this repository's configuration spells the prefix out (`build/icon.png`).
 * Accept either: try the project directory first, then build resources.
 */
export function resolveIconPath(packageJson) {
  const build = packageJson.build ?? {};
  const linux = build.linux ?? {};
  const configured = linux.icon ?? build.icon ?? "build/icon.png";
  if (typeof configured !== "string") {
    throw new Error(`unsupported icon configuration: ${JSON.stringify(configured)}`);
  }
  const projectDir = join(REPOSITORY_ROOT, "apps/desktop");
  const buildResourcesDir = join(
    projectDir,
    build.directories?.buildResources ?? "build",
  );
  for (const candidate of [
    join(projectDir, configured),
    join(buildResourcesDir, configured),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return join(projectDir, configured);
}

/** Load the desktop package and derive its Linux layout from the real icon. */
export function loadLinuxPackagePaths({
  packageJsonPath = DESKTOP_PACKAGE_JSON,
} = {}) {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const iconPath = resolveIconPath(packageJson);
  const { width, height } = readPngSize(readFileSync(iconPath));
  if (width !== height) {
    throw new Error(`icon must be square, got ${width}x${height}`);
  }
  return {
    packageJson,
    iconPath,
    paths: linuxPackagePaths({ packageJson, iconSize: width }),
  };
}

function formatEnv(paths) {
  const entries = {
    LINUX_PRODUCT_NAME: paths.productName,
    LINUX_APP_DIR: paths.appDir,
    LINUX_APP_ASAR: paths.appAsar,
    LINUX_SIDECAR: paths.sidecar,
    LINUX_DESKTOP_BASENAME: paths.desktopBasename,
    LINUX_DESKTOP_FILE: paths.desktopFile,
    LINUX_DESKTOP_ENTRY_PATH: paths.desktopEntryPath,
    LINUX_ICON_KEY: paths.iconKey,
    LINUX_WM_CLASS: paths.wmClass,
    LINUX_EXEC_LINE: paths.execLine,
  };
  if (paths.iconEntry !== null) entries.LINUX_ICON_FILE = paths.iconEntry;
  return Object.entries(entries)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function main(argv) {
  const { paths } = loadLinuxPackagePaths();
  if (argv.includes("--json")) {
    console.log(JSON.stringify(paths, null, 2));
    return;
  }
  console.log(formatEnv(paths));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
