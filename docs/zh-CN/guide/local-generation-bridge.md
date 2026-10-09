---
title: 本机生成桥
description: 把 ComfyUI 或 Stable Diffusion WebUI 放在一个 OpenAI 兼容的壳后面，让媒体工作台能按地址调用它们。
---

# 本机生成桥

媒体工作台以 OpenAI 形状与服务商通信：它发出 `POST /v1/images/generations`，并从 `data[0].b64_json` 取回图像。ComfyUI 与 Stable Diffusion WebUI 不说这个形状 —— 它们的原生路由是 `POST /prompt` 与 `POST /sdapi/v1/txt2img` —— 因此把工作台直接指向 `http://127.0.0.1:8188` 只会得到 404 或 400，应用也只能报告它看到的 HTTP 码。桥就是一个坐在原生服务器前面的小脚本，把一种形状翻译成另一种。

它是仓库里一个零依赖文件：`docs/public/local-bridge.mjs`。复制到任何地方，用 Node 18 或更新版本运行即可；它只使用 Node 标准库。

[English version](/guide/local-generation-bridge)

## 为什么工作台需要一层桥

原生服务器是一个活着的 HTTP 服务器，所以你当然可以把它的地址填进服务商 —— 请求确实会离开本机。回来的却是 `404`（ComfyUI 没有 `/v1/images/generations`）或 `400`（Stable Diffusion WebUI 把 OpenAI 的请求体读成缺少提示词）。工作台没有一个字段能表达「这个端点不是 OpenAI 形状」，所以翻译只能发生在应用之外、服务器之前。

桥刻意做成能办成这件事的最小东西：它暴露工作台真正会调用的两条路由，并把活交给原生 API。

## 运行桥

选好后端，把 `--upstream` 指向原生服务器。桥会打印要填进应用的地址。

```bash
# Stable Diffusion WebUI（其 API 默认在 :7860 开启）
node docs/public/local-bridge.mjs --backend sd --upstream http://127.0.0.1:7860
```

```bash
# ComfyUI（其 API 监听 :8188）
node docs/public/local-bridge.mjs --backend comfy --upstream http://127.0.0.1:8188 --ckpt v1-5-pruned-emaonly.safetensors
```

`--help` 会列出所有参数：`--port`（默认 `8787`）、`--model`（应用里显示的 id）、`--steps`、`--default-size`、`--negative`、`--timeout`，以及用于自定义 ComfyUI 图的 `--workflow`。ComfyUI 图按模板读取，因此不会被绑死在某一个检查点上：`__PI_PROMPT__`、`__PI_NEGATIVE__`、`__PI_WIDTH__`、`__PI_HEIGHT__`、`__PI_STEPS__`、`__PI_SEED__`、`__PI_CKPT__` 这些占位符会由请求与参数填入。在自定义图里，字符串占位符（`prompt`、`negative`、`ckpt`）要留在引号内，数值占位符（`width`、`height`、`steps`、`seed`）要裸露在外，与内置图保持一致。

不生成任何图像也能检查它是否在跑：

```bash
curl -s http://127.0.0.1:8787/v1/models
```

## 让 QianNing Agent 指向桥

把桥加成一个**自定义**服务商，起一个你认得出的名字：

- **Base URL**：`http://127.0.0.1:8787/v1` —— 与桥打印的地址一致。
- **API 格式**：任意 OpenAI 兼容格式均可；形状无所谓，因为工作台总是把 OpenAI 请求体发往 `/v1/images/generations`。
- **API 密钥**：留空。环回地址会以无密钥方式保存，无需任何密钥。
- **模型**：桥从 `/v1/models` 报告的 id（`sd-webui` 或 `comfyui`，或 `--model` 设定值）。环回地址会被标记为**本机**，并豁免按名判断生图/生视频家族的检查，因为自建服务器是用文件名给模型命名的。

然后打开媒体工作台，选好模型，生成即可。让这次运行成功的正是桥。

## 桥能做什么、不能做什么

| 能力 | 是否支持 | 说明 |
|---|---|---|
| 文生图 | 支持 | 每次请求一张图；`POST /sdapi/v1/txt2img` 或一张 `POST /prompt` 图 |
| 具体像素尺寸 | 支持 | `WIDTHxHEIGHT` 直接透传为宽与高 |
| 智能 / 服务商默认尺寸 | 近似 | 请求不带尺寸，桥改用 `--default-size`（默认 `512x512`） |
| 比例 | 隐含 | 工作台会组合出固定的 `WIDTHxHEIGHT`，因此比例以像素形式传递 |
| 参考图 / 编辑 | 不支持 | `POST /v1/images/edits` 返回 `501`；img2img 与局部重绘不翻译 |
| 视频 | 不支持 | `POST /v1/videos` 返回 `501`；请使用支持视频的服务 |
| 返回图像 | Base64 | 始终是 `data[0].b64_json`；只认 `url` 的客户端拿不到链接 |

如实总结：一个纯提示词加一个像素尺寸可以端到端跑通；「智能」尺寸会退回默认值；带参考图的运行，或要求视频的运行，会以一个清楚的错误失败，而不会悄悄产出别的东西。

## 排错

- **桥起来了，但生成失败。** 先确认原生服务器真的在跑：在浏览器打开 `http://127.0.0.1:7860/docs`（SD WebUI）或 `http://127.0.0.1:8188`（ComfyUI）。
- **应用显示 `IMAGE_HTTP_404`。** 请求到达了桥上的某个 OpenAI 路由，但你连的桥不是你以为的那个，或者你把服务商指向了原生服务器而不是桥。确认 base URL 以 `/v1` 结尾，且端口与桥自己的输出一致。
- **应用显示 `IMAGE_HTTP_400`。** 请求直接到达了原生服务器，而不是桥 —— 原生服务器把 OpenAI 请求体读成了格式错误。
- **ComfyUI 报「没有图像输出」。** 图跑完了，却没有产生 `SaveImage` 输出。内置图通过节点 `9` 保存；自定义的 `--workflow` 必须包含一个 `SaveImage` 节点。
- **超时。** 应用对单张图像在 180 秒时中止；桥自身的预算默认 150 秒。只有在不超过那个上限时才可以调高 `--timeout`，否则请调低 `--steps`。

这里没有需要解决的 CORS 问题：工作台的请求跑在 Electron 主进程里，而不是浏览器页面里，所以桥从不会被要求给出 `Access-Control-Allow-Origin` 头。让它只绑定环回（默认 `--host 127.0.0.1`）；它不检查任何凭据，也不转发任何凭据。

## 继续阅读

| 接下来要做的事 | 文档 |
|---|---|
| 了解工作台与模型绑定 | [媒体工作台](/zh-CN/guide/media-workbench) |
| 添加服务商或本机服务器 | [创建第一个项目会话](/zh-CN/guide/first-session) |
| 文件与密钥存在哪里 | [数据、隐私与安全](/zh-CN/guide/data-and-security) |
| 请求与错误码契约 | [视频生成](/zh-CN/spec/03-runtime/24-video-generation) |
