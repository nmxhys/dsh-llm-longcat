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

DeepSeek Harness 提供两种接入方式，任选其一即可。

**1. 通过 Web UI 配置（推荐）**

1. 启动 `npx @deepseek-ai/dsh web`，打开 `http://127.0.0.1:3080`
2. 进入 **Settings → Models**
3. 点击 **Add a custom provider**
4. 按下表填写：

| 字段 | 值 |
|---|---|
| Provider ID | `longcat` |
| Display name | `LongCat` |
| Base URL | `https://api.longcat.chat/openai/v1` |
| API protocol | `openai-completions` |
| API Key | 你的 LongCat API Key |

5. 在 **Model catalog** 中点击 **Fetch available models**，选择 `LongCat-2.0`，保存

Provider ID 创建后不可修改（请求记录、历史会话与凭证引用都以它为键），其余字段均可编辑。API Key 为只写字段，保存后仅返回脱敏描述符，实际存储于 `$DSH_HOME/.credentials.yaml`。

**2. 通过配置文件**

在 `$DSH_HOME/settings.yaml` 中写入以下内容，保存后下一次请求即生效，无需重启：

```yaml
llm-pi-ai:
  providers:
    longcat:
      displayName: LongCat
      apiKeyEnv: LONGCAT_API_KEY
      api: openai-completions
      baseURL: https://api.longcat.chat/openai/v1
      compat:
        thinkingFormat: deepseek
        supportsReasoningEffort: false
      models:
        - id: LongCat-2.0
          name: LongCat-2.0
          contextWindow: 1048576
          maxTokens: 131072
          reasoningEfforts:
            'off':
            high: high
```

再导出 API Key：

```bash
export LONGCAT_API_KEY=your_longcat_api_key
```

配置文件中只写环境变量名（`apiKeyEnv`），不写明文密钥。

**3. 关于思考模式的两个必填项**

LongCat 使用 `thinking` 对象控制思考模式，与 OpenAI 的 `reasoning_effort` 字符串不同。DeepSeek Harness 依赖 endpoint URL 推断该方言，而 `api.longcat.chat` 无法被自动识别，因此以下两项必须显式声明：

| 配置项 | 作用 |
|---|---|
| `thinkingFormat: deepseek` | 使用 `thinking: {"type": "enabled"}` 格式。**缺少此项会导致思考模式始终无法开启**。 |
| `supportsReasoningEffort: false` | LongCat 不接受 `reasoning_effort` 参数，此项确保该字段不会被发送。 |

配置完成后，实际发送的请求体为：

| 选择的思考档位 | 请求体 |
|---|---|
| `high` | `{"thinking": {"type": "enabled"}}` |
| `off` | `{"thinking": {"type": "disabled"}}` |
| 未指定 | `{"thinking": {"type": "disabled"}}` |

**4. 使用插件包（可选）**

上述配置已封装为插件包，可一条命令安装：

```bash
dsh plugin --profile default add github:YOUR_GITHUB_USER/dsh-longcat
export LONGCAT_API_KEY=your_longcat_api_key
```

安装插件包会在本机执行该包的安装脚本（不受 Agent 沙箱约束），建议固定 commit：`github:YOUR_GITHUB_USER/dsh-longcat#COMMIT_SHA`。

**5. 支持的模型**

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

检查 `compat.thinkingFormat` 是否为 `deepseek`。缺少该配置时，DeepSeek Harness 会按 OpenAI 方言发送 `reasoning_effort`，而 LongCat 不接受该参数，思考模式不会开启。

**上传图片被拒绝**

LongCat-2.0 仅支持文本输入。请勿为其配置 `input: [text, image]`，否则会将本可提前拦截的请求变为服务端报错。

**注意：`models` 是替换而非追加**

在 `settings.yaml` 中声明 `models` 列表会整体替换原有模型列表，需要保留的模型必须全部列出。若只想修改单个模型的字段，请改用 `modelOverrides`（以模型 ID 为键）。
