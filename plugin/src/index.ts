/** llm-chat-text：纯文本对话模型接入 dsh 内核的插件入口。
 * 每个 providers 配置段是一条 provider 路由；adapter 把 dsh 的工具 schema 渲染成文本协议、
 * 把模型回复里的 <tool_call> 转回原生工具调用，dsh 的 agent loop / 工具 / Web UI 全部照常工作。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { ChatTextAdapter } from './adapter.ts'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import type { ProviderProfile } from './types.ts'

export const name = 'llm-chat-text'
export const inject = ['llm']

export interface Options {
  providers: Record<string, ProviderProfile>
}

/** 配置 schema：providers 是 provider 路由 → 模型清单。改完配置保存，dsh 会自动重载本插件。 */
export const Config = z.object({
  providers: z.dict(z.object({
    displayName: z.string().default(''),
    baseURL: z.string().required(),
    apiKey: z.string(),
    apiKeyEnv: z.string(),
    noAuth: z.boolean(),
    headers: z.dict(z.string()),
    params: z.dict(z.any()),
    proxy: z.string(),
    timeoutSec: z.number(),
    contextWindow: z.number(),
    maxTokensField: z.string(),
    models: z.array(z.object({
      id: z.string().required(),
      name: z.string(),
      contextWindow: z.number(),
      maxTokens: z.number(),
    })).required(),
  })).required(),
})

/** 从配置对象提取当前路由快照（Config 实例或普通对象都兼容）。 */
function profilesOf(config: Options): ReadonlyMap<string, ProviderProfile> {
  const raw = typeof (config as any).providers?.get === 'function'
    ? (config.providers as unknown as { get(): Options['providers'] }).get()
    : config.providers
  const out = new Map<string, ProviderProfile>()
  for (const [provider, p] of Object.entries(raw ?? {})) {
    if (!p || typeof p !== 'object') continue
    out.set(provider, {
      displayName: p.displayName || provider,
      baseURL: p.baseURL,
      apiKey: p.apiKey,
      apiKeyEnv: p.apiKeyEnv,
      noAuth: p.noAuth,
      headers: p.headers,
      params: p.params,
      proxy: p.proxy,
      timeoutSec: p.timeoutSec,
      contextWindow: p.contextWindow,
      maxTokensField: p.maxTokensField,
      models: p.models ?? [],
    })
  }
  return out
}

/** 注册一个 adapter 服务全部已配置路由；路由集合变化时原子换绑（与官方 llm-pi-ai 同模式）。 */
export function apply(ctx: Context, config: Options): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  const log = (message: string) => { try { ctx.logger.info(`llm-chat-text: ${message}`) } catch {} }
  const profiles = () => profilesOf(config)
  const adapter = new ChatTextAdapter({ profiles, log })
  let registration: AdapterRegistrationHandle | undefined
  let registeredFacts = ''
  const ensure = (): void => {
    const facts = [...profiles().keys()].sort().join(',')
    if (facts === registeredFacts) return
    const routes = [...profiles().keys()]
    if (registration === undefined) {
      if (routes.length === 0) { registeredFacts = facts; return }
      registration = ctx.llm.registerAdapter(routes, adapter)
      log(`registered provider routes: ${routes.join(', ')}`)
    } else {
      registration.replace(routes)
      log(`provider routes updated: ${routes.join(', ') || '(none)'}`)
    }
    registeredFacts = facts
  }
  ensure()
  // 配置热更新（模型清单增减 → 原子换绑路由）
  ctx.on('loader/volatile-update', () => {
    try { ensure() } catch (error) {
      ctx.logger.error('llm-chat-text: configuration update failed')
      ctx.logger.error(error)
    }
  })
}
