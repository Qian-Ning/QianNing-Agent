import { Type } from "@earendil-works/pi-ai";

/**
 * The write half of the skill system: a procedure worth keeping becomes a user
 * skill instead of being re-derived next session.
 *
 * The model-facing contract is deliberately three fields. The id is derived by
 * host-core from `name`, and level, scope and activation are not the model's to
 * choose — a skill the model writes belongs to the user and is on by default,
 * which is the same state the renderer's own create action produces.
 *
 * The wording invites use without overselling: a skill is worth writing when the
 * procedure is repeatable and not already covered, and the body is the part that
 * pays off later, so the description says what belongs in it.
 */
export const skillCreateDescription =
  "Save a repeatable procedure as a user skill so later sessions can load it instead of re-deriving it. " +
  "Use it when you have worked out an approach with more than one step that the user will plausibly need again, " +
  "and skip it for a one-off task or something an existing skill already covers. " +
  "`name` is the short title shown in the skills list; `description` is one line saying when the skill applies; " +
  "`body` is the full instructions in markdown and is the part that pays off later, so write it to stand alone. " +
  "Creating a skill that already exists fails; read the existing skills first and choose a distinct name.";

export const skillCreateParameters = {
  name: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
  body: Type.String({ minLength: 1, maxLength: 200000 }),
};
