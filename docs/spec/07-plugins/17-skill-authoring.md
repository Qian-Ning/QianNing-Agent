# 17. Skill Authoring

> Status: Implemented as described; every limit and rule below is quoted from the
> running code, and §10 names the file that enforces it.
> Scope: the skill document format. Marketplace entry metadata is specified in
> [07-plugin-marketplace.md](07-plugin-marketplace.md).

## 1. Purpose and scope

A **skill** is a markdown document — optional YAML frontmatter over an
instruction body — that teaches the agent how to do something. It is the one
extension surface a user can author without writing code, and it is the surface
the agent reads at the moment a task matches it.

This document specifies the **document format**: where a document may live, what
the frontmatter fields mean, what limits apply, what the host guarantees when it
writes a document back, and which rules are enforced mechanically. It does not
specify the market catalog ([07-plugin-marketplace.md](07-plugin-marketplace.md))
or the extension API ([16-trusted-extensions.md](16-trusted-extensions.md)).

Three consumers read this format, and they are deliberately not identical:

| Consumer | Role |
|---|---|
| **host-core** (`user_skills.rs`) | The authority. Discovers, validates, and writes documents. |
| **Desktop plugin runtime** | Renders the catalog entry the model sees, including truncation. |
| **Skill importer** | Scans an external tree and reports candidates with warnings. |

## 2. Where a document may live

A skill document is one of two shapes. Both are supported, and the difference is
whether the skill ships sibling resources.

| Root | Shape | Id derivation |
|---|---|---|
| Bundled resources, shipped with the build | One `*.md` file per skill, directly in the directory | `qianning/<file name without extension>` |
| User and imported skills | Either a loose `*.md`, or `<skill-name>/SKILL.md` | From the document's `name` (§4.1) |

Two rules about the directory shape:

- **The directory is the unit of a move**, not the document, because a skill may
  ship sibling resources next to its `SKILL.md`.
- A loose `SKILL.md` sitting **directly** in a skills directory is **not** the
  directory shape. Its parent is the skills directory itself, and treating that as
  the skill's directory would move every skill at once. It is handled as a loose
  document.

The bundled root derives ids from file names rather than from frontmatter, so a
file cannot be silently dead for lack of an entry and a removed file cannot leave a
dangling reference. Three bundled ids are pinned by an explicit override table
because they predate the file-name rule and already appear in stored transcripts;
renaming one would break a reference that already exists. **A pinned id is a
compatibility commitment, not a preference.**

## 3. The document

```markdown
---
name: Short technical name
description: Trigger condition, not a summary
---

Body instructions in markdown.
```

The frontmatter block is optional. A document without one is a valid skill: it
takes its display name from the file path (§4.1) and the whole text is the body.

When the host writes a document back, it writes exactly this shape:

```
---\nname: <name>\n---\n\n<body>
```

## 4. Frontmatter fields

### 4.1 `name`

| Property | Value |
|---|---|
| Required | **Yes.** Absent and empty both fail with `SKILL_INVALID: the file needs a name`. |
| Maximum | **120 characters** (`MAX_NAME_CHARS`). |
| Over the maximum | **Clipped**, not rejected. |
| Fallback | The document's path stem, when the field is absent but the path yields one. |
| Non-ASCII | **Permitted.** Chinese and other non-ASCII titles are expected; a frontmatter name is frequently not ASCII. |

The display name is the **only** field the id is derived from. The id is computed
from the name, the path, and a 64-character budget; where that derivation cannot
produce a valid id, it falls back to the skill directory and then to a hash
(`capability_id`). Ids that collide are dropped rather than renamed, so two
documents claiming the same name do not both load.

### 4.2 `description`

| Property | Value |
|---|---|
| Required | **No**, by host-core. An empty description does not fail discovery. |
| Truncated at | **240 characters** (`MAX_SKILL_DESCRIPTION_CHARS`), with a trailing `…`. |
| Required by | The **importer**, which warns `frontmatter missing description`. |

Write the description as a **trigger condition** — the situation in which this
skill applies — not as a summary of the body. It is the text the model uses to
decide whether to load the document at all, so a description that reads like a
table of contents is a description that never matches.

### 4.3 `version`

`version` is an **entry field of the market catalog** (`SkillCatalogEntry`). It is
**not consumed by host-core**: no code reads it after a document is installed, and
it does not bind an installed document to a revision. A document may carry one, and
it will be carried through a rename unchanged, but nothing enforces its meaning.

**This is deliberate and is stated here so that no one assumes a guarantee that
does not exist.** Where a change must reach an installed skill, the market updates
the document; where a user must pin a revision, that is a catalog concern, not a
frontmatter one.

### 4.4 Unknown keys

Unknown top-level keys are **dropped** when the host renders a document. A rename
does not drop them (§7); a render does. Do not encode anything load-bearing in a
key outside this specification, because a round trip through the renderer will
silently remove it.

### 4.5 Nested keys

Indented lines are **not parsed as fields**. They do not become entries in the
field map, and they are counted as the continuation of a block scalar rather than
as a nested structure. A `metadata:` subtree is therefore carried as text and is
**not** addressable as `metadata.author` by any reader. Keep every field that a
reader must see at the top level, unindented.

## 5. Parsing rules

The parser is deliberately lenient at the edges and strict in the middle. The
lenient cases exist to protect a document from being corrupted by a rewrite, not
because they are good style.

| Input | Result |
|---|---|
| Leading byte order mark | **Stripped** before anything else. |
| Opener `---`, then any rest-of-line whitespace | **Accepted.** `---`, `--- ` and `---\r` all open a block. |
| Opener `---x` | **Not** frontmatter. The text is the body. |
| An unterminated block | **Not** frontmatter. The text is the body, and the host writes a fresh, complete block above it. |
| A line that is only `---` after trimming | **Terminator.** Everything after it is the body. |
| Blank lines inside the block | Skipped. |
| Lines beginning `#` | Skipped. YAML comments are not fields. |
| A line with no `:` | Skipped. |
| Indented lines | Skipped as fields; treated as block-scalar content. |
| A duplicate key | **The last occurrence wins**, because the block is read into a map. |

The last rule has a direct consequence for authors: **a second `name:` line
silently overrides the first.** The host's rename path handles this by dropping
later occurrences rather than preserving them, since keeping a stale one would let
the document keep its old display name while the rename claimed to have changed it.

## 6. Limits

| Limit | Value | Constant |
|---|---|---|
| Document size | **128 KiB** (131,072 bytes) | `MAX_SKILL_BYTES` |
| `name` length | **120 characters** | `MAX_NAME_CHARS` |
| `description` length | **240 characters** | `MAX_SKILL_DESCRIPTION_CHARS` |
| Id length | **64 characters** | `capability_id(…, 64)` |
| Id pattern | `^[a-z0-9][a-z0-9-]{0,63}$` | `SKILL_ID` |

The size limit is the one that fails loudly: a document over it is rejected by
host-core rather than truncated, because truncating an instruction document would
silently remove the part that matters. The name and description limits are
cosmetic and are clipped instead.

## 7. What a write-back preserves

This is the guarantee that matters when the host touches a document the user
authored, and it is narrower than it may appear:

- **A rename rewrites only the `name` line.** Every other line — extra fields,
  whitespace, line endings, the body — is copied through **byte for byte**. A
  move that has to change the display name must not reformat the document, because
  a render normalizes prose, drops unknown keys, and re-indents the body, which
  would silently edit a file the user only asked to relocate.
- **When there is existing frontmatter**, the new `name:` line is emitted at the
  position of the first `name:` line, or immediately before the terminator when
  there was none. A later `name:` line is dropped (§5).
- **When there is no usable frontmatter** — absent, or an unterminated opener — a
  fresh block is written above the text.
- **A render is not a rename.** Only the render drops unknown keys and normalizes
  whitespace. A caller that wants preservation must take the rename path.

## 8. Required conventions in this repository

These are project policy rather than format rules, and they are enforced (§10):

- **Every bundled skill document carries an `## Origin` section** opening with
  `QianNing Agent`, and no bundled document names an upstream product.
- **`name` is the short technical name**, because the model reads it and a shorter
  name costs less context. Brand identity is carried by the **id**, which doubles
  as the slash-command name and is the user-visible surface.
- **`description` is the trigger condition**, and it is bounded by §4.2.
- **The body ends with its own final instruction**, not with a promise of further
  work or a sentence that describes the document.

## 9. Editing an existing document

- **Changing `name` changes the derived id** unless the id is pinned (§2). An
  installed skill whose name changes may therefore load under a different id, and
  the old id stops resolving. Where a reference already exists, pin the id.
- **Never reorder frontmatter to tidy it.** Field order is not semantic, and a
  reorder makes a diff that hides the change that mattered.
- **A description change is a behavior change.** It is what the model matches on,
  so it moves which tasks load the document. Treat it as a change to be reviewed,
  not as copy editing.
- **Keep the body one document.** A skill that links to five fragments is a skill
  whose fragments are loaded without their context, and the agent reads what it
  was pointed at.

## 10. Enforcement

Each rule below is checked by the file named beside it. A rule that is not in this
table is a convention followed by people, not a guarantee.

| Rule | Enforced by |
|---|---|
| Origin section present, upstream name absent (§8) | `scripts/check-skill-provenance.mjs`, run by `.github/workflows/skills-check.yml` |
| Limits match this document (§6) | `scripts/check-skill-authoring-spec.mjs`, same workflow, separate job |
| Spec exists in both locales | same check |
| Discovery finds every bundled document | `apps/desktop/test/builtin-skill-discovery.test.mjs` |
| Name required, clipping, id derivation, rename preservation | `crates/host-core/src/user_skills/tests.rs`, `crates/host-core/src/agent_capabilities/tests.rs` |
| Importer warnings for missing fields | `apps/desktop/electron/test/agent-skill-scan.test.mjs` |

## 11. Authoring checklist

- Does it have a `name` at the top level, unindented, within 120 characters?
- Is the `description` a trigger condition rather than a summary?
- Is `name` short, because the model pays for it on every turn?
- Is the id the identity, and is it pinned if a reference already exists?
- Is every field a reader needs at the top level, not indented under a subtree?
- Are there two `name:` lines, where only the last one will be read?
- Is the document under 128 KiB, and would it still be usable if it were not?
- Does the body end with an instruction rather than a description of itself?
- Is there an `## Origin` section, and does the document name no upstream product?
- Does the document still make sense read alone, with no sibling file beside it?
