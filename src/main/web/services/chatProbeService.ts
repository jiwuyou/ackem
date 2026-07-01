import type { AppSettings } from '../../../shared/types'
import { loadWebSettings } from '../runtime'
import type { WebHandlerRegistry } from '../types'

export type WebProbeLocalChatResult = {
  ok: boolean
  latencyMs?: number
  model?: string
  error?: string
  endpoint?: string
  method?: 'models' | 'chat'
  statusCode?: number
  models?: string[]
}

function mergeSettings(patch?: Partial<AppSettings>): AppSettings {
  return {
    ...loadWebSettings(),
    ...(patch ?? {}),
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function resolveLocalBaseUrl(settings: AppSettings): string {
  return (
    (settings.localChatBaseUrl ?? '').trim() ||
    (settings.openaiBaseUrl ?? '').trim() ||
    'http://127.0.0.1:11434/v1'
  )
}

function resolveLocalModel(settings: AppSettings): string {
  return (
    (settings.localChatModel ?? '').trim() ||
    (settings.model ?? '').trim()
  )
}

function resolveChatCompletionsUrl(base: string): string {
  const raw = trimTrailingSlash(base.trim())
  if (/\/chat\/completions\b/i.test(raw)) return raw
  return `${raw}/chat/completions`
}

function resolveModelsUrl(base: string): string {
  const raw = trimTrailingSlash(base.trim())
  if (/\/chat\/completions\b/i.test(raw)) return raw.replace(/\/chat\/completions\b.*$/i, '/models')
  if (/\/models\b/i.test(raw)) return raw
  return `${raw}/models`
}

function buildProbeHeaders(settings: AppSettings): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
  }
  const key = (settings.openaiApiKey ?? '').trim()
  if (key) {
    if ((settings.apiKeyHeaderMode ?? 'bearer') === 'x-api-key') headers['x-api-key'] = key
    else headers.authorization = `Bearer ${key}`
  }
  const extra = (settings.llmExtraHeadersJson ?? '').trim()
  if (extra) {
    try {
      const parsed = JSON.parse(extra) as Record<string, unknown>
      for (const [name, value] of Object.entries(parsed)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          headers[name] = String(value)
        }
      }
    } catch {
      /* Ignore invalid custom headers during a probe. */
    }
  }
  return headers
}

function probeTimeoutMs(settings: AppSettings): number {
  const configured = Number(settings.timeoutMs)
  const base = Number.isFinite(configured) && configured > 0 ? configured : 120_000
  return Math.max(1000, Math.min(base, 5000))
}

function parseModelIds(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  const data = (value as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  return data
    .map((item) => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>
        if (typeof record.id === 'string') return record.id
        if (typeof record.name === 'string') return record.name
        if (typeof record.model === 'string') return record.model
      }
      return ''
    })
    .filter(Boolean)
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'probe_timeout'
    return error.message || String(error)
  }
  return String(error)
}

async function withTimeout<T>(
  settings: AppSettings,
  task: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), probeTimeoutMs(settings))
  try {
    return await task(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

async function probeModels(
  settings: AppSettings,
  modelsUrl: string,
  model: string,
  startedAt: number
): Promise<WebProbeLocalChatResult> {
  return withTimeout(settings, async (signal) => {
    const res = await fetch(modelsUrl, {
      method: 'GET',
      headers: buildProbeHeaders(settings),
      signal,
    })
    const latencyMs = Date.now() - startedAt
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      return {
        ok: false,
        latencyMs,
        model,
        endpoint: modelsUrl,
        method: 'models',
        statusCode: res.status,
        error: `HTTP ${res.status}: ${text.slice(0, 200)}`,
      }
    }
    const json = (await res.json().catch(() => null)) as unknown
    const models = parseModelIds(json)
    if (model && models.length > 0 && !models.includes(model)) {
      return {
        ok: false,
        latencyMs,
        model,
        endpoint: modelsUrl,
        method: 'models',
        models: models.slice(0, 50),
        error: `model_not_found: ${model}`,
      }
    }
    return {
      ok: true,
      latencyMs,
      model,
      endpoint: modelsUrl,
      method: 'models',
      models: models.slice(0, 50),
    }
  })
}

async function probeChatCompletions(
  settings: AppSettings,
  chatUrl: string,
  model: string,
  startedAt: number
): Promise<WebProbeLocalChatResult> {
  return withTimeout(settings, async (signal) => {
    const res = await fetch(chatUrl, {
      method: 'POST',
      headers: buildProbeHeaders(settings),
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
        stream: false,
      }),
      signal,
    })
    const latencyMs = Date.now() - startedAt
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      return {
        ok: false,
        latencyMs,
        model,
        endpoint: chatUrl,
        method: 'chat',
        statusCode: res.status,
        error: `HTTP ${res.status}: ${text.slice(0, 200)}`,
      }
    }
    await res.text().catch(() => '')
    return {
      ok: true,
      latencyMs,
      model,
      endpoint: chatUrl,
      method: 'chat',
    }
  })
}

export async function handleWebProbeLocalChat(
  patch?: Partial<AppSettings>
): Promise<WebProbeLocalChatResult> {
  const settings = mergeSettings(patch)
  const base = resolveLocalBaseUrl(settings)
  const model = resolveLocalModel(settings)
  if (!base || !model) {
    return { ok: false, error: 'missing_base_or_model', model }
  }

  const modelsUrl = resolveModelsUrl(base)
  const chatUrl = resolveChatCompletionsUrl(base)
  const startedAt = Date.now()

  try {
    const modelProbe = await probeModels(settings, modelsUrl, model, startedAt)
    if (modelProbe.ok) return modelProbe
    const chatProbe = await probeChatCompletions(settings, chatUrl, model, startedAt)
    if (chatProbe.ok) return chatProbe
    return {
      ...chatProbe,
      error: `${modelProbe.method}: ${modelProbe.error}; ${chatProbe.method}: ${chatProbe.error}`,
    }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      model,
      endpoint: chatUrl,
      method: 'chat',
      error: errorText(error),
    }
  }
}

export function registerWebChatProbeHandlers(registry: WebHandlerRegistry): void {
  registry.set('settings:probeLocalChat', (patch) =>
    handleWebProbeLocalChat(patch as Partial<AppSettings> | undefined)
  )
}
