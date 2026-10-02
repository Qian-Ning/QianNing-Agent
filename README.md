<div align="center">

<img src="apps/desktop/src/assets/brand/logo.png" alt="QianNing Agent logo" width="144" />

# QianNing Agent

### 千凝 · 本地优先的 AI Agent 桌面工作台

**把项目、会话、模型、工具和自动化工作流集中在一个可持续使用的桌面环境中。**

Windows 优先 · 本地数据 · 多模型 · 插件扩展 · 语音输入

[![Release](https://img.shields.io/github/v/release/Qian-Ning/QianNing-Agent?label=release)](https://github.com/Qian-Ning/QianNing-Agent/releases)
[![CI](https://github.com/Qian-Ning/QianNing-Agent/actions/workflows/ci.yml/badge.svg)](https://github.com/Qian-Ning/QianNing-Agent/actions)
[![License](https://img.shields.io/badge/license-LGPL--3.0-blue.svg)](LICENSE)

[下载](https://github.com/Qian-Ning/QianNing-Agent/releases) ·
[项目文档](docs/README.md) ·
[隐私政策](docs/privacy-policy.md) ·
[English](README.en.md)

</div>

> 当前版本线：`0.15.x`（最新 `0.15.13`）。这是 QianNing Agent 的定制发行版，主要面向 Windows 桌面使用。

## 关于千凝

QianNing Agent 是一个独立运行的 AI Agent 桌面应用。它不依附某个 IDE，能够围绕本地项目建立长期会话，让 Agent 读取代码、修改文件、运行命令、调用工具并持续完成任务。

“千凝”的“凝”取凝聚与专注之意。英文品牌固定为 **QianNing Agent**。

## 当前特性

- **长期会话**：项目、Session、Transcript、任务状态和检查结果保存在本地。
- **多模型支持**：可配置 OpenAI、Anthropic、OpenAI-Compatible、自建网关及本地模型。
- **Agent / Plan / Goal**：支持直接执行、先规划后执行以及目标驱动工作方式。
- **项目工具**：文件读写、Shell、Diff Review、工作面板、浏览器和插件工具。
- **会话级设定**：支持单会话 System Prompt、Persona 和推理强度选择。
- **语音输入**：正式版可列出本地 Whisper 模型，展示大小、下载进度和安装状态。
- **费用统计**：按模型统计 Token 与估算费用，可维护本地模型价格表。
- **皮肤与宠物**：支持纯色、图片和视频皮肤，以及桌面宠物。
- **千凝品牌**：应用、窗口、快捷方式、安装包和 Windows 子进程统一使用 QianNing Agent 名称。

## 本地优先

| 数据 | 默认行为 |
| --- | --- |
| 项目与会话 | 保存在本机 |
| 应用数据 | `~/.qianning-agent` |
| API 凭据 | 本地加密存储 |
| 模型请求 | 直接发送到你配置的服务商或本地服务 |
| 应用遥测 | 当前不提供远程遥测 |
| 自动更新 | 当前定制发行版保持关闭 |

使用远程模型、插件或 MCP 服务时，请求所需数据可能发送给相应第三方。详细说明见[隐私政策](docs/privacy-policy.md)。

## Windows 安装包

Windows x64 构建会生成：

```text
QianNing-Agent-Setup-0.15.10.exe
QianNing-Agent-Portable-0.15.10.exe
```

发布后的安装包位于本仓库的 [Releases](https://github.com/Qian-Ning/QianNing-Agent/releases)。如果 Releases 尚无附件，可按下方步骤从源码构建。

## 从源码运行

### 环境要求

- Node.js `>= 22.19`
- pnpm `>= 10`
- Rust stable toolchain
- Windows 构建 Rust host 时需要可用的 GNU/MSVC C 工具链

### 获取与构建

```bash
git clone https://github.com/Qian-Ning/QianNing-Agent.git
cd QianNing-Agent
pnpm install
cargo build -p host-core
pnpm build:js
pnpm dev
```

常用验证：

```bash
pnpm --filter @pi-desktop/desktop typecheck
pnpm lint
pnpm --filter @pi-desktop/shared test
```

Windows 发布构建：

```bash
pnpm build:js
cargo build --release -p host-core --locked
pnpm -C packages/agent-runtime bundle
pnpm exec electron-vite build
pnpm exec electron-builder --win nsis portable --publish never
```

## 项目结构

```text
apps/desktop/          Electron 主进程、预加载与 React 界面
crates/host-core/      Rust host、SQLite、权限和本地状态
packages/agent-runtime Agent 执行运行时
packages/plugin-sdk/   插件开发接口
packages/shared/       跨进程协议与共享类型
packages/voice-runtime 本地语音模型管理与转写运行时
docs/                  规格、架构决策和维护文档
```

内部仍保留部分 `@pi-desktop/*` 包名、`pi-desktop/` IPC channel、`PI_DESKTOP_*` 环境变量和 Cargo crate 名。这些是兼容协议，不是对外产品品牌，贸然重命名会破坏已有数据、插件或构建流程。

## 开源来源

QianNing Agent 基于 [vastsa/PI-Desktop](https://github.com/vastsa/PI-Desktop) 进行二次开发，并持续吸收上游的安全修复与基础能力。千凝的品牌、Windows 发行配置、语音入口、费用统计、皮肤、宠物和其他定制由本仓库维护。

本项目保留上游版权与许可证声明。请勿将千凝定制仓库误认为 PI-Desktop 上游官方发行版。

## 贡献与安全

- 开发约定：[CONTRIBUTING.md](CONTRIBUTING.md)
- 安全报告：[SECURITY.md](SECURITY.md)
- 规格索引：[docs/spec/README.md](docs/spec/README.md)
- 插件开发：[docs/plugin-development.md](docs/plugin-development.md)

请不要在公开 Issue 中提交 API Key、Token、密码、私人源码或其他敏感信息。

## License

本项目沿用 **GNU Lesser General Public License v3.0**。详见 [LICENSE](LICENSE)。
