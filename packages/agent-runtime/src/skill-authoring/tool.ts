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
  "A name is capped at 120 characters and a description at 240 - over that the host clips and truncates, so a longer one is written and then silently shortened. " +
  "The document itself is capped at 131072 bytes, which for non-ASCII text arrives far sooner than a character count suggests. " +
  "Creating a skill that already exists fails; read the existing skills first and choose a distinct name.";

/**
 * The caps mirror the enforcement constants, and the test beside this file reads both
 * sides and asserts they are equal, so neither can move alone.
 *
 * `name` and `description` are `MAX_NAME_CHARS` (user_skills.rs) and
 * `MAX_SKILL_DESCRIPTION_CHARS` (plugin-runtime.ts). host-core clips an over-long
 * name and the runtime truncates an over-long description, so advertising more than
 * the cap does not buy the model a longer field - it buys it a field shortened after
 * the fact.
 *
 * `body` is the subtle one. The cap is `MAX_SKILL_BYTES` (128 KiB) measured in
 * BYTES, while `maxLength` counts CHARACTERS, so the character budget has to be the
 * byte cap divided by the widest UTF-8 encoding (four bytes). Sizing it any larger
 * lets the model write a document that satisfies the schema and then fails with
 * `SKILL_INVALID: document exceeds 131072 bytes` - the error host-core raises for a
 * document over the cap.
 */
export const skillCreateParameters = {
  name: Type.String({ minLength: 1, maxLength: 120 }),
  description: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
  body: Type.String({ minLength: 1, maxLength: 32768 }),
};
