// 一次性准备：把 dsh 安装里的 peer 依赖链接进本项目的 node_modules，
// 让插件的 bare import（@deepseek-ai/dsh-llm、@deepseek-ai/schemastery）能被 Node 原生解析。
// 幂等：链接已存在则跳过。用法：node setup.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)))

/** dsh 安装的 node_modules（全局 npm 安装；其它安装位置可用 --install-root 覆盖）。 */
function findInstallRoot() {
  const explicit = process.argv[2]
  if (explicit) return path.resolve(explicit)
  const candidates = [
    path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'),
    path.join(os.homedir(), '.local', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules',
  ]
  return candidates.find(dir => fs.existsSync(path.join(dir, '@deepseek-ai', 'dsh-llm')))
}

export function ensurePeerLinks({ installRoot = findInstallRoot(), root = ROOT } = {}) {
  if (!installRoot) throw new Error('找不到 dsh 安装目录：请先 npm i -g @deepseek-ai/dsh，或把安装的 node_modules 路径作为参数传入')
  const missing = ['@deepseek-ai/dsh-llm', '@deepseek-ai/schemastery'].filter(name => !fs.existsSync(path.join(installRoot, name)))
  if (missing.length) throw new Error(`dsh 安装目录缺少依赖：${missing.join(', ')}（installRoot=${installRoot}）`)
  const linked = []
  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-llm', '@deepseek-ai/schemastery']) {
    const scopeDir = path.join(root, 'node_modules', '@deepseek-ai')
    const link = path.join(scopeDir, name.split('/')[1])
    fs.mkdirSync(scopeDir, { recursive: true })
    if (fs.existsSync(link)) continue
    // Windows 用 junction（免管理员权限）；其它平台用目录符号链接
    fs.symlinkSync(path.join(installRoot, name), link, 'junction')
    linked.push(name)
  }
  return { installRoot, linked }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { installRoot, linked } = ensurePeerLinks()
    console.log(`peer 依赖就绪（dsh 安装：${installRoot}）${linked.length ? `，新建链接：${linked.join(', ')}` : '，链接已存在'}`)
  } catch (e) {
    console.error(`setup 失败：${e.message}`)
    process.exit(1)
  }
}
