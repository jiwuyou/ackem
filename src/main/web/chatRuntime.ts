import { existsSync, readFileSync } from 'node:fs'
import { join, normalize } from 'node:path'
import type { MemoryAuditCardPayload } from '../../shared/memoryAudit'
import { buildMemoryAuditIntro, detectMemoryAuditIntent } from '../../shared/memoryAuditIntent'
import type { SearchCardPayload } from '../../shared/searchCard'
import type { AppSettings } from '../../shared/types'
import type { WavePlan, WaveSpec } from '../../shared/wavePlan'
import { buildSystemPrompt } from '../prompt/main-chat'
import { handleWebMemoryAuditReport } from './services/dataWorkflowService'
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

export {
  handleWebProbeLocalChat,
  registerWebChatProbeHandlers,
  type WebProbeLocalChatResult,
} from './services/chatProbeService'

type ChatRole = 'system' | 'user' | 'assistant'
type ChatMessage = { role: ChatRole; content: string }
type ChatProvider = AppSettings['llmProvider']

type ParsedSseLine = {
  text?: string
  done?: boolean
  error?: string
}

type ChatProviderResult = {
  assistantText: string
  provider: ChatProvider
  transport: 'sse' | 'json' | 'empty'
}

type WebCardMode = 'knowledge' | 'plan' | 'search'

type WebCardResult = {
  assistantText: string
  memoryWrites: string[]
}

export type WebContextBuildArgs = {
  userText: string
  explicitRel?: string
  recentMessages?: Array<{ role: 'user' | 'assistant'; content: string }>
  sessionId?: string
  turnIndex?: number
  systemHint?: string
  desktopAgentChatMode?: boolean
  dispatchRespond?: unknown
}

export type WebContextBuildResult = {
  messages: ChatMessage[]
  skipLlm: false
  turnId: string
  tracePreview?: unknown
  dispatchTriggered?: null
  dispatchBypassed?: boolean
  useWaveChat?: false
  sessionId?: string
}

function assertSettings(value: unknown): AppSettings {
  if (value && typeof value === 'object') return value as AppSettings
  return loadWebSettings()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item
        if (isRecord(item) && typeof item.text === 'string') return item.text
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (content == null) return ''
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

export function normalizeWebChatMessages(input: unknown): ChatMessage[] {
  if (!Array.isArray(input)) return []
  const out: ChatMessage[] = []
  for (const item of input) {
    if (!isRecord(item)) continue
    const role = item.role
    if (role !== 'system' && role !== 'user' && role !== 'assistant') continue
    const content = contentToText(item.content).trim()
    if (!content) continue
    out.push({ role, content })
  }
  return out
}

function appendExtraHeaders(headers: Record<string, string>, settings: AppSettings): void {
  const extra = (settings.llmExtraHeadersJson || '').trim()
  if (!extra) return
  try {
    const parsed = JSON.parse(extra) as Record<string, unknown>
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        headers[k] = String(v)
      }
    }
  } catch {
    /* Invalid custom headers should not block chat. */
  }
}

function resolveOpenAiChatCompletionsUrl(settings: AppSettings): string {
  const raw = (settings.openaiBaseUrl || '').trim() || 'https://api.openai.com/v1'
  if (/\/chat\/completions\b/i.test(raw)) return raw.replace(/\/+$/, '')
  return `${raw.replace(/\/+$/, '')}/chat/completions`
}

function buildOpenAiHeaders(settings: AppSettings): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const key = (settings.openaiApiKey || '').trim()
  if (key) {
    if ((settings.apiKeyHeaderMode ?? 'bearer') === 'x-api-key') headers['x-api-key'] = key
    else headers.authorization = `Bearer ${key}`
  }
  appendExtraHeaders(headers, settings)
  return headers
}

function resolveAnthropicMessagesUrl(settings: AppSettings): string {
  const raw = (settings.anthropicBaseUrl || '').trim() || 'https://api.anthropic.com/v1'
  if (/\/messages\b/i.test(raw)) return raw.replace(/\/+$/, '')
  return `${raw.replace(/\/+$/, '')}/messages`
}

function buildAnthropicHeaders(settings: AppSettings): Record<string, string> {
  const key = (settings.openaiApiKey || '').trim()
  if (!key) {
    throw Object.assign(
      new Error('Anthropic requires an API key. Fill the shared API Key field in Settings.'),
      { code: 'MISSING_API_KEY' }
    )
  }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': (settings.anthropicApiVersion || '').trim() || '2023-06-01',
  }
  appendExtraHeaders(headers, settings)
  return headers
}

function readDataPayload(line: string): unknown | 'DONE' | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return null
  const data = trimmed.slice(5).trim()
  if (!data) return null
  if (data === '[DONE]') return 'DONE'
  try {
    return JSON.parse(data) as unknown
  } catch {
    return null
  }
}

function firstTextBlock(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map((block) => {
      if (!isRecord(block)) return ''
      if (typeof block.text === 'string') return block.text
      if (typeof block.content === 'string') return block.content
      return ''
    })
    .filter(Boolean)
    .join('')
}

export function extractOpenAiChatText(value: unknown): string {
  if (!isRecord(value)) return ''
  if (typeof value.output_text === 'string') return value.output_text
  if (Array.isArray(value.choices)) {
    const choice = value.choices.find(isRecord)
    if (choice) {
      const delta = isRecord(choice.delta) ? choice.delta : null
      const message = isRecord(choice.message) ? choice.message : null
      if (typeof delta?.content === 'string') return delta.content
      if (typeof message?.content === 'string') return message.content
      if (Array.isArray(message?.content)) return firstTextBlock(message.content)
      if (typeof choice.text === 'string') return choice.text
    }
  }
  if (Array.isArray(value.output)) return firstTextBlock(value.output)
  return ''
}

export function extractAnthropicChatText(value: unknown): string {
  if (!isRecord(value)) return ''
  if (isRecord(value.error) && typeof value.error.message === 'string') {
    throw new Error(value.error.message)
  }
  if (Array.isArray(value.content)) return firstTextBlock(value.content)
  if (typeof value.completion === 'string') return value.completion
  if (typeof value.text === 'string') return value.text
  return ''
}

export function parseOpenAiSseLine(line: string): ParsedSseLine {
  const payload = readDataPayload(line)
  if (payload === null) return {}
  if (payload === 'DONE') return { done: true }
  if (isRecord(payload) && isRecord(payload.error)) {
    const message = typeof payload.error.message === 'string' ? payload.error.message : JSON.stringify(payload.error)
    return { error: message }
  }
  return { text: extractOpenAiChatText(payload) }
}

export function parseAnthropicSseLine(line: string): ParsedSseLine {
  const payload = readDataPayload(line)
  if (payload === null) return {}
  if (payload === 'DONE') return { done: true }
  if (!isRecord(payload)) return {}
  if (payload.type === 'error' && isRecord(payload.error)) {
    const message = typeof payload.error.message === 'string' ? payload.error.message : JSON.stringify(payload.error)
    return { error: `Anthropic: ${message}` }
  }
  if (payload.type === 'content_block_start' && isRecord(payload.content_block)) {
    const block = payload.content_block
    return { text: typeof block.text === 'string' ? block.text : '' }
  }
  if (payload.type === 'content_block_delta' && isRecord(payload.delta)) {
    const delta = payload.delta
    return { text: delta.type === 'text_delta' && typeof delta.text === 'string' ? delta.text : '' }
  }
  if (payload.type === 'message_stop') return { done: true }
  return {}
}

function parseJsonText(raw: string, extractText: (value: unknown) => string): string {
  const trimmed = raw.trim()
  if (!trimmed || !trimmed.startsWith('{')) return ''
  try {
    return extractText(JSON.parse(trimmed))
  } catch {
    return ''
  }
}

async function readChatResponseText(
  response: Response,
  options: {
    sink: WebEventSink
    parseSseLine: (line: string) => ParsedSseLine
    extractJsonText: (value: unknown) => string
  }
): Promise<{ text: string; transport: ChatProviderResult['transport'] }> {
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    const raw = await response.text()
    const text = parseJsonText(raw, options.extractJsonText)
    if (text) options.sink.send('chat:replace', text)
    return { text, transport: text ? 'json' : 'empty' }
  }

  if (!response.body) {
    const raw = await response.text().catch(() => '')
    const text = parseJsonText(raw, options.extractJsonText)
    if (text) options.sink.send('chat:replace', text)
    return { text, transport: text ? 'json' : 'empty' }
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let raw = ''
  let assistantText = ''
  let streamDone = false

  const handleLine = (line: string): boolean => {
    const parsed = options.parseSseLine(line)
    if (parsed.error) throw new Error(parsed.error)
    if (parsed.text) {
      assistantText += parsed.text
      options.sink.send('chat:chunk', parsed.text)
    }
    return parsed.done === true
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = decoder.decode(value, { stream: true })
    if (raw.length < 2_000_000) raw += chunk
    buffer += chunk
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (handleLine(line)) {
        streamDone = true
        break
      }
    }
    if (streamDone) break
  }

  const tail = buffer.trim()
  if (!streamDone && tail) handleLine(tail)
  if (assistantText.trim()) return { text: assistantText, transport: 'sse' }

  const fallbackText = parseJsonText(raw, options.extractJsonText)
  if (fallbackText) {
    options.sink.send('chat:replace', fallbackText)
    return { text: fallbackText, transport: 'json' }
  }
  return { text: '', transport: 'empty' }
}

async function readJsonCompletionText(
  response: Response,
  extractJsonText: (value: unknown) => string
): Promise<string> {
  const raw = await response.text().catch(() => '')
  const text = parseJsonText(raw, extractJsonText)
  if (text) return text
  return raw.trim().startsWith('{') ? '' : raw.trim()
}

function toAnthropicMessages(messages: ChatMessage[]): {
  system?: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
} {
  const systemParts: string[] = []
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content.trim()) systemParts.push(message.content)
      continue
    }
    out.push({ role: message.role, content: message.content })
  }
  return {
    system: systemParts.length ? systemParts.join('\n\n') : undefined,
    messages: out,
  }
}

function temperatureFromPayload(payload: Record<string, unknown>, base: number): number {
  const intensityMod = typeof payload.intensityMod === 'number' ? payload.intensityMod : 1
  return Math.max(0.1, Math.min(1.5, base * intensityMod))
}

async function completeOpenAiCompatibleChat(
  settings: AppSettings,
  messages: ChatMessage[],
  signal: AbortSignal,
  options?: { temperature?: number; maxTokens?: number }
): Promise<string> {
  const body: Record<string, unknown> = {
    model: settings.model,
    messages,
    stream: false,
    temperature: options?.temperature ?? 0.5,
  }
  if (options?.maxTokens) body.max_tokens = options.maxTokens
  const response = await fetch(resolveOpenAiChatCompletionsUrl(settings), {
    method: 'POST',
    headers: buildOpenAiHeaders(settings),
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText)
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`)
  }
  return readJsonCompletionText(response, extractOpenAiChatText)
}

async function completeAnthropicChat(
  settings: AppSettings,
  messages: ChatMessage[],
  signal: AbortSignal,
  options?: { temperature?: number; maxTokens?: number }
): Promise<string> {
  const converted = toAnthropicMessages(messages)
  if (converted.messages.length === 0) return ''
  const body: Record<string, unknown> = {
    model: settings.model,
    max_tokens: Math.max(
      256,
      Math.min(200_000, options?.maxTokens ?? (Number(settings.anthropicMaxTokens) || 8192))
    ),
    messages: converted.messages,
    stream: false,
    temperature: options?.temperature ?? 0.5,
  }
  if (converted.system) body.system = converted.system
  const response = await fetch(resolveAnthropicMessagesUrl(settings), {
    method: 'POST',
    headers: buildAnthropicHeaders(settings),
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText)
    throw new Error(`Anthropic HTTP ${response.status}: ${text.slice(0, 800)}`)
  }
  return readJsonCompletionText(response, extractAnthropicChatText)
}

async function completeProviderChat(
  settings: AppSettings,
  messages: ChatMessage[],
  signal: AbortSignal,
  options?: { temperature?: number; maxTokens?: number }
): Promise<string> {
  return (settings.llmProvider ?? 'openai') === 'anthropic'
    ? completeAnthropicChat(settings, messages, signal, options)
    : completeOpenAiCompatibleChat(settings, messages, signal, options)
}

async function streamOpenAiCompatibleChat(
  payload: Record<string, unknown>,
  settings: AppSettings,
  messages: ChatMessage[],
  sink: WebEventSink,
  signal: AbortSignal
): Promise<ChatProviderResult> {
  const response = await fetch(resolveOpenAiChatCompletionsUrl(settings), {
    method: 'POST',
    headers: buildOpenAiHeaders(settings),
    body: JSON.stringify({
      model: settings.model,
      messages,
      stream: true,
      temperature: temperatureFromPayload(payload, 0.7),
    }),
    signal,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText)
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`)
  }

  const result = await readChatResponseText(response, {
    sink,
    parseSseLine: parseOpenAiSseLine,
    extractJsonText: extractOpenAiChatText,
  })
  return { assistantText: result.text, provider: 'openai', transport: result.transport }
}

async function streamAnthropicChat(
  payload: Record<string, unknown>,
  settings: AppSettings,
  messages: ChatMessage[],
  sink: WebEventSink,
  signal: AbortSignal
): Promise<ChatProviderResult> {
  const converted = toAnthropicMessages(messages)
  if (converted.messages.length === 0) {
    throw Object.assign(new Error('Anthropic chat requires at least one user or assistant message.'), {
      code: 'INVALID_ARGUMENT',
    })
  }
  const body: Record<string, unknown> = {
    model: settings.model,
    max_tokens: Math.max(256, Math.min(200_000, Number(settings.anthropicMaxTokens) || 8192)),
    messages: converted.messages,
    stream: true,
    temperature: temperatureFromPayload(payload, 0.6),
  }
  if (converted.system) body.system = converted.system

  const response = await fetch(resolveAnthropicMessagesUrl(settings), {
    method: 'POST',
    headers: buildAnthropicHeaders(settings),
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText)
    throw new Error(`Anthropic HTTP ${response.status}: ${text.slice(0, 800)}`)
  }

  const result = await readChatResponseText(response, {
    sink,
    parseSseLine: parseAnthropicSseLine,
    extractJsonText: extractAnthropicChatText,
  })
  return { assistantText: result.text, provider: 'anthropic', transport: result.transport }
}

function lastUserText(messages: ChatMessage[]): string {
  return [...messages].reverse().find((message) => message.role === 'user')?.content ?? ''
}

function cleanTitle(value: string, fallback: string): string {
  const title = value.replace(/\s+/g, ' ').trim()
  return (title || fallback).slice(0, 120)
}

function buildCardCopyText(label: string, displayTitle: string, cardBody: string): string {
  return `【${label}】${displayTitle}\n${'─'.repeat(32)}\n${cardBody.trim()}`
}

function toCardPayload(mode: WebCardMode, topic: string, cardBody: string, error?: string): SearchCardPayload {
  const label = mode === 'plan' ? '计划书' : mode === 'search' ? '检索简报' : '知识整理'
  const displayTitle = cleanTitle(topic, label)
  return {
    query: topic,
    displayTitle,
    cardBody,
    sources: [],
    copyText: buildCardCopyText(label, displayTitle, cardBody),
    mode,
    ...(error ? { error } : {}),
  }
}

function cardPrompt(mode: WebCardMode, topic: string, userQuestion: string): ChatMessage[] {
  const base =
    mode === 'plan'
      ? [
          '你要生成一份可保存的 Markdown 计划书。',
          '必须包含：目标与背景、总体安排、分步任务、资源与准备、风险与备选、下一步。',
          '分步任务优先使用 checkbox，内容要可执行，不要只给态度或空话。',
        ].join('\n')
      : mode === 'search'
        ? [
            '你要生成一份本地 Web 版检索简报。',
            '当前运行时不打开 Electron 窗口；如果没有实时搜索结果，就基于模型知识与对话上下文整理，并明确标注可能需要用户后续核验实时信息。',
            '不要编造参考链接；没有来源时不要列来源。',
          ].join('\n')
        : [
            '你要生成一份可保存的 Markdown 知识整理正文。',
            '正文要有结构、要点、常见误区或补充、综合结论；不要只写聊天开场白。',
            '不确定或可能随时间变化的信息要说明可能滞后。',
          ].join('\n')

  return [
    { role: 'system', content: base },
    { role: 'user', content: userQuestion || topic },
    {
      role: 'user',
      content: `主题：「${topic}」\n请直接输出纸面卡正文 Markdown。`,
    },
  ]
}

function companionPrompt(mode: WebCardMode, topic: string, cardBody: string, userQuestion: string): ChatMessage[] {
  const label = mode === 'plan' ? '计划书' : mode === 'search' ? '检索简报' : '知识整理'
  return [
    {
      role: 'system',
      content: `上方已经生成「${label}」纸面卡。你现在只用伴侣口吻写 1 到 2 句短回复，不复述正文。`,
    },
    { role: 'user', content: userQuestion || topic },
    {
      role: 'user',
      content: `纸面卡主题：「${topic}」\n正文摘录：${cardBody.slice(0, 600)}`,
    },
  ]
}

async function handleWebCardTurn(
  mode: WebCardMode,
  topic: string,
  settings: AppSettings,
  messages: ChatMessage[],
  sink: WebEventSink,
  signal: AbortSignal
): Promise<WebCardResult> {
  const userQuestion = lastUserText(messages)
  const label = mode === 'plan' ? '计划书' : mode === 'search' ? '检索简报' : '知识整理'
  sink.send('chat:status', `正在生成${label}...`)
  const cardBody = await completeProviderChat(settings, cardPrompt(mode, topic, userQuestion), signal, {
    temperature: mode === 'plan' ? 0.42 : 0.45,
    maxTokens: mode === 'plan' ? 3600 : 3200,
  })
  const body = cardBody.trim() || `## ${cleanTitle(topic, label)}\n\n暂时没有生成足够内容，请稍后重试。`
  sink.send('chat:searchCard', toCardPayload(mode, topic, body))

  sink.send('chat:status', '正在整理回复...')
  const companion = await completeProviderChat(settings, companionPrompt(mode, topic, body, userQuestion), signal, {
    temperature: 0.82,
    maxTokens: 320,
  })
  const assistantText =
    companion.trim() ||
    (mode === 'plan'
      ? '我先把计划整理在上面的卡片里了，下一步可以从最容易开始的那一项做。'
      : '我把整理好的内容放在上面的卡片里了，你可以先从重点部分看。')
  sink.send('chat:replace', assistantText)
  return {
    assistantText,
    memoryWrites: mode === 'plan' ? [`PLAN ${cleanTitle(topic, '计划书')}`] : [],
  }
}

function memoryAuditFromPayload(payload: Record<string, unknown>, messages: ChatMessage[]) {
  if (isRecord(payload.memoryAuditIntent)) {
    const mode = payload.memoryAuditIntent.mode
    if (
      mode === 'curated_audit' ||
      mode === 'self_report' ||
      mode === 'stats_only' ||
      mode === 'full_dump'
    ) {
      return {
        mode,
        includeAvoid: payload.memoryAuditIntent.includeAvoid === true,
        page: typeof payload.memoryAuditIntent.page === 'number' ? payload.memoryAuditIntent.page : undefined,
        confidence: 1,
      }
    }
  }
  const recent = messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({ role: message.role, content: message.content }))
  return detectMemoryAuditIntent(lastUserText(messages), recent)
}

function handleWebMemoryAuditTurn(
  payload: Record<string, unknown>,
  messages: ChatMessage[],
  sink: WebEventSink
): WebCardResult | null {
  const intent = memoryAuditFromPayload(payload, messages)
  if (!intent) return null
  sink.send('chat:status', '正在整理记忆审计...')
  const result = handleWebMemoryAuditReport({
    mode: intent.mode,
    includeAvoid: intent.includeAvoid,
    page: intent.page,
  }) as { card?: MemoryAuditCardPayload }
  if (!result.card) throw new Error('memory:auditReport did not return a card payload')
  sink.send('chat:memoryAudit', result.card)
  const assistantText = buildMemoryAuditIntro(
    result.card.mode,
    result.card.stats.factsListed,
    result.card.stats.totalActiveFacts
  )
  sink.send('chat:replace', assistantText)
  return { assistantText, memoryWrites: [] }
}

function extractTopic(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

async function maybeHandleStructuredCardTurn(
  payload: Record<string, unknown>,
  settings: AppSettings,
  messages: ChatMessage[],
  sink: WebEventSink,
  signal: AbortSignal
): Promise<WebCardResult | null> {
  const memoryAudit = handleWebMemoryAuditTurn(payload, messages, sink)
  if (memoryAudit) return memoryAudit

  const planTopic = extractTopic(payload.planDocumentTopic)
  if (planTopic) return handleWebCardTurn('plan', planTopic, settings, messages, sink, signal)

  const forcedSearch = extractTopic(payload.forcedWebSearchQuery)
  if (forcedSearch) return handleWebCardTurn('search', forcedSearch, settings, messages, sink, signal)

  const knowledgeTopic = extractTopic(payload.knowledgeTopic) || extractTopic(payload.suggestedSearchQuery)
  if (knowledgeTopic) return handleWebCardTurn('knowledge', knowledgeTopic, settings, messages, sink, signal)

  return null
}

function parseWavePlan(payload: Record<string, unknown>): WavePlan | null {
  if (!isRecord(payload.wavePlan)) return null
  const waveCount = Number(payload.wavePlan.waveCount)
  const waves = Array.isArray(payload.wavePlan.waves) ? payload.wavePlan.waves : []
  if (!Number.isFinite(waveCount) || waveCount < 1 || waves.length === 0) return null
  const parsed = waves
    .map((item, index): WaveSpec | null => {
      if (!isRecord(item)) return null
      const waveIndex = Number(item.waveIndex)
      const maxChars = Number(item.maxChars)
      return {
        waveIndex: Number.isFinite(waveIndex) ? waveIndex : index,
        maxChars: Number.isFinite(maxChars) ? maxChars : 80,
        systemDelta: typeof item.systemDelta === 'string' ? item.systemDelta : undefined,
      }
    })
    .filter((item): item is WaveSpec => item !== null)
    .sort((a, b) => a.waveIndex - b.waveIndex)
    .slice(0, 4)
  if (parsed.length === 0) return null
  return {
    waveCount: Math.min(Math.max(waveCount, 1), parsed.length) as WavePlan['waveCount'],
    waves: parsed,
    rhythmMode: typeof payload.wavePlan.rhythmMode === 'string' ? (payload.wavePlan.rhythmMode as WavePlan['rhythmMode']) : 'chatter',
  }
}

function messagesForWave(messages: ChatMessage[], wave: WaveSpec, waveCount: number, priorParts: string[]): ChatMessage[] {
  const hintParts = [
    wave.systemDelta,
    wave.maxChars > 0 ? `【长度】本条回复不超过 ${wave.maxChars} 字，只输出这一条气泡。` : '【长度】只输出这一条气泡。',
    wave.waveIndex > 0 ? '【多波续写】前面气泡已经发出，请补充新信息，不要重复问候或重复前文。' : '',
    priorParts.length > 0 ? `【已发送气泡】\n${priorParts.map((part, i) => `${i + 1}. ${part}`).join('\n')}` : '',
  ].filter((part): part is string => Boolean(part?.trim()))

  const out = messages.map((message) => ({ ...message }))
  const systemIndex = out.findIndex((message) => message.role === 'system')
  if (systemIndex >= 0) {
    out[systemIndex] = {
      ...out[systemIndex],
      content: `${out[systemIndex].content}\n\n${hintParts.join('\n\n')}`.trim(),
    }
  } else {
    out.unshift({ role: 'system', content: hintParts.join('\n\n') })
  }

  if (priorParts.length > 0) {
    const lastUserIndex = out.map((message) => message.role).lastIndexOf('user')
    const insertAt = lastUserIndex >= 0 ? lastUserIndex : out.length
    out.splice(
      insertAt,
      0,
      ...priorParts.map((part) => ({ role: 'assistant' as const, content: part }))
    )
  }

  void waveCount
  return out
}

async function streamWebWaveChat(
  payload: Record<string, unknown>,
  settings: AppSettings,
  messages: ChatMessage[],
  sink: WebEventSink,
  signal: AbortSignal
): Promise<ChatProviderResult | null> {
  if (payload.useWaveChat !== true && !payload.wavePlan) return null
  const wavePlan = parseWavePlan(payload)
  if (!wavePlan) return null
  sink.send('chat:status', '正在生成多条回复...')
  const priorParts: string[] = []
  const waveTexts: string[] = []

  for (const wave of wavePlan.waves.slice(0, wavePlan.waveCount)) {
    if (signal.aborted) throw Object.assign(new Error('Chat request timed out.'), { name: 'AbortError' })
    sink.send('chat:wave-start', {
      waveIndex: wave.waveIndex,
      waveCount: wavePlan.waveCount,
      newBubble: wave.waveIndex > 0,
    })
    const result =
      (settings.llmProvider ?? 'openai') === 'anthropic'
        ? await streamAnthropicChat(payload, settings, messagesForWave(messages, wave, wavePlan.waveCount, priorParts), sink, signal)
        : await streamOpenAiCompatibleChat(payload, settings, messagesForWave(messages, wave, wavePlan.waveCount, priorParts), sink, signal)
    const text = result.assistantText.trim()
    if (text) {
      priorParts.push(text)
      waveTexts[wave.waveIndex] = text
      sink.send('chat:wave-end', { waveIndex: wave.waveIndex, text })
    } else {
      sink.send('chat:wave-end', { waveIndex: wave.waveIndex, text: '', partial: true })
    }
  }

  const assistantText = waveTexts.filter(Boolean).join('\n')
  return {
    assistantText,
    provider: (settings.llmProvider ?? 'openai') === 'anthropic' ? 'anthropic' : 'openai',
    transport: assistantText ? 'sse' : 'empty',
  }
}

function emitWebModeStatus(payload: Record<string, unknown>, settings: AppSettings, sink: WebEventSink): void {
  if (payload.desktopAgentChatMode === true || payload.desktopAgentCapability) {
    sink.send('chat:status', 'Web 本地版会保留业务回复，但不会执行桌面窗口/系统控制动作。')
  } else if (settings.disableChatTools === false) {
    sink.send('chat:status', 'Web 本地版优先使用纯 Node 业务能力；需要 OS 控制的工具动作会被模型回答路径跳过。')
  }
}

function saveTurnState(settings: AppSettings, payload: Record<string, unknown>, turnId: string): void {
  const root = resolveWebDataRoot(settings)
  const sessionId =
    typeof payload.sessionId === 'string' && payload.sessionId.trim()
      ? payload.sessionId
      : currentWebSessionId()
  const state = mergeWebEngineState(root, settings)
  state.lastActive = new Date().toISOString()
  state.counters = {
    ...state.counters,
    totalTurns: (state.counters?.totalTurns ?? 0) + 1,
  }
  saveWebState(root, state, sessionId)
  void turnId
}

export async function handleWebContextBuild(args: WebContextBuildArgs): Promise<WebContextBuildResult> {
  const settings = loadWebSettings()
  const root = resolveWebDataRoot(settings)
  const now = new Date()
  const localClock = `【系统时钟 · 本地】${now.toISOString()}`
  const webModeHint = args.desktopAgentChatMode
    ? '【Web运行提示】本地 Web 运行时不执行桌面窗口/系统控制工具，本轮按普通聊天回答。'
    : ''
  const systemParts = [
    buildSystemPrompt(settings),
    settings.companionSystemHint,
    localClock,
    args.systemHint,
    webModeHint,
    memoryFactsBlock(),
    explicitDocumentBlock(root, settings, args.explicitRel),
  ].filter((part): part is string => Boolean(part && part.trim()))

  const messages: ChatMessage[] = [
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
    dispatchBypassed: args.dispatchRespond ? true : undefined,
    useWaveChat: false,
    sessionId: args.sessionId ?? settings.activeSessionId ?? 'default',
    tracePreview: {
      runtime: 'web',
      provider: settings.llmProvider ?? 'openai',
      unsupportedWindowLayer: args.desktopAgentChatMode === true,
    },
  }
}

export async function handleWebChatStart(
  payload: Record<string, unknown>,
  sink: WebEventSink
): Promise<void> {
  const settings = assertSettings(payload.settings)
  const messages = normalizeWebChatMessages(payload.messages)
  const turnId = typeof payload.turnId === 'string' ? payload.turnId : newWebTurnId()

  if (messages.length === 0) {
    sink.send('chat:error', 'chat:start requires messages')
    return
  }

  const provider: ChatProvider = (settings.llmProvider ?? 'openai') === 'anthropic' ? 'anthropic' : 'openai'
  const controller = new AbortController()
  const timeoutMs =
    payload.desktopAgentChatMode === true ? Math.max(settings.timeoutMs || 120_000, 900_000) : settings.timeoutMs || 120_000
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    sink.send('chat:stream-start', {})
    emitWebModeStatus(payload, settings, sink)

    const cardResult = await maybeHandleStructuredCardTurn(payload, settings, messages, sink, controller.signal)
    if (cardResult) {
      sink.send('chat:done', {
        memoryWrites: cardResult.memoryWrites,
        assistantText: cardResult.assistantText,
        turnId,
        provider: 'web',
        transport: 'local',
      })
      saveTurnState(settings, payload, turnId)
      return
    }

    const waveResult = await streamWebWaveChat(payload, settings, messages, sink, controller.signal)
    if (waveResult) {
      const assistantText = waveResult.assistantText.trim() || '...'
      if (assistantText === '...') sink.send('chat:replace', assistantText)
      sink.send('chat:done', {
        memoryWrites: [],
        assistantText,
        turnId,
        provider: waveResult.provider,
        transport: waveResult.transport,
      })
      saveTurnState(settings, payload, turnId)
      return
    }

    sink.send('chat:status', provider === 'anthropic' ? '正在连接 Anthropic...' : '正在连接模型...')
    const result =
      provider === 'anthropic'
        ? await streamAnthropicChat(payload, settings, messages, sink, controller.signal)
        : await streamOpenAiCompatibleChat(payload, settings, messages, sink, controller.signal)

    let assistantText = result.assistantText
    if (!assistantText.trim()) {
      assistantText = '...'
      sink.send('chat:replace', assistantText)
    }

    sink.send('chat:done', {
      memoryWrites: [],
      assistantText,
      turnId,
      provider: result.provider,
      transport: result.transport,
    })
    saveTurnState(settings, payload, turnId)
  } catch (error) {
    const message =
      error instanceof Error && error.name === 'AbortError'
        ? 'Chat request timed out.'
        : error instanceof Error
          ? error.message
          : String(error)
    sink.send('chat:error', message)
  } finally {
    clearTimeout(timer)
  }
}
