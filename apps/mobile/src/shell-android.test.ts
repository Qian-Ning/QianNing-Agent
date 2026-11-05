// @vitest-environment node
/**
 * The Android shell is edited by hand, in XML and Java, far from the React code
 * the rest of these tests cover. These checks pin the handful of declarations a
 * device actually reads: the permissions the first-run screen asks for, the
 * adaptive icon layers, and the launch theme. A resource rename or a lost
 * manifest line fails here instead of on a phone.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = fileURLToPath(new URL(".", import.meta.url));
const main = join(here, "../android/app/src/main");
const res = join(main, "res");

const read = (path: string) => readFileSync(join(main, path), "utf8");

describe("the Android shell", () => {
  it("declares the permissions first run asks for", () => {
    const manifest = read("AndroidManifest.xml");
    expect(manifest).toContain("android.permission.POST_NOTIFICATIONS");
    expect(manifest).toContain("android.permission.SCHEDULE_EXACT_ALARM");
    expect(manifest).toContain("android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS");
    expect(manifest).toContain('android:windowSoftInputMode="adjustResize"');
  });

  it("draws the adaptive icon from the branded foreground on paper", () => {
    const adaptive = readFileSync(join(res, "mipmap-anydpi-v26/ic_launcher.xml"), "utf8");
    expect(adaptive).toContain('@color/ic_launcher_background');
    expect(adaptive).toContain('@mipmap/ic_launcher_foreground');
    expect(adaptive).toContain("<monochrome");
  });

  it("keeps the launch window branded on both sides of Android 12", () => {
    const legacy = readFileSync(join(res, "values/styles.xml"), "utf8");
    const modern = readFileSync(join(res, "values-v31/styles.xml"), "utf8");
    expect(legacy).toContain("@drawable/splash");
    expect(legacy).toContain("windowSplashScreenAnimatedIcon");
    expect(modern).toContain("@mipmap/ic_launcher_foreground");
    expect(modern).toContain("postSplashScreenTheme");
  });

  it("registers the permissions bridge the onboarding screen calls", () => {
    const activity = read("java/app/qianning/agent/MainActivity.java");
    expect(activity).toContain("registerPlugin(PermissionsPlugin.class)");
    expect(activity).toContain("installSplashScreen");

    const plugin = read("java/app/qianning/agent/PermissionsPlugin.java");
    expect(plugin).toContain('name = "AgentPermissions"');
  });
});
