/** 面向无原生工具调用模型的文本工具协议：系统提示词渲染 + 流式回复解析。
 * 协议沿用 Agent Router chat-agent 的 <tool_call>/<tool_result> 约定（JSON 形式为主），
 * 这里新增了逐字流式解析（delta 可拆在任意字节边界上）。 */
import type { ParseEvent, ToolSpec } from './types.ts'

const RESULT_LIMIT = 30000

/** 渲染一个 JSON Schema 属性类型的紧凑写法：string、number、string[]、object … */
function typeOf(schema = {} as Record<string, any>): string {
  const s = schema as any
  if (s.enum) return s.enum.map((v: unknown) => JSON.stringify(v)).join(' | ')
  if (s.type === 'array') return `${typeOf(s.items)}[]`
  return s.type || 'any'
}

/** 工具参数表：兼容完整 JSON Schema（{type:'object', properties, required}）与 dsh 工具的简写
 * （属性直接展开、required 内联在属性上）。 */
function parameterView(parameters: Record<string, unknown> | undefined): { props: Record<string, any>; required: Set<string> } {
  const p = (parameters ?? {}) as any
  const fullSchema = p.properties !== undefined && typeof p.properties === 'object'
  const props = (fullSchema ? p.properties : p) as Record<string, any>
  const required = new Set<string>(Array.isArray(p.required) ? p.required : [])
  for (const [k, v] of Object.entries(props)) {
    if (v && typeof v === 'object' && (v as any).required === true) required.add(k)
  }
  return { props, required }
}

/** 追加到系统提示词的工具协议说明。 */
export function protocolPrompt(tools: readonly ToolSpec[]): string {
  if (!tools.length) return ''
  const list = tools.map((t) => {
    const { props, required } = parameterView(t.parameters)
    const params = Object.entries(props)
      .map(([k, v]) => `- ${k} (${typeOf(v)}${required.has(k) ? ', required' : ''})${v?.description ? `: ${v.description}` : ''}`)
      .join('\n')
    return `## ${t.name}\n${t.description}\n${params ? `Parameters:\n${params}` : 'No parameters.'}`
  }).join('\n\n')
  return `
# Tools

You have no built-in tools. Call the tools below by writing tool call blocks in your reply:

<tool_call>
{"name": "tool_name", "arguments": {"param": "value"}}
</tool_call>

- JSON calls must be one valid JSON object with "name" and "arguments"; escape newlines and quotes inside strings.
- You may write several tool calls in one reply; they run in order. After your last call, stop writing and wait: the results arrive in the next message as <tool_result> blocks.
- Never write <tool_result> blocks yourself and never guess what a tool returned.
- Text outside tool call blocks is shown to the user. A reply without tool calls ends your turn, so finish with a message for the user.

${list}`.trim()
}

/** 剥掉某些模型包在块里的 ```json … ``` 围栏。 */
function unfence(s: string): string {
  const m = s.trim().match(/^```[\w-]*\s*\n([\s\S]*?)\n?```$/)
  return m ? m[1] : s.trim()
}

const OPENER_BASE = '<tool_call'
const GUARD_BASE = '<tool_result'
const CLOSER = '</tool_call>'

/** 把原始 JSON 体重建成一次工具调用；解析失败返回 call-error。 */
function parseJsonCall(raw: string): ParseEvent {
  const body = unfence(raw)
  if (!body) return { type: 'call-error', error: 'empty tool call', raw }
  let v: any
  try {
    v = JSON.parse(body)
  } catch (e) {
    return { type: 'call-error', error: `invalid JSON: ${(e as Error).message}`, raw }
  }
  const name = v.name ?? v.tool
  if (typeof name !== 'string' || !name) return { type: 'call-error', error: 'missing "name"', raw }
  let args = v.arguments ?? v.args ?? v.input ?? {}
  const argumentsString = typeof args === 'string' ? args : JSON.stringify(args ?? {})
  return { type: 'call', name, arguments: argumentsString }
}

/** 具名形式的调用体：raw 文本先按 JSON 解析（dsh 的工具都是 JSON schema）。 */
function parseNamedCall(name: string, raw: string): ParseEvent {
  const body = unfence(raw)
  let v: any
  try {
    v = JSON.parse(body)
  } catch {
    // 具名形式但 body 不是 JSON：当作 arguments 的纯文本输入
    const trimmed = raw.replace(/^\r?\n/, '').replace(/\r?\n$/, '')
    return { type: 'call', name, arguments: JSON.stringify({ input: trimmed }) }
  }
  const args = v && typeof v === 'object' && 'arguments' in v ? v.arguments : v
  return { type: 'call', name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) }
}

/** buffer 尾部可能仍是 opener/guard（前缀，或完整基串还在等闭合 '>'）时返回应压住的起点，否则返回 -1。 */
function heldbackIndex(buffer: string): number {
  for (const base of [OPENER_BASE, GUARD_BASE]) {
    for (let keep = Math.min(base.length, buffer.length); keep >= 1; keep--) {
      if (buffer.endsWith(base.slice(0, keep))) return buffer.length - keep
    }
  }
  return -1
}

const OPEN_TAG = /<tool_call(?:\s+name\s*=\s*["']([\w.-]+)["'])?\s*>/

/**
 * 逐字流式解析器。push() 收 SSE 正文增量，end() 收尾；
 * 可见文本尽快吐出（压住可能是 opener 前缀的尾巴），工具调用在闭合后整块给出。
 */
export interface StreamParser {
  push(delta: string): ParseEvent[]
  end(): ParseEvent[]
}

export function createStreamParser(): StreamParser {
  let buffer = ''
  let state: 'text' | 'call' = 'text'
  let callName: string | null = null // null = JSON 形式
  let callBody = ''
  let dropped = false // 模型自己编造 <tool_result：其后内容全部丢弃

  const emitCall = (): ParseEvent[] => {
    const event = callName === null
      ? parseJsonCall(callBody)
      : parseNamedCall(callName, callBody)
    state = 'text'
    callName = null
    callBody = ''
    return [event]
  }

  return {
    push(delta) {
      const events: ParseEvent[] = []
      buffer += delta
      for (;;) {
        if (dropped) { buffer = ''; break }
        if (state === 'text') {
          // 模型编造结果：从这里到结尾全部丢弃——但只在它先于下一个 opener 出现时
          // （调用块之后的伪造结果才该丢；调用块本身必须照常解析）
          const fake = buffer.indexOf(GUARD_BASE)
          const open = OPEN_TAG.exec(buffer)
          if (fake !== -1 && (open === null || (open.index !== undefined && fake < open.index))) {
            if (fake > 0) events.push({ type: 'text', text: buffer.slice(0, fake) })
            dropped = true
            buffer = ''
            break
          }
          if (open && open.index !== undefined) {
            if (open.index > 0) events.push({ type: 'text', text: buffer.slice(0, open.index) })
            state = 'call'
            callName = open[1] ?? null
            callBody = ''
            buffer = buffer.slice(open.index + open[0].length)
            continue
          }
          // 压住可能是 opener/guard 前缀的尾巴，其余尽快发出
          const hold = heldbackIndex(buffer)
          const safe = hold === -1 ? buffer.length : hold
          if (safe > 0) {
            events.push({ type: 'text', text: buffer.slice(0, safe) })
            buffer = buffer.slice(safe)
          }
          break
        }
        // state === 'call'
        if (callName === null) {
          const close = buffer.indexOf(CLOSER)
          if (close === -1) break
          callBody += buffer.slice(0, close)
          buffer = buffer.slice(close + CLOSER.length)
          events.push(...emitCall())
          continue
        }
        // 具名形式：闭合标签需自成一行（补丁体可含任意文本），退而求其次匹配任意位置
        const lineClose = /(^|\n)<\/tool_call>/.exec(buffer)
        const anyClose = buffer.indexOf(CLOSER)
        if (lineClose) {
          callBody += buffer.slice(0, lineClose.index)
          buffer = buffer.slice(lineClose.index + lineClose[0].length)
          events.push(...emitCall())
          continue
        }
        if (anyClose !== -1) {
          callBody += buffer.slice(0, anyClose)
          buffer = buffer.slice(anyClose + CLOSER.length)
          events.push(...emitCall())
          continue
        }
        break
      }
      return events
    },
    end() {
      const events: ParseEvent[] = []
      if (state === 'call') {
        // 截断的调用：原样作为可见文本保留，不静默丢内容
        const opener = callName === null ? '<tool_call>' : `<tool_call name="${callName}">`
        events.push({ type: 'text', text: `\n${opener}\n${callBody}` })
        state = 'text'
        callName = null
        callBody = ''
      }
      if (!dropped && buffer) {
        const fake = buffer.indexOf(GUARD_BASE)
        events.push({ type: 'text', text: fake === -1 ? buffer : buffer.slice(0, fake) })
      }
      buffer = ''
      return events
    },
  }
}

/** 工具结果正文的截断上限（与协议提示里的行为一致）。 */
export function clampResult(text: string): string {
  return text.length > RESULT_LIMIT
    ? `${text.slice(0, RESULT_LIMIT)}\n… (truncated, ${text.length} chars total)`
    : text
}
