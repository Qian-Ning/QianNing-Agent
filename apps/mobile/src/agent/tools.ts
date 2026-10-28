/**
 * The tools the phone agent can actually use.
 *
 * This is the honest difference between the desktop and the phone: there is no
 * shell here, no `git`, no desktop filesystem. What a phone does have is network
 * access and its own storage, so that is what the agent gets — and the tool list
 * is the whole list, rather than a desktop list with half of it failing at
 * runtime.
 */

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentStore } from "./store";

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
const FetchArgs = Type.Object({
  url: Type.String({ minLength: 1 }),
  method: Type.Optional(Type.Union([Type.Literal("GET"), Type.Literal("POST")])),
  body: Type.Optional(Type.String()),
});

/**
 * `root` is the open project's folder prefix, or null at the storage root. A
 * path the agent passes is always relative to whatever the reader opened, so
 * "notes.md" in project A and in project B are different files.
 */
export function createTools(
  store: AgentStore,
  root: () => string | null = () => null,
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
    description: "Read a file previously written by this agent.",
    parameters: ReadArgs,
    execute: async (_toolCallId: string, args: Static<typeof ReadArgs>) => {
      const key = fileKey(resolve(args.path) ?? "");
      if (!key) return failure("invalid path");
      const content = store.readValue(key);
      return content === null ? failure("no such file: " + args.path) : text(content);
    },
  };

  const writeFile: AgentTool<typeof WriteArgs> = {
    name: "write_file",
    label: "Write file",
    description: "Write a text file into the app's own storage, replacing any existing file.",
    parameters: WriteArgs,
    execute: async (_toolCallId: string, args: Static<typeof WriteArgs>) => {
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
      _toolCallId: string,
      args: Static<typeof FetchArgs>,
      signal?: AbortSignal,
    ) => {
      if (!/^https?:\/\//i.test(args.url)) return failure("only http(s) URLs are allowed");
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

  return [listFiles, readFile, writeFile, fetchUrl];
}
