# 视频生成

> **翻译说明：** 本页是与 [英文源规格](/spec/03-runtime/24-video-generation) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。

桌面端把 `AppSettings.videoGeneration` 作为当前的默认视频生成绑定对外暴露，并把 `AppSettings.videoGenerationModels` 作为"标记为生视频"的可选模型列表。当前绑定为 null 或为空即表示没有默认值；host-core 通过既有的 settings 存储校验并持久化这两个字段，无需升级 schema，而生图相关字段保有各自含义：把一个模型标记为生视频并不会把它标记为生图，两份候选列表互相独立。引用已不存在的服务商行的引用不会被持久化：host-core 在每次 settings 读写时都会丢弃当前绑定和对应的候选，这与 config sync 套用 bundle 时执行的引用规则一致，因此被删除的服务商不会留下一个运行时必须拒绝的默认值。每个候选都引用一个已启用的 API-key 或 no-auth 服务商及其已配置模型中的一个；最多存储 64 个候选。id 中带有生图或生视频家族名的模型，会在应用第一次见到它时被自动标记，这样工作台无需用户先去找能力勾选框就有东西可选：检测表位于 `packages/shared/src/generation-capability.ts`，对短词或有歧义的词只做整段匹配，因此 `imagen-4.0-generate` 会被判为生图模型而不是 Runway 的 `gen-4`。只有当某项能力的列表从未被写过时才会做种子填充 —— 已存在的列表（包括空列表）绝不覆盖 —— 并且跳过已停用的服务商与 OAuth 账号，因为两者都无法渲染。

## 配置

`videoGeneration` 接受一个 `{providerId, modelId}` 绑定，两个值都非空（provider 最多 128 字符，model 最多 256）。`videoGenerationModels` 最多接受 64 个这样的绑定，存在时必须是数组；形状错误的绑定、非数组列表或超长列表都会在写入任何内容之前以 `INVALID_PARAMS` 拒绝，因此一次被拒绝的保存会完整保留先前的设置。config sync 在套用 bundle 时会针对已存在的服务商行校验这两个键，并把它们列在 video 域中，因此导入的 bundle 无法引用本机不存在的服务商。

选择、修改和清空该绑定与任何其他 settings 写入相同；运行时按调用读取该绑定而不做缓存，因此改动会在下一次 `GenerateVideos` 调用时生效，无需重启。若绑定的服务商存在但已停用、属于 OAuth 账号或不带凭据，不会被静默修复：该调用会以下面对应的 `VIDEO_*` 错误码失败，且已存储的绑定保持不变，因为只有用户才能决定是重新启用服务商、补一个密钥还是换一个模型。

## Agent 契约

`GenerateVideos({items: [{prompt, image?, lastFrame?, count?, durationSeconds?, size?}]})` 是一个 Agent 模式工具。`items` 接受 1–8 项；`count` 默认为 1 并接受 1–8，展开后的批次总量上限为 8 个视频，因此 `count` 与条目数相乘也不会越过上限。`prompt` 会被 trim 并限制在 32,000 字符内。`durationSeconds` 接受 1 到 15 的整数，且仅在存在时发送，因为服务商按秒计费。`size` 接受每边 2 到 5 位数字的 `WIDTHxHEIGHT` 字符串，且仅在存在时发送；否则套用模型自身的默认值。`image` 是一个本地路径，用作片段的**首帧**；`lastFrame` 是一个本地路径，用作其**尾帧**。尾帧要求必须已有首帧，没有首帧时会被拒绝，因为兼容适配器会把这一对作为"括号过渡"发送；两者都通过同一条包含性规则解析。不支持的形状、空提示词、超出范围的数字和超量条目都以 `INVALID_ARGUMENT` 拒绝，而不是截断或静默丢弃，且提示词绝不会被扩散成超出所请求数量的额外片段。

内置的 `qianning/videogen` 技能在普通会话中可被发现，并经由既有的 Skill 工具加载。它教的是：何时调用该工具、如何为"运动"写提示词、首帧如何改变结果、渲染需要数分钟且按秒计费、只生成被要求的内容、报告部分失败而不是重试、以及逐个报告返回的本地路径。它不授予任何权限，也不携带任何凭据。

可信桌面桥先以相同的身份、参数与权限范围调用 host-core 的 `tools.execute`。host-core 把 `GenerateVideos` 归类为高风险，在 `ask` 与 `accept-edits` 下从不自动批准，在 `plan` 与 `goal` 下直接拒绝，并且只对可信桥返回 `authorized: true`；随后由该桥运行视频服务。审批卡会写明模型、片段数量和所请求的时长，因为一个批次可能产生按秒计费的开销。运行时取消按与 Bash、生图相同的工具路径注册：它会触达待处理的审批、停止排队项并中止进行中的 HTTP 请求。取消无法保证上游服务商已停止处理或停止计费；已完成的文件会保留。host 丢失或 sidecar 释放会以同样方式中止本地工作。

## OpenAI Videos 适配器

只支持 OpenAI 兼容的 Videos。根 base URL 会补上 `/v1`；显式路径前缀会保留。任务以 `POST videos` 提交，并以 5 秒间隔用 `GET videos/{id}` 轮询。创建请求携带 `model` 和 `prompt`，并在调用方设置了 `seconds` 与 `size` 时一并携带；带帧时同一请求以 multipart 发送，不带帧时以 JSON 发送。帧部件的名字取自调用方设置的 `frames: {first?, last?}`，否则回退到 `input_reference` 与 `last_frame`；名字只有在匹配表单字段模式时才被接受，因此调用方永远无法借它注入额外的 header 或字段。服务商凭据只在对服务商的调用中以 `Bearer` header 发送。对服务商的调用从不跟随重定向（`redirect: "error"`）。提交后直接返回最终 URL 而不带 id 的服务商会被接受；报告终态失败状态的任务会让该项失败；找不到 id 的任务会以 `VIDEO_JOB_NOT_FOUND` 失败，而不是永久轮询。

每一项有 10 分钟预算，整个批次有 40 分钟上限；轮询循环在休眠前检查截止时间，因此永不完成的服务商会以 `VIDEO_TIMEOUT` 结束，而不是挂住这一轮。批次每次运行两项，并按输入顺序返回结果并带上每一项的索引，因此部分失败也能在报告中保住各自的位置。请求从不自动重试。认证类失败会停止排队中的工作并把剩余项报告为已停止；非认证类失败只让该项失败，批次其余部分继续运行。

JSON 体限制在 256 KiB，声明超过该上限的 `Content-Length` 会在读取之前被拒绝。完成的文件以 `generated-<uuid>.mp4`（或 `.webm`、`.mov`）下载到会话的 scratch 目录，上限 256 MiB，且必须带有与其存储扩展名相符的、可识别的容器签名。下载使用经校验、钉住的公网 DNS 地址，拒绝重定向与私网目标，并且从不接收服务商 header。当"设置 > 通用 > 网络"显式启用代理 fake-IP 支持时，处于 benchmark 段的 fake-IP 应答会走应用具备代理感知的传输；真实的私网、环回、链路本地和元数据地址仍被拦截。

帧从会话项目、该会话的 scratch 目录或附件存储读取，并经过 realpath 包含性校验；这些根之外的任何内容、不存在的路径，或不是可识别图像的文件的都会被以 `VIDEO_FRAME_UNAVAILABLE` 拒绝，且只有该项失败。凭据始终留在渲染层和工具结果之外。

## 错误

| Code | Raised when | Scope |
| --- | --- | --- |
| `INVALID_ARGUMENT` | 工具载荷未通过形状与边界校验 | 该次调用 |
| `VIDEO_NOT_CONFIGURED` | 没有存储可用的默认绑定 | 该次调用 |
| `VIDEO_MODEL_UNAVAILABLE` | 服务商已停用、不存在，或未列出该模型 | 该次调用 |
| `VIDEO_AUTH_UNSUPPORTED` | 服务商通过 OAuth 认证 | 该次调用 |
| `VIDEO_AUTH_FAILED` | 没有凭据，或服务商返回 401/403 | 该批次 |
| `VIDEO_INVALID_ENDPOINT` | 服务商 base URL 无法组成请求 | 该次调用 |
| `VIDEO_HTTP_<status>` | 服务商返回其他任何非成功状态 | 该项 |
| `VIDEO_INVALID_RESPONSE` | 响应体超长、不可读，或缺少 job id 与 URL | 该项 |
| `VIDEO_JOB_FAILED` | 任务报告了终态失败状态 | 该项 |
| `VIDEO_JOB_NOT_FOUND` | 被轮询的 job id 已不存在 | 该项 |
| `VIDEO_TIMEOUT` | 该项预算或批次上限已耗尽 | 该项 |
| `VIDEO_CANCELLED` | 该轮在请求之前或期间被取消 | 该项 |
| `VIDEO_REQUEST_FAILED` | 没有更具体错误码的传输失败 | 该项 |
| `VIDEO_FRAME_UNAVAILABLE` | 帧不在允许的根内，或不是图像 | 该项 |
| `VIDEO_TOO_LARGE` | 完成的文件超过下载上限 | 该项 |

失败的一项从不丢弃整个批次：成功的片段保留各自的本地路径，报告会带错误码与提示词索引列出每一处失败。任何内容都不会被自动重生成，包括失败的片段，因为每一次重试都是一次新的计费渲染。
