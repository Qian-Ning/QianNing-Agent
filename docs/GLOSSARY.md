# Terminology glossary

QianNing Agent is Chinese-first: `docs/zh-CN/spec` is what our own readers and
contributors actually read. This file fixes the terms that matter, so a
translator — human or model — stops re-deciding them per page.

The count column is measured in this tree, not assumed. Where two forms exist,
the count says which one is established.

| English | 中文 | 本仓库既有用法（出现次数） | 备注 |
| --- | --- | --- | --- |
| `main process` | 主进程 | 168 | 从不写作「主要」 |
| `renderer` | 渲染器 | 594 |  |
| `host core, host` | 主机、Rust 主机 | 932 |  |
| `sidecar` | sidecar | 258 | 保留英文，不译 |
| `session` | 会话 | 2803 |  |
| `turn` | 回合 | 888 | 不写作「轮次」 |
| `transcript（对话转写）` | 转录 | 425 |  |
| `transcribe（语音转写）` | 转写 | 8 | 仅语音域；与「转录」是两个词两个意思 |
| `outbox` | outbox | 82 | 常与「持久化」连用：持久化 outbox |
| `deadline, timeout` | 超时 | 165 | 不写作「死线」 |
| `budget` | 预算 | 233 |  |
| `snapshot` | 快照 | 239 |  |
| `workspace` | 工作区 | 564 |  |
| `project` | 项目 | 1451 |  |
| `primary（folder）` | 主文件夹、primary | 35 / 68 | 两种并存，指同一概念时择一 |
| `archive` | 归档 | 119 |  |
| `envelope（IPC）` | 消息封套 | 封套 0／信封 13 | 「信封」指纸信封，协议语境不要用 |

## Enforced rules

`docs/scripts/check-locales.mjs` fails the docs check on the decidable
mistranslations only, so a hit is always a defect rather than a style opinion:

- `Electron 主要` — the English source reads "Electron main" (the main process);
  write `Electron 主进程`. `主要` means "mainly", which is a different sentence.

Everything else above is guidance, not a gate: the remaining drift is
stylistic, and a rule that can match a legitimate sentence makes the gate
noise that people learn to ignore.

## Adding a rule

Add a rule only when the English source and the Chinese disagree about a fact,
and only when no legitimate Chinese sentence can contain the banned form. Add
the term to the table above in the same change, and extend
`docs/scripts/check-locales.test.mjs`.
