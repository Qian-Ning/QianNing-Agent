/**
 * Resolves the JDK and the Android SDK this machine already has, for the APK
 * build.
 *
 * Gradle needs both, and neither is guaranteed to be on PATH or exported: a JDK
 * can live in a scratch directory, and the Android SDK can sit under a custom
 * path that the current shell never inherited. `pnpm apk` should fail on a real
 * compile error, not on "JAVA_HOME is unset" from a shell that did not load the
 * right profile.
 *
 * Lookup order per tool, first hit wins:
 *
 *   JDK  $QN_JAVA_HOME, $JAVA_HOME, $ANDROID_STUDIO_HOME/jbr,
 *        %LOCALAPPDATA%\Programs\Android Studio\jbr, ~/.jdks/*,
 *        %LOCALAPPDATA%\hermes\cache\scratch\jdk21\*
 *   SDK  $QN_ANDROID_HOME, $ANDROID_HOME, $ANDROID_SDK_ROOT,
 *        %LOCALAPPDATA%\Android\Sdk, ~/Android/Sdk, ~/Library/Android/sdk,
 *        %LOCALAPPDATA%\hermes\cache\scratch\android-sdk
 *
 * Nothing here downloads or installs. A missing tool lists every path that was
 * checked and the one command that fixes it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The Android Gradle Plugin in this project refuses anything older. */
export const MIN_JAVA = 21;

/** What `compileSdkVersion` / build-tools in variables.gradle resolve to. */
export const REQUIRED_BUILD_TOOLS = "36.0.0";
export const REQUIRED_PLATFORM = "android-36";

const isWindows = process.platform === "win32";
const localAppData = process.env.LOCALAPPDATA ?? "";
const scratch = localAppData ? join(localAppData, "hermes/cache/scratch") : "";

function parseMajor(text) {
  const property = /java\.version\s*=\s*"?(?:1\.)?(\d+)/.exec(text ?? "");
  if (property) return Number(property[1]);
  const banner = /(?:openjdk|java)\s+version\s+"(?:1\.)?(\d+)/i.exec(text ?? "");
  return banner ? Number(banner[1]) : null;
}

function javaBinary(javaHome) {
  return join(javaHome, "bin", isWindows ? "java.exe" : "java");
}

/**
 * Runs a binary and returns both streams, or null when it could not run at all.
 *
 * `java -version` exits 0 and writes to stderr, so a nonzero exit is not the
 * failure signal — a missing binary or a spawn error is, and `spawnSync` marks
 * that with `error` and a null status rather than by throwing.
 */
function capture(command, args) {
  const child = spawnSync(command, args, { encoding: "utf8", timeout: 20_000 });
  if (child.error || child.status === null) return null;
  return { stdout: child.stdout ?? "", stderr: child.stderr ?? "" };
}

/**
 * The major version of a JDK home, or null when it holds no runnable java.
 *
 * The property dump is asked for first because it answers for any vendor and any
 * locale; the plain banner is the fallback when a launcher refuses the extra flag.
 */
export function javaMajor(javaHome) {
  if (!javaHome) return null;
  const binary = javaBinary(javaHome);
  if (!existsSync(binary)) return null;

  const dump = capture(binary, ["-XshowSettings:properties", "-version"]);
  if (dump) {
    const fromDump = parseMajor(`${dump.stdout}${dump.stderr}`);
    if (fromDump !== null) return fromDump;
  }

  const banner = capture(binary, ["-version"]);
  if (!banner) return null;
  return parseMajor(`${banner.stdout}${banner.stderr}`);
}

/** Directories under `root` that hold a java binary, in name order. */
function jdkChildren(root) {
  if (!root || !existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
      .filter((path) => existsSync(javaBinary(path)))
      .sort();
  } catch {
    return [];
  }
}

function javaCandidates() {
  const list = [process.env.QN_JAVA_HOME, process.env.JAVA_HOME];

  const studioHome = process.env.ANDROID_STUDIO_HOME;
  if (studioHome) list.push(join(studioHome, "jbr"));

  if (localAppData) list.push(join(localAppData, "Programs/Android Studio/jbr"));
  list.push(join(process.env.ProgramFiles ?? "", "Android/Android Studio/jbr"));
  list.push(join(process.env["ProgramFiles(x86)"] ?? "", "Android/Android Studio/jbr"));

  list.push(...jdkChildren(join(homedir(), ".jdks")).reverse());

  // The project's own scratch toolchain: `jdk21/jdk-*`, newest first.
  if (scratch) list.push(...jdkChildren(join(scratch, "jdk21")).reverse());

  return list.filter(Boolean);
}

/** JAVA_HOME of a JDK new enough for the Android Gradle Plugin, or null. */
export function findJavaHome() {
  for (const home of javaCandidates()) {
    const major = javaMajor(home);
    if (major !== null && major >= MIN_JAVA) return home;
  }
  return null;
}

function sdkCandidates() {
  const list = [process.env.QN_ANDROID_HOME, process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT];

  if (localAppData) list.push(join(localAppData, "Android/Sdk"));
  list.push(join(homedir(), "Android/Sdk"));
  list.push(join(homedir(), "Library/Android/sdk"));
  if (scratch) list.push(join(scratch, "android-sdk"));

  return list.filter(Boolean);
}

/*
  A directory is the SDK only when it carries the pieces Gradle will call. An
  empty folder left behind by an interrupted install satisfies `existsSync` and
  answers none of the build.
*/
export function isSdk(path) {
  if (!path || !existsSync(path)) return false;
  return (
    existsSync(join(path, "platform-tools")) &&
    existsSync(join(path, "build-tools", REQUIRED_BUILD_TOOLS)) &&
    existsSync(join(path, "platforms", REQUIRED_PLATFORM))
  );
}

/** ANDROID_HOME of an SDK with platform-tools, build-tools 36 and platform 36. */
export function findAndroidHome() {
  for (const home of sdkCandidates()) {
    if (isSdk(home)) return home;
  }
  return null;
}

/**
 * Both homes, or the reason the build cannot start. The message names what was
 * looked for so the answer is a path, not a guess.
 */
export function resolveToolchain() {
  const javaHome = findJavaHome();
  if (!javaHome) {
    throw new Error(
      [
        `no JDK ${MIN_JAVA}+ found.`,
        "looked at: $QN_JAVA_HOME, $JAVA_HOME, $ANDROID_STUDIO_HOME/jbr,",
        "  %LOCALAPPDATA%/Programs/Android Studio/jbr, ~/.jdks/*,",
        `  ${scratch || "(no LOCALAPPDATA)"}/jdk21/*`,
        `set QN_JAVA_HOME to a JDK ${MIN_JAVA}+ and re-run.`,
      ].join("\n"),
    );
  }

  const androidHome = findAndroidHome();
  if (!androidHome) {
    throw new Error(
      [
        `no Android SDK with build-tools ${REQUIRED_BUILD_TOOLS} and ${REQUIRED_PLATFORM} found.`,
        "looked at: $QN_ANDROID_HOME, $ANDROID_HOME, $ANDROID_SDK_ROOT,",
        "  %LOCALAPPDATA%/Android/Sdk, ~/Android/Sdk, ~/Library/Android/sdk,",
        `  ${scratch || "(no LOCALAPPDATA)"}/android-sdk`,
        `install them with: sdkmanager "build-tools;${REQUIRED_BUILD_TOOLS}" "platforms;${REQUIRED_PLATFORM}"`,
      ].join("\n"),
    );
  }

  return { javaHome, androidHome };
}

// Only act as a program when run directly; importing this from a test or the
// APK build script must not print anything.
const invokedDirectly =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  try {
    const { javaHome, androidHome } = resolveToolchain();
    console.log(`JAVA_HOME=${javaHome}`);
    console.log(`ANDROID_HOME=${androidHome}`);
  } catch (error) {
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }
}
