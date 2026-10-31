import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deleteSshProfile,
  ensureSsh,
  findSshProfile,
  hasSsh,
  isConnected,
  listSshProfiles,
  runSsh,
  saveSshProfile,
} from "./connections";

type Call = { method: string; options: Record<string, unknown> };

function install(overrides: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const track = (method: string) => (options: Record<string, unknown> = {}) => {
    calls.push({ method, options });
    return Promise.resolve((overrides as Record<string, unknown>)[method] ?? {});
  };
  const plugin = {
    profiles: track("profiles"),
    saveProfile: track("saveProfile"),
    deleteProfile: track("deleteProfile"),
    probe: track("probe"),
    connect: track("connect"),
    disconnect: track("disconnect"),
    exec: track("exec"),
    shell: track("shell"),
  };
  (globalThis as unknown as { Capacitor: unknown }).Capacitor = { Plugins: { QnSsh: plugin } };
  return calls;
}

afterEach(() => {
  delete (globalThis as unknown as { Capacitor?: unknown }).Capacitor;
});

describe("ssh connections", () => {
  it("reports no client when the plugin is absent", () => {
    expect(hasSsh()).toBe(false);
  });

  it("sorts machines by name", async () => {
    install({
      profiles: {
        profiles: [
          { id: "b", name: "zeta", host: "10.0.0.2", port: 22, user: "me", enabled: true, auth: "password", fingerprint: "", hasSecret: true },
          { id: "a", name: "alpha", host: "10.0.0.1", port: 22, user: "me", enabled: true, auth: "password", fingerprint: "", hasSecret: true },
        ],
      },
    });
    const list = await listSshProfiles();
    expect(list.map((entry) => entry.name)).toEqual(["alpha", "zeta"]);
  });

  it("refuses to save without a host or a user", async () => {
    const calls = install();
    await expect(
      saveSshProfile({ name: "", host: "", port: 22, user: "root", auth: "password" }),
    ).rejects.toThrow("地址和用户名都要填");
    await expect(
      saveSshProfile({ name: "", host: "10.0.0.1", port: 22, user: " ", auth: "password" }),
    ).rejects.toThrow("地址和用户名都要填");
    expect(calls).toHaveLength(0);
  });

  it("falls back to the host as the name and 22 as the port", async () => {
    const calls = install({ saveProfile: { id: "a", name: "10.0.0.9" } });
    await saveSshProfile({ name: "  ", host: " 10.0.0.9 ", port: 0, user: "me", auth: "password" });
    expect(calls[0]?.options).toMatchObject({
      name: "10.0.0.9",
      host: "10.0.0.9",
      port: 22,
      user: "me",
    });
  });

  it("does not send an empty secret over the bridge", async () => {
    const calls = install({ saveProfile: { id: "a" } });
    await saveSshProfile({
      name: "box",
      host: "10.0.0.9",
      port: 22,
      user: "me",
      auth: "key",
      privateKey: "",
      password: "",
    });
    expect(calls[0]?.options).not.toHaveProperty("privateKey");
    expect(calls[0]?.options).not.toHaveProperty("password");
  });

  it("connects once and reuses the session", async () => {
    const calls = install({ connect: { sessionId: "a", fingerprint: "AA" } });
    expect(isConnected("a")).toBe(false);
    await ensureSsh("a");
    await ensureSsh("a");
    expect(calls.filter((call) => call.method === "connect")).toHaveLength(1);
    expect(isConnected("a")).toBe(true);
  });

  it("passes the timeout through and keeps the shell's answer", async () => {
    const calls = install({
      connect: { sessionId: "a" },
      shell: { output: "/srv\n", exitStatus: 0, cwd: "/srv", timedOut: false },
    });
    const result = await runSsh("a", "pwd", 45_000);
    expect(result).toEqual({ output: "/srv\n", exitStatus: 0, cwd: "/srv", timedOut: false });
    expect(calls.find((call) => call.method === "shell")?.options).toMatchObject({
      sessionId: "a",
      command: "pwd",
      timeoutMs: 45_000,
    });
  });

  it("drops the connection before deleting the machine", async () => {
    const calls = install({ connect: { sessionId: "a" } });
    await ensureSsh("a");
    await deleteSshProfile("a");
    const order = calls.map((call) => call.method);
    expect(order.indexOf("disconnect")).toBeLessThan(order.indexOf("deleteProfile"));
    expect(isConnected("a")).toBe(false);
  });

  it("finds a machine by name, host or id", async () => {
    install({
      profiles: {
        profiles: [
          { id: "a", name: "Build box", host: "10.0.0.5", port: 22, user: "ci", enabled: true, auth: "key", fingerprint: "", hasSecret: true },
          { id: "b", name: "NAS", host: "nas.lan", port: 22, user: "me", enabled: true, auth: "password", fingerprint: "", hasSecret: true },
        ],
      },
    });
    expect((await findSshProfile("build box"))?.id).toBe("a");
    expect((await findSshProfile("NAS"))?.id).toBe("b");
    expect((await findSshProfile("nas.lan"))?.id).toBe("b");
    expect((await findSshProfile("a"))?.id).toBe("a");
    expect(await findSshProfile("nothing")).toBeNull();
  });
});
