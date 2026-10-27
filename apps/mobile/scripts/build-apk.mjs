/**
 * Builds the Android debug APK.
 *
 * Three steps in the order Capacitor requires: the web bundle (`vite build`),
 * the native project sync (which copies `dist/` into the Android assets), then
 * Gradle. Running `cap sync` before the build would package the previous bundle,
 * which is the classic way to ship a fix that is not in the APK.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const isWindows = process.platform === "win32";

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: isWindows });
  if (result.status !== 0) {
    console.error(`\n${command} ${args.join(" ")} failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

if (!process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT) {
  console.error("ANDROID_HOME is not set; the Android SDK is required to build the APK.");
  process.exit(1);
}

run("pnpm", ["build"], root);
run("pnpm", ["exec", "cap", "sync", "android"], root);

const gradlew = join(root, "android", isWindows ? "gradlew.bat" : "gradlew");
if (!existsSync(gradlew)) {
  console.error("the Android project is missing; run `pnpm exec cap add android` first.");
  process.exit(1);
}
run(gradlew, ["assembleDebug"], join(root, "android"));

console.log(
  "\nAPK: apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk",
);
