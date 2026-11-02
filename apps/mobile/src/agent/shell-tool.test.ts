import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "./store";
import { createTools } from "./tools";
import { requiresApproval } from "./permissions";

/**
 * The shell tool is only reachable through the Android plugin. These tests pin
 * the contract the agent sees: a denied command never reaches the device, an
 * allowed one comes back with its output and exit code, and the app degrades to
 * an honest message when the plugin is not there.
 */
function withPlugin(exec: (options: { command: string; cwd?: string }) => Promise<unknown>) {
  const calls: Array<{ command: string; cwd?: string }> = [];
  (globalThis as unknown as { window: unknown }).window = {
    Capacitor: {
      Plugins: {
        QnShell: {
          exec: async (options: { command: string; cwd?: string }) => {
            calls.push(options);
            return exec(options);
          },
          info: async () => ({ cwd: "/data/user/0/app/files", home: "/data/user/0/app/files", user: "u0_a100", timeoutMs: 20_000 }),
        },
      },
    },
  };
  return calls;
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

function tool(approve?: Parameters<typeof createTools>[2]) {
  const store = new MemoryStore();
  return createTools(store, () => null, approve).find((entry) => entry.name === "run_command")!;
}

function named(name: string) {
  const store = new MemoryStore();
  return createTools(store, () => null).find((entry) => entry.name === name)!;
}

function withBrowser(open: (options: { url: string }) => Promise<unknown>, page: unknown) {
  const opened: string[] = [];
  (globalThis as unknown as { window: unknown }).window = {
    Capacitor: {
      Plugins: {
        QnBrowser: {
          open: async (options: { url: string }) => {
            opened.push(options.url);
            return open(options);
          },
          read: async () => page,
          close: async () => ({ ok: true }),
        },
      },
    },
  };
  return opened;
}

describe("run_command", () => {
  it("returns output and the exit code", async () => {
    const calls = withPlugin(async () => ({
      output: "a.txt\nb.txt\n",
      code: 0,
      truncated: false,
      cwd: "/data/user/0/app/files",
      durationMs: 12,
    }));

    const result = (await tool().execute("call-1", { command: "ls" })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(calls).toEqual([{ command: "ls" }]);
    expect(result.content[0]?.text).toContain("a.txt");
    expect(result.content[0]?.text).toContain("(exit 0 ");
    expect(result.isError).toBeUndefined();
  });

  it("marks a failing command as an error but keeps what it printed", async () => {
    withPlugin(async () => ({
      output: "ls: /nope: No such file or directory",
      code: 2,
      truncated: false,
      cwd: "/data/user/0/app/files",
      durationMs: 8,
    }));

    const result = (await tool().execute("call-2", { command: "ls /nope" })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("No such file");
    expect(result.content[0]?.text).toContain("(exit 2 ");
  });

  it("never runs a command the reader refused", async () => {
    const calls = withPlugin(async () => ({
      output: "",
      code: 0,
      truncated: false,
      cwd: "/data/user/0/app/files",
      durationMs: 1,
    }));

    const result = (await tool(async () => false).execute("call-3", { command: "rm -rf files" })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(calls).toEqual([]);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("permission denied");
  });

  it("says so plainly when the device has no shell plugin", async () => {
    const result = (await tool().execute("call-4", { command: "ls" })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("没有可用的 shell");
  });
});

describe("browser tools", () => {
  it("opens a URL in the app's own window", async () => {
    const opened = withBrowser(async () => ({ ok: true }), null);

    const result = (await named("open_browser").execute("call-b1", { url: "https://example.com" })) as {
      content: Array<{ text: string }>;
    };

    expect(opened).toEqual(["https://example.com"]);
    expect(result.content[0]?.text).toContain("in-app browser");
  });

  it("reads back the rendered page, not the source", async () => {
    withBrowser(async () => ({ ok: true }), {
      open: true,
      url: "https://example.com/list",
      title: "List",
      text: "第一项\n第二项\n",
    });

    const result = (await named("read_browser").execute("call-b2", {})) as {
      content: Array<{ text: string }>;
    };

    expect(result.content[0]?.text).toContain("url: https://example.com/list");
    expect(result.content[0]?.text).toContain("title: List");
    expect(result.content[0]?.text).toContain("第一项");
  });

  it("reports a closed window instead of inventing a page", async () => {
    withBrowser(async () => ({ ok: true }), { open: false, url: "", title: "", text: "" });

    const result = (await named("read_browser").execute("call-b3", {})) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("no browser window is open");
  });

  it("says the tool list really contains both", () => {
    const names = createTools(new MemoryStore(), () => null).map((entry) => entry.name);
    expect(names).toContain("run_command");
    expect(names).toContain("open_browser");
    expect(names).toContain("read_browser");
  });
});

describe("run_command approval", () => {
  it("asks in the modes that still protect the device", () => {
    expect(requiresApproval("ask", "run_command")).toBe(true);
    expect(requiresApproval("accept-edits", "run_command")).toBe(true);
    expect(requiresApproval("auto", "run_command")).toBe(false);
  });
});
