/** 本地类型：纯逻辑模块不 import dsh-llm 的运行时值，类型形状与 packages/llm/llm/src/types.ts 保持一致。 */

/** 一个工具的 JSON Schema 描述（dsh ToolSchema 的本地投影）。 */
export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** OpenAI 风格的聊天消息。 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 流式解析器吐出的解析事件。 */
export type ParseEvent =
  | { type: 'text'; text: string }
  | { type: 'call'; name: string; arguments: string }
  | { type: 'call-error'; error: string; raw: string }

/**
 * 回合的流式逻辑块序列（块已配对，块类型只有 text / reasoning / tool-call）。
 * adapter 把它 1:1 映射成 dsh 的 StreamChunk（补上 index 与 usage/finish）。
 */
export type LogicalChunk =
  | { type: 'block-start'; blockType: 'text' | 'reasoning' | 'tool-call' }
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string }
  | { type: 'block-end'; blockType: 'text' | 'reasoning' | 'tool-call'; text: string; call?: { id: string; name: string; arguments: string } }

/** SSE 流里解析出的一个事件。 */
export type SseEvent =
  | { type: 'delta'; content?: string; reasoning?: string }
  | { type: 'usage'; usage: { promptTokens?: number; completionTokens?: number; reasoningTokens?: number } }
  | { type: 'done' }

/** 供给一个 provider 路由的运行配置（apply 时从 cordis 配置解析）。 */
export interface ProviderProfile {
  displayName: string
  baseURL: string
  apiKey?: string
  apiKeyEnv?: string
  noAuth?: boolean
  headers?: Record<string, string>
  params?: Record<string, unknown>
  proxy?: string
  timeoutSec?: number
  contextWindow?: number
  maxTokensField?: string
  models: readonly { id: string; name?: string; contextWindow?: number; maxTokens?: number }[]
}
