# DeepSeek Harness 配置

> 提交给 LongCat 官方文档的稿件，建议放在 `docs/zh/deepseek-harness`，
> 并在 `tools-overview` 的集成列表中增加一行：
> **DeepSeek Harness** — 开源 AI Agent 框架，一切皆插件。
>
> 本文件按 LongCat 现有集成页（如 Claude Code 页）的结构与语气撰写。

## 概述

本文介绍如何在 DeepSeek Harness 中接入 LongCat 模型。

DeepSeek Harness 是 DeepSeek 开源的 Agent 框架，其模型能力以插件形式提供。LongCat 平台兼容 OpenAI API 格式，只需少量配置即可在 DeepSeek Harness 中使用 LongCat 模型。

## 前置条件

**1. 获取 API Key**

1. 访问 LongCat API 开放平台 `https://longcat.chat/platform/`
2. 注册并创建账号
3. 登录后进入 API Keys 页面 `https://longcat.chat/platform/api_keys`
4. 手动创建你的 API Key

**2. 确认 DeepSeek Harness 已安装**

DeepSeek Harness 需要 Node.js `^22.19.0` 或 `>=24.0.0`。确认已安装后，可直接运行：

```bash
npx @deepseek-ai/dsh web
```

Web UI 默认地址为 `http://127.0.0.1:3080`。安装说明详见 DeepSeek Harness 官方仓库 `https://github.com/deepseek-ai/deepseek-harness`。

## 配置方法

DeepSeek Harness 的模型能力以插件形式提供，推荐安装 LongCat 官方适配插件。

**1. 安装插件**

```bash
dsh plugin --profile default add github:ffyuuu/dsh-llm-longcat
export LONGCAT_API_KEY=your_longcat_api_key
```

安装后启动 Web UI，在模型选择器中即可看到 **LongCat-2.5-Preview** 与 **LongCat-2.0**。

插件会注册 `longcat` provider 路由，并自动处理 LongCat 的思考模式协议、工具调用、图片输入与流式解析。API Key 通过凭证机制按请求解析，也可在 **Settings → Models** 页面保存（只写字段，实际存储于 `$DSH_HOME/.credentials.yaml`）。

> 安装插件包会在本机执行该包的安装脚本（不受 Agent 沙箱约束）。建议固定 commit：
> `dsh plugin --profile default add github:ffyuuu/dsh-llm-longcat#<commit-sha>`

**2. 通过配置**

安装插件后，可在 profile 的 patch 层（`$DSH_HOME/profiles/<name>/cordis.patch.yml`）或 Harness 设置表单中修改任意字段（设置表单直接读取本插件的 `Config` schema）：

```yaml
- id: llm-longcat
  name: dsh-llm-longcat
  config:
    apiKeyEnv: LONGCAT_API_KEY
    baseURL: https://api.longcat.chat/openai/v1
    thinking: enabled
    reasoningEffort: high        # off | high —— LongCat 思考开关是二元的
    maxTokens: 131072
    defaultContextWindow: 1048576
```

再导出 API Key：

```bash
export LONGCAT_API_KEY=your_longcat_api_key
```

配置文件中只写环境变量名（`apiKeyEnv`），不写明文密钥。`apiKeyEnv` 与 `models` 是 volatile 字段：修改凭证引用或模型清单会在运行中的路由上就地生效，新增模型下一个请求即可用。

**3. 关于思考模式**

LongCat 使用 `thinking` 对象控制思考模式，且**不接受** OpenAI 的顶层 `reasoning_effort` 参数（模型详情接口的 `supported_parameters` 只列出 `thinking`）。因此思考档位只有二元的开与关，插件对应发送的请求体为：

| 选择的思考档位 | 请求体 |
|---|---|
| `high`（思考） | `{"thinking": {"type": "enabled"}}` |
| `off`（关闭） | `{"thinking": {"type": "disabled"}}` |

选择「关闭」时会显式发送 `disabled` 而非省略该字段——省略会把决定权交回服务端默认值，这与「关闭」的语义不符。请求 `low` / `medium` / `max` 会在发起网络请求前直接失败。

**4. 支持的模型**

| 模型名称 | API格式 | 描述 |
|---|---|---|
| LongCat-2.5-Preview | OpenAI/Anthropic | 原生多模态 Agentic 模型，支持文本与图片输入 |
| LongCat-2.0 | OpenAI/Anthropic | 高性能 Agentic 模型，仅文本输入 |

两个模型的上下文长度均为 1,048,576（1M），最大输出 131,072，支持工具调用与思考模式。模型能力来自 `GET /openai/v1/models/{model}` 的 `architecture.input_modalities`，插件据此在 Harness 中声明输入模态。

**5. 图片输入（LongCat-2.5-Preview）**

在对话中直接上传图片即可，插件会把每张图确定性地重编码成请求版本，再以 OpenAI 兼容的 content parts 形式发送：

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "这张图里是什么？" },
    { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
  ]
}
```

说明：

- 聊天补全文档把 `content` 记为纯文本字符串；图片使用的 content parts 数组由模型详情接口的 `input_modalities` 声明，并已通过真实流量的“识别图片中数字”验证。
- 每张图片前会附一段文本句柄（图片名、尺寸、只读副本路径），便于模型与后续工具引用。
- 单张图片的像素上限与字节目标、单次请求的图片总字节上限都可在配置中调整（`imageMaxPixels`、`imageMaxBytes`、`maxRequestImageBytes`、`maxImagesPerRequest`）。超出上限时插件返回 `IMAGE_OFFLOAD_REQUIRED` 并给出需要卸载的图片数量，由 Harness 记录并重试，不会静默丢弃图片。
- LongCat-2.0 仅支持文本输入（`modality: text->text`）：其输入模态声明为 text，Harness 会在发送前用占位文本替换图片；若图片仍到达适配器，请求会以 `UNSUPPORTED_CONTENT` 明确失败。

## 测试 DeepSeek Harness

启动 Web UI：

```bash
npx @deepseek-ai/dsh web
```

打开 `http://127.0.0.1:3080`，在模型选择器中选择 **LongCat-2.5-Preview**（可上传图片）或 **LongCat-2.0**（纯文本），然后输入测试问题：

```
你好，请介绍一下自己
```

若配置正确，将收到来自 LongCat 模型的回复。选择 `high` 思考档位时，回复中会包含模型的思考过程；选择 LongCat-2.5-Preview 时可同时上传一张图片提问。

## 常见问题

**`MISSING_CREDENTIAL`**

未找到 API Key。请通过 Models 页面保存密钥，或导出 `LONGCAT_API_KEY` 环境变量。

**`UNKNOWN_MODEL`**

模型未在 provider 中配置。请确认模型 ID 为 `LongCat-2.5-Preview` 或 `LongCat-2.0`（区分大小写）。

**思考模式不生效**

确认所选档位不是「关闭」。LongCat 的思考开关是二元的（开 / 关），不支持 `low` / `medium` / `max` 档位——请求这些档位会在发起网络请求前直接报 `UNSUPPORTED_REASONING_EFFORT`。

**选择 LongCat-2.0 时上传图片被拒绝**

LongCat-2.0 仅支持文本输入（`modality: text->text`），其输入模态声明为 text，Harness 因此不会把图片路由给它。需要图片输入请选择 **LongCat-2.5-Preview**。

**`IMAGE_OFFLOAD_REQUIRED`**

单次请求的图片超出预算（默认累计 base64 20 MiB、单图 2048×2048 像素 / 1 MiB 编码目标）。Harness 会按返回的 `offloadImages` 数量把最旧的图片标记为已卸载并重试；也可以在配置中放宽 `maxRequestImageBytes`、`maxImagesPerRequest` 或单模型的 `imageMaxPixels` / `imageMaxBytes`。

**`UNSUPPORTED_OPTION`（stop 序列）**

LongCat 不支持 `stop` 参数，插件选择显式报错而非静默忽略——否则生成会越过调用方依赖的停止序列。

**余额不足**

LongCat 用 **402** 表示 token 额度耗尽，并在 **403** 上返回 `insufficient_quota`（多数 OpenAI 兼容服务用 429）。插件将两者都归类为 `QUOTA_EXCEEDED`，不会误报为密钥错误，也不会当作限流重试。
