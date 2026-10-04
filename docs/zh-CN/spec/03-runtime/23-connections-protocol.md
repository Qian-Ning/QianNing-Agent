# 连接 协议

- 状态：目标规格；尚未实现
- 决策：D660 / ADR 0320，由 D661、D662 扩展
- 架构：`02-architecture/06-connections.md`
- 绑定：本地 stdio NDJSON JSON-RPC 传输（`01-ipc-protocol.md`、
  `06-host-rpc-protocol.md`）
- 线路版本：仍为 v11；本文新增方法与工具，不做协议版本升级
- 英文源规格：[英文源规格](/spec/03-runtime/23-connections-protocol)

## 1. 范围

本文是**连接**能力的名字、参数、结果、错误码、设闸与工具定义的规范来源。它定义：

- `connection.*` 方法域，分为面向智能体的一半与面向用户的一半；
- `Connection` 与 `Console` 两个智能体工具；
- 该域发出的错误码；以及
- 它写入的审计行。

它不定义第二条传输、第二套权限系统，也不做协议版本升级。这些方法走的是既有的
分发器、既有的错误信封、既有的设置 blob；新增的持久化记录是本次唯一的存储变更，
并作为一次 schema 迁移记录（`04-data-storage.md`）。

## 2. 配置资源

```jsonc
{
  "id": "0f5c…",                  // 稳定、不透明、由宿主生成
  "label": "build-box",           // 用户可见，同一宿主内唯一
  "kind": "ssh",                  // ssh | serial | telnet | raw-tcp
  "enabled": false,               // 逐目标开关，默认关
  "target": { … },                // 形状由 kind 决定，见 §2.1
  "credentialRef": "conn:0f5c…",  // 秘密库句柄，永不存放秘密本身
  "hostKeyPolicy": "strict",      // strict | accept-new | pinned
  "hostKeyFingerprint": null,     // hostKeyPolicy 为 "pinned" 时必填
  "multiplex": "per-call",        // per-call | multiplex，见 §7
  "limits": {
    "timeoutMs": 60000,
    "outputBytes": 262144,
    "streamBytes": 65536
  },
  "lastProbe": null               // 见 §3.1
}
```

`credentialRef` 会返回给面向用户的界面，以便界面能说「已配置凭据」，而在面向
智能体的结果里被整体略去。它指向的值，没有任何东西会返回。

### 2.1 按 kind 的 `target`

| kind | 字段 |
|---|---|
| `ssh` | `host`、`port`（默认 22）、`user`、`identityFile`、`proxyJump` |
| `serial` | `port`、`baud`（默认 115200）、`dataBits`（8）、`parity`（`none`）、`stopBits`（1）、`flow`（`none`） |
| `telnet` | `host`、`port`（默认 23） |
| `raw-tcp` | `host`、`port` |

`identityFile` 是路径，不是秘密；它存在配置里，可以返回给面向用户的界面。登录
口令是秘密，存在秘密库里，由 `credentialRef` 指向。

## 3. 面向智能体的方法

这是 `tools.execute` 通路与智能体工具唯一能触及的 `connection.*` 方法。每一个都
受 §8 设闸。

| 方法 | 幂等 | 含义 |
|---|---|---|
| `connection.list` | 是 | 已启用的配置，只有 id 与标签，带 kind 与最近探测状态 |
| `connection.probe` | 是 | 连接、认证、校验主机密钥、断开；记录 `lastProbe` |
| `connection.exec` | 否 | 在配置上执行一条命令并返回其结果 |
| `connection.read` | 是 | 从目标读一个文件到结果预算内 |
| `connection.write` | 否 | 往目标写一个文件 |
| `connection.upload` | 否 | 把本地文件拷到目标 |
| `connection.download` | 否 | 把目标文件拷到本地 scratch 目录 |
| `connection.stat` | 是 | 目标路径的存在性、大小与修改时间 |

`read`、`write`、`upload`、`download`、`stat` 属于增量 R2；在 R2 落地之前，它们
**根本不出现在方法表里**，因此调用者拿到的是分发器的未知方法错误，而不会学到
一个不存在的方法。

### 3.1 `connection.probe`

```jsonc
// 请求
{ "id": "p1", "method": "connection.probe", "params": { "profileId": "0f5c…" } }

// 结果
{ "id": "p1", "result": {
    "ok": true,
    "durationMs": 412,
    "hostKey": { "algorithm": "ssh-ed25519", "fingerprint": "SHA256:…", "known": true },
    "multiplexed": false
} }
```

探测是产生主机密钥判定的那个操作。它的结果始终带上对方出示的指纹、该指纹是否
已知，以及**是否真的**拿到了共享连接。`lastProbe` 是最近一次尝试（无论成败）的
持久化摘要。

### 3.2 `connection.exec`

```jsonc
// 请求
{ "id": "e1", "method": "connection.exec", "params": {
    "profileId": "0f5c…",
    "command": "systemctl --user restart build-agent",
    "timeoutMs": 60000
} }

// 结果
{ "id": "e1", "result": {
    "ok": true,
    "exitCode": 0,
    "stdout": "…",
    "stderr": "…",
    "truncated": false,
    "durationMs": 1203
} }
```

规则：

1. `command` 在目标自己的登录 shell 里执行。没有会话、调用之间不保留工作目录、
   没有 shell 状态可继承 —— 与本地 `Bash` 工具完全相同的契约。
2. `timeoutMs` 被夹到配置限额与宿主上限之间。超时是 `1035` 拒绝，不是退出码。
3. 预算见 §11。被截断的流把 `truncated` 置位，并以与本地工具相同的标记指出溢出
   文件。
4. 非零 `exitCode` **不是**错误，它就是答案。
5. 对没有 `exec` 能力的传输执行 `exec` 是 `1037`，在尝试连接**之前**就判定。
6. 发起它的轮次被中止时，spawn 出去的进程树被终止，走的是终止本地命令的同一条
   路径。

### 3.3 结果与面向智能体的脱敏

面向智能体的结果永不包含 `credentialRef`、永不包含秘密库的内容、永不包含
`target` 中非公开字段以外的内容。`connection.list` 返回：

```jsonc
{ "id": "l1", "result": { "profiles": [
    { "id": "0f5c…", "label": "build-box", "kind": "ssh",
      "lastProbe": { "ok": true, "at": "2026-10-04T12:31:07Z" } }
] } }
```

## 4. 面向用户的方法

这些服务于 `连接` 目的地与设置卡片。它们不能从智能体工具面到达，且 §8 的设闸
开关**不关闭它们**，因为正是它们让人能够打开那个开关。

| 方法 | 含义 |
|---|---|
| `connection.profiles` | 全部配置，含已禁用的，凭据引用以「是否已配置」的布尔值给出 |
| `connection.create` | 创建配置；按 kind 校验，标签重复即拒绝 |
| `connection.update` | 编辑配置；秘密不属于它，因为 `connection.setCredential` 是唯一写入秘密的通路 |
| `connection.delete` | 删除配置及其秘密；幂等 |
| `connection.setEnabled` | 翻转某条配置的开关 |
| `connection.setCredential` | 把秘密写入该配置引用下的秘密库 |
| `connection.clearCredential` | 删除已存的秘密 |
| `connection.acceptHostKey` | 记录一个人在主机密钥未知或变更时接受的指纹，并把策略置为 `pinned` |
| `connection.activity` | 某条配置最近的审计行，倒序，有界 |

以上每一个都由审计轨迹（§10）记录，并带上行为主体。它们照旧受 host-core 的普通
权限与角色规则约束；不能改动宿主状态的角色就不能创建配置。

`connection.create` 与 `connection.update` 在写入前校验整条记录：按 kind 的目标
字段、端口范围、波特率是否属于已知集合、标签长度与唯一性，以及
`hostKeyPolicy` 与指纹的配对。`pinned` 策略而没有指纹是校验拒绝，而不是先存下来
再在以后失败。

## 5. `Connection` 工具

一个带 `action` 字段的工具，沿用 `Computer` 先例。

```jsonc
{
  "name": "Connection",
  "description": "…",
  "risk": "high",
  "parameters": {
    "type": "object",
    "properties": {
      "action":   { "type": "string" },
      "profile":  { "type": "string" },
      "command":  { "type": "string" },
      "path":     { "type": "string" },
      "content":  { "type": "string" },
      "localPath":{ "type": "string" },
      "timeoutMs":{ "type": "number" }
    },
    "required": ["action"]
  }
}
```

| `action` | 必填 | 分发到 |
|---|---|---|
| `list` | — | `connection.list` |
| `probe` | `profile` | `connection.probe` |
| `exec` | `profile`、`command` | `connection.exec` |
| `read` | `profile`、`path` | `connection.read` |
| `write` | `profile`、`path`、`content` | `connection.write` |
| `upload` | `profile`、`localPath`、`path` | `connection.upload` |
| `download` | `profile`、`path`、`localPath` | `connection.download` |
| `stat` | `profile`、`path` | `connection.stat` |

`localPath` 只在会话工作区与 scratch 目录之内解析；两处之外按本地 `Read` 与
`Write` 工具的同一条规则拒绝。未知 `action` 是 `INVALID_PARAMS`，由方法与工具
共用的同一个解析器判定。

## 6. `Console` 工具

增量 R4。它只持有一条有状态的字节流。

| `action` | 必填 | 含义 |
|---|---|---|
| `open` | `profile` | 打开一条流，返回 `streamId` 与环形缓冲当前内容 |
| `send` | `streamId`、`content` | 往流里写字节，可选终止符 |
| `recv` | `streamId` | 返回上次 `recv` 之后收到的字节，带序号区间 |
| `close` | `streamId` | 关闭流；幂等 |

`recv` 报出序号区间，因此调用者能把「什么都没来」与「环形缓冲溢出、字节被丢弃」
区分开。环形缓冲由配置的 `streamBytes` 界定；落出去的部分报成空档，绝不静默。

一条流归打开它的那个会话所有，并在下列时刻关闭：会话被销毁、配置被禁用、全局
开关被关掉、宿主关闭。它永不隐式重开。

## 7. 传输选项

### 7.1 复用

`multiplex` 默认为 `per-call`：每一次 `exec`、`probe` 与传输都是自己一条连接。
`multiplex` 要求共享连接（spawn 的 `ssh` 上的 `ControlMaster`）。它**不是**默认
值，协议也从不假设它，因为 `OpenSSH_for_Windows` 不实现它。只有当共享连接**真的**
建立起来时，探测才报 `multiplexed: true`；一个要求在无法支持的平台上复用的配置，
其行为等同 `per-call`，并在探测结果里如实说明，而不是失败。

### 7.2 主机密钥策略

| 策略 | 未知密钥 | 变更密钥 |
|---|---|---|
| `strict` | 拒绝，`1033`，返回指纹 | 拒绝，`1033`，须由人处理 |
| `accept-new` | 接受并记录 | 拒绝，`1033`，须由人处理 |
| `pinned` | 与固定指纹不符即拒绝 | 拒绝，`1033`，须由人处理 |

任何策略下，变更的密钥都**永不**被方法调用接受。清除它是在目的地里的人工行为。

### 7.3 端口转发

增量 R3。配置可以带转发定义。监听者是 spawn 出来的 `ssh -N` 子进程；host-core
不打开监听套接字，且 `02-architecture/06-connections.md` §12 中「host-core 不
绑定网络端口」这一条验收标准在转发活跃期间同样成立。

## 8. 设闸

一个判定，在三处读取（D659）：

```text
allowed(profileId) =
    settings.remoteControlEnabled == true
    && profile.enabled == true
```

| 门 | 关闭时的拒绝 |
|---|---|
| 面向智能体的方法 | `1029 CONNECTION_DISABLED`（全局）或 `1031 CONNECTION_PROFILE_DISABLED`（配置），在做任何传输工作之前 |
| `tools.list` | `Connection` 与 `Console` 两个工具整体撤下 |
| `tools.execute` | 即使模型握着上一轮拿到的定义也拒绝 |

必须一致的是方法注册表与工具注册表两处，规则是**列表判定与执行判定是同一个
函数**。D659 记录的那类缺陷 —— 模型在前一轮见过某工具，于是仍然握着它的定义 ——
在这里一模一样地成立。

面向智能体的每个方法都在开关之后，没有只读豁免：`connection.list` 是调用方获知
清单的途径，`connection.probe` 会建立连接并认证。任何仍然放行这两者的「关闭」，
都等于允许调用方枚举用户的主机、并让本机拨出去。面向用户的方法不受门控，因为
看到目标正是用户决定开启它的依据 —— 有一个刻意的例外：目的地里的「探测」按钮
调用的就是 `connection.probe` 本身，因为探测要拨号，而拨号正是全局开关管的事。
门在宿主里读，界面绕不过去；开关关着时按钮是禁用的，即便真的发出请求也会以
`1029` 被拒绝。

## 9. 错误码

| 码 | Slug | 可重试 | 含义 |
|---|---|---|---|
| 1029 | `CONNECTION_DISABLED` | 否 | 全局开关关闭；什么都没发出去 |
| 1030 | `CONNECTION_NOT_FOUND` | 否 | 没有这个 id 的配置 |
| 1031 | `CONNECTION_PROFILE_DISABLED` | 否 | 该配置自己的开关关闭；`details.profile` 指出是哪条 |
| 1032 | `CONNECTION_UNREACHABLE` | 是 | 目标不可达；`details.reason` 指出是哪个阶段 |
| 1033 | `CONNECTION_HOST_KEY` | 否 | 主机密钥未知或已变更；`details.fingerprint` 与 `details.kind`（`unknown` 或 `changed`） |
| 1034 | `CONNECTION_AUTH_FAILED` | 否 | 目标拒绝了凭据 |
| 1035 | `CONNECTION_TIMEOUT` | 是 | 操作超出超时 |
| 1036 | `CONNECTION_UNSUPPORTED` | 否 | 该传输种类在这里没有实现，或所需的程序不存在 |
| 1037 | `CONNECTION_NO_EXEC` | 否 | 该传输没有命令通道；请用 `Console` |

本表中每一个码都成立的规则：

1. **载荷与 slug 并列，不替换。** 任何携带 `details.profile`、`details.reason`、
   `details.fingerprint` 或 `details.kind` 的码，同时也携带 `details.errorCode`
   及其自己的 slug。这是 D659 后续记录的那次修正：一个替换了 slug 的载荷字段，
   让同一次失败在两扇门上给出了两个不同的码。
2. 非零的远端退出码不在本表内，它是结果数据。
3. `1029` 与 `1031` 是用户决定，不是宿主或平台限制；对应开关打开后，同一个调用
   就会成功。

## 10. 审计

每一次面向智能体的调用与每一次配置改动都写一行审计：

```jsonc
{
  "at": "2026-10-04T12:31:07Z",
  "principal": "local-user",
  "profileId": "0f5c…",
  "label": "build-box",
  "action": "exec",
  "outcome": "ok",
  "exitCode": 0,
  "bytes": 1284,
  "durationMs": 1203
}
```

审计行永不包含凭据、秘密库的值，或被归类为秘密的命令参数。`connection.activity`
返回某条配置的这些行，倒序、有界，目的地渲染它们。

无论调用成功还是失败都写这一行，§8 的闸门拒绝也包括在内，因此「开关关着时智能体
曾试图访问某台主机」这件事本身也是可见的。

## 11. 结果预算与溢出

`exec` 复用本地命令的预算对：stdout 留头、stderr 留尾，超出预算的流转以本地工具
写入的同一个标记截断，溢出落到本地 scratch 目录下的一个文件中，并在标记里点名。
`read` 与 `download` 复用读取预算。

配置的 `limits.outputBytes` 可以调低宿主上限，**永远不能调高**。生效预算是两者的
较小值；当它与宿主默认值不同时，结果里会报出来，因此拿到比预期更少的调用者知道
原因。

## 12. 一致性要求

本文档的绑定或实现必须：

1. 暴露相同的方法名、参数与结果字段；
2. 发出 §9 的码，并遵守 §9.1 的载荷规则；
3. 在列表门与执行门施加**同一个** §8 判定，并通过在两种开关状态下调用两扇门来
   验证；
4. 在尝试连接之前拒绝传输层服务不了的动作；
5. 对成功与失败两种结果都写审计行；
6. 每次探测都返回指纹，且任何方法调用都不接受变更的主机密钥；
7. 保持线路协议版本不变。
