# QianNing Agent Docs

`docs/` is a VitePress project. The published site starts at [`index.md`](index.md);
the repository's English technical source of truth remains organized under
`spec/` and `adr/`.

## Local commands

```bash
pnpm docs:dev
pnpm docs:build
pnpm docs:preview
pnpm docs:check
```

## Layout notes

- `spec/` and `adr/` are the English source of truth; `zh-CN/` mirrors
  `spec/` and `guide/` path for path and is checked by `pnpm docs:check`.
- `image/` holds pictures embedded by the repository READMEs. `public/` holds
  assets served by the site itself (brand mark, screenshots).
- `project/` keeps historical planning records; current status lives in the
  changelog and GitHub Issues.

## Entry points

- [English documentation site](index.md)
- [中文入口](zh-CN/index.md)
- [QianNing brand contract](spec/01-qianning-brand.md)
- [Quick guide](guide/index.md)
- [Specification index](spec/README.md)
- [ADR index](adr/README.md)
- [Plugin development](plugin-development.md)
- [Visual verification](project/2026-08-13-docs-redesign-verification.md)

The Chinese entry point mirrors the English reading paths and includes a
path-for-path companion for every specification. Each translated page links to
the canonical English source and preserves code, protocol fields, and
identifiers. The generated sidebar keeps both locale trees complete as the
specification set grows.

Chinese pages are **condensed references, not full translations.** English is
normative (see [ADR 0009](adr/0009-english-first-globalization.md)), so a mirror
is expected to carry fewer sections than its source: `spec/03-runtime/
19-remote-agent-control-protocol.md` has 45 headings including its title and
`zh-CN/spec/03-runtime/19-remote-agent-control-protocol.md` has 8, by design.
What a Chinese page must get exactly right is what it claims to preserve —
protocol fields, method names, and error codes — so translation work belongs in
the accuracy of what the page already carries, not in expanding it to the
English section count.

Judge a mirror by whether its identifiers match the English, not by how many
headings it has. Reading a condensed mirror as an unfinished translation is the
easy mistake, and it has happened: every mirror states this contract in its own
opening paragraph, next to the English-source link, and none of the checks
treats a lower section count as a defect. `pnpm docs:check` enforces the parts a
machine can decide — mirror existence, the source notice, table shape,
code-fence counts, and terminology.
