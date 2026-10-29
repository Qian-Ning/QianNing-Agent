import { describe, expect, it } from "vitest";
import { MemoryStore } from "../agent/store";
import { ProjectBook, toProjectGroup, toProjectRecord } from "../agent/projects";
import { createTools } from "../agent/tools";
import { PhoneBridge } from "./desktop-bridge";

function bridge() {
  const store = new MemoryStore();
  const host = {
    send: async () => undefined,
    subscribe: () => () => undefined,
  };
  return new PhoneBridge({
    store,
    platform: "android",
    version: "2.2.0",
    host,
    now: () => 1_700_000_000_000,
  });
}

describe("ProjectBook", () => {
  it("creates a project as a folder in app storage and opens it", () => {
    const store = new MemoryStore();
    const projects = new ProjectBook(store);

    const created = projects.create({ name: "调研" });

    expect(created.folder).toBe("projects/调研");
    expect(projects.active()?.folder).toBe("projects/调研");
    expect(projects.list()).toHaveLength(1);
  });

  it("keeps two projects with the same name apart", () => {
    const projects = new ProjectBook(new MemoryStore());
    projects.create({ name: "notes" });
    const second = projects.create({ name: "notes" });
    expect(second.folder).toBe("projects/notes-2");
  });

  it("renames without moving the folder", () => {
    const projects = new ProjectBook(new MemoryStore());
    const created = projects.create({ name: "old" });
    const renamed = projects.rename(String(created.n), "new");
    expect(renamed.name).toBe("new");
    expect(renamed.folder).toBe(created.folder);
  });

  it("removes a project and clears it when it was open", () => {
    const projects = new ProjectBook(new MemoryStore());
    const created = projects.create({ name: "temp" });
    expect(projects.remove(created.folder)).toBe(true);
    expect(projects.active()).toBeNull();
  });

  it("survives a corrupted book instead of throwing", () => {
    const store = new MemoryStore();
    store.writeValue("qn.local.projects", "{not json");
    const projects = new ProjectBook(store);
    expect(projects.list()).toEqual([]);
  });
});

describe("project channels", () => {
  it("answers the sidebar with desktop-shaped rows", async () => {
    const api = bridge();
    await api.invoke("pi-desktop/project-group/create", { name: "写作", folders: ["手机存储"] });

    const listed = await api.invoke("pi-desktop/project/list");
    const projects = (listed as unknown as { data: { projects: Array<{ id: number; path: string; name: string }> } })
      .data.projects;

    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ id: 1, name: "写作", path: "projects/写作" });
  });

  it("offers app storage as the one folder a phone can pick", async () => {
    const api = bridge();
    const picked = await api.invoke("pi-desktop/project/pickFolders");
    expect((picked as unknown as { data: { folders: string[] } }).data.folders).toEqual(["手机存储"]);
  });

  it("opens a listed project by its path and reports it back", async () => {
    const api = bridge();
    const created = await api.invoke("pi-desktop/project-group/create", { name: "笔记" });
    const group = (created as unknown as { data: { group: { id: string; primaryPath: string } } }).data.group;

    const opened = await api.invoke("pi-desktop/project/openFolder", group.primaryPath);
    expect((opened as unknown as { data: { ok: boolean } }).data.ok).toBe(true);

    const got = await api.invoke("pi-desktop/project/get");
    const workspace = (got as unknown as { data: { workspace: { path: string; name: string } | null } })
      .data.workspace;
    expect(workspace).toEqual({ path: group.primaryPath, name: "笔记" });
  });

  it("activates a project from the bare path the renderer sends", async () => {
    const api = bridge();
    const created = await api.invoke("pi-desktop/project-group/create", { name: "写作" });
    const group = (created as unknown as { data: { group: { primaryPath: string } } }).data.group;

    const set = await api.invoke("pi-desktop/project/set", group.primaryPath);
    const workspace = (set as unknown as { data: { workspace: { path: string } | null } }).data.workspace;
    expect(workspace?.path).toBe(group.primaryPath);
  });

  it("keeps project notes beside the project", async () => {
    const api = bridge();
    const created = await api.invoke("pi-desktop/project-group/create", { name: "规范" });
    const group = (created as unknown as { data: { group: { primaryPath: string } } }).data.group;

    await api.invoke("pi-desktop/project/memory/save", {
      projectPath: group.primaryPath,
      entries: [{ id: "e1", title: "命名", content: "用全小写文件名" }],
    });
    const got = await api.invoke("pi-desktop/project/memory/get", { projectPath: group.primaryPath });
    const memory = (got as unknown as { data: { memory: { content: string } } }).data.memory;
    expect(memory.content).toContain("用全小写文件名");
  });

  it("opens the skill, mcp and subagent pages with empty catalogues", async () => {
    const api = bridge();
    const skills = await api.invoke("pi-desktop/skill/list");
    const mcp = await api.invoke("pi-desktop/mcp/list");
    const subagents = await api.invoke("pi-desktop/subagent/list");

    expect((skills as unknown as { ok: boolean }).ok).toBe(true);
    expect((skills as unknown as { data: { skills: unknown[] } }).data.skills).toEqual([]);
    expect((mcp as unknown as { data: { servers: unknown[]; statuses: unknown[] } }).data).toEqual({
      servers: [],
      statuses: [],
    });
    expect((subagents as unknown as { data: { subagents: unknown[] } }).data.subagents).toEqual([]);
  });

  it("treats a desktop-only surface as closed instead of failing", async () => {
    const api = bridge();
    const closed = await api.invoke("pi-desktop/plugin/view/close", { viewId: "x" });
    expect((closed as unknown as { ok: boolean }).ok).toBe(true);
  });

  it("clears the open project", async () => {
    const api = bridge();
    await api.invoke("pi-desktop/project-group/create", { name: "临时" });
    await api.invoke("pi-desktop/project/clear");
    const got = await api.invoke("pi-desktop/project/get");
    expect((got as unknown as { data: { workspace: unknown } }).data.workspace).toBeNull();
  });

  it("maps a project to the group shape the dialogs read", () => {
    const projects = new ProjectBook(new MemoryStore());
    const created = projects.create({ name: "分组" });
    const group = toProjectGroup(created);
    expect(group.id).toBe(created.folder);
    expect(group.roots).toHaveLength(1);
    expect(toProjectRecord(created).id).toBe(created.n);
  });
});

describe("file tools under an open project", () => {
  it("writes inside the project folder and lists only that project", async () => {
    const store = new MemoryStore();
    const projects = new ProjectBook(store);
    const first = projects.create({ name: "A" });

    const toolsA = createTools(store, () => projects.activeFolder());
    const write = toolsA.find((tool) => tool.name === "write_file")!;
    await write.execute("call-1", { path: "notes.md", content: "hello" });

    const second = projects.create({ name: "B" });
    const toolsB = createTools(store, () => projects.activeFolder());
    const listB = toolsB.find((tool) => tool.name === "list_files")!;
    const listed = await listB.execute("call-2", {} as never);
    expect((listed as { content: Array<{ text: string }> }).content[0].text).toBe("(no files yet)");

    projects.open(first.folder);
    const read = toolsA.find((tool) => tool.name === "read_file")!;
    const readBack = await read.execute("call-3", { path: "notes.md" });
    expect((readBack as { content: Array<{ text: string }> }).content[0].text).toBe("hello");
    expect(second.folder).toBe("projects/b");
  });

  it("refuses a path that climbs out of the project", async () => {
    const store = new MemoryStore();
    const projects = new ProjectBook(store);
    projects.create({ name: "safe" });
    const tools = createTools(store, () => projects.activeFolder());
    const read = tools.find((tool) => tool.name === "read_file")!;
    const result = await read.execute("call-4", { path: "../../etc/passwd" });
    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});
