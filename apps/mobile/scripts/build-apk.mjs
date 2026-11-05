/**
 * Builds the Android debug APK.
 *
 * Three steps in the order Capacitor requires: the web bundle (`vite build`),
 * the native project sync (which copies `dist/` into the Android assets), then
 * Gradle. Running `cap sync` before the build would package the previous bundle,
 * which is the classic way to ship a fix that is not in the APK.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveToolchain } from "./android-env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const isWindows = process.platform === "win32";

/*
  `--release` builds the distributable variant: minified off, signed with the
  debug keystore (see android/app/build.gradle), installable by sideload. The
  default stays `assembleDebug` so a quick local round-trip does not pay for the
  release pipeline.
*/
const release = process.argv.includes("--release");
const variant = release ? "release" : "debug";
const task = release ? "assembleRelease" : "assembleDebug";
const artifact = release
  ? "android/app/build/outputs/apk/release/app-release.apk"
  : "android/app/build/outputs/apk/debug/app-debug.apk";

function run(command, args, cwd, extraEnv) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: isWindows,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  if (result.status !== 0) {
    console.error(`\n${command} ${args.join(" ")} failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

/*
  Gradle needs a JDK 21+ and an Android SDK with build-tools 36 / platform 36.
  The shell that runs this may export neither — resolve them and hand them to
  the Gradle process explicitly instead of trusting whatever the profile loaded.
*/
let toolchain;
try {
  toolchain = resolveToolchain();
} catch (error) {
  console.error(`\n${error.message}\n`);
  process.exit(1);
}
console.log(`[apk] java     ${toolchain.javaHome}`);
console.log(`[apk] android  ${toolchain.androidHome}`);

/*
  The phone runs the desktop renderer through the bridge bundle. An APK without
  that bootstrap loads the renderer with no `window.piDesktop`, and every screen
  that talks to the host comes up empty — the app looks installed and works.
  The check is cheap and catches the failure before it reaches a device.
*/
const sharedIndex = join(root, "public/shared/index.html");
if (!existsSync(sharedIndex)) {
  console.error(
    "public/shared/index.html is missing; run `pnpm build:shared` before building the APK.",
  );
  process.exit(1);
}
const sharedHtml = readFileSync(sharedIndex, "utf8");
if (!sharedHtml.includes("bridge-boot.js")) {
  console.error(
    "public/shared/index.html does not reference bridge-boot.js; the phone would ship without its host bridge.",
  );
  process.exit(1);
}
const bridgeBundle = join(root, "public/shared/bridge-boot.js");
if (!existsSync(bridgeBundle)) {
  console.error("public/shared/bridge-boot.js is missing; the phone would ship without its host bridge.");
  process.exit(1);
}

/*
  A stale shared surface packages yesterday's renderer without a word: the APK
  installs, boots, and quietly lacks every feature merged since the last
  `build:shared`. Compare the desktop build that feeds it against the copy that
  ships, and refuse rather than produce a plausible-looking old bundle.
*/
const rendererIndex = join(root, "../../apps/desktop/out/renderer/index.html");
if (existsSync(rendererIndex)) {
  const desktopBuiltAt = statSync(rendererIndex).mtimeMs;
  const sharedBuiltAt = statSync(sharedIndex).mtimeMs;
  if (desktopBuiltAt > sharedBuiltAt + 1000) {
    console.error(
      "public/shared is older than apps/desktop/out/renderer; run `pnpm build:shared` before building the APK.",
    );
    process.exit(1);
  }
}

run("pnpm", ["build"], root);
run("pnpm", ["exec", "cap", "sync", "android"], root);

const gradlew = join(root, "android", isWindows ? "gradlew.bat" : "gradlew");
if (!existsSync(gradlew)) {
  console.error("the Android project is missing; run `pnpm exec cap add android` first.");
  process.exit(1);
}
run(gradlew, [task], join(root, "android"), {
  JAVA_HOME: toolchain.javaHome,
  ANDROID_HOME: toolchain.androidHome,
  ANDROID_SDK_ROOT: toolchain.androidHome,
});

const apk = join(root, artifact);
if (!existsSync(apk)) {
  console.error(`\nthe ${variant} build finished but ${artifact} is missing.`);
  process.exit(1);
}
console.log(`\nAPK (${variant}): ${artifact}  ${statSync(apk).size.toLocaleString()} bytes`);
