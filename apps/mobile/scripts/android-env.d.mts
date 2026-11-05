/**
 * Types for `android-env.mjs`, the toolchain resolver the APK build uses.
 *
 * The module is plain JS because `build-apk.mjs` runs it straight from Node
 * without a build step; this file only gives the tests and any TS caller the
 * shape.
 */

/** The Android Gradle Plugin in this project refuses anything older. */
export const MIN_JAVA: number;

/** What `compileSdkVersion` / build-tools in variables.gradle resolve to. */
export const REQUIRED_BUILD_TOOLS: string;
export const REQUIRED_PLATFORM: string;

export interface Toolchain {
  javaHome: string;
  androidHome: string;
}

/** The major version of a JDK home, or null when it holds no runnable java. */
export function javaMajor(javaHome: string): number | null;

/** Whether a path carries platform-tools, build-tools 36 and platform 36. */
export function isSdk(path: string): boolean;

/** JAVA_HOME of a JDK new enough for the Android Gradle Plugin, or null. */
export function findJavaHome(): string | null;

/** ANDROID_HOME of an SDK with platform-tools, build-tools 36 and platform 36. */
export function findAndroidHome(): string | null;

/** Both homes, or a thrown Error naming what was checked. */
export function resolveToolchain(): Toolchain;
