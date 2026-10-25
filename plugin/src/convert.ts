/** dsh provider-neutral 请求 → OpenAI 风格 chat messages。
 * 只做类型导入（import type 在运行时被剥除），所以本模块可独立单测。 */
import type { GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import { clampResult, protocolPrompt } from './protocol.ts'
import type { ChatMessage, ToolSpec } from './types.ts'

/** 文本模型的图片占位（上游能力门控已把图片投影为文本，这里兜底）。 */
function imagePlaceholder(attachment: { name?: string; attachmentId: unknown }): string {
  const digest = String(attachment.attachmentId).slice('sha256:'.length, 'sha256:'.length + 8)
  return `[image omitted because this model accepts text only${attachment.name ? `: ${attachment.name}` : `; attachment sha256:${digest}`}]`
}

/** 消息内容块的可见文本。 */
function blockText(block: any): string {
  switch (block?.type) {
    case 'text': return String(block.text ?? '')
    case 'image': return imagePlaceholder(block.attachment ?? {})
    case 'file': return `[file attachment: ${block.attachment?.name ?? 'unnamed'}]`
    case 'reasoning': return '' // 历史里的思考不回放
    default: return ''
  }
}

/** dsh 请求 → 聊天消息数组（工具协议渲染含在内）。 */
export function toChatRequest(
  options: Pick<GenerateOptions, 'messages' | 'system' | 'tools'>,
): { system: string; messages: ChatMessage[] } {
  const callNames = new Map<string, string>()
  const out: ChatMessage[] = []
  let baseSystem = ''
  const push = (role: ChatMessage['role'], content: string) => {
    if (!content) return
    const last = out.at(-1)
    if (last?.role === role) last.content += `\n\n${content}`
    else out.push({ role, content })
  }
  const walk = (message: RequestMessage): void => {
    if (message.role === 'system') {
      baseSystem = message.content.map(blockText).filter(Boolean).join('\n')
      return
    }
    if (message.role === 'developer') return // toolUpdate 未声明的路由不含 developer 消息；兜底跳过
    if (message.role === 'tool') {
      const name = callNames.get(message.toolCallId) ?? 'tool'
      const body = message.content.map(blockText).filter(Boolean).join('\n') || '(empty result)'
      push('user', `<tool_result name="${name}"${message.isError ? ' error="true"' : ''}>\n${clampResult(body)}\n</tool_result>`)
      return
    }
    const texts: string[] = []
    for (const block of message.content) {
      if (block.type === 'tool-call') {
        callNames.set(block.id, block.name)
        texts.push(`<tool_call>\n{"name": ${JSON.stringify(block.name)}, "arguments": ${block.arguments}}\n</tool_call>`)
        continue
      }
      const text = blockText(block)
      if (text) texts.push(text)
    }
    push(message.role, texts.join('\n'))
  }
  for (const message of options.messages) walk(message)
  const tools = (options.tools ?? []) as ToolSpec[]
  const system = [options.system, baseSystem, protocolPrompt(tools)].filter(Boolean).join('\n\n')
  // dsh 的对话以 user 消息开头之外还可能合出 assistant 开头（续聊场景），占位保持交替
  if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: '(conversation start)' })
  return { system, messages: out }
}
