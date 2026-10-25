# free2agent (the dsh-llm-text plugin)

<div align="right"><b>English</b> · <a href="README.zh-CN.md">中文</a></div>

**Turn the web's free models into full agents.** The free models on DeepSeek / Kimi / Qwen / GLM web pages, once bridged into OpenAI-compatible endpoints by projects like [DeepSeek-Free-API](https://github.com/LLM-Red-Team/deepseek-free-api) and [Chat2API](https://github.com/xiaoY233/Chat2API) (OpenRouter's `:free`, SiliconFlow's free tier, and local Ollama alike), are all **pure-text models without native function calling** — in most tools they can only chat. This plugin connects them to the deepseek-harness kernel: dsh's agent loop, every built-in tool (bash, read/write, glob/grep, todo, subagents…), the Web UI, and session persistence keep working as-is, so free models can run commands, read and write files, and do real coding work.

The mechanism is one thing: dsh's tool schemas are rendered into a `<tool_call>` text protocol for the model, and the `<tool_call>` blocks in the model's reply are turned back into native tool-call stream chunks.

```
dsh kernel (agent loop / tools / Web UI / sessions)
   │ provider-neutral request (messages + tool schemas)
   ▼
llm-chat-text adapter (this plugin)
   ├─ protocol.ts   tool schemas → text protocol prompt; streaming <tool_call> parser
   ├─ convert.ts    conversation history ↔ chat messages (tool-call / tool_result replay)
   ├─ sse.ts        OpenAI-compatible /chat/completions streaming client (proxy/timeout/abort)
   └─ adapter.ts    dsh LlmAdapter interface (StreamChunk: block/text/reasoning/tool-call/usage/finish)
        │ POST /chat/completions (streaming)
        ▼
   DeepSeek / Kimi / Qwen / local Ollama / any OpenAI-compatible gateway
```

The text protocol is the same one as [`chat-agent`](../Agent-Router/chat-agent/) (the Codex Responses gateway), moved into dsh's model adapter layer.

## Quick start

Prerequisites: Node ≥ 24.9 and the dsh CLI: `npm i -g @deepseek-ai/dsh`.

```sh
cd D:\Dsh-Chat-Plugin
node setup.mjs          # link the peer dependencies from the dsh installation into this project (once)
```

Edit `cordis.patch.yml` with your models. Free-source examples: web-page bridges (DeepSeek-Free-API serves a local OpenAI-compatible endpoint), OpenRouter `:free`, local Ollama (subject to each site's current policy):

```yaml
- insert:
    - id: llm-chat-text
      name: './plugin/src/index.ts'
      config:
        providers:
          # A local endpoint bridged by DeepSeek-Free-API / Chat2API
          web-deepseek:
            displayName: DeepSeek Web
            baseURL: http://127.0.0.1:8000/v1
            apiKey: bridge-token            # the bridge's own auth token
            contextWindow: 128000
            models:
              - id: deepseek-chat
                name: DeepSeek V3
          # OpenRouter free tier
          openrouter:
            displayName: OpenRouter Free
            baseURL: https://openrouter.ai/api/v1
            apiKeyEnv: OPENROUTER_API_KEY
            models:
              - id: deepseek/deepseek-chat-v3.1:free
          # Local models
          ollama:
            displayName: Local Ollama
            baseURL: http://127.0.0.1:11434/v1
            noAuth: true
            models:
              - id: qwen3:32b
- id: agent-default-model
  config:
    provider: web-deepseek
    model: deepseek-chat
```

Launch:

```sh
# Web chat UI (the model picker lists every configured model)
dsh --profile web --patch D:\Dsh-Chat-Plugin\cordis.patch.yml

# One-shot command-line task (headless)
dsh --profile headless --patch D:\Dsh-Chat-Plugin\cordis.patch.yml "summarize README.md"
```

Editing and saving `cordis.patch.yml` is enough — dsh hot-reloads the plugin (route-set changes rebind atomically).

## Configuration

Each provider route (a key under `providers` becomes the provider id):

| Field | Meaning |
|---|---|
| `displayName` | Name shown in the model picker |
| `baseUrl` / `baseURL` | OpenAI-compatible endpoint (required; both spellings accepted) |
| `apiKeyEnv` / `apiKey` / `noAuth` | Credential, one of: env var / inline / none (local servers) |
| `headers` / `params` | Extra request headers / extra body parameters |
| `proxy` | HTTP proxy (CONNECT tunnel supported) |
| `timeoutSec` | Per-request timeout (default 600) |
| `contextWindow` | Route-default context window (overridable per model) |
| `maxTokensField` | Request field for the output cap (default `max_tokens`; some gateways need `max_completion_tokens`) |
| `models[]` | Model list: `id` (required), `name`, `contextWindow`, `maxTokens` |

## Tests

```sh
npm test        # unit: protocol rendering / streaming parser / request conversion / block pairing / SSE client (13 cases)
npm run e2e     # end-to-end: real dsh headless + mock model completing one read tool call
```

The e2e proof is airtight: the mock model only emits the marker-containing final answer after its request history contains `<tool_result>` — i.e. after dsh actually executed the tool and sent the result back. Asserting that the marker appears in the final answer proves a pure-text model completed a real tool call through the text protocol.

## Implementation notes & limitations

- **Text protocol**: tools go out as `<tool_call>{"name","arguments"}</tool_call>` blocks; results come back as `<tool_result name=…>`. Model-invented `<tool_result` content is dropped; malformed calls are kept as visible text with a correction hint; a truncated call at stream end is preserved as text.
- **Token streaming**: visible text streams as it is generated (holding back tails that might be an opener prefix); reasoning models' `reasoning_content` maps to dsh's reasoning block.
- **Usage**: provider-reported usage when available, otherwise estimated at chars/4 (indicative only; reporting differs across providers).
- **Text-only**: models declare `inputModalities: ['text']`; images are projected to text placeholders by the upstream capability gate.
- No compile-required TS syntax (parameter properties etc.) — the plugin is loaded by Node in strip-only mode.
- The plugin does not register a "Custom model API" card on the Models page; edit `cordis.patch.yml` to change models (hot-reloaded).
