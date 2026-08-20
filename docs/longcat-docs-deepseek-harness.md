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

安装后启动 Web UI，在模型选择器中即可看到 **LongCat-2.0**。

插件会注册 `longcat` provider 路由，并自动处理 LongCat 的思考模式协议、工具调用与流式解析。API Key 通过凭证机制按请求解析，也可在 **Settings → Models** 页面保存（只写字段，实际存储于 `$DSH_HOME/.credentials.yaml`）。

> 安装插件包会在本机执行该包的安装脚本（不受 Agent 沙箱约束）。建议固定 commit：
> `dsh plugin --profile default add github:ffyuuu/dsh-llm-longcat#<3dcb3b1b5870ba52baab053453bdbb28826e5f13>`

**2. 通过配置文件**

安装插件后，可在 `$DSH_HOME/settings.yaml` 中覆盖任意字段，保存后下一次请求即生效，无需重启：

```yaml
llm-longcat:
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

配置文件中只写环境变量名（`apiKeyEnv`），不写明文密钥。

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
| LongCat-2.0 | OpenAI/Anthropic | 高性能 Agentic 模型 |

模型参数：上下文长度 1,048,576（1M），最大输出 131,072，支持工具调用与思考模式，仅支持文本输入。

## 测试 DeepSeek Harness

启动 Web UI：

```bash
npx @deepseek-ai/dsh web
```

打开 `http://127.0.0.1:3080`，在模型选择器中选择 **LongCat-2.0**，然后输入测试问题：

```
你好，请介绍一下自己
```

若配置正确，将收到来自 LongCat 模型的回复。选择 `high` 思考档位时，回复中会包含模型的思考过程。

## 常见问题

**`MISSING_CREDENTIAL`**

未找到 API Key。请通过 Models 页面保存密钥，或导出 `LONGCAT_API_KEY` 环境变量。

**`UNKNOWN_MODEL`**

模型未在 provider 中配置。请确认模型 ID 为 `LongCat-2.0`（区分大小写）。

**思考模式不生效**

确认所选档位不是「关闭」。LongCat 的思考开关是二元的（开 / 关），不支持 `low` / `medium` / `max` 档位——请求这些档位会在发起网络请求前直接报 `UNSUPPORTED_REASONING_EFFORT`。

**上传图片被拒绝**

LongCat-2.0 仅支持文本输入（`modality: text->text`），插件会在发送前拦截图片内容并指明模型名。

**`UNSUPPORTED_OPTION`（stop 序列）**

LongCat 不支持 `stop` 参数，插件选择显式报错而非静默忽略——否则生成会越过调用方依赖的停止序列。

**余额不足**

LongCat 用 **402** 表示 token 额度耗尽，并在 **403** 上返回 `insufficient_quota`（多数 OpenAI 兼容服务用 429）。插件将两者都归类为 `QUOTA_EXCEEDED`，不会误报为密钥错误，也不会当作限流重试。
