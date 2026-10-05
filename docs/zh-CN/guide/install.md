---
title: 安装与升级
description: 在 Windows、macOS 或 Linux 上选择、安装、升级和移除正确的 QianNing Agent 安装包。
---

# 安装与升级

正式安装包发布在 [GitHub Releases](https://github.com/Qian-Ning/QianNing-Agent/releases/latest)。请从这个页面下载，让文件名、版本、架构和发布校验信息保持在一起。

## 选择安装包

| 平台 | 安装包 | 更新方式 |
|---|---|---|
| Windows x64 | `QianNing-Agent-Setup-<version>.exe` | NSIS 安装版支持应用内更新 |
| Windows x64 | `QianNing-Agent-Portable-<version>.exe` 或便携 ZIP | 提醒新版本并打开发布页，需要手动替换 |
| macOS arm64 / x64 | `QianNing-Agent-<version>-<arch>.dmg` | 已签名、公证的正式版支持应用内更新 |
| Linux x64 | AppImage | 支持应用内更新 |
| Debian / Ubuntu x64 | `qianning-agent_<version>_amd64.deb` | 提醒新版本并打开下载页 |
| Fedora / RPM x64 | `qianning-agent-<version>-x86_64.rpm` | 提醒新版本并打开下载页 |

QianNing Agent 发布原生 macOS arm64 与 x64、Windows x64 和 Linux x64 安装包。Linux 正式版以 glibc 2.35 及以上为目标，包括 Ubuntu 22.04、Debian 12 与 Fedora 36 及以上版本。

## Windows

1. 日常使用选择 NSIS 安装版。
2. 运行安装程序，根据提示选择安装位置。
3. 从开始菜单或桌面快捷方式打开 **QianNing Agent**。
4. 只有在需要独立应用目录、并且接受手动更新时，才选择便携版。

如果 Windows 显示信誉提示，请先确认文件确实来自官方发布页，再决定是否继续。

## macOS

1. 根据 Mac 架构下载 DMG：Apple Silicon 选择 `arm64`，Intel 选择 `x64`。
2. 打开 DMG，将 **QianNing Agent** 拖入 Applications。
3. 从 Applications 启动。

Tag 正式版使用 Developer ID 签名、公证与 stapling。不要为来源不明的未签名文件执行移除 quarantine 的命令。

## Linux

### AppImage

```bash
chmod +x QianNing-Agent-<version>-x86_64.AppImage
./QianNing-Agent-<version>-x86_64.AppImage
```

### Debian 或 Ubuntu

```bash
sudo apt install ./qianning-agent_<version>_amd64.deb
```

### Fedora 或其他 RPM 系统

```bash
sudo dnf install ./qianning-agent-<version>-x86_64.rpm
```

Linux 包安装的可执行文件名是 `qianning-agent`。

## 第一次启动

QianNing Agent 会启动名为 `QianNing-Agent-Host-Core` 的 Rust 宿主进程，以及打包在应用内的 Node Agent Runtime。如果启动页报告宿主或运行时故障：

1. 先完整重启应用一次；
2. 打开错误页提供的日志位置；
3. 记录应用版本、操作系统和失败的进程；
4. 清除敏感信息后，将日志附到 GitHub Issue。

不要发布模型密钥、连接字符串、私人项目完整路径或完整环境变量。

## 升级机制

应用只检查固定的 HTTPS GitHub Releases 更新源，Renderer 无法替换更新地址。支持自动更新的安装类型会下载带哈希约束的产物，再提供重启安装；手动更新类型会打开官方发布页。

更新源不可用、manifest 无效、哈希不符或安装类型不支持时，更新会失败关闭，不会继续安装。

## 升级或卸载时的数据

应用数据与安装目录分开：

- 正式版：`~/.qianning-agent`
- 开发版：`~/.qianning-agent-dev`

安装新版本会保留该目录，并执行受支持的数据库迁移。卸载应用不一定删除用户数据；请按[数据、隐私与安全](/zh-CN/guide/data-and-security)单独备份或删除数据目录。

## 下一步

继续阅读[创建第一个项目会话](/zh-CN/guide/first-session)。
