import type { AgentSidecar, LocalToolResult } from "./agent-sidecar.js";

/**
 * The model's write path into the user's own skill library, shared by every host.
 *
 * It lives with the sidecar rather than in one app because the runtime advertises
 * `SkillCreate` to whichever host it is embedded in — the desktop app and the
 * headless host both build the same tool catalogue — and a tool that is offered
 * but has no handler is worse than no tool at all. Each host supplies the one
 * thing that differs: how to reach host-core.
 *
 * The handler deliberately adds no storage of its own. It forwards to the same
 * `skills.create` host method the renderer's create action calls, so a skill the
 * model writes lands in exactly the state a user-authored one does, with the same
 * validation, slugging and listing. host-core owns the policy; this file
 * normalises arguments and reports the result in words a model can act on.
 *
 * host-core rejects a name that collides with an existing skill at the same
 * level, matching on id or on the name case-insensitively, so a retry after a
 * partial success fails loudly instead of quietly overwriting.
 */

export type SkillAuthoringToolDeps = {
  /** Create a user skill through host-core; resolves with the host's reply. */
  createUserSkill: (input: {
    name: string;
    description?: string;
    body: string;
  }) => Promise<unknown>;
};

function failure(content: string): LocalToolResult {
  return { ok: false, isError: true, content };
}

function text(raw: unknown, field: string): string {
  return String((raw as Record<string, unknown> | null)?.[field] ?? "").trim();
}

export function registerSkillAuthoringTools(
  sidecar: Pick<AgentSidecar, "setLocalTool">,
  deps: SkillAuthoringToolDeps,
): void {
  sidecar.setLocalTool("SkillCreate", async ({ args }) => {
    const name = text(args, "name");
    if (!name) {
      return failure("SkillCreate: `name` is required; it is the title shown in the skills list.");
    }
    const body = text(args, "body");
    if (!body) {
      return failure(
        "SkillCreate: `body` is required and is the part that pays off later; write it to stand alone.",
      );
    }
    const description = text(args, "description");
    try {
      const reply = await deps.createUserSkill({
        name,
        description: description || undefined,
        body,
      });
      const id = (reply as { skill?: { id?: string } } | undefined)?.skill?.id;
      return {
        ok: true,
        content: `SkillCreate: created ${id ? `\`${id}\`` : "the skill"}. It is listed under Skills and loads through the Skill tool.`,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return failure(`SkillCreate: ${detail}`);
    }
  });
}
