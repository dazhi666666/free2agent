// 端到端验证：真实 dsh 内核（headless profile）+ llm-chat-text 插件 + mock 对话模型。
// mock 模型按历史里是否有 tool_result 切换脚本：无 → 发起一次 read 工具调用（文本协议）；有 → 给出最终回答。
// 注意：dsh 用 spawnSync 阻塞运行，mock 必须在独立子进程里。
// 运行：node test/e2e-headless.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
await import(new URL('../setup.mjs', import.meta.url).href).then(m => m.ensurePeerLinks())
const MARKER = 'CHAT-PLUGIN-E2E-6f2b91'
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-chat-e2e-'))
const workspaceFile = path.join(workspace, 'note.txt')
fs.writeFileSync(workspaceFile, `hello from ${MARKER}\n`)
const dshHome = path.join(workspace, 'dsh-home')
const profileDir = path.join(dshHome, 'profiles', 'e2e')
fs.mkdirSync(profileDir, { recursive: true })
fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
  name: 'e2e', private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
}, null, 2))

// ---- mock 模型子进程：按历史里是否有 tool_result 切换脚本；每次请求把计数落盘 ----
const mockScript = path.join(workspace, 'mock-model.mjs')
const counterFile = path.join(workspace, 'mock-requests.txt')
const pluginPath = path.join(ROOT, 'plugin', 'src', 'index.ts').split(path.sep).join('/')
const patchPath = path.join(profileDir, 'cordis.patch.yml')
fs.writeFileSync(mockScript, `
import http from 'node:http'
import fs from 'node:fs'
const workspaceFile = ${JSON.stringify(workspaceFile)}
const MARKER = ${JSON.stringify(MARKER)}
const counterFile = ${JSON.stringify(counterFile)}
let requestCount = 0
const server = http.createServer(async (req, res) => {
  let body = ''
  for await (const c of req) body += c
  requestCount += 1
  fs.writeFileSync(counterFile, String(requestCount))
  const sawToolResult = (JSON.parse(body || '{}').messages || []).some(m => String(m.content).includes('<tool_result'))
  const script = sawToolResult
    ? [{ choices: [{ delta: { content: '文件内容是：' + MARKER } }] }, { usage: { prompt_tokens: 100, completion_tokens: 20 } }]
    : [
      { choices: [{ delta: { content: '我先读取文件内容。\\n' } }] },
      { choices: [{ delta: { content: '<tool_call>\\n{"name": "read", "arguments": {"file_path": ' + JSON.stringify(JSON.stringify(workspaceFile)) + '}}\\n</tool_call>' } }] },
    ]
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const send = v => res.write('data: ' + JSON.stringify(v) + '\\n\\n')
  for (const chunk of script) send(chunk)
  res.write('data: [DONE]\\n\\n')
  res.end()
})
server.listen(0, '127.0.0.1', () => process.stdout.write('MOCK_PORT=' + server.address().port + '\\n'))
`)
const mock = spawn(process.execPath, [mockScript], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] })
const port = await new Promise((resolve, reject) => {
  let buf = ''
  mock.stdout.on('data', d => {
    buf += String(d)
    const m = buf.match(/MOCK_PORT=(\d+)/)
    if (m) resolve(Number(m[1]))
  })
  mock.on('exit', () => reject(new Error('mock model exited early')))
  setTimeout(() => reject(new Error('mock model start timeout')), 10000)
})
const baseURL = `http://127.0.0.1:${port}/v1`

// ---- profile 的 cordis.patch.yml：插件（相对锚定到本项目）+ 默认模型 ----
fs.writeFileSync(patchPath, `
- insert:
    - id: llm-chat-text
      name: '${pluginPath}'
      config:
        providers:
          e2e:
            displayName: E2E Mock
            baseURL: ${baseURL}
            noAuth: true
            contextWindow: 32000
            models:
              - id: mock-model
                name: Mock Model
- id: agent-default-model
  config:
    provider: e2e
    model: mock-model
`)

// ---- 跑真实 dsh headless（Windows 的 npm 垫片是 .cmd，spawnSync 直接跑不了：用 node + bin.js） ----
const dshBin = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
if (!fs.existsSync(dshBin)) {
  console.error(`E2E FAILED: dsh CLI not installed at ${dshBin} (npm i -g @deepseek-ai/dsh)`)
  mock.kill()
  fs.rmSync(workspace, { recursive: true, force: true })
  process.exit(1)
}
const task = `读取 ${workspaceFile} 并把文件内容原样告诉我`
const run = spawnSync(process.execPath, [dshBin, '--profile', 'e2e', '--json', task], {
  cwd: workspace,
  encoding: 'utf8',
  timeout: 180000,
  windowsHide: true,
  env: { ...process.env, DSH_HOME: dshHome },
})

const stdout = String(run.stdout || '')
const stderr = String(run.stderr || '')
const events = stdout.split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } })
if (process.env.E2E_DEBUG) for (const e of events) console.log('EVENT', e.type, JSON.stringify(e).slice(0, 200))
const toolCalls = events.filter(e => /tool.?call/i.test(String(e.type)))
const finalEvent = events.filter(e => ['message', 'result', 'final'].includes(String(e.type))).at(-1)
const summary = {
  exitCode: run.status,
  eventTypes: [...new Set(events.map(e => e.type))],
  toolCallEvents: toolCalls.length,
  finalText: finalEvent?.text ?? finalEvent?.message ?? stdout.slice(-500),
  stderrTail: stderr.split('\n').filter(Boolean).slice(-8),
}

let ok = false
try {
  assert.ok(run.status === 0, `dsh exited ${run.status}: ${stderr.slice(-1200)}`)
  // 铁证链：mock 只在历史里见到 <tool_result>（即 dsh 真的执行了 read 并回传结果）才吐含 MARKER 的回答
  const mockRequests = Number(fs.readFileSync(counterFile, 'utf8') || 0)
  assert.ok(mockRequests >= 2, `expected >=2 model requests, got ${mockRequests}`)
  assert.ok(
    JSON.stringify(summary.finalText).includes(MARKER),
    'final answer lacks the file content marker (tool result never reached the model?)',
  )
  ok = true
  console.log('E2E OK: 纯文本模型经文本协议完成了 dsh 工具调用与回答')
} catch (e) {
  console.error('E2E FAILED:', e.message)
}
console.log(JSON.stringify(summary, null, 1))
mock.kill()
fs.rmSync(workspace, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
