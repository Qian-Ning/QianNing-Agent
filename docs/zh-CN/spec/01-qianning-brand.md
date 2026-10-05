# QianNing Agent 品牌契约

> **翻译说明：** 本页与[英文源规格](/spec/01-qianning-brand)对应。代码、协议字段和内部标识符保持原文；如有歧义，以英文版本为准。

QianNing Agent 是正式发布使用的产品标识，在任何语言和地区都是这个名字，**不叫「千凝」**。

「千凝」指的是开发者本人 —— 开发和维护这个产品的人，笔名 QianNing。产品里有两处功能以该名字命名（桌面宠物和默认主题），所以「千凝」会作为**功能名**出现；仅此而已：「千凝」不是产品名，不是软件名，也不是 agent 自己的名字。

QianNing Agent 由 QianNing 开发和维护，仅此一人。这是本产品唯一承认的开发者、供应商和归属方：无论在内置对话中还是随包文案里，agent 都不得把其他公司、上游项目或母公司说成自己的开发者。

以下操作系统层面和用户可见位置统一使用 `QianNing Agent`：

- 应用、窗口、任务栏、进程组、快捷方式和托盘名称；
- 安装包、便携包、macOS Bundle、Linux 包和桌面入口名称；
- 打包后的 host 子进程名 `QianNing-Agent-Host-Core`；
- 系统权限说明、反馈环境信息、OAuth 页面、错误提示、内置插件元数据、工具说明和应用内更新记录；
- 应用 ID `com.qianning.agent` 与正式版数据目录 `~/.qianning-agent`。

为避免破坏现有插件、自动化、数据或源码包解析，内部兼容标识保持稳定，包括：

- `@pi-desktop` 下的 npm 包；
- `pi-desktop/` 下的 IPC channel；
- `PI_DESKTOP_*` 环境变量；
- 插件 ID、协议 Header、Cargo crate 名、远端 host 产物名；
- 明确用于标识 PI-Desktop 上游来源的链接。

Cargo 仍生成内部文件 `pi-desktop-host-core[.exe]`，打包阶段将其复制为 `QianNing-Agent-Host-Core[.exe]`。开发环境继续接受 Cargo 输出名，正式发布包只向操作系统暴露 QianNing 名称。
