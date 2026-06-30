import { existsSync, readFileSync } from 'node:fs'
import { join, normalize } from 'node:path'
import type { AppSettings } from '../../shared/types'
import { buildSystemPrompt } from '../prompt/main-chat'
import type { WebEventSink } from './types'
import {
  currentWebSessionId,
  handleWebMemoryList,
  loadWebSettings,
  mergeWebEngineState,
  newWebTurnId,
  resolveWebDataRoot,
  saveWebState,
} from './runtime'

export type WebContextBuildArgs = {
  userText: string
  explicitRel?: string
  recentMessages?: Array<{ role: 'user' | 'assistant'; content: string }>
  sessionId?: string
  turnIndex?: number
  systemHint?: string
}

export type WebContextBuildResult = {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  skipLlm: false
  turnId: string
  tracePreview?: unknown
  dispatchTriggered?: null
  useWaveChat?: false
}

function assertSettings(value: unknown): AppSettings {
  if (value && typeof value === 'object') return value as AppSettings
  return loadWebSettings()
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n...`
}

function safeRelPath(rel: string): string | null {
  const normalized = normalize(rel).replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('../') || normalized === '..' || normalized.includes('\0')) {
    return null
  }
  return normalized.replace(/^\/+/, '')
}

function explicitDocumentBlock(root: string, settings: AppSettings, rel?: string): string {
  if (!rel) return ''
  const safe = safeRelPath(rel)
  if (!safe) return ''
  const full = join(root, safe)
  if (!existsSync(full)) return ''
  try {
    return `【用户指定文档 ${safe}】\n${clip(readFileSync(full, 'utf-8'), settings.singleFileSoftLimitBytes)}`
  } catch {
    return ''
  }
}

function memoryFactsBlock(): string {
  try {
    const facts = handleWebMemoryList()
      .slice(0, 12)
      .map((fact) => {
        const subject = Array.isArray(fact.subject) ? fact.subject.join(' / ') : String(fact.subject ?? '')
        return `- ${subject}: ${fact.summary}`
      })
      .filter(Boolean)
    return facts.length ? `【长期记忆摘要】\n${facts.join('\n')}` : ''
  } catch {
    return ''
  }
}

function resolveChatCompletionsUrl(settings: AppSettings): string {
  const raw = (settings.openaiBaseUrl || '').trim() || 'https://api.openai.com/v1'
  if (/\/chat\/completions\b/i.test(raw)) return raw.replace(/\/+$/, '')
  return `${raw.replace(/\/+$/, '')}/chat/completions`
}

function buildHeaders(settings: AppSettings): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const key = (settings.openaiApiKey || '').trim()
  if (key) {
    if ((settings.apiKeyHeaderMode ?? 'bearer') === 'x-api-key') headers['x-api-key'] = key
    else headers.authorization = `Bearer ${key}`
  }
  const extra = (settings.llmExtraHeadersJson || '').trim()
  if (extra) {
    try {
      const parsed = JSON.parse(extra) as Record<string, unknown>
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') headers[k] = String(v)
      }
    } catch {
      /* ignore invalid custom headers */
    }
  }
  return headers
}

function extractDelta(line: string): string {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return ''
  const data = trimmed.slice(5).trim()
  if (!data || data === '[DONE]') return ''
  try {
    const parsed = JSON.parse(data) as {
      choices?: Array<{ delta?: { content?: string }; message?: { content?: string }; text?: string }>
    }
    return (
      parsed.choices?.[0]?.delta?.content ??
      parsed.choices?.[0]?.message?.content ??
      parsed.choices?.[0]?.text ??
      ''
    )
  } catch {
    return ''
  }
}

export async function handleWebContextBuild(args: WebContextBuildArgs): Promise<WebContextBuildResult> {
  const settings = loadWebSettings()
  const root = resolveWebDataRoot(settings)
  const now = new Date()
  const localClock = `【系统时钟 · 本地】${now.toISOString()}`
  const systemParts = [
    buildSystemPrompt(settings),
    settings.companionSystemHint,
    localClock,
    args.systemHint,
    memoryFactsBlock(),
    explicitDocumentBlock(root, settings, args.explicitRel),
  ].filter((part): part is string => Boolean(part && part.trim()))

  const messages: WebContextBuildResult['messages'] = [
    { role: 'system', content: systemParts.join('\n\n') },
  ]
  for (const message of (args.recentMessages ?? []).slice(-20)) {
    if (
      (message.role === 'user' || message.role === 'assistant') &&
      typeof message.content === 'string' &&
      message.content.trim()
    ) {
      messages.push({ role: message.role, content: message.content })
    }
  }
  const last = messages[messages.length - 1]
  if (!(last?.role === 'user' && last.content === args.userText)) {
    messages.push({ role: 'user', content: args.userText })
  }

  return {
    messages,
    skipLlm: false,
    turnId: newWebTurnId(),
    dispatchTriggered: null,
    useWaveChat: false,
  }
}

export async function handleWebChatStart(
  payload: Record<string, unknown>,
  sink: WebEventSink
): Promise<void> {
  const settings = assertSettings(payload.settings)
  const messages = Array.isArray(payload.messages) ? payload.messages : []
  const turnId = typeof payload.turnId === 'string' ? payload.turnId : newWebTurnId()

  if ((settings.llmProvider ?? 'openai') === 'anthropic') {
    sink.send('chat:error', 'Ackem Web runtime currently supports OpenAI-compatible chat only.')
    return
  }
  if (messages.length === 0) {
    sink.send('chat:error', 'chat:start requires messages')
    return
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs || 120_000)
  let assistantText = ''

  try {
    sink.send('chat:stream-start', {})
    sink.send('chat:status', '正在连接模型...')
    const response = await fetch(resolveChatCompletionsUrl(settings), {
      method: 'POST',
      headers: buildHeaders(settings),
      body: JSON.stringify({
        model: settings.model,
        messages,
        stream: true,
        temperature: 0.7,
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      sink.send('chat:error', `HTTP ${response.status}: ${text.slice(0, 500)}`)
      return
    }

    if (!response.body) {
      const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
      assistantText = json.choices?.[0]?.message?.content ?? ''
      if (assistantText) sink.send('chat:replace', assistantText)
      sink.send('chat:done', { assistantText, turnId })
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const delta = extractDelta(line)
        if (!delta) continue
        assistantText += delta
        sink.send('chat:chunk', delta)
      }
    }
    const tail = extractDelta(`data: ${buffer.trim()}`)
    if (tail) {
      assistantText += tail
      sink.send('chat:chunk', tail)
    }

    if (!assistantText.trim()) sink.send('chat:replace', '...')
    sink.send('chat:done', { assistantText: assistantText || '...', turnId })

    const root = resolveWebDataRoot(settings)
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : currentWebSessionId()
    const state = mergeWebEngineState(root, settings)
    state.lastActive = new Date().toISOString()
    state.counters = {
      ...state.counters,
      totalTurns: (state.counters?.totalTurns ?? 0) + 1,
    }
    saveWebState(root, state, sessionId)
  } catch (error) {
    sink.send('chat:error', error instanceof Error ? error.message : String(error))
  } finally {
    clearTimeout(timer)
  }
}
