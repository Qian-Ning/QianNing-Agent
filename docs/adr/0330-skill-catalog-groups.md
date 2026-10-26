# ADR 0330: Grouped skill catalog with a description budget

- Status: Accepted
- Date: 2026-10-26
- Related: `packages/agent-runtime/src/plugin-skills-prompt.ts`;
  `apps/desktop/electron/main/builtin-skills.ts`;
  [skill authoring](../spec/07-plugins/17-skill-authoring.md)

## Context

Skill bodies load on demand: the system prompt carries only one line per skill —
id, name, description — and the `Skill` tool pulls the document when the model
decides it applies. That mechanism works. The catalog itself was the weak part.

Eighty-three shipped skills meant eighty-three flat lines in every session's
prompt, roughly 2.2k tokens, of which a typical session needs zero to three.
One undifferentiated list of that size reads as noise: the model has no short
set of topics to scan, skims the block, and reaches for the document less often
than the task warrants. The same list is also where a bloated description costs
every session — the longest shipped description was 244 characters, the format
limit, for a document whose body already carries the detail.

Three gates already withheld skills a session could not use (plugin work without
a plugin workspace, image and video generation without a configured model). No
mechanism organised the entries that did remain.

## Decision

Give the model-facing catalog structure without changing what it contains.

- **Grouping is presentation, never filtering.** Every entry is still advertised;
  the renderer prints a `## <group>` heading before a group's entries and puts
  entries with no group in the flat list ahead of the headings. An entry under a
  heading is exactly as discoverable as one in the flat list.
- **Built-in skills carry a group; plugin and user skills do not.** The group
  table lives in `builtin-skills.ts` keyed by document file name. A newly added
  document that is not listed falls into `Other` — still advertised, never
  silently dropped — and the gating test reports it as a missing entry. The
  renderer therefore leaves third-party entries in their existing shape and
  order, so nothing owned by a plugin or a user changes.
- **A group heading is a section identity of its own.** The catalog section map
  gains `skill-group:<heading>` keys next to the existing `skill:<id>` keys. A
  heading is appended when its group first appears, is not re-sent while only
  its members change, and is revoked with `null` like any other section. The
  runtime digest includes `group`, so re-grouping a skill is a catalog change
  rather than a prompt that silently stays stale.
- **Order follows the renderer when groups exist.** The catalog renderer emits
  entries in reading order — ungrouped entries, then each heading followed by its
  members, groups by name, entries by id. System-transcript sync now takes that
  insertion order as the contract, because a sort by key name would separate
  every heading from the entries it introduces. Without a heading present, the
  historical id sort is kept, so callers that hand sections over unordered still
  compose the identical prompt.
- **Bundled descriptions stay within 120 characters.** The 240-character format
  limit stays where it is; this is a tighter budget for the shipped catalog,
  enforced by `builtin-skill-gating.test.mjs` and stated in the authoring spec.
  Fourteen documents were rewritten to fit.

## Consequences

The catalog costs about a kilobyte more raw characters for group headings, and
buys a nine-topic structure the model can scan before committing to a load. The
fourteen rewritten descriptions cut the total description payload by roughly
half a kilobyte and removed the one entry that sat at the format ceiling.

The rules are now mechanical: a new document without a group entry fails the
gating test, and a description over budget fails it too. Adding a group is a
one-line change to the table and needs no spec change; the authoring spec points
at the table rather than restating it.

Plugin and user skill catalogs are untouched in rendering, ordering and
advertisement, so this ADR changes no third-party contract. `PluginSkillDef`
gains an optional `group` field, which existing producers may ignore.

`system-transcript` keeps both paths: grouped catalogs follow insertion order,
ungrouped catalogs keep the id sort. A session that recorded its catalog before
this change reconstructs the same prompt it recorded.
