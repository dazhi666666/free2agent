/** 回合流式状态机：SSE 正文/思考增量 → 配对好的逻辑块序列（可 1:1 映射成 dsh StreamChunk）。
 * 纯逻辑，不依赖 dsh-llm 的运行时值，可独立单测。 */
import { createStreamParser } from './protocol.ts'
import type { ParseEvent, LogicalChunk } from './types.ts'

let callSeq = 0
function nextCallId(): string {
  callSeq += 1
  return `call-${callSeq}-${Math.random().toString(36).slice(2, 8)}`
}

interface OpenTextBlock { blockType: 'text' | 'reasoning'; text: string }

/** 创建一个回合驱动器。块配对规则：正文/思考各自一个块；工具调用独立成块；切换时自动闭合。 */
export function createResponseDriver(): {
  pushContent: (delta: string) => LogicalChunk[]
  pushReasoning: (delta: string) => LogicalChunk[]
  end: () => LogicalChunk[]
} {
  const parser = createStreamParser()
  let open: OpenTextBlock | null = null

  const closeBlock = (): LogicalChunk[] => {
    const block = open
    open = null
    return block ? [{ type: 'block-end', blockType: block.blockType, text: block.text }] : []
  }
  const openBlock = (blockType: 'text' | 'reasoning'): LogicalChunk[] => {
    if (open?.blockType === blockType) return []
    const chunks = closeBlock()
    open = { blockType, text: '' }
    chunks.push({ type: 'block-start', blockType })
    return chunks
  }
  const take = (event: ParseEvent): LogicalChunk[] => {
    if (event.type === 'text') {
      const chunks = openBlock('text')
      open!.text += event.text
      chunks.push({ type: 'text-delta', text: event.text })
      return chunks
    }
    // 工具调用：先闭合正文块
    const chunks = closeBlock()
    if (event.type === 'call') {
      const call = { id: nextCallId(), name: event.name, arguments: event.arguments }
      chunks.push({ type: 'block-start', blockType: 'tool-call' })
      chunks.push({ type: 'tool-call', ...call })
      chunks.push({ type: 'block-end', blockType: 'tool-call', text: '', call })
      return chunks
    }
    // 解析失败的调用：原样作为可见文本保留并附纠正提示，不让内容消失
    const textChunks = openBlock('text')
    const text = `\n<tool_call>\n${event.raw}\n</tool_call>\n\n(The tool call above could not be executed: ${event.error}. Reply again with one valid JSON tool call.)`
    open!.text += text
    textChunks.push({ type: 'text-delta', text })
    return [...chunks, ...textChunks]
  }
  return {
    pushContent: delta => {
      const out: LogicalChunk[] = []
      for (const event of parser.push(delta)) out.push(...take(event))
      return out
    },
    pushReasoning: delta => {
      if (!delta) return []
      const chunks = openBlock('reasoning')
      open!.text += delta
      chunks.push({ type: 'reasoning-delta', text: delta })
      return chunks
    },
    end: () => {
      const out: LogicalChunk[] = []
      for (const event of parser.end()) out.push(...take(event))
      out.push(...closeBlock())
      return out
    },
  }
}
