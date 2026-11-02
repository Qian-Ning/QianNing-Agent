/**
 * The tools the phone agent can actually use.
 *
 * The phone has no desktop filesystem and no `git`, but it does have network
 * access, its own storage, and — since the shell plugin landed — a real
 * `/system/bin/sh` inside the app's sandbox. The tool list is the whole list:
 * nothing here is announced and then fails at runtime.
 */

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentStore } from "./store";
import { bundledSkills, findBundledSkill } from "./skills";
import type { GatedAction } from "./permissions";
import { runShell, openBrowser, readBrowser } from "../lib/shell";
import { findSshProfile, runSsh } from "./connections";

const FILE_PREFIX = "file:";
const MAX_FILE_BYTES = 200_000;
const MAX_FETCH_CHARS = 20_000;

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }], details: {} };
}

function failure(message: string) {
  return { content: [{ type: "text" as const, text: message }], details: {}, isError: true };
}

/** Paths are a flat namespace in app storage; nothing may climb out of it. */
function fileKey(path: string): string | null {
  const cleaned = path.trim().replace(/^\/+/, "");
  if (!cleaned || cleaned.includes("..")) return null;
  return FILE_PREFIX + cleaned;
}

const ListArgs = Type.Object({});
const ReadArgs = Type.Object({ path: Type.String({ minLength: 1 }) });
const WriteArgs = Type.Object({
  path: Type.String({ minLength: 1 }),
  content: Type.String(),
});
const SkillArgs = Type.Object({ id: Type.String({ minLength: 1 }) });
const FetchArgs = Type.Object({
  url: Type.String({ minLength: 1 }),
  method: Type.Optional(Type.Union([Type.Literal("GET"), Type.Literal("POST")])),
  body: Type.Optional(Type.String()),
});
const ShellArgs = Type.Object({
  command: Type.String({ minLength: 1 }),
  /** Per-command ceiling; the plugin clamps it to 1s..300s. */
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 300_000 })),
});
const SshArgs = Type.Object({
  machine: Type.String({ minLength: 1 }),
  command: Type.String({ minLength: 1 }),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 300_000 })),
});
const BrowserArgs = Type.Object({ url: Type.String({ minLength: 1 }) });
const EmptyArgs = Type.Object({});

/**
 * `root` is the open project's folder prefix, or null at the storage root. A
 * path the agent passes is always relative to whatever the reader opened, so
 * "notes.md" in project A and in project B are different files.
 */
export type ToolApproval = (input: {
  action: GatedAction;
  toolCallId: string;
  toolName: string;
  argsPreview: unknown;
}) => Promise<boolean>;

export function createTools(
  store: AgentStore,
  root: () => string | null = () => null,
  approve?: ToolApproval,
): AgentTool[] {
  const resolve = (path: string): string | null => {
    const base = root();
    const clean = path.trim().replace(/^\/+/, "");
    return base ? `${base}/${clean}` : clean;
  };

  const listFiles: AgentTool<typeof ListArgs> = {
    name: "list_files",
    label: "List files",
    description: "List the files this agent has written in the app's own storage.",
    parameters: ListArgs,
    execute: async () => {
      const base = root();
      const stored = store.readValue(FILE_PREFIX + "index") ?? "";
      const names = stored
        .split("\n")
        .filter(Boolean)
        .filter((entry) => (base ? entry.startsWith(base + "/") : true))
        .map((entry) => (base ? entry.slice(base.length + 1) : entry))
        .sort();
      return text(names.length > 0 ? names.join("\n") : "(no files yet)");
    },
  };

  const readFile: AgentTool<typeof ReadArgs> = {
    name: "read_file",
    label: "Read file",
    description:
      "Read a file previously written by this agent, or a file attached in the composer (its chip path is a real path in app storage).",
    parameters: ReadArgs,
    execute: async (_toolCallId: string, args: Static<typeof ReadArgs>) => {
      const key = fileKey(resolve(args.path) ?? "");
      if (!key) return failure("invalid path");
      const content = store.readValue(key);
      if (content !== null) return text(content);
      // Attachments are real files, not entries in the app's file store: read
      // them the way the device would, through the shell.
      if (args.path.trim().startsWith("/")) {
        const quoted = `'${args.path.trim().replace(/'/g, "'\\''")}'`;
        const result = await runShell(`head -c ${MAX_FILE_BYTES} -- ${quoted}`, 15_000);
        if (result.code === 0 && result.output.trim().length > 0) {
          return text(result.output.slice(0, MAX_FILE_BYTES));
        }
        return failure("no such file: " + args.path);
      }
      return failure("no such file: " + args.path);
    },
  };

  const writeFile: AgentTool<typeof WriteArgs> = {
    name: "write_file",
    label: "Write file",
    description: "Write a text file into the app's own storage, replacing any existing file.",
    parameters: WriteArgs,
    execute: async (toolCallId: string, args: Static<typeof WriteArgs>) => {
      if (
        approve &&
        !(await approve({
          action: "write_file",
          toolCallId,
          toolName: "write_file",
          argsPreview: { path: args.path, bytes: args.content.length },
        }))
      ) {
        return failure("permission denied: the user did not allow this write");
      }
      const scoped = resolve(args.path);
      const key = fileKey(scoped ?? "");
      if (!key) return failure("invalid path");
      const bytes = new TextEncoder().encode(args.content).byteLength;
      if (bytes > MAX_FILE_BYTES) return failure("file is too large: " + bytes + " bytes");
      store.writeValue(key, args.content);
      const index = new Set((store.readValue(FILE_PREFIX + "index") ?? "").split("\n").filter(Boolean));
      index.add(args.path.trim().replace(/^\/+/, ""));
      store.writeValue(FILE_PREFIX + "index", [...index].join("\n"));
      return text("wrote " + bytes + " bytes to " + (scoped ?? args.path));
    },
  };

  const fetchUrl: AgentTool<typeof FetchArgs> = {
    name: "fetch_url",
    label: "Fetch URL",
    description:
      "Fetch an http(s) URL and return its body as text, truncated to 20000 characters.",
    parameters: FetchArgs,
    execute: async (
      toolCallId: string,
      args: Static<typeof FetchArgs>,
      signal?: AbortSignal,
    ) => {
      if (!/^https?:\/\//i.test(args.url)) return failure("only http(s) URLs are allowed");
      if (
        approve &&
        !(await approve({
          action: "fetch_url",
          toolCallId,
          toolName: "fetch_url",
          argsPreview: { url: args.url, method: args.method ?? "GET" },
        }))
      ) {
        return failure("permission denied: the user did not allow this request");
      }
      const response = await fetch(args.url, {
        method: args.method ?? "GET",
        ...(args.body ? { body: args.body } : {}),
        signal,
      });
      const body = await response.text();
      const truncated = body.length > MAX_FETCH_CHARS;
      return text(
        (response.ok ? "" : "HTTP " + response.status + "\n") +
          (truncated ? body.slice(0, MAX_FETCH_CHARS) + "\n…(truncated)" : body),
      );
    },
  };

  /**
   * Skills are model-invoked: the catalog names them, this tool loads one body.
   * Without it the phone would carry the instructions and never read them.
   */
  const skill: AgentTool<typeof SkillArgs> = {
    name: "Skill",
    label: "Load skill",
    description:
      "Load the full instructions of a bundled skill by id. The available ids are listed under # Skills in the system prompt.",
    parameters: SkillArgs,
    execute: async (_toolCallId: string, args: Static<typeof SkillArgs>) => {
      const found = findBundledSkill(args.id);
      if (!found) {
        const known = bundledSkills()
          .slice(0, 12)
          .map((entry) => entry.id)
          .join(", ");
        return failure(`no such skill: ${args.id}. Known ids include ${known}`);
      }
      return text(`# ${found.name}

${found.body}`);
    },
  };

  /**
   * The phone's shell, as a tool.
   *
   * It runs in the app's sandbox with its own 20-second ceiling, so a command
   * that hangs costs one turn rather than the session. Output comes back whole
   * — exit code included — because a model that cannot see why a command failed
   * will simply run it again.
   */
  const runCommand: AgentTool<typeof ShellArgs> = {
    name: "run_command",
    label: "Run command",
    description:
      "Run a shell command with /system/bin/sh inside this app's sandbox and return its output. " +
      "The shell is persistent: `cd`, `export` and variables carry over between calls, so `cd project-a` " +
      "followed by `ls` works. Each command has its own timeout (default 60s, pass timeoutMs for longer, up to 300s); " +
      "a command that runs past it is killed and the next call starts a fresh shell.",
    parameters: ShellArgs,
    execute: async (toolCallId: string, args: Static<typeof ShellArgs>) => {
      if (
        approve &&
        !(await approve({
          action: "run_command",
          toolCallId,
          toolName: "run_command",
          argsPreview: { command: args.command.slice(0, 400) },
        }))
      ) {
        return failure("permission denied: the user did not allow this command");
      }
      const result = await runShell(args.command, args.timeoutMs);
      const parts: string[] = [];
      if (result.output.trim()) parts.push(result.output.replace(/\s+$/, ""));
      parts.push(`(exit ${result.code}${result.truncated ? ", output trimmed" : ""} · ${result.cwd})`);
      if (result.error) parts.push(result.error);
      return result.code === 0 ? text(parts.join("\n")) : { ...text(parts.join("\n")), isError: true };
    },
  };

  /**
   * The in-app browser, as two tools: one to go somewhere, one to see what is
   * there. Splitting them matters — `open` returns as soon as the window is up,
   * and the page needs a moment before `read` has anything to say, so the model
   * can open a page, do something else, then read it.
   */
  const openBrowserTool: AgentTool<typeof BrowserArgs> = {
    name: "open_browser",
    label: "Open browser",
    description:
      "Open a URL in the app's built-in browser window on this phone. The reader sees the page; " +
      "you do not get its content from this call — use read_browser for the rendered text.",
    parameters: BrowserArgs,
    execute: async (_toolCallId: string, args: Static<typeof BrowserArgs>) => {
      const ok = await openBrowser(args.url);
      if (!ok) return failure("the in-app browser is not available on this device");
      return text(`opened ${args.url} in the in-app browser window`);
    },
  };

  const readBrowserTool: AgentTool<typeof EmptyArgs> = {
    name: "read_browser",
    label: "Read browser",
    description:
      "Read the page currently open in the in-app browser: its URL, title, and the text as rendered " +
      "(after its scripts ran). Empty text means the window is closed or the page has not finished loading.",
    parameters: EmptyArgs,
    execute: async () => {
      const page = await readBrowser();
      if (!page) return failure("the in-app browser is not available on this device");
      if (!page.open && !page.url) return failure("no browser window is open");
      const body = page.text.trim();
      return text(
        [
          `url: ${page.url}`,
          `title: ${page.title || "(none)"}`,
          "",
          body.length > MAX_FETCH_CHARS
            ? body.slice(0, MAX_FETCH_CHARS) + "\n…(truncated)"
            : body || "(the page has no readable text yet — it may still be loading)",
        ].join("\n"),
      );
    },
  };


  /**
   * The machines saved on the connections page. Same shell semantics as the
   * local one — `cd` sticks — but the commands run where the user's work is.
   */
  const sshRunTool: AgentTool<typeof SshArgs> = {
    name: "ssh_run",
    label: "Run on machine",
    description:
      "Run a shell command over SSH on one of the machines the user saved in 连接 (connections). " +
      "Pass the machine name as the user named it. The remote shell is persistent: `cd` and exported " +
      "variables carry over between calls. Returns the output, the exit status and the working directory.",
    parameters: SshArgs,
    execute: async (toolCallId: string, args: Static<typeof SshArgs>) => {
      const profile = await findSshProfile(args.machine);
      if (!profile) return failure(`no saved machine matches "${args.machine}"`);
      if (
        approve &&
        !(await approve({
          action: "run_command",
          toolCallId,
          toolName: "ssh_run",
          argsPreview: { machine: profile.name, command: args.command.slice(0, 400) },
        }))
      ) {
        return failure("permission denied: the user did not allow this command");
      }
      try {
        const result = await runSsh(profile.id, args.command, args.timeoutMs ?? 60_000);
        const parts: string[] = [];
        if (result.output.trim()) parts.push(result.output.replace(/\s+$/, ""));
        parts.push(
          `(exit ${result.exitStatus >= 0 ? result.exitStatus : "unknown"} · ${profile.name}${
            result.cwd ? ` · ${result.cwd}` : ""
          })`,
        );
        if (result.timedOut) parts.push("the command was still running when the time ran out");
        return result.exitStatus === 0
          ? text(parts.join("\n"))
          : { ...text(parts.join("\n")), isError: true };
      } catch (cause) {
        return failure(cause instanceof Error ? cause.message : String(cause));
      }
    },
  };

  return [
    listFiles,
    readFile,
    writeFile,
    fetchUrl,
    runCommand,
    sshRunTool,
    openBrowserTool,
    readBrowserTool,
    skill,
  ];
}
