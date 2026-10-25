# dsh-llm-text（llm-chat-text 插件）

<div align="right"><b>中文</b> · <a href="README.md">English</a></div>

**把纯文本对话模型（只有 `/chat/completions`、没有原生工具调用的模型）接入 deepseek-harness 内核的插件。**

dsh 的 agent loop、全部内置工具（bash、read/write、glob/grep、todo、subagent…）、Web UI、会话持久化全部照常工作——本插件只做一件事：把 dsh 的工具 schema 渲染成文本协议交给模型，再把模型回复里的 `<tool_call>` 块转回原生工具调用流。

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

```sh
cd D:\Dsh-Chat-Plugin
node setup.mjs          # 把 dsh 安装里的 peer 依赖链接进本项目（一次性）
```

编辑 `cordis.patch.yml`，配置你的模型（默认给了 DeepSeek 示例）：

```yaml
- insert:
    - id: llm-chat-text
      name: './plugin/src/index.ts'
      config:
        providers:
          chat-text:
            displayName: 对话模型
            baseURL: https://api.deepseek.com/v1
            apiKeyEnv: DEEPSEEK_API_KEY
            contextWindow: 128000
            models:
              - id: deepseek-chat
                name: DeepSeek Chat
- id: agent-default-model
  config:
    provider: chat-text
    model: deepseek-chat
```

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
