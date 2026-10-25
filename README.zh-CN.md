# free2agent（dsh-llm-text 插件）

<div align="right"><b>中文</b> · <a href="README.md">English</a></div>

**把网页端的免费模型用成完整的 agent。** DeepSeek / Kimi / Qwen / GLM 网页端白送的模型，经 [DeepSeek-Free-API](https://github.com/LLM-Red-Team/deepseek-free-api)、[Chat2API](https://github.com/xiaoY233/Chat2API) 这类项目桥接成 OpenAI 兼容接口后（OpenRouter 的 `:free`、SiliconFlow 免费档、本地 Ollama 同理），全都是**不会函数调用的纯文本模型**——在别的工具里只能聊天。本插件把它们接进 deepseek-harness 内核：dsh 的 agent loop、全部内置工具（bash、read/write、glob/grep、todo、subagent…）、Web UI、会话持久化照常工作，免费模型也能跑命令、读写文件、干代码活。

原理只有一件事：把 dsh 的工具 schema 渲染成 `<tool_call>` 文本协议交给模型，再把模型回复里的 `<tool_call>` 块转回原生工具调用流。

```
dsh 内核（agent loop / 工具 / Web UI / 会话）
   │ provider-neutral 请求（messages + tools schema）
   ▼
llm-chat-text adapter（本插件）
   ├─ protocol.ts   工具 schema → 文本协议提示词；逐字流式解析 <tool_call> 块
   ├─ convert.ts    会话历史 ↔ chat messages（tool-call/tool_result 文本回放）
   ├─ sse.ts        OpenAI 兼容 /chat/completions 流式客户端（代理/超时/中止）
   └─ adapter.ts    dsh LlmAdapter 接口（StreamChunk：block/text/reasoning/tool-call/usage/finish）
        │ POST /chat/completions（流式）
        ▼
   DeepSeek / Kimi / Qwen / 本地 Ollama / 任意 OpenAI 兼容网关
```

与 [`chat-agent`](../Agent-Router/chat-agent/)（Codex Responses gateway）同源的文本协议，搬进了 dsh 的模型适配层。

## 快速开始

前置：Node ≥ 24.9，安装 dsh CLI：`npm i -g @deepseek-ai/dsh`。

### 方式一：插件市场安装（推荐）

```text
设置 → 插件 → 实验性插件 → 打开「Custom plugin indexes」
→ Discover → Add index source → 填入：
   https://dazhi666666.github.io/free2agent/index.json
→ 选择 free2agent → Install
```

装完后插件进入当前 profile 的 node_modules，组合树自动出现 `llm-chat-text` 行（出厂带一个 DeepSeek 示例路由）。

### 方式二：本地路径（开发或免发布）

```sh
cd D:\Dsh-Chat-Plugin
node setup.mjs          # 把 dsh 安装里的 peer 依赖链接进本项目（一次性）
dsh --profile web --patch cordis.patch.yml
```

### 配置模型

改你自己 profile 的 `cordis.patch.yml`（覆盖插件的整份 config），免费来源示例——网页端桥接（DeepSeek-Free-API / Chat2API 起一个本地 OpenAI 兼容服务）、OpenRouter `:free`、本地 Ollama（以各站点当前政策为准）：

```yaml
- id: llm-chat-text
  config:
    providers:
      # DeepSeek-Free-API / Chat2API 桥接出的本地接口
      web-deepseek:
        displayName: DeepSeek 网页端
        baseURL: http://127.0.0.1:8000/v1
        apiKey: bridge-token            # 桥接项目自己的鉴权 token
        contextWindow: 128000
        models:
          - id: deepseek-chat
            name: DeepSeek V3
      # OpenRouter 免费档
      openrouter:
        displayName: OpenRouter 免费
        baseURL: https://openrouter.ai/api/v1
        apiKeyEnv: OPENROUTER_API_KEY
        models:
          - id: deepseek/deepseek-chat-v3.1:free
      # 本地模型
      ollama:
        displayName: 本地 Ollama
        baseURL: http://127.0.0.1:11434/v1
        noAuth: true
        models:
          - id: qwen3:32b
```

默认模型：在 dsh 模型选择器里选一次即自动存为默认；或叠加本仓库的 `default-model.patch.yml`（`--patch cordis.patch.yml --patch default-model.patch.yml`）。改完保存即热重载。

启动：

```sh
# Web 聊天界面（模型选择器里会出现上面的全部模型）
dsh --profile web --patch D:\Dsh-Chat-Plugin\cordis.patch.yml

# 命令行单任务（headless）
dsh --profile headless --patch D:\Dsh-Chat-Plugin\cordis.patch.yml "读取 README.md 并总结"
```

改 `cordis.patch.yml` 保存即可，dsh 自动重载插件（路由集合变化原子换绑）。

## 配置字段

每个 provider 路由（`providers` 下的键即 provider id）：

| 字段 | 说明 |
|---|---|
| `displayName` | 模型选择器里的显示名 |
| `baseUrl` / `baseURL` | OpenAI 兼容接口地址（必填，两种拼写都收） |
| `apiKeyEnv` / `apiKey` / `noAuth` | 密钥三选一：环境变量 / 内联 / 免鉴权（本地服务） |
| `headers` / `params` | 额外请求头 / 合并进请求体的额外参数 |
| `proxy` | HTTP 代理（支持 CONNECT 隧道） |
| `timeoutSec` | 单次请求超时（默认 600） |
| `contextWindow` | 路由默认上下文窗口（模型可覆盖） |
| `maxTokensField` | 输出上限的请求字段名（默认 `max_tokens`，部分网关要 `max_completion_tokens`） |
| `models[]` | 模型清单：`id`（必填）、`name`、`contextWindow`、`maxTokens` |

## 测试

```sh
npm test        # 单元：协议渲染/流式解析/请求转换/块配对/SSE 客户端（13 个用例）
npm run e2e     # 端到端：真实 dsh headless + mock 模型跑通一次 read 工具调用
```

e2e 的验证逻辑是铁证链：mock 模型只有在请求历史里见到 `<tool_result>`（即 dsh 真的执行了工具并回传结果）才会吐出含标记的最终回答；断言「标记出现在最终回答」即证明纯文本模型经文本协议完成了一次真实的工具调用。

## 实现说明与已知限制

- **文本协议**：工具以 `<tool_call>{"name","arguments"}</tool_call>` 文本块下发，结果以 `<tool_result name=…>` 回放；模型伪造 `<tool_result` 会被丢弃，坏 JSON 调用原样保留为可见文本并附纠正提示，流截断的未闭合调用按文本保留。
- **逐字流式**：可见文本边生成边上屏（压住可能是 opener 前缀的尾巴）；思考模型的 `reasoning_content` 进入 dsh 的 reasoning 块。
- **用量**：优先采用接口返回的 usage，缺省按 chars/4 估算（跨厂商口径不一致，仅参考）。
- **纯文本**：模型声明 `inputModalities: ['text']`，图片由上游门控投影为文本占位。
- 不支持参数属性等需编译的 TS 语法（插件以 Node strip-only 模式直接加载）。
- 插件未注册 Models 页的"自定义模型 API"卡片；改模型请直接编辑 `cordis.patch.yml`（热重载）。
