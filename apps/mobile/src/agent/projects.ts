import type { AgentStore } from "./store";

/**
 * Projects on a phone.
 *
 * A desktop project is a folder on a disk the user can point at. A phone has no
 * disk to point at, so its projects live in the app's own storage — the same
 * place the agent's file tools already write. A project is therefore a named
 * folder prefix (`projects/<slug>`), and every file tool resolves against the
 * open project when there is one.
 */

const BOOK_KEY = "qn.local.projects";
const ACTIVE_KEY = "qn.local.projects.active";

export type PhoneProject = {
  /** Stable numeric id; the desktop sidebar keys projects by number. */
  n: number;
  name: string;
  /** Folder prefix inside app storage, never a filesystem path. */
  folder: string;
  pinned: boolean;
  createdAt: number;
  lastOpenedAt: number;
};

export type PhoneProjectInput = { name: string };

function slugify(name: string): string {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii.slice(0, 40) || "project";
}

export class ProjectBook {
  constructor(
    private readonly store: AgentStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  list(): PhoneProject[] {
    const raw = this.store.readValue(BOOK_KEY);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((entry): entry is PhoneProject => {
        if (typeof entry !== "object" || entry === null) return false;
        const row = entry as Partial<PhoneProject>;
        return typeof row.folder === "string" && typeof row.name === "string" && typeof row.n === "number";
      });
    } catch {
      // A corrupted book must not take the whole settings page down with it.
      return [];
    }
  }

  create(input: PhoneProjectInput): PhoneProject {
    const name = input.name.trim();
    if (!name) throw new Error("a project needs a name");
    const projects = this.list();
    const base = slugify(name);
    let folder = `projects/${base}`;
    let suffix = 2;
    const taken = new Set(projects.map((project) => project.folder));
    while (taken.has(folder)) {
      folder = `projects/${base}-${suffix}`;
      suffix += 1;
    }
    const at = this.now();
    const project: PhoneProject = {
      n: projects.reduce((max, row) => Math.max(max, row.n), 0) + 1,
      name,
      folder,
      pinned: false,
      createdAt: at,
      lastOpenedAt: at,
    };
    this.write([...projects, project]);
    this.setActive(project.folder);
    return project;
  }

  rename(idOrFolder: string, name: string): PhoneProject {
    const trimmed = name.trim();
    const projects = this.list();
    const index = projects.findIndex((project) => this.matches(project, idOrFolder));
    if (index < 0) throw new Error(`unknown project ${idOrFolder}`);
    if (!trimmed) throw new Error("a project needs a name");
    const next = { ...projects[index], name: trimmed };
    projects[index] = next;
    this.write(projects);
    return next;
  }

  remove(idOrFolder: string): boolean {
    const projects = this.list();
    const remaining = projects.filter((project) => !this.matches(project, idOrFolder));
    if (remaining.length === projects.length) return false;
    this.write(remaining);
    if (this.active() === null) this.store.writeValue(ACTIVE_KEY, "");
    return true;
  }

  /** Opens by folder path; the sidebar sends the path it lists. */
  open(folderPath: string): PhoneProject | null {
    const project = this.list().find((row) => this.matches(row, folderPath)) ?? null;
    if (!project) return null;
    this.setActive(project.folder);
    return project;
  }

  active(): PhoneProject | null {
    const folder = this.store.readValue(ACTIVE_KEY);
    if (!folder) return null;
    return this.list().find((row) => row.folder === folder) ?? null;
  }

  setActive(folder: string | null): void {
    this.store.writeValue(ACTIVE_KEY, folder ?? "");
  }

  /** Folder prefix the file tools resolve against, or null at the root. */
  activeFolder(): string | null {
    return this.active()?.folder ?? null;
  }

  private matches(project: PhoneProject, key: string): boolean {
    const trimmed = key.trim().replace(/^\/+/, "");
    return (
      project.folder === trimmed ||
      String(project.n) === trimmed ||
      project.name === key.trim()
    );
  }

  private write(projects: PhoneProject[]): void {
    this.store.writeValue(BOOK_KEY, JSON.stringify(projects));
  }
}

/** The workspace shape the renderer's `project/get` expects. */
export function toWorkspace(project: PhoneProject): { path: string; name: string } {
  return { path: project.folder, name: project.name };
}

/** The row shape the sidebar's project list expects. */
export function toProjectRecord(project: PhoneProject): {
  id: number;
  path: string;
  name: string;
  pinned: boolean;
  createdAt: number;
  lastOpenedAt: number;
} {
  return {
    id: project.n,
    path: project.folder,
    name: project.name,
    pinned: project.pinned,
    createdAt: project.createdAt,
    lastOpenedAt: project.lastOpenedAt,
  };
}

/** The group shape the project dialogs expect; one root per phone project. */
export function toProjectGroup(project: PhoneProject): {
  id: string;
  name: string;
  primaryPath: string;
  roots: Array<{ path: string; name: string; position: number }>;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  lastOpenedAt: number;
} {
  return {
    id: project.folder,
    name: project.name,
    primaryPath: project.folder,
    roots: [{ path: project.folder, name: project.name, position: 0 }],
    createdAt: project.createdAt,
    updatedAt: project.lastOpenedAt,
    pinned: project.pinned,
    lastOpenedAt: project.lastOpenedAt,
  };
}
