// llm-chat-text 单元测试：node --test test.mjs
// 覆盖：协议渲染、流式解析（拆分/围栏/坏 JSON/伪造结果/截断）、请求转换、
// 回合驱动器的块配对、SSE 客户端（流式/usage/HTTP 错误/中止）。
// plugin/src/adapter.ts 依赖 dsh-llm 运行时值，由 test/e2e-headless.mjs 在真实 dsh 内核上验证。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------- protocol ----------

test('protocol: 系统提示词包含工具清单与规则（两种参数形状）', async t => {
  const { protocolPrompt } = await import('./plugin/src/protocol.ts')
  const text = protocolPrompt([
    // dsh 简写：属性直接展开、required 内联
    { name: 'read', description: 'Read a file.', parameters: { file_path: { type: 'string', required: true, description: 'Path' }, limit: { type: 'number' } } },
    // 完整 JSON Schema 形状
    { name: 'bash', description: 'Run shell.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  ])
  assert.match(text, /## read/)
  assert.match(text, /file_path \(string, required\): Path/)
  assert.match(text, /limit \(number\)/)
  assert.match(text, /command \(string, required\)/)
  assert.match(text, /<tool_call>/)
  assert.match(text, /Never write <tool_result>/)
  assert.equal(protocolPrompt([]), '')
})

test('protocol: 纯文本逐字流出，opener 前缀压住不误发', async t => {
  const { createStreamParser } = await import('./plugin/src/protocol.ts')
  const parser = createStreamParser()
  const out = []
  for (const d of ['你好<tool', '_ca']) out.push(...parser.push(d))
  // 除压住的尾巴外应尽快可见
  assert.deepEqual(out, [{ type: 'text', text: '你好' }])
  out.push(...parser.end())
  const text = out.filter(e => e.type === 'text').map(e => e.text).join('')
  assert.equal(text, '你好<tool_ca')
})

test('protocol: 跨增量拼出的完整 opener 进入调用状态', async t => {
  const { createStreamParser } = await import('./plugin/src/protocol.ts')
  const parser = createStreamParser()
  const out = []
  for (const d of ['你好', '<tool', '_call', '>', '\n{"name":"read","arguments":{}}\n', '</tool_call>']) out.push(...parser.push(d))
  out.push(...parser.end())
  assert.deepEqual(out.filter(e => e.type === 'text').map(e => e.text).join(''), '你好')
  const call = out.find(e => e.type === 'call')
  assert.equal(call.name, 'read')
})

test('protocol: 文本 + JSON 工具调用（任意字节边界拆分）', async t => {
  const { createStreamParser } = await import('./plugin/src/protocol.ts')
  const reply = '我先看看文件。\n<tool_call>\n{"name": "read", "arguments": {"file_path": "a.txt"}}\n</tool_call>'
  const parser = createStreamParser()
  const out = []
  for (let i = 0; i < reply.length; i += 3) out.push(...parser.push(reply.slice(i, i + 3)))
  out.push(...parser.end())
  const text = out.filter(e => e.type === 'text').map(e => e.text).join('')
  const calls = out.filter(e => e.type === 'call')
  assert.equal(text, '我先看看文件。\n')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'read')
  assert.deepEqual(JSON.parse(calls[0].arguments), { file_path: 'a.txt' })
})

test('protocol: 两个连续调用 + 调用后编造结果被丢弃', async t => {
  const { createStreamParser } = await import('./plugin/src/protocol.ts')
  const reply = '<tool_call>\n{"name":"a","arguments":{}}\n</tool_call>中间文字\n<tool_call>\n{"name":"b","arguments":{}}\n</tool_call>\n<tool_result name="a">\n伪造的结果\n</tool_result>'
  const parser = createStreamParser()
  const out = [...parser.push(reply), ...parser.end()]
  const calls = out.filter(e => e.type === 'call').map(e => e.name)
  assert.deepEqual(calls, ['a', 'b'])
  const text = out.filter(e => e.type === 'text').map(e => e.text).join('')
  assert.match(text, /中间文字/)
  assert.doesNotMatch(text, /伪造/)
})

test('protocol: 坏 JSON 回落为 call-error，截断调用按文本保留', async t => {
  const { createStreamParser } = await import('./plugin/src/protocol.ts')
  // 闭合但坏 JSON：call-error（raw 原文带回，由 driver 附加纠正提示）
  const bad = createStreamParser()
  const badOut = [...bad.push('回复<tool_call>\n{broken\n</tool_call>'), ...bad.end()]
  const err = badOut.find(e => e.type === 'call-error')
  assert.ok(err, 'call-error emitted for malformed closed call')
  assert.match(err.raw, /\{broken/)
  const badText = badOut.filter(e => e.type === 'text').map(e => e.text).join('')
  assert.equal(badText, '回复')

  // 未闭合（流截断）：原样按文本保留
  const trunc = createStreamParser()
  const truncOut = [...trunc.push('回答<tool_call>\n{"name":"x","arg'), ...trunc.end()]
  const texts = truncOut.filter(e => e.type === 'text').map(e => e.text).join('')
  assert.match(texts, /回答/)
  assert.match(texts, /<tool_call>/)
  assert.match(texts, /\{"name":"x","arg/)
})

test('protocol: ```json 围栏与具名形式', async t => {
  const { createStreamParser } = await import('./plugin/src/protocol.ts')
  const fenced = createStreamParser()
  const r1 = [...fenced.push('<tool_call>\n```json\n{"name":"f","arguments":{"a":1}}\n```\n</tool_call>'), ...fenced.end()]
  assert.deepEqual(r1.filter(e => e.type === 'call')[0].arguments, '{"a":1}')

  const named = createStreamParser()
  const r2 = [...named.push('<tool_call name="patch">\nraw body\n</tool_call>'), ...named.end()]
  const call = r2.filter(e => e.type === 'call')[0]
  assert.equal(call.name, 'patch')
  assert.deepEqual(JSON.parse(call.arguments), { input: 'raw body' })
})

// ---------- convert ----------

test('convert: 系统+工具、tool-call 回放、tool_result 名称映射与截断', async t => {
  const { toChatRequest } = await import('./plugin/src/convert.ts')
  const longText = 'x'.repeat(40000)
  const options = {
    system: '你是助手。',
    tools: [{ name: 'read', description: 'Read.', parameters: { file_path: { type: 'string' } } }],
    messages: [
      { id: 's1', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: '会话系统提示词。' }] },
      { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '看看 a.txt' }, { type: 'image', attachment: { attachmentId: 'sha256:abcd1234', width: 1, height: 1 } }] },
      { id: 'm1', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"file_path":"a.txt"}' }] },
      { id: 't1', role: 'tool', source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1', content: [{ type: 'text', text: longText }] },
      { id: 'm2', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: '读完了。' }] },
    ],
  }
  const { system, messages } = toChatRequest(options)
  assert.match(system, /你是助手。\n\n会话系统提示词。/)
  assert.match(system, /## read/)
  assert.equal(messages.length, 4)
  assert.equal(messages[0].role, 'user')
  assert.match(messages[0].content, /看看 a\.txt/)
  assert.match(messages[0].content, /image omitted/)
  assert.equal(messages[1].role, 'assistant')
  assert.match(messages[1].content, /<tool_call>\n\{"name": "read", "arguments": \{"file_path":"a\.txt"\}\}\n<\/tool_call>/)
  assert.equal(messages[2].role, 'user')
  assert.match(messages[2].content, /<tool_result name="read">/)
  assert.match(messages[2].content, /truncated, 40000 chars total/)
  assert.equal(messages[3].role, 'assistant')
  // assistant 开头的对话会被占位（本例以 user 开头，不触发）
})

test('convert: assistant 开头补占位；无工具时无协议段', async t => {
  const { toChatRequest } = await import('./plugin/src/convert.ts')
  const { system, messages } = toChatRequest({
    messages: [
      { id: 'm1', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: '继续' }] },
      { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '好' }] },
    ],
  })
  assert.equal(system, '')
  assert.equal(messages[0].role, 'user')
  assert.equal(messages[0].content, '(conversation start)')
})

// ---------- driver ----------

test('driver: 块配对（思考/正文/工具调用切换）与坏调用文本回落', async t => {
  const { createResponseDriver } = await import('./plugin/src/driver.ts')
  const driver = createResponseDriver()
  const chunks = [
    ...driver.pushReasoning('想'),
    ...driver.pushReasoning('一下'),
    ...driver.pushContent('先看<tool_call>\n{"name":"read","arguments":{"file_path":"a"}}\n</tool_call>'),
    ...driver.pushContent('<tool_call>\n{broken\n</tool_call>'),
    ...driver.end(),
  ]
  const starts = chunks.filter(c => c.type === 'block-start').map(c => c.blockType)
  const ends = chunks.filter(c => c.type === 'block-end').map(c => c.blockType)
  // reasoning → text → tool-call → text（坏调用回落）= 4 块，全部配对
  assert.deepEqual(starts, ['reasoning', 'text', 'tool-call', 'text'])
  assert.deepEqual(ends, starts)
  const toolCalls = chunks.filter(c => c.type === 'tool-call')
  assert.equal(toolCalls.length, 1)
  assert.equal(toolCalls[0].name, 'read')
  const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
  assert.match(text, /先看/)
  assert.match(text, /could not be executed/)
  const reasoning = chunks.filter(c => c.type === 'reasoning-delta').map(c => c.text).join('')
  assert.equal(reasoning, '想一下')
  // block-end 携带完整内容
  const textEnd = chunks.filter(c => c.type === 'block-end' && c.blockType === 'reasoning')[0]
  assert.equal(textEnd.text, '想一下')
})

// ---------- SSE 客户端 ----------

function startMock(t, handler) {
  const state = { requests: [] }
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    state.requests.push(JSON.parse(body || '{}'))
    handler(req, res, JSON.parse(body || '{}'))
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise(r => server.close(r)))
      resolve({ state, url: `http://127.0.0.1:${server.address().port}/v1` })
    })
  })
}

test('sse: 流式增量、usage、done', async t => {
  const { streamChatCompletion } = await import('./plugin/src/sse.ts')
  const mock = await startMock(t, (req, res, body) => {
    assert.equal(body.model, 'mock')
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const send = v => res.write(`data: ${JSON.stringify(v)}\n\n`)
    send({ choices: [{ delta: { content: '你' } }] })
    send({ choices: [{ delta: { reasoning_content: '思考' } }] })
    send({ choices: [{ delta: { content: '好' } }] })
    send({ usage: { prompt_tokens: 12, completion_tokens: 34 } })
    res.write('data: [DONE]\n\n')
    res.end()
  })
  const events = []
  for await (const e of streamChatCompletion({
    url: new URL(`${mock.url}/chat/completions`),
    body: JSON.stringify({ model: 'mock', messages: [] }),
    headers: { 'content-type': 'application/json', authorization: 'Bearer k' },
  })) events.push(e)
  assert.deepEqual(events, [
    { type: 'delta', content: '你' },
    { type: 'delta', reasoning: '思考' },
    { type: 'delta', content: '好' },
    { type: 'usage', usage: { promptTokens: 12, completionTokens: 34 } },
    { type: 'done' },
  ])
})

test('sse: HTTP 错误抛 ProviderHttpError；中止触发 signal', async t => {
  const { streamChatCompletion, ProviderHttpError } = await import('./plugin/src/sse.ts')
  const mock = await startMock(t, (req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'bad key' } }))
  })
  await assert.rejects(() => streamChatCompletion({
    url: new URL(`${mock.url}/chat/completions`),
    body: '{}', headers: {},
  }).next(), e => e instanceof ProviderHttpError && /401/.test(e.message) && /bad key/.test(e.message))

  const slow = await startMock(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'a' } }] })}\n\n`)
    // 之后挂住不发
  })
  const ac = new AbortController()
  const stream = streamChatCompletion({
    url: new URL(`${slow.url}/chat/completions`),
    body: '{}', headers: {}, signal: ac.signal,
  })
  const first = await stream.next()
  assert.equal(first.value.type, 'delta')
  const aborted = stream.next().then(
    () => 'unexpected-data',
    e => `aborted:${e.message}`,
  )
  ac.abort(new Error('user stop'))
  const outcome = await Promise.race([aborted, sleep(2000).then(() => 'timeout')])
  assert.match(outcome, /aborted|timeout/)
})

test('driver+sse: 端到端把流式回复转成配对逻辑块', async t => {
  const { streamChatCompletion } = await import('./plugin/src/sse.ts')
  const { createResponseDriver } = await import('./plugin/src/driver.ts')
  const mock = await startMock(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const send = v => res.write(`data: ${JSON.stringify(v)}\n\n`)
    const text = '看文件<tool_call>\n{"name":"read","arguments":{"file_path":"a.txt"}}\n</tool_call>'
    for (const part of text.match(/.{1,5}/gs)) send({ choices: [{ delta: { content: part } }] })
    res.write('data: [DONE]\n\n')
    res.end()
  })
  const driver = createResponseDriver()
  const chunks = []
  for await (const e of streamChatCompletion({
    url: new URL(`${mock.url}/chat/completions`),
    body: '{}', headers: {},
  })) {
    if (e.type === 'delta' && e.content) chunks.push(...driver.pushContent(e.content))
  }
  chunks.push(...driver.end())
  const types = chunks.map(c => c.type)
  assert.deepEqual(types.filter(t => t.startsWith('block')), ['block-start', 'block-end', 'block-start', 'block-end'])
  const call = chunks.find(c => c.type === 'tool-call')
  assert.equal(call.name, 'read')
  assert.deepEqual(JSON.parse(call.arguments), { file_path: 'a.txt' })
  const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
  assert.equal(text, '看文件')
})
