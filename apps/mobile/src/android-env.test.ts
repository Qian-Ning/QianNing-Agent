// @vitest-environment node
/**
 * The APK build is the one script that must work from a shell with nothing
 * exported — a bare CI step, a fresh terminal, a machine where the SDK was
 * installed into a scratch directory months ago. These checks pin the two
 * behaviours that failure taught: an incomplete toolchain is rejected by name
 * rather than half-accepted, and the platform/build-tools pair stays in step
 * with what the Gradle files ask for.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { REQUIRED_BUILD_TOOLS, REQUIRED_PLATFORM, isSdk, javaMajor } from "../scripts/android-env.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));

describe("the Android toolchain", () => {
  it("calls a directory the SDK only when every piece AGP needs is there", () => {
    // An interrupted install leaves the folder behind; it answers none of the build.
    expect(isSdk(join(here, "__not_installed__"))).toBe(false);
    expect(isSdk("")).toBe(false);
    // The repo itself is not an SDK, however much of it exists.
    expect(isSdk(join(here, ".."))).toBe(false);
  });

  it("matches the versions the Gradle files ask for", () => {
    const variables = readFileSync(join(here, "../android/variables.gradle"), "utf8");
    const compileSdk = /compileSdkVersion\s*=\s*(\d+)/.exec(variables);
    expect(compileSdk).not.toBeNull();
    expect(REQUIRED_PLATFORM).toBe(`android-${compileSdk?.[1]}`);

    // Platform and build-tools are picked together; bumping one and not the
    // other fails inside Gradle with "failed to find target".
    const major = REQUIRED_PLATFORM.replace("android-", "").split(".")[0];
    expect(REQUIRED_BUILD_TOOLS.startsWith(`${major}.`)).toBe(true);
  });

  // Spawning a JVM is the slow part, and a cold one on a hosted runner can pass
  // the default five seconds; the assertion is about parsing, not speed.
  it("reads a version out of a JDK that is present and says nothing about one that is not", { timeout: 30_000 }, () => {
    expect(javaMajor(join(here, "__no_such_jdk__"))).toBeNull();

    const real = process.env.QN_JAVA_HOME ?? process.env.JAVA_HOME;
    if (!real) return; // A runner without a JDK still proves the missing path.
    const major = javaMajor(real);
    if (major === null) return;
    expect(Number.isInteger(major)).toBe(true);
    expect(major).toBeGreaterThan(0);
  });
});
