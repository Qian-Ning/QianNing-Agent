// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TerminalView } from "./terminal";
import { createTranslator } from "../lib/i18n";

const t = createTranslator("zh");

afterEach(() => {
  cleanup();
  const scope = globalThis as unknown as { window?: { Capacitor?: unknown } };
  if (scope.window) delete scope.window.Capacitor;
});

function installShell(exec: (options: { command: string; cwd?: string }) => Promise<unknown>) {
  (window as unknown as { Capacitor?: unknown }).Capacitor = {
    Plugins: {
      QnShell: {
        exec,
        info: async () => ({
          cwd: "/data/user/0/app.qianning.agent/files",
          home: "/data/user/0/app.qianning.agent/files",
          user: "u0_a100",
          timeoutMs: 20_000,
        }),
      },
    },
  };
}

describe("the terminal", () => {
  it("runs what was typed and shows what came back", async () => {
    const calls: string[] = [];
    installShell(async (options) => {
      calls.push(options.command);
      return {
        output: "notes.md\nproject-a\n",
        code: 0,
        truncated: false,
        cwd: "/data/user/0/app.qianning.agent/files",
        durationMs: 9,
      };
    });

    render(<TerminalView t={t} onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("输入命令"), { target: { value: "ls" } });
    fireEvent.submit(screen.getByPlaceholderText("输入命令").closest("form")!);

    await waitFor(() => expect(screen.getByText(/notes\.md/)).toBeTruthy());
    expect(calls).toEqual(["ls"]);
    expect(screen.getByText("ls")).toBeTruthy();
  });

  it("follows the session's directory across a cd", async () => {
    // The shell is one process: the plugin owns the working directory, and the
    // prompt has to follow whatever the last command left behind.
    let cwd = "/data/user/0/app.qianning.agent/files";
    const commands: string[] = [];

    installShell(async (options) => {
      commands.push(options.command);
      if (options.command.startsWith("cd ")) {
        cwd = `${cwd}/${options.command.slice(3).trim()}`;
        return { output: "", code: 0, truncated: false, cwd, durationMs: 3 };
      }
      return { output: "index.html\n", code: 0, truncated: false, cwd, durationMs: 4 };
    });

    render(<TerminalView t={t} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("~")).toBeTruthy());

    const field = screen.getByPlaceholderText("输入命令");
    fireEvent.change(field, { target: { value: "cd project-a" } });
    fireEvent.submit(field.closest("form")!);
    await waitFor(() => expect(screen.getByText("~/project-a")).toBeTruthy());

    fireEvent.change(field, { target: { value: "ls" } });
    fireEvent.submit(field.closest("form")!);
    await waitFor(() => expect(screen.getByText(/index\.html/)).toBeTruthy());

    expect(commands).toEqual(["cd project-a", "ls"]);
  });

  it("says the shell is missing instead of pretending", async () => {
    render(<TerminalView t={t} onClose={() => {}} />);
    expect(screen.getByText(/没有 shell/)).toBeTruthy();
  });
});
