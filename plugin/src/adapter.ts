/** ChatTextAdapter：dsh LlmAdapter 的纯文本模型实现。
 * dsh 的工具 schema 渲染成文本协议（protocol.ts），模型回复里的 <tool_call> 块
 * 转回原生 tool-call StreamChunk——agent loop 照常执行工具、回填结果。 */
import { attributionHeaders, LlmAdapter, LlmError, projectImagesForTextModel } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, LlmProviderInfo, StreamChunk, ToolCallId, TokenUsage } from '@deepseek-ai/dsh-llm'
import { toChatRequest } from './convert.ts'
import { createResponseDriver } from './driver.ts'
import { streamChatCompletion, ProviderHttpError } from './sse.ts'
import type { LogicalChunk, ProviderProfile } from './types.ts'

export interface ChatTextAdapterOptions {
  /** 当前 provider 路由 → 运行配置（apply 层提供实时快照）。 */
  profiles: () => ReadonlyMap<string, ProviderProfile>
  log?: (message: string) => void
}

const TOKENS_PER_CHAR = 4 // 估算值：OpenAI 兼容接口的流式 usage 各家不一致

export class ChatTextAdapter extends LlmAdapter {
  private readonly options: ChatTextAdapterOptions
  constructor(options: ChatTextAdapterOptions) {
    super()
    this.options = options
  }

  private profile(provider: string): ProviderProfile {
    const hit = this.options.profiles().get(provider)
    if (!hit) throw new LlmError(`llm-chat-text: unknown provider route "${provider}"`, 'UNKNOWN_PROVIDER')
    return hit
  }

  override providerInfo(provider: string): LlmProviderInfo {
    let name = provider
    try { name = this.profile(provider).displayName || provider } catch {}
    return { id: provider, name }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const profile = this.profile(provider)
    return profile.models.map(m => ({ provider, id: m.id, name: m.name || m.id, inputModalities: ['text' as const] }))
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const profile = this.profile(provider)
    const entry = profile.models.find(m => m.id === model)
    const contextWindow = entry?.contextWindow ?? profile.contextWindow
    return {
      provider, id: model, name: entry?.name || model,
      inputModalities: ['text'], // 纯文本模型：上游能力门控会把图片投影为文本
      ...(contextWindow ? { context: { contextWindow } } : {}),
      ...(entry?.maxTokens ? { defaultMaxTokens: entry.maxTokens } : {}),
    }
  }

  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const profile = this.profile(options.provider)
    const apiKey = profile.apiKey ?? (profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined)
    if (!apiKey && !profile.noAuth) {
      throw new LlmError(
        `llm-chat-text: API key missing for route "${options.provider}"; set ${profile.apiKeyEnv || 'apiKey'} in the environment or configuration`,
        'MISSING_CREDENTIAL',
      )
    }
    // 图片在上游已按 inputModalities 投影；这里再兜底一次（纯文本路由永不发送图片块）
    const messages = projectImagesForTextModel(options.messages)
    const { system, messages: chat } = toChatRequest({ messages, system: options.system, tools: options.tools })
    const body: Record<string, unknown> = {
      model: options.model,
      messages: system ? [{ role: 'system', content: system }, ...chat] : chat,
      stream: true,
      ...(options.maxTokens ? { [profile.maxTokensField || 'max_tokens']: options.maxTokens } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.stop?.length ? { stop: options.stop } : {}),
      ...profile.params,
    }
    const url = new URL(`${profile.baseURL.replace(/\/+$/, '')}/chat/completions`)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...attributionHeaders(),
      ...profile.headers,
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    }
    this.options.log?.(`POST ${url.host}${url.pathname} model=${options.model} messages=${chat.length} tools=${options.tools?.length ?? 0}`)
    const driver = createResponseDriver()
    // 块序号是每次调用的状态（并发流互不干扰），首见顺序递增
    let index = -1
    const nextIndex = () => ++index
    const logicalToStream = function* (chunks: Iterable<LogicalChunk>): Generator<StreamChunk> {
      for (const chunk of chunks) {
        switch (chunk.type) {
          case 'block-start':
            yield { type: 'block-start', index: nextIndex(), blockType: chunk.blockType }
            break
          case 'text-delta':
            yield { type: 'text-delta', index, text: chunk.text }
            break
          case 'reasoning-delta':
            yield { type: 'reasoning-delta', index, text: chunk.text }
            break
          case 'tool-call':
            yield { type: 'tool-call-delta', index, id: chunk.id as ToolCallId, name: chunk.name, argumentsDelta: chunk.arguments }
            break
          case 'block-end': {
            const i = index
            if (chunk.blockType === 'tool-call' && chunk.call) {
              yield { type: 'block-end', index: i, block: { type: 'tool-call', id: chunk.call.id as ToolCallId, name: chunk.call.name, arguments: chunk.call.arguments } }
            } else if (chunk.blockType === 'reasoning') {
              yield { type: 'block-end', index: i, block: { type: 'reasoning', text: chunk.text } }
            } else {
              yield { type: 'block-end', index: i, block: { type: 'text', text: chunk.text } }
            }
            break
          }
        }
      }
    }
    let toolCalls = 0
    let textChars = 0
    let usage: TokenUsage | undefined
    try {
      for await (const event of streamChatCompletion({
        url, body: JSON.stringify(body), headers,
        proxy: profile.proxy ?? null,
        timeoutSec: profile.timeoutSec,
        ...(options.signal ? { signal: options.signal } : {}),
      })) {
        if (event.type === 'delta') {
          for (const chunk of event.reasoning ? driver.pushReasoning(event.reasoning) : driver.pushContent(event.content ?? '')) {
            if (chunk.type === 'text-delta') textChars += chunk.text.length
            if (chunk.type === 'tool-call') toolCalls += 1
            yield* logicalToStream([chunk])
          }
          continue
        }
        if (event.type === 'usage') usage = this.toTokenUsage(event.usage)
      }
    } catch (e) {
      if (options.signal?.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'request aborted', code: 'REQUEST_ABORTED' } } }
        return
      }
      if (e instanceof ProviderHttpError) {
        throw new LlmError(`llm-chat-text: provider HTTP error on "${options.provider}/${options.model}": ${e.message}`, 'PROVIDER_HTTP_ERROR', { cause: e })
      }
      throw new LlmError(`llm-chat-text: provider request failed: ${(e as Error).message}`, 'PROVIDER_REQUEST_FAILED', { cause: e })
    }
    for (const chunk of driver.end()) {
      if (chunk.type === 'text-delta') textChars += chunk.text.length
      if (chunk.type === 'tool-call') toolCalls += 1
      yield* logicalToStream([chunk])
    }
    yield { type: 'usage', usage: usage ?? this.estimateUsage(system, chat, textChars) }
    yield { type: 'finish', reason: { kind: toolCalls > 0 ? 'tool-calls' : 'stop' } }
  }

  private toTokenUsage(u: { promptTokens?: number; completionTokens?: number; reasoningTokens?: number }): TokenUsage {
    const input = u.promptTokens ?? 0
    const output = u.completionTokens ?? 0
    return {
      inputTokens: input,
      outputTokens: output,
      totalTokens: input + output,
      ...(u.reasoningTokens ? { reasoningTokens: u.reasoningTokens } : {}),
    }
  }

  private estimateUsage(system: string, chat: { role: string; content: string }[], textChars: number): TokenUsage {
    const inputChars = system.length + chat.reduce((n, m) => n + m.content.length, 0)
    const est = (n: number) => Math.max(1, Math.ceil(n / TOKENS_PER_CHAR))
    const input = est(inputChars)
    const output = est(textChars)
    return { inputTokens: input, outputTokens: output, totalTokens: input + output }
  }
}
