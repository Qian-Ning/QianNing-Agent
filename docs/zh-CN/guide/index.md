---
title: 快速开始
description: 用大约五分钟完成 QianNing Agent 的安装、模型连接与第一个可验证项目任务。
---

# 快速开始

QianNing Agent 是一款本地优先的 AI Agent 桌面工作台。它面向所有希望让 Agent 在本机直接动手干活的人 —— 写代码只是其中一类工作，文档、资料、数据、系统设置同样可以交给它；同时它不会把工具、权限和结果藏在黑盒里。

这篇导览只走最短的有效路径：安装应用、连接模型、绑定项目，再完成一个你能够检查和验证的改动。

## 五分钟上手路径

1. 按操作系统[安装 QianNing Agent](/zh-CN/guide/install)。
2. 添加模型服务并测试连接。
3. 打开一个项目目录，创建项目会话。
4. 第一次运行先把权限模式保持为**询问**。
5. 给 Agent 一个边界清楚的小任务，再检查工具记录和结果。

完整步骤见[创建第一个项目会话](/zh-CN/guide/first-session)。

## 选择工作模式

| 模式 | 适用情况 | 执行前会发生什么 |
|---|---|---|
| **Agent** | 任务明确，希望立即开始 | 每个工具仍受宿主权限策略控制 |
| **Plan** | 希望先审查实施路线 | 应用保存不可变的计划文件，并单独请求执行批准 |
| **Goal** | 结果明确，但实现路径可以交给 Agent | 先批准结果、验收标准与不可越过的边界 |

Plan 和 Goal 是同一个 Agent 的契约模式，不是另外两个助手。Bash 在所有模式中都服从当前权限策略；刚开始使用时建议保持**询问**，不要直接使用全自动。

## 本机保存了什么

正式版默认使用 `~/.qianning-agent`。会话正文是可读的 JSONL 文件，SQLite 保存索引和结构化应用状态。模型服务密钥由 Rust host-core 管理，并通过 Electron `safeStorage` 加密。

QianNing Agent 目前尚未接入操作系统钥匙串。能够以同一系统用户读取应用数据目录的进程，仍属于本地威胁模型的一部分。在加入生产凭据或市场插件前，请阅读[数据、隐私与安全](/zh-CN/guide/data-and-security)。

## 按任务继续阅读

| 接下来要做的事 | 文档 |
|---|---|
| 安装、升级或选择安装包 | [安装与升级](/zh-CN/guide/install) |
| 配置模型并完成第一个任务 | [创建第一个项目会话](/zh-CN/guide/first-session) |
| 了解存储、权限、密钥与插件边界 | [数据、隐私与安全](/zh-CN/guide/data-and-security) |
| 运行周期任务 | [定时任务](/zh-CN/guide/automations) |
| 添加 MCP 目录 | [MCP 市场](/zh-CN/guide/mcp-market) |
| 浏览应用界面 | [界面图库](/zh-CN/guide/screenshots) |
| 开发扩展 | [插件开发](/zh-CN/plugin-development) |
| 理解进程职责 | [架构规格](/zh-CN/spec/02-architecture/01-architecture) |

## 系统心智模型

```text
Renderer UI
    ↓ 白名单约束的 preload IPC
Electron Main
    ├── Rust Host Core：持久化、工具、权限、审计
    └── Node Agent Runtime：模型、上下文、工具编排、子智能体
```

Renderer 只负责呈现和交互，不能直接访问 Node、文件系统或 SQLite。Electron Main 协调桌面能力和子进程。Rust host-core 掌握持久化与特权操作。Node sidecar 负责 Agent 循环和面向模型服务的工作。

参与仓库开发时，继续阅读 [AI 开发流程](/zh-CN/spec/06-delivery/03-ai-development-workflow)与[变更检查表](/zh-CN/spec/06-delivery/05-change-checklist)。
