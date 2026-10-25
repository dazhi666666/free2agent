/** OpenAI 兼容 /chat/completions 的流式客户端：http/https + 可选 CONNECT 代理 + 整体超时 + 中止信号。
 * 纯 Node 内置模块，yield 出解析好的 SSE 事件。 */
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import type { SseEvent } from './types.ts'

export class ProviderHttpError extends Error {
  readonly status: number
  readonly body: string
  constructor(message: string, status: number, body: string) {
    super(message)
    this.status = status
    this.body = body
  }
}

export interface StreamOptions {
  url: URL
  body: string
  headers: Record<string, string>
  proxy?: string | null
  timeoutSec?: number
  signal?: AbortSignal
}

export async function* streamChatCompletion(opts: StreamOptions): AsyncGenerator<SseEvent> {
  const res = await request(opts)
  if (res.statusCode >= 400) {
    const raw = await readAll(res)
    let message = raw
    try { const j = JSON.parse(raw); message = j.error?.message || j.message || raw } catch {}
    throw new ProviderHttpError(`HTTP ${res.statusCode}: ${String(message).slice(0, 500)}`, res.statusCode ?? 0, raw.slice(0, 2000))
  }
  const isSse = /event-stream/.test(res.headers['content-type'] || '')
  if (!isSse) {
    // 非流式应答：整包读出后按一条完整消息处理
    const plain = await readAll(res)
    const j = JSON.parse(plain)
    const m = j.choices?.[0]?.message || {}
    if (j.usage) yield usageEvent(j.usage)
    if (m.content) yield { type: 'delta', content: String(m.content) }
    if (m.reasoning_content || m.reasoning) yield { type: 'delta', reasoning: String(m.reasoning_content || m.reasoning) }
    yield { type: 'done' }
    return
  }
  let buf = ''
  for await (const chunk of res) {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      const event = parseSseLine(line)
      if (event) yield event
    }
  }
}

function parseSseLine(line: string): SseEvent | null {
  if (!line.startsWith('data:')) return null
  const data = line.slice(5).trim()
  if (data === '[DONE]') return { type: 'done' }
  let ev: any
  try { ev = JSON.parse(data) } catch { return null }
  if (ev.error) throw new ProviderHttpError(String(ev.error.message || JSON.stringify(ev.error)), 0, data.slice(0, 2000))
  if (ev.usage) return usageEvent(ev.usage)
  const d = ev.choices?.[0]?.delta || {}
  const content = d.content || undefined
  const reasoning = d.reasoning_content || d.reasoning || undefined
  if (!content && !reasoning) return null
  return content !== undefined
    ? { type: 'delta', content, ...(reasoning !== undefined ? { reasoning } : {}) }
    : { type: 'delta', reasoning }
}

function usageEvent(u: any): SseEvent {
  const usage: SseEvent extends { type: 'usage'; usage: infer T } ? T : never = {}
  if (u.prompt_tokens) usage.promptTokens = Number(u.prompt_tokens)
  if (u.completion_tokens) usage.completionTokens = Number(u.completion_tokens)
  const reasoning = Number(u.completion_tokens_details?.reasoning_tokens)
  if (reasoning) usage.reasoningTokens = reasoning
  return { type: 'usage', usage }
}

function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = ''
    stream.setEncoding('utf8')
    stream.on('data', d => { s += d })
    stream.on('end', () => resolve(s))
    stream.on('error', reject)
  })
}

/** http(s) 请求，可选 HTTP CONNECT 代理与整体超时（不用 undici 的空闲限制）。 */
function request({ url, body, headers, proxy, timeoutSec = 600, signal }: StreamOptions): Promise<http.IncomingMessage> {
  const secure = url.protocol === 'https:'
  const port = Number(url.port) || (secure ? 443 : 80)
  const opts: https.RequestOptions = {
    method: 'POST',
    headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
    host: url.hostname, port, path: url.pathname + url.search,
  }
  const proxyPrepare = async (): Promise<void> => {
    if (!proxy) return
    const p = new URL(proxy)
    const auth = p.username
      ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')}` }
      : {}
    if (secure) {
      const socket = await connectTunnel(p, url.hostname, port, auth)
      ;(opts as any).createConnection = () => tls.connect({ socket, servername: url.hostname })
      ;(opts as any).agent = false
    } else {
      Object.assign(opts, { host: p.hostname, port: Number(p.port) || 80, path: url.href, headers: { ...opts.headers, ...auth } })
    }
  }
  return proxyPrepare().then(() => new Promise((resolve, reject) => {
    const req = (secure ? https : http).request(opts, (res: http.IncomingMessage) => { res.setEncoding('utf8'); resolve(res) })
    const timer = setTimeout(() => req.destroy(new Error(`request timed out after ${Math.round(timeoutSec * 1000) / 1000}s`)), timeoutSec * 1000)
    timer.unref?.()
    const abort = () => req.destroy(new Error('aborted'))
    signal?.addEventListener('abort', abort, { once: true })
    req.on('error', reject)
    req.on('close', () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) })
    req.end(body)
  }))
}

function connectTunnel(p: URL, host: string, port: number, auth: Record<string, string>): Promise<import('node:net').Socket> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: p.hostname, port: Number(p.port) || 80, method: 'CONNECT', path: `${host}:${port}`, headers: { Host: `${host}:${port}`, ...auth } })
    req.once('connect', (res, socket) => {
      if (res.statusCode === 200) resolve(socket)
      else { socket.destroy(); reject(new Error(`proxy CONNECT failed: HTTP ${res.statusCode}`)) }
    })
    req.once('error', reject)
    req.end()
  })
}
