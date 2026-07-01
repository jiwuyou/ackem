import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { clearStructuredData, getDatabase } from '../../db/database'
import { deleteChatHistoryFromDb, loadChatHistoryFromDb } from '../../db/repos/chatHistory'
import { deleteCompanionStateFromDb } from '../../db/repos/companionState'
import { loadDiaryFromDb, saveDiaryToDb } from '../../db/repos/diary'
import { appendOrOverwriteAllowed, promoteImportToMemory } from '../../fsops'
import { ACKEM_CANON } from '../../canon/ackemCanon'
import { loadCreatorMemoryStore } from '../../canon/creatorMemory'
import {
  DECISION_LOG_EMBEDDING_ROUTING_PLANNED,
  listRecentDecisionLogs,
  summarizeRecentDecisions,
} from '../../extensions/policy/decisionLogStore'
import { FactStore, defaultFactsPath } from '../../memory/factStore'
import { EpisodicStore, defaultEpisodesPath } from '../../memory/episodicStore'
import { KnowledgeGraph, defaultKgPath } from '../../memory/knowledgeGraph'
import { VectorStore } from '../../memory/vectorStore'
import { exportMemoryArchive } from '../../memory/archiveExporter'
import {
  appendMirrorFindings,
  readMirrorFindings,
  runMirrorCheck,
} from '../../memory/mirrorCheckRunner'
import { buildMemoryAuditReport } from '../../memory/memoryAudit/buildMemoryAuditReport'
import {
  formatMemoryAuditMarkdown,
  toMemoryAuditCardPayload,
} from '../../memory/memoryAudit/formatMemoryAuditMarkdown'
import { captureEmotionalContext } from '../../memory/memoryBinding'
import { extractTriggers } from '../../memory/triggerExtractor'
import { CATEGORY_META, DOMAINS, SUBCATEGORIES, isValidSubcategory, type Domain, type Subcategory } from '../../memory/taxonomy'
import { workingMemory } from '../../memory/workingMemory'
import { loadTraceFile } from '../../engine/tracer'
import { clearActiveDesires, dismissDesireFromStack } from '../../engine/desire'
import { defaultFullState } from '../../engine/state-persistence'
import type { CompanionSuggestion, DesireStack, MemoryFact, TurnTrace, UserSixDimensions } from '../../engine/types'
import {
  estimateScanStats,
  mapToLegacyUserProfile,
  mergeFileTexts,
  writePortraitSummary,
} from '../../engine/user-dimension-inferrer'
import {
  PERSONALITY_PRESETS,
  defaultPersonalitySlice,
  getPreset,
  sortPresetsForDisplay,
} from '../../personalityPresets'
import { ensureDataLayout } from '../../layout'
import {
  IMPORT_CONSENT_VERSION,
  IMPORT_SESSION_ID,
  type ImportAnchorDraft,
  type ImportCommitResult,
  type ImportEpisodeDraft,
  type ImportFactDraft,
  type ImportJob,
  type ImportParseResult,
} from '../../../shared/documentImport'
import { INFERENCE_CONSENT_VERSION } from '../../../shared/types'
import {
  currentWebDataRoot,
  currentWebSessionId,
  handleWebArchiveList,
  handleWebDiaryList,
  loadWebSessionsFile,
  loadWebSettings,
  mergeWebEngineState,
  saveWebSessionsFile,
  saveWebSettings,
  saveWebState,
} from '../runtime'
import type { WebHandlerRegistry, WebInvokeHandler } from '../types'
import {
  clampInteger,
  clampNumber,
  isSafeIsoDate,
  normalizeSafeRelativePath,
  resolveSafeChildFile,
} from './safePaths'
import { handleWebIndexRebuild } from './embeddingWorkflowService'

type MemoryUpdatePatch = Partial<
  Pick<MemoryFact, 'summary' | 'weight' | 'confidence' | 'triggers' | 'sensitivity' | 'tier' | 'privacyLevel'>
>

type MemoryFeedbackAction = 'thumbs_up' | 'thumbs_down' | 'edit' | 'delete'

type DiaryGenerateOptions = {
  date?: string
  force?: boolean
}

type ImportParseArgs = {
  relPaths?: unknown
  consentAck?: unknown
  consentVersion?: unknown
}

type ImportCommitArgs = {
  jobId?: unknown
  disabledDraftIds?: unknown
}

type ProfileInferArgs = {
  relPaths?: unknown
  consentAck?: unknown
  consentVersion?: unknown
}

type DiaryMetaEntry = {
  type?: string
  tier?: string
  gapHours?: number
  writeMode?: string
  trigger?: string
  generatedAt?: string
}

function unsupported(channel: string, reason: string): { ok: false; code: string; channel: string; reason: string } {
  return { ok: false, code: 'WEB_UNSUPPORTED', channel, reason }
}

function rootWithLayout(): string {
  const root = currentWebDataRoot()
  ensureDataLayout(root)
  return root
}

function factStore(root = rootWithLayout()): FactStore {
  const store = new FactStore(defaultFactsPath(root))
  store.load()
  return store
}

function episodicStore(root = rootWithLayout()): EpisodicStore {
  const store = new EpisodicStore(defaultEpisodesPath(root))
  store.load()
  return store
}

function knowledgeGraph(root = rootWithLayout()): KnowledgeGraph {
  const kg = new KnowledgeGraph(defaultKgPath(root))
  kg.load()
  return kg
}

function stringArg(value: unknown, channel: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim()
  throw Object.assign(new Error(`${channel} requires a non-empty string`), { code: 'INVALID_ARGUMENT' })
}

function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return fallback
  }
}

function normalizeSessionName(name: unknown, fallback: string): string {
  return typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : fallback
}

function normalizeWriteMode(mode: unknown): 'append' | 'overwrite' {
  return mode === 'append' ? 'append' : 'overwrite'
}

function normalizeProfileRelPaths(value: unknown): string[] {
  return normalizeRelPathList(value).slice(0, 50)
}

function isLocalWebLlmEndpoint(settings: ReturnType<typeof loadWebSettings>): boolean {
  const base = settings.localChatEnabled
    ? settings.localChatBaseUrl
    : settings.llmProvider === 'openai'
      ? settings.openaiBaseUrl
      : settings.anthropicBaseUrl
  return /127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0/i.test(base ?? '')
}

function countPattern(text: string, patterns: RegExp[]): number {
  return patterns.reduce((sum, pattern) => sum + (text.match(pattern)?.length ?? 0), 0)
}

function scoreFromSignals(base: number, positive: number, negative = 0): number {
  return Math.max(0, Math.min(100, Math.round(base + positive * 7 - negative * 6)))
}

function deterministicProfileInference(
  root: string,
  relPaths: string[]
): { userSix: UserSixDimensions; companionSuggestion: CompanionSuggestion } {
  const merged = mergeFileTexts(root, relPaths)
  if (merged.fileCount === 0 || !merged.text.trim()) {
    throw new Error('所选文件为空或不可读')
  }

  const text = merged.text.slice(0, 60_000)
  const lower = text.toLowerCase()
  const lineCount = Math.max(1, text.split(/\n+/).filter((line) => line.trim()).length)
  const questionCount = countPattern(text, [/[?？]/g])
  const exclaimCount = countPattern(text, [/[!！]/g])
  const firstPersonCount = countPattern(text, [/我/g, /\bi\b/g, /\bme\b/g, /\bmy\b/g])
  const feelingCount = countPattern(text, [/喜欢/g, /讨厌/g, /开心/g, /难过/g, /害怕/g, /焦虑/g, /孤独/g, /想要/g, /希望/g, /love/g, /hate/g, /feel/g])
  const directCount = countPattern(text, [/直接/g, /明确/g, /立刻/g, /马上/g, /不要/g, /必须/g, /\bmust\b/g, /\bnow\b/g])
  const planningCount = countPattern(text, [/计划/g, /目标/g, /安排/g, /复盘/g, /清单/g, /todo/g, /plan/g, /goal/g])
  const powerCount = countPattern(text, [/控制/g, /主导/g, /服从/g, /命令/g, /支配/g, /边界/g, /domin/g, /control/g])
  const noveltyCount = countPattern(text, [/尝试/g, /好奇/g, /新/g, /探索/g, /旅行/g, /学习/g, /研究/g, /open/g, /curious/g])
  const supportCount = countPattern(text, [/陪/g, /安慰/g, /理解/g, /关心/g, /抱/g, /依赖/g, /想你/g, /孤独/g, /support/g, /comfort/g])

  const density = Math.min(8, Math.ceil(text.length / Math.max(800, lineCount * 80)))
  const userSix: UserSixDimensions = {
    E: scoreFromSignals(45, Math.min(5, firstPersonCount / 12 + exclaimCount / 4 + density / 2)),
    A: scoreFromSignals(45, Math.min(6, supportCount / 3 + feelingCount / 12)),
    D: scoreFromSignals(45, Math.min(6, directCount / 3 + questionCount / 10), planningCount > 8 ? 1 : 0),
    P: scoreFromSignals(50, Math.min(5, powerCount / 2), supportCount > powerCount * 2 ? 1 : 0),
    N: scoreFromSignals(42, Math.min(7, feelingCount / 8 + supportCount / 4)),
    O: scoreFromSignals(48, Math.min(7, noveltyCount / 3 + questionCount / 8 + planningCount / 10)),
    sourceFiles: relPaths,
    inferredAt: new Date().toISOString(),
    summary: `Web 本地推断：扫描 ${merged.fileCount} 个文件、${merged.charCount} 字符；基于表达密度、情绪词、计划词和探索词生成初始画像。`,
  }
  const companionSuggestion: CompanionSuggestion = {
    T: Math.max(20, Math.min(95, Math.round(65 + (userSix.N - 50) * 0.35 + (userSix.A - 50) * 0.2))),
    I: Math.max(20, Math.min(95, Math.round(50 + (userSix.D - 50) * 0.25 + (userSix.P - 50) * 0.25))),
    S: Math.max(10, Math.min(90, Math.round(50 + (userSix.A - 50) * 0.25 - (userSix.P - 50) * 0.15))),
    O: Math.max(15, Math.min(95, Math.round(50 + (userSix.O - 50) * 0.3 + (userSix.E - 50) * 0.15))),
    R: Math.max(15, Math.min(95, Math.round(55 + (userSix.D - 50) * 0.2 - (userSix.N - 50) * 0.1))),
    confidence: Math.max(0.35, Math.min(0.72, Number((0.35 + Math.min(merged.charCount, 12_000) / 32_000).toFixed(2)))),
    rationale: lower.includes('web local')
      ? '基于本地 Web 文件扫描生成，未调用外部模型。'
      : '基于本地文本中的表达、依恋、直接度、边界和探索信号生成，未调用外部模型。',
  }
  return { userSix, companionSuggestion }
}

function importJobDir(root: string): string {
  return join(root, '_derived', 'import-jobs')
}

function importJobPath(root: string, jobId: string): string {
  return join(importJobDir(root), `${jobId}.json`)
}

function isSafeJobId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f-]{20,80}$/i.test(value)
}

function saveImportJob(root: string, job: ImportJob): void {
  mkdirSync(importJobDir(root), { recursive: true })
  writeFileSync(importJobPath(root, job.id), JSON.stringify(job, null, 2), 'utf-8')
}

function loadImportJob(root: string, jobId: unknown): ImportJob | null {
  if (!isSafeJobId(jobId)) return null
  return readJson<ImportJob | null>(importJobPath(root, jobId), null)
}

function normalizeRelPathList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => normalizeSafeRelativePath(item))
    .filter((item): item is string => Boolean(item))
}

function clampImportNumber(value: unknown, fallback: number, min: number, max: number): number {
  return clampNumber(value, fallback, min, max)
}

const SUBCATEGORY_ALIASES: Record<string, Subcategory> = {
  基本资料: 'BASIC_PROFILE',
  基本信息: 'BASIC_PROFILE',
  人生经历: 'LIFE_STORY',
  家人: 'FAMILY',
  家庭: 'FAMILY',
  朋友: 'FRIENDS',
  伴侣: 'PARTNER',
  感情: 'PARTNER',
  喜好: 'TASTES',
  健康: 'HEALTH',
  职业: 'CAREER',
  工作: 'CAREER',
  目标: 'GOALS',
  计划: 'PLANS',
  习惯: 'ROUTINES',
  价值观: 'VALUES_BELIEFS',
}

function domainForSubcategory(subcategory: Subcategory): Domain {
  for (const domain of DOMAINS) {
    if ((SUBCATEGORIES[domain] as readonly string[]).includes(subcategory)) return domain
  }
  return 'DAILY_LIFE'
}

function normalizeSubcategory(value: unknown): Subcategory {
  if (typeof value !== 'string' || !value.trim()) return 'TASTES'
  const raw = value.trim()
  const upper = raw.toUpperCase().replace(/\s+/g, '_')
  if (isValidSubcategory(upper)) return upper
  return SUBCATEGORY_ALIASES[raw] ?? SUBCATEGORY_ALIASES[upper] ?? 'TASTES'
}

function normalizeDomain(value: unknown, subcategory: Subcategory): Domain {
  return typeof value === 'string' && (DOMAINS as readonly string[]).includes(value)
    ? (value as Domain)
    : domainForSubcategory(subcategory)
}

function newDraftId(): string {
  return randomUUID()
}

function previewMergeForDraft(store: FactStore, draft: Omit<ImportFactDraft, 'draftId' | 'enabled'>): Pick<ImportFactDraft, 'mergeWithExistingId' | 'mergeWithSummary'> {
  const existing = store.findSimilarFacts(draft.subcategory, draft.subject, draft.summary, 0.35)[0]
  return existing ? { mergeWithExistingId: existing.id, mergeWithSummary: existing.summary } : {}
}

function normalizeFactDraft(
  raw: Record<string, unknown>,
  sourceFile: string,
  chunkIndex: number,
  store: FactStore
): ImportFactDraft | null {
  const subject = typeof raw.subject === 'string' ? raw.subject.trim() : ''
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : ''
  if (!subject || !summary) return null
  const subcategory = normalizeSubcategory(raw.subcategory)
  const domain = normalizeDomain(raw.domain, subcategory)
  const meta = CATEGORY_META[subcategory]
  const triggers = Array.isArray(raw.triggers)
    ? raw.triggers.map((item) => String(item).trim()).filter(Boolean).slice(0, 12)
    : []
  const base: Omit<ImportFactDraft, 'draftId' | 'enabled'> = {
    domain,
    subcategory,
    subject: subject.slice(0, 120),
    summary: summary.slice(0, 500),
    weight: clampImportNumber(raw.weight, meta.defaultWeight, 0.2, 5),
    confidence: clampImportNumber(raw.confidence, meta.defaultConfidence, 0.35, 0.98),
    selfRelevance: clampImportNumber(raw.selfRelevance, meta.selfRelevance, 0, 1),
    triggers,
    sourceFile,
    sourceQuote: typeof raw.sourceQuote === 'string' ? raw.sourceQuote.slice(0, 240) : undefined,
    chunkIndex,
  }
  return {
    draftId: newDraftId(),
    ...base,
    enabled: true,
    ...previewMergeForDraft(store, base),
  }
}

function normalizeEpisodeDraft(raw: Record<string, unknown>, sourceFile: string): ImportEpisodeDraft | null {
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : ''
  if (!summary) return null
  return {
    draftId: newDraftId(),
    summary: summary.slice(0, 400),
    emotionalIntensity: clampImportNumber(raw.emotionalIntensity, 0.5, 0, 1),
    dominantEmotion: typeof raw.dominantEmotion === 'string' ? raw.dominantEmotion.slice(0, 32) : 'neutral',
    keywords: Array.isArray(raw.keywords)
      ? raw.keywords.map((item) => String(item).trim()).filter(Boolean).slice(0, 8)
      : [],
    timeRange: typeof raw.timeRange === 'string' ? raw.timeRange.slice(0, 64) : undefined,
    sourceFile,
    enabled: true,
  }
}

function normalizeAnchorDraft(raw: Record<string, unknown>, sourceFile: string): ImportAnchorDraft | null {
  const label = typeof raw.label === 'string' ? raw.label.trim() : ''
  if (!label) return null
  const monthDay = typeof raw.monthDay === 'string' && /^\d{1,2}-\d{1,2}$/.test(raw.monthDay)
    ? raw.monthDay
    : undefined
  return {
    draftId: newDraftId(),
    type: raw.type === 'birthday' || raw.type === 'anniversary' || raw.type === 'custom' ? raw.type : 'custom',
    label: label.slice(0, 80),
    monthDay,
    year: raw.year !== undefined ? clampInteger(raw.year, new Date().getFullYear(), 1900, 2100) : undefined,
    summary: typeof raw.summary === 'string' ? raw.summary.slice(0, 200) : label.slice(0, 200),
    sourceFile,
    enabled: true,
  }
}

function unwrapMemoryJson(parsed: unknown): {
  facts: Record<string, unknown>[]
  episodes: Record<string, unknown>[]
  anchors: Record<string, unknown>[]
} {
  if (Array.isArray(parsed)) return { facts: parsed.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item))), episodes: [], anchors: [] }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { facts: [], episodes: [], anchors: [] }
  const obj = parsed as Record<string, unknown>
  if (obj.subject && obj.summary) return { facts: [obj], episodes: [], anchors: [] }
  return {
    facts: Array.isArray(obj.facts)
      ? obj.facts.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
      : [],
    episodes: Array.isArray(obj.episodes)
      ? obj.episodes.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
      : [],
    anchors: Array.isArray(obj.anchors)
      ? obj.anchors.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
      : [],
  }
}

function parseJsonImportFile(text: string, sourceFile: string, store: FactStore): {
  facts: ImportFactDraft[]
  episodes: ImportEpisodeDraft[]
  anchors: ImportAnchorDraft[]
  chunksProcessed: number
  skipped: number
} {
  const parsed = JSON.parse(text) as unknown
  const unwrapped = unwrapMemoryJson(parsed)
  const facts: ImportFactDraft[] = []
  let skipped = 0
  unwrapped.facts.slice(0, 800).forEach((raw, index) => {
    if (raw.status === 'retired') {
      skipped += 1
      return
    }
    const draft = normalizeFactDraft(raw, sourceFile, index, store)
    if (draft) facts.push(draft)
    else skipped += 1
  })
  const episodes = unwrapped.episodes
    .slice(0, 200)
    .map((raw) => normalizeEpisodeDraft(raw, sourceFile))
    .filter((draft): draft is ImportEpisodeDraft => draft !== null)
  const anchors = unwrapped.anchors
    .slice(0, 200)
    .map((raw) => normalizeAnchorDraft(raw, sourceFile))
    .filter((draft): draft is ImportAnchorDraft => draft !== null)
  return { facts, episodes, anchors, chunksProcessed: 1, skipped }
}

function textChunks(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n')
  const paragraphs = normalized
    .split(/\n{2,}|(?=^[-*]\s+)/m)
    .map((part) => part.replace(/^[-*]\s+/, '').trim())
    .filter((part) => part.length >= 8)
  const chunks = paragraphs.length > 0 ? paragraphs : [normalized.trim()]
  return chunks
    .flatMap((chunk) => {
      if (chunk.length <= 600) return [chunk]
      const parts: string[] = []
      for (let i = 0; i < chunk.length; i += 600) parts.push(chunk.slice(i, i + 600))
      return parts
    })
    .filter(Boolean)
    .slice(0, 120)
}

function inferTextSubcategory(text: string): Subcategory {
  if (/生日|出生|年龄|姓名|昵称|身高|地址/.test(text)) return 'BASIC_PROFILE'
  if (/家人|父母|妈妈|爸爸|哥哥|姐姐|妹妹|弟弟|朋友/.test(text)) return 'FAMILY'
  if (/工作|职业|公司|项目|代码|开发|学习/.test(text)) return 'CAREER'
  if (/目标|计划|打算|想要|准备/.test(text)) return 'PLANS'
  if (/喜欢|讨厌|偏好|爱好|口味/.test(text)) return 'TASTES'
  if (/健康|睡眠|焦虑|压力|生病|医院/.test(text)) return 'HEALTH'
  return 'LIFE_STORY'
}

function parseTextImportFile(text: string, sourceFile: string, store: FactStore): {
  facts: ImportFactDraft[]
  episodes: ImportEpisodeDraft[]
  anchors: ImportAnchorDraft[]
  chunksProcessed: number
} {
  const facts: ImportFactDraft[] = []
  const title = sourceFile.split('/').pop()?.replace(/\.[^.]+$/, '') || '导入文档'
  textChunks(text).forEach((chunk, index) => {
    const firstLine = chunk.split('\n').find((line) => line.trim())?.trim() ?? title
    const subcategory = inferTextSubcategory(chunk)
    const raw = {
      domain: domainForSubcategory(subcategory),
      subcategory,
      subject: firstLine.replace(/^#+\s*/, '').slice(0, 80) || title,
      summary: chunk.replace(/\s+/g, ' ').slice(0, 420),
      sourceQuote: chunk.slice(0, 220),
      confidence: 0.62,
      weight: 1,
    }
    const draft = normalizeFactDraft(raw, sourceFile, index, store)
    if (draft) facts.push(draft)
  })
  const episode = text.trim()
    ? normalizeEpisodeDraft({
        summary: `导入了文档 ${title}，包含 ${facts.length} 条可确认信息。`,
        emotionalIntensity: 0.3,
        dominantEmotion: 'neutral',
        keywords: [title],
      }, sourceFile)
    : null
  return {
    facts,
    episodes: episode ? [episode] : [],
    anchors: [],
    chunksProcessed: Math.max(1, facts.length),
  }
}

function readImportRelFile(root: string, relPath: string, maxBytes: number): { ok: true; text: string; relPath: string } | { ok: false; error: string } {
  const allowed =
    relPath.startsWith('imports/') ||
    relPath.startsWith('memory/') ||
    relPath.startsWith('diary/') ||
    relPath.startsWith('staging/')
  if (!allowed) return { ok: false, error: 'path must be under imports/, memory/, diary/, or staging/' }
  const resolved = resolveSafeChildFile(root, relPath)
  if (!resolved.ok) return resolved
  try {
    return { ok: true, relPath: resolved.relPath, text: readFileSync(resolved.absPath).slice(0, maxBytes).toString('utf-8') }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function ensureImportMemoryPath(root: string, relPath: string): { ok: true; relPath: string; promoted?: string } | { ok: false; error: string } {
  if (relPath.startsWith('memory/')) return { ok: true, relPath }
  if (!relPath.startsWith('imports/')) return { ok: false, error: 'path must be under imports/ or memory/' }
  const promoted = promoteImportToMemory(root, relPath)
  if (!promoted.ok) return promoted
  return { ok: true, relPath: promoted.to, promoted: promoted.to }
}

function sanitizeMemoryPatch(patch: unknown): MemoryUpdatePatch {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw Object.assign(new Error('memory:update requires an object patch'), { code: 'INVALID_ARGUMENT' })
  }
  const input = patch as Record<string, unknown>
  const out: MemoryUpdatePatch = {}
  if (typeof input.summary === 'string') out.summary = input.summary.slice(0, 2000)
  if (input.weight !== undefined) out.weight = clampNumber(input.weight, 1, 0, 10)
  if (input.confidence !== undefined) out.confidence = clampNumber(input.confidence, 0.7, 0, 1)
  if (Array.isArray(input.triggers)) {
    out.triggers = input.triggers
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 20)
  }
  if (input.sensitivity === 'normal' || input.sensitivity === 'avoid') out.sensitivity = input.sensitivity
  if (input.tier === 'core' || input.tier === 'archival') out.tier = input.tier
  if (input.privacyLevel === 'normal' || input.privacyLevel === 'intimate' || input.privacyLevel === 'explicit') {
    out.privacyLevel = input.privacyLevel
  }
  return out
}

function clearChatHistoryFiles(root: string): void {
  const companionDir = join(root, 'companion')
  if (!existsSync(companionDir)) return
  for (const entry of readdirSync(companionDir)) {
    const isLegacy = entry === 'chat-history.json'
    const isSession = entry.startsWith('chat-history-') && entry.endsWith('.json')
    if (!isLegacy && !isSession) continue
    try {
      rmSync(join(companionDir, entry), { force: true })
    } catch {
      /* ignore */
    }
  }
  deleteChatHistoryFromDb(root)
}

function listTraceDates(root: string): string[] {
  const dates = new Set<string>()
  const traceDir = join(root, 'traces')
  if (existsSync(traceDir)) {
    for (const name of readdirSync(traceDir)) {
      const match = name.match(/^trace-(\d{4}-\d{2}-\d{2})\.jsonl$/)
      if (match) dates.add(match[1])
    }
  }
  dates.add(new Date().toISOString().slice(0, 10))
  return [...dates].sort((a, b) => b.localeCompare(a))
}

function traceLatestFromDb(root: string, limit: number): TurnTrace[] {
  const db = getDatabase(root)
  if (!db) return []
  try {
    const rows = db
      .prepare(
        `SELECT trace_json FROM turn_traces
         ORDER BY timestamp DESC, id DESC
         LIMIT ?`
      )
      .all(limit) as { trace_json: string }[]
    return rows
      .map((row) => {
        try {
          return JSON.parse(row.trace_json) as TurnTrace
        } catch {
          return null
        }
      })
      .filter((row): row is TurnTrace => row !== null)
      .reverse()
  } catch {
    return []
  }
}

function traceLatestFromFiles(root: string, limit: number): TurnTrace[] {
  const traces: TurnTrace[] = []
  for (const date of listTraceDates(root)) {
    traces.push(...loadTraceFile(root, date))
    if (traces.length >= limit * 2) break
  }
  return traces
    .sort((a, b) => {
      const ta = new Date(a.timestamp ?? 0).getTime()
      const tb = new Date(b.timestamp ?? 0).getTime()
      if (ta !== tb) return ta - tb
      return (a.turn ?? 0) - (b.turn ?? 0)
    })
    .slice(-limit)
}

function sameLocalDate(iso: string | undefined, date: string): boolean {
  return typeof iso === 'string' && iso.slice(0, 10) === date
}

function chatRowText(row: unknown): string | null {
  if (!row || typeof row !== 'object') return null
  const record = row as Record<string, unknown>
  const role = typeof record.role === 'string' ? record.role : typeof record.kind === 'string' ? record.kind : ''
  const content = typeof record.content === 'string' ? record.content : ''
  if (!content.trim()) return null
  return `${role || 'message'}: ${content.trim().slice(0, 240)}`
}

function buildDeterministicDiary(root: string, date: string): { content: string; facts: number; traces: number; chats: number } {
  const store = factStore(root)
  const facts = store
    .listActive()
    .filter((fact) => sameLocalDate(fact.createdAt, date) || sameLocalDate(fact.updatedAt, date))
    .sort((a, b) => b.weight * b.confidence - a.weight * a.confidence)
    .slice(0, 24)
  const traces = loadTraceFile(root, date).slice(-12)
  const chatRows = loadChatHistoryFromDb(root, currentWebSessionId())
    .map(chatRowText)
    .filter((row): row is string => Boolean(row))
    .slice(-20)

  const lines: string[] = [
    `# ${date}`,
    '',
    '> Web 本地版生成的结构化日记。内容来自当天记忆、trace 与最近聊天记录；未调用 LLM。',
    '',
  ]

  if (facts.length > 0) {
    lines.push('## 今日记住的事', '')
    for (const fact of facts) {
      lines.push(`- ${fact.subject}: ${fact.summary}`)
    }
    lines.push('')
  }

  if (traces.length > 0) {
    lines.push('## 情绪轨迹', '')
    for (const trace of traces) {
      lines.push(
        `- 轮 ${trace.turn}: ${trace.l2?.label ?? 'unknown'} aff=${trace.l2?.aff ?? 0} sec=${trace.l2?.sec ?? 0}`
      )
    }
    lines.push('')
  }

  if (chatRows.length > 0) {
    lines.push('## 对话片段', '')
    for (const row of chatRows) lines.push(`- ${row}`)
    lines.push('')
  }

  if (facts.length === 0 && traces.length === 0 && chatRows.length === 0) {
    lines.push('今天没有足够材料生成日记。', '')
  }

  return {
    content: lines.join('\n').trimEnd() + '\n',
    facts: facts.length,
    traces: traces.length,
    chats: chatRows.length,
  }
}

function readDiaryMeta(root: string): Record<string, DiaryMetaEntry> {
  return readJson<Record<string, DiaryMetaEntry>>(join(root, 'diary', 'meta.json'), {})
}

function writeDiaryMeta(root: string, meta: Record<string, DiaryMetaEntry>): void {
  const path = join(root, 'diary', 'meta.json')
  mkdirSync(join(root, 'diary'), { recursive: true })
  writeFileSync(path, JSON.stringify(meta, null, 2), 'utf-8')
}

export function handleWebStateReset(): ReturnType<typeof defaultFullState> {
  const root = rootWithLayout()
  const settings = loadWebSettings()
  const state = defaultFullState(defaultPersonalitySlice(settings))
  saveWebState(root, state, currentWebSessionId())
  return state
}

export function handleWebWriteAllowed(
  rel: unknown,
  content: unknown,
  mode: unknown
): { ok: true } | { ok: false; error: string } {
  if (typeof rel !== 'string' || !rel.trim()) return { ok: false, error: 'missing relative path' }
  if (typeof content !== 'string') return { ok: false, error: 'content must be a string' }
  return appendOrOverwriteAllowed(rootWithLayout(), rel, content, normalizeWriteMode(mode))
}

export function handleWebSessionCreate(name: unknown): {
  id: string
  sessions: ReturnType<typeof loadWebSessionsFile>
} {
  const root = rootWithLayout()
  const sessions = loadWebSessionsFile(root)
  const id = `session-${Date.now()}`
  const now = new Date().toISOString()
  sessions.push({
    id,
    name: normalizeSessionName(name, `会话 ${sessions.length + 1}`),
    createdAt: now,
    lastActive: now,
  })
  saveWebSessionsFile(root, sessions)
  const settings = loadWebSettings()
  saveWebState(root, defaultFullState(defaultPersonalitySlice(settings)), id)
  return { id, sessions }
}

export function handleWebSessionDelete(sessionId: unknown): {
  ok: boolean
  sessions?: ReturnType<typeof loadWebSessionsFile>
  error?: string
} {
  const id = stringArg(sessionId, 'session:delete')
  const root = rootWithLayout()
  let sessions = loadWebSessionsFile(root)
  if (sessions.length <= 1) return { ok: false, error: '至少保留一个会话' }
  if (!sessions.some((session) => session.id === id)) return { ok: false, error: '会话不存在' }

  sessions = sessions.filter((session) => session.id !== id)
  saveWebSessionsFile(root, sessions)
  try {
    rmSync(join(root, 'companion', `state-${id}.json`), { force: true })
    rmSync(join(root, 'companion', `chat-history-${id}.json`), { force: true })
  } catch {
    /* best effort */
  }
  deleteCompanionStateFromDb(root, id)
  deleteChatHistoryFromDb(root, id)

  const settings = loadWebSettings()
  if ((settings.activeSessionId || 'default') === id) {
    saveWebSettings({ activeSessionId: sessions[0]?.id ?? 'default' })
  }
  return { ok: true, sessions }
}

export function handleWebCanonGet(): {
  name: string
  birthDate: string
  creator: typeof ACKEM_CANON.creator
} {
  return {
    name: ACKEM_CANON.name,
    birthDate: ACKEM_CANON.birthDate,
    creator: { ...ACKEM_CANON.creator },
  }
}

export function handleWebCreatorMemoryGet(): {
  version: string
  documentVersion: string
  entryCount: number
  decayPolicy: 'none'
  seededAt: string | null
  entries: Array<{
    id: string
    category: string
    title: string
    content: string
    narrativeAt: string
  }>
} {
  const store = loadCreatorMemoryStore(rootWithLayout())
  return {
    version: store.version,
    documentVersion: store.documentVersion ?? store.version,
    entryCount: store.entries.length,
    decayPolicy: store.decayPolicy,
    seededAt: store.seededAt ?? null,
    entries: store.entries.map((entry) => ({
      id: entry.id,
      category: entry.category,
      title: entry.title,
      content: entry.content,
      narrativeAt: entry.narrativeAt,
    })),
  }
}

export function handleWebPolicyDecisionLogRecent(limitArg?: unknown): {
  logs: ReturnType<typeof listRecentDecisionLogs>
  summary: ReturnType<typeof summarizeRecentDecisions>
  embeddingRoutingPlanned: boolean
} {
  const limit = clampInteger(limitArg, 20, 1, 200)
  const logs = listRecentDecisionLogs(rootWithLayout(), limit)
  return {
    logs,
    summary: summarizeRecentDecisions(logs),
    embeddingRoutingPlanned: DECISION_LOG_EMBEDDING_ROUTING_PLANNED,
  }
}

export function handleWebPersonalityList(genderArg?: unknown): Array<{
  id: string
  label: string
  gender: string
  requiresAdult18: boolean
}> {
  const settings = loadWebSettings()
  const gender = genderArg === 'female' || genderArg === 'male' ? genderArg : settings.companionGender
  return sortPresetsForDisplay(PERSONALITY_PRESETS.filter((preset) => preset.gender === gender)).map((preset) => ({
    id: preset.id,
    label: preset.label,
    gender: preset.gender,
    requiresAdult18: preset.requiresAdult18 === true,
  }))
}

export function handleWebPersonalitySet(idArg: unknown): ReturnType<typeof loadWebSettings> {
  const id = stringArg(idArg, 'personality:set')
  const settings = loadWebSettings()
  const preset = getPreset(id)
  if (preset?.requiresAdult18 && !settings.ageConfirmed18) {
    throw Object.assign(new Error('PERSONALITY_NEED_AGE_CONFIRM'), { code: 'PERSONALITY_NEED_AGE_CONFIRM' })
  }
  const next = saveWebSettings({
    personalityPresetId: id,
    ...(preset ? { companionGender: preset.gender } : {}),
  })
  const root = rootWithLayout()
  const state = mergeWebEngineState(root, next)
  state.personality = defaultPersonalitySlice(next)
  state.personalityBaseline = {
    T: state.personality.T,
    I: state.personality.I,
    S: state.personality.S,
    O: state.personality.O,
    R: state.personality.R,
  }
  saveWebState(root, state, currentWebSessionId())
  return next
}

export function handleWebMemoryConsolidate(): { added: number; considered: number; mode: 'web_deterministic' } {
  const root = rootWithLayout()
  const settings = loadWebSettings()
  const state = mergeWebEngineState(root, settings)
  const store = factStore(root)
  store.preferDbWrites()
  const recent = store
    .listActive()
    .filter((fact) => !fact.factLayer || fact.factLayer === 'raw')
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 60)
  const groups = new Map<string, MemoryFact[]>()
  for (const fact of recent) {
    const key = `${fact.domain}::${fact.subcategory}`
    groups.set(key, [...(groups.get(key) ?? []), fact])
  }

  const emotionalContext = captureEmotionalContext(state.relationship, state.emotion)
  let added = 0
  for (const [key, facts] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 4)) {
    if (facts.length < 3) continue
    const [, subcategory] = key.split('::')
    if (!isValidSubcategory(subcategory)) continue
    const subjects = [...new Set(facts.map((fact) => fact.subject).filter(Boolean))].slice(0, 4)
    const subject = `${CATEGORY_META[subcategory].label}模式`
    const summary = `近期多条记忆反复指向${subjects.length ? `「${subjects.join('、')}」` : CATEGORY_META[subcategory].label}：${facts
      .slice(0, 3)
      .map((fact) => fact.summary.replace(/\s+/g, ' ').slice(0, 80))
      .join('；')}`
    if (store.findSimilarFacts(subcategory, subject, summary, 0.42).length > 0) continue
    const result = store.addFactDetailed({
      domain: domainForSubcategory(subcategory),
      subcategory,
      subject,
      summary: summary.slice(0, 500),
      weight: Math.min(4.5, 1.4 + facts.length * 0.25),
      confidence: 0.68,
      selfRelevance: 1,
      triggers: [...new Set(facts.flatMap((fact) => fact.triggers ?? []))].slice(0, 12),
      sourceSessionId: currentWebSessionId(),
      sourceTurnIndex: state.counters.totalTurns,
      emotionalContext,
      derivedFrom: facts.map((fact) => fact.id),
      factLayer: 'consolidated',
    })
    if (result.isNew) added += 1
  }
  store.flush()
  state.counters.lastConsolidationTurn = state.counters.totalTurns
  saveWebState(root, state, currentWebSessionId())
  return { added, considered: recent.length, mode: 'web_deterministic' }
}

export async function handleWebMirrorCheck(): Promise<{
  contradictions: Awaited<ReturnType<typeof runMirrorCheck>>
  findings: ReturnType<typeof appendMirrorFindings>
}> {
  const root = rootWithLayout()
  const settings = loadWebSettings()
  const state = mergeWebEngineState(root, settings)
  const contradictions = await runMirrorCheck(root, factStore(root))
  const findings = appendMirrorFindings(root, contradictions, [], state.counters.totalTurns)
  state.counters.lastMirrorCheckTurn = state.counters.totalTurns
  saveWebState(root, state, currentWebSessionId())
  return { contradictions, findings }
}

export function handleWebMirrorFindings(): ReturnType<typeof readMirrorFindings> {
  return readMirrorFindings(rootWithLayout())
}

export function handleWebProfileEstimateScan(relPathsArg: unknown): ReturnType<typeof estimateScanStats> & {
  isLocal: boolean
  consentVersion: number
} {
  const settings = loadWebSettings()
  const root = rootWithLayout()
  return {
    ...estimateScanStats(root, normalizeProfileRelPaths(relPathsArg)),
    isLocal: isLocalWebLlmEndpoint(settings),
    consentVersion: INFERENCE_CONSENT_VERSION,
  }
}

export function handleWebProfileInferFromFiles(args?: ProfileInferArgs): {
  ok: true
  userSixDimensions: UserSixDimensions
  companionSuggestion: CompanionSuggestion
} | { ok: false; error: string } {
  if (!args?.consentAck) return { ok: false, error: '须先确认知情同意' }
  if (Number(args.consentVersion) !== INFERENCE_CONSENT_VERSION) {
    return { ok: false, error: '知情同意版本已更新，请重新阅读并确认' }
  }
  const relPaths = normalizeProfileRelPaths(args.relPaths)
  if (relPaths.length === 0) return { ok: false, error: '未选择文件' }

  try {
    const root = rootWithLayout()
    const settings = loadWebSettings()
    const result = deterministicProfileInference(root, relPaths)
    const portraitWrite = writePortraitSummary(root, result)
    if (!portraitWrite.ok) return { ok: false, error: portraitWrite.error }

    const state = mergeWebEngineState(root, settings)
    state.userSixDimensions = result.userSix
    state.companionSuggestion = result.companionSuggestion
    state.userProfile = mapToLegacyUserProfile(result.userSix, state.userProfile)
    saveWebState(root, state, currentWebSessionId())
    saveWebSettings({ personalityConfigMode: 'inferred' })
    return {
      ok: true,
      userSixDimensions: result.userSix,
      companionSuggestion: result.companionSuggestion,
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function handleWebProfileApplyCompanionSuggestion(): {
  ok: true
  personality: ReturnType<typeof defaultPersonalitySlice>
} | { ok: false; error: string } {
  const root = rootWithLayout()
  const settings = loadWebSettings()
  const state = mergeWebEngineState(root, settings)
  const suggestion = state.companionSuggestion
  if (!suggestion) return { ok: false, error: '暂无伴侣人格建议' }
  state.personality = {
    ...state.personality,
    T: suggestion.T,
    I: suggestion.I,
    S: suggestion.S,
    O: suggestion.O,
    R: suggestion.R,
  }
  state.personalityBaseline = {
    T: suggestion.T,
    I: suggestion.I,
    S: suggestion.S,
    O: suggestion.O,
    R: suggestion.R,
  }
  saveWebState(root, state, currentWebSessionId())
  return { ok: true, personality: state.personality }
}

export function handleWebMemoryListFull(): MemoryFact[] {
  return factStore().listActive()
}

export function handleWebMemoryRead(id: unknown): { ok: true; fact: MemoryFact } | { ok: false; error: string } {
  const fact = factStore().getById(stringArg(id, 'memory:read'))
  return fact ? { ok: true, fact } : { ok: false, error: 'memory fact not found' }
}

export function handleWebMemoryUpdate(id: unknown, patch: unknown): boolean {
  return factStore().updateFact(stringArg(id, 'memory:update'), sanitizeMemoryPatch(patch))
}

export function handleWebMemoryRetire(id: unknown): boolean {
  return factStore().retireFact(stringArg(id, 'memory:retire'))
}

export function handleWebMemoryFeedback(
  id: unknown,
  action: unknown,
  payload?: unknown
): boolean {
  const factId = stringArg(id, 'memory:feedback')
  const feedback = stringArg(action, 'memory:feedback') as MemoryFeedbackAction
  const store = factStore()
  if (feedback === 'delete') return store.retireFact(factId)
  const fact = store.getById(factId)
  if (!fact) return false
  if (feedback === 'thumbs_up') {
    return store.updateFact(factId, { confidence: Math.min(1, fact.confidence + 0.1) })
  }
  if (feedback === 'thumbs_down') {
    return store.updateFact(factId, { confidence: Math.max(0.3, fact.confidence - 0.15) })
  }
  if (feedback === 'edit') {
    return store.updateFact(factId, sanitizeMemoryPatch(payload))
  }
  return false
}

export function handleWebMemoryClearAll(): { ok: boolean; error?: string } {
  const root = rootWithLayout()
  const dirsToClear = [
    join(root, 'memory', 'facts'),
    join(root, 'memory', 'tree'),
    join(root, 'memory', 'shared-events'),
    join(root, 'memory', 'episodes'),
    join(root, 'memory', 'kg'),
    join(root, 'memory', 'archive'),
    join(root, 'diary'),
    join(root, 'portrait'),
    join(root, 'preferences'),
    join(root, 'staging'),
    join(root, '_derived'),
  ]

  for (const dir of dirsToClear) {
    try {
      if (!existsSync(dir)) continue
      for (const entry of readdirSync(dir)) rmSync(join(dir, entry), { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
  clearChatHistoryFiles(root)
  try {
    clearStructuredData(root)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  workingMemory.clearAll()
  ensureDataLayout(root)

  const settings = loadWebSettings()
  const state = defaultFullState(defaultPersonalitySlice(settings))
  saveWebState(root, state, currentWebSessionId())
  return { ok: true }
}

export function handleWebMemoryExportArchive(): ReturnType<typeof exportMemoryArchive> {
  const root = rootWithLayout()
  return exportMemoryArchive(root, factStore(root), episodicStore(root))
}

export function handleWebMemoryVectorSearch(query: unknown, topK?: unknown): {
  results: Array<{ factId: string; score: number }>
  facts: Array<Pick<MemoryFact, 'id' | 'subject' | 'summary' | 'subcategory'>>
} {
  const q = stringArg(query, 'memory:vectorSearch')
  const store = factStore()
  const active = store.listActive()
  const vs = new VectorStore()
  vs.build(active)
  const results = vs.search(q, clampInteger(topK, 6, 1, 50))
  return {
    results,
    facts: vs.resolveFacts(results, active).map((fact) => ({
      id: fact.id,
      subject: fact.subject,
      summary: fact.summary,
      subcategory: fact.subcategory,
    })),
  }
}

export function handleWebMemoryStats(): {
  totalFacts: number
  activeFacts: number
  retiredFacts: number
  coreFacts: number
  totalTriples: number
  totalAssociations: number
  totalEpisodes: number
  totalAnchors: number
  byDomain: Array<{ domain: string; c: number }>
  bySubcategory: Array<{ subcategory: string; c: number }>
} | null {
  const root = rootWithLayout()
  const db = getDatabase(root)
  if (!db) return null
  const count = (sql: string) => (db.prepare(sql).get() as { c: number } | undefined)?.c ?? 0
  const all = <T>(sql: string) => db.prepare(sql).all() as T[]
  return {
    totalFacts: count('SELECT COUNT(*) as c FROM memory_facts'),
    activeFacts: count("SELECT COUNT(*) as c FROM memory_facts WHERE status='active'"),
    retiredFacts: count("SELECT COUNT(*) as c FROM memory_facts WHERE status='retired'"),
    coreFacts: count("SELECT COUNT(*) as c FROM memory_facts WHERE tier='core'"),
    totalTriples: count('SELECT COUNT(*) as c FROM knowledge_triples'),
    totalAssociations: count('SELECT COUNT(*) as c FROM memory_associations WHERE strength > 0.05'),
    totalEpisodes: count('SELECT COUNT(*) as c FROM episodes'),
    totalAnchors: count('SELECT COUNT(*) as c FROM temporal_anchors'),
    byDomain: all<{ domain: string; c: number }>(
      "SELECT domain, COUNT(*) as c FROM memory_facts WHERE status='active' GROUP BY domain"
    ),
    bySubcategory: all<{ subcategory: string; c: number }>(
      "SELECT subcategory, COUNT(*) as c FROM memory_facts WHERE status='active' GROUP BY subcategory"
    ),
  }
}

export function handleWebMemoryAuditReport(opts?: {
  mode?: 'curated_audit' | 'self_report' | 'stats_only' | 'full_dump'
  includeAvoid?: boolean
  page?: number
}): {
  report: unknown
  card: unknown
} {
  const root = rootWithLayout()
  const report = buildMemoryAuditReport({
    dataRoot: root,
    factStore: factStore(root),
    episodicStore: episodicStore(root),
    mode: opts?.mode ?? 'curated_audit',
    includeAvoid: opts?.includeAvoid ?? false,
    page: opts?.page,
  })
  const cardBody = formatMemoryAuditMarkdown(report)
  return { report, card: toMemoryAuditCardPayload(report, cardBody) }
}

export function handleWebArchiveListFull(): ReturnType<typeof handleWebArchiveList> {
  return handleWebArchiveList()
}

export function handleWebArchiveRead(relPath: unknown, maxBytes?: unknown): {
  ok: true
  text: string
  path: string
} | { ok: false; error: string } {
  const root = rootWithLayout()
  const archiveRoot = join(root, 'memory', 'archive')
  const resolved = resolveSafeChildFile(archiveRoot, relPath)
  if (!resolved.ok) return { ok: false, error: resolved.error }
  const limit = clampInteger(maxBytes, 512_000, 1, 5_000_000)
  try {
    const text = readFileSync(resolved.absPath).slice(0, limit).toString('utf-8')
    return { ok: true, text, path: resolved.relPath }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function handleWebArchiveExport(): ReturnType<typeof handleWebMemoryExportArchive> {
  return handleWebMemoryExportArchive()
}

export function handleWebDiaryListFull(): ReturnType<typeof handleWebDiaryList> {
  return handleWebDiaryList()
}

export function handleWebDiaryRead(dateArg: unknown): { ok: true; date: string; content: string } | { ok: false; error: string } {
  if (!isSafeIsoDate(dateArg)) return { ok: false, error: 'invalid date' }
  const root = rootWithLayout()
  const fromDb = loadDiaryFromDb(root, dateArg)
  if (fromDb !== null) return { ok: true, date: dateArg, content: fromDb }
  const file = join(root, 'diary', `${dateArg}.md`)
  if (!existsSync(file)) return { ok: false, error: 'diary not found' }
  try {
    return { ok: true, date: dateArg, content: readFileSync(file, 'utf-8') }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function handleWebDiaryGenerate(opts?: DiaryGenerateOptions): Promise<{
  ok: boolean
  path?: string
  date?: string
  writeMode?: string
  reason?: string
  stats?: { facts: number; traces: number; chats: number }
}> {
  const root = rootWithLayout()
  const date = opts?.date ?? new Date().toISOString().slice(0, 10)
  if (!isSafeIsoDate(date)) return { ok: false, reason: 'invalid date' }
  const file = join(root, 'diary', `${date}.md`)
  if (existsSync(file) && !opts?.force) {
    return { ok: false, date, path: file, reason: 'diary already exists' }
  }

  const generated = buildDeterministicDiary(root, date)
  mkdirSync(join(root, 'diary'), { recursive: true })
  writeFileSync(file, generated.content, 'utf-8')
  const meta = readDiaryMeta(root)
  meta[date] = {
    ...(meta[date] ?? {}),
    type: 'daily',
    writeMode: 'web_structured',
    trigger: 'manual',
    generatedAt: new Date().toISOString(),
  }
  writeDiaryMeta(root, meta)
  saveDiaryToDb(root, date, generated.content, JSON.stringify(meta[date]))
  return { ok: true, date, path: file, writeMode: 'web_structured', stats: generated }
}

export function handleWebDiaryAutoGenerated(limitArg?: unknown): {
  entries: Array<{ date: string; path: string; generatedAt: string | null; type: string }>
} {
  const root = rootWithLayout()
  const limit = clampInteger(limitArg, 10, 1, 100)
  const meta = readDiaryMeta(root)
  const entries = Object.entries(meta)
    .filter(([, value]) => Boolean(value.generatedAt || value.trigger))
    .map(([date, value]) => ({
      date,
      path: `${date}.md`,
      generatedAt: value.generatedAt ?? null,
      type: value.type ?? 'daily',
    }))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit)
  return { entries }
}

export function handleWebTraceLatest(limitArg?: unknown): TurnTrace[] {
  const root = rootWithLayout()
  const limit = clampInteger(limitArg, 50, 1, 500)
  const fromDb = traceLatestFromDb(root, limit)
  if (fromDb.length > 0) return fromDb
  return traceLatestFromFiles(root, limit)
}

export function handleWebDesireList(): DesireStack {
  const root = rootWithLayout()
  return mergeWebEngineState(root, loadWebSettings()).desireStack
}

export function handleWebDesireDismiss(desireId: unknown): DesireStack {
  const root = rootWithLayout()
  const settings = loadWebSettings()
  const state = mergeWebEngineState(root, settings)
  state.desireStack = dismissDesireFromStack(state.desireStack, stringArg(desireId, 'desire:dismiss'))
  saveWebState(root, state, settings.activeSessionId || 'default')
  return state.desireStack
}

export function handleWebDesireClearActive(): DesireStack {
  const root = rootWithLayout()
  const settings = loadWebSettings()
  const state = mergeWebEngineState(root, settings)
  state.desireStack = clearActiveDesires(state.desireStack)
  saveWebState(root, state, settings.activeSessionId || 'default')
  return state.desireStack
}

export function handleWebProfileGet(): {
  mode: 'manual' | 'inferred'
  userSixDimensions: unknown | null
  companionSuggestion: unknown | null
} {
  const root = rootWithLayout()
  const state = mergeWebEngineState(root, loadWebSettings())
  return {
    mode: state.userSixDimensions ? 'inferred' : 'manual',
    userSixDimensions: state.userSixDimensions ?? null,
    companionSuggestion: state.companionSuggestion ?? null,
  }
}

export function handleWebEpisodeList(): ReturnType<EpisodicStore['listAll']> {
  return episodicStore().listAll()
}

export function handleWebKgList(): ReturnType<KnowledgeGraph['listAll']> {
  return knowledgeGraph().listAll()
}

export function handleWebKgOneHop(entity: unknown): ReturnType<KnowledgeGraph['oneHop']> {
  return knowledgeGraph().oneHop(stringArg(entity, 'kg:oneHop'))
}

export function handleWebAssociationList(): unknown[] {
  const db = getDatabase(rootWithLayout())
  if (!db) return []
  return db
    .prepare('SELECT * FROM memory_associations WHERE strength > 0.05 ORDER BY strength DESC')
    .all() as unknown[]
}

export function handleWebAnchorList(): unknown[] {
  const db = getDatabase(rootWithLayout())
  if (!db) return []
  return db.prepare('SELECT * FROM temporal_anchors ORDER BY anchor_date DESC').all() as unknown[]
}

export async function handleWebImportParseDocuments(args?: ImportParseArgs): Promise<ImportParseResult> {
  const root = rootWithLayout()
  if (!args?.consentAck) return { ok: false, error: '须先确认知情同意' }
  if (Number(args.consentVersion) !== IMPORT_CONSENT_VERSION) {
    return { ok: false, error: '知情同意版本已更新，请重新确认' }
  }
  const relPaths = normalizeRelPathList(args.relPaths)
  if (relPaths.length === 0) return { ok: false, error: '未选择文件' }

  const store = factStore(root)
  const job: ImportJob = {
    id: randomUUID(),
    status: 'parsing',
    files: [],
    createdAt: new Date().toISOString(),
    facts: [],
    episodes: [],
    anchors: [],
    stats: {
      chunksProcessed: 0,
      factsExtracted: 0,
      factsMergedPreview: 0,
      episodesExtracted: 0,
      anchorsExtracted: 0,
    },
  }
  saveImportJob(root, job)

  const promoted: string[] = []
  try {
    for (const rel of relPaths) {
      const ensured = ensureImportMemoryPath(root, rel)
      if (!ensured.ok) return { ok: false, error: ensured.error }
      if (ensured.promoted) promoted.push(ensured.promoted)

      const read = readImportRelFile(root, ensured.relPath, loadWebSettings().singleFileSoftLimitBytes ?? 120_000)
      if (!read.ok) return { ok: false, error: `${ensured.relPath}: ${read.error}` }
      const lower = read.relPath.toLowerCase()
      const parsed = lower.endsWith('.json')
        ? parseJsonImportFile(read.text, read.relPath, store)
        : parseTextImportFile(read.text, read.relPath, store)

      job.files.push(read.relPath)
      job.facts.push(...parsed.facts)
      job.episodes.push(...parsed.episodes)
      job.anchors.push(...parsed.anchors)
      job.stats.chunksProcessed += parsed.chunksProcessed
    }

    job.stats.factsExtracted = job.facts.length
    job.stats.factsMergedPreview = job.facts.filter((fact) => Boolean(fact.mergeWithExistingId)).length
    job.stats.episodesExtracted = job.episodes.length
    job.stats.anchorsExtracted = job.anchors.length
    job.status = job.facts.length || job.episodes.length || job.anchors.length ? 'ready' : 'failed'
    if (job.status === 'failed') job.error = '所选文件为空或没有可导入内容'
    saveImportJob(root, job)

    return job.status === 'ready'
      ? { ok: true, job, promoted }
      : { ok: false, error: job.error ?? '解析失败' }
  } catch (error) {
    job.status = 'failed'
    job.error = error instanceof Error ? error.message : String(error)
    saveImportJob(root, job)
    return { ok: false, error: job.error }
  }
}

export function handleWebImportGetJob(jobId: unknown): ImportJob | null {
  return loadImportJob(rootWithLayout(), jobId)
}

function writeImportAnchor(root: string, anchor: ImportAnchorDraft, linkedFactIds: string[]): boolean {
  const db = getDatabase(root)
  if (!db) return false
  const now = new Date()
  let anchorDate = now.toISOString().slice(0, 10)
  if (anchor.monthDay) {
    const [monthRaw, dayRaw] = anchor.monthDay.split('-')
    const month = String(Math.max(1, Math.min(12, Number(monthRaw) || 1))).padStart(2, '0')
    const day = String(Math.max(1, Math.min(31, Number(dayRaw) || 1))).padStart(2, '0')
    anchorDate = `${anchor.year ?? now.getFullYear()}-${month}-${day}`
  } else if (anchor.year) {
    anchorDate = `${anchor.year}-01-01`
  }
  const anchorType = anchor.type === 'birthday' || anchor.type === 'anniversary' ? 'recurring' : 'milestone'
  try {
    db.prepare(
      `INSERT OR IGNORE INTO temporal_anchors (id, anchor_date, anchor_type, linked_fact_ids, emotional_valence, emotional_intensity, domain, summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      anchorDate,
      anchorType,
      JSON.stringify(linkedFactIds),
      0,
      0.5,
      'TEMPORAL',
      `${anchor.label}: ${anchor.summary}`.slice(0, 200),
      now.toISOString()
    )
    return true
  } catch {
    return false
  }
}

export async function handleWebImportCommitJob(args?: ImportCommitArgs): Promise<ImportCommitResult> {
  const root = rootWithLayout()
  const job = loadImportJob(root, args?.jobId)
  if (!job) return { ok: false, error: '导入任务不存在' }
  if (job.status === 'committed') return { ok: false, error: '该任务已提交' }
  if (job.status !== 'ready') return { ok: false, error: job.error ?? '任务未就绪' }

  const disabled = new Set(
    Array.isArray(args?.disabledDraftIds)
      ? args.disabledDraftIds.filter((id): id is string => typeof id === 'string')
      : []
  )
  const settings = loadWebSettings()
  const state = mergeWebEngineState(root, settings)
  const emo = captureEmotionalContext(state.relationship, state.emotion)
  const store = factStore(root)
  store.preferDbWrites()
  const epStore = episodicStore(root)

  let factsWritten = 0
  let factsMerged = 0
  let episodesWritten = 0
  let anchorsWritten = 0
  const linkedFactIds: string[] = []

  for (const draft of job.facts) {
    if (!draft.enabled || disabled.has(draft.draftId)) continue
    const triggers = [...new Set([...(draft.triggers ?? []), ...extractTriggers(draft.subject, draft.summary)])]
    const result = store.addFactDetailed({
      domain: draft.domain,
      subcategory: draft.subcategory,
      subject: draft.subject,
      summary: draft.summary,
      weight: draft.weight,
      confidence: draft.confidence,
      selfRelevance: draft.selfRelevance,
      triggers,
      sourceSessionId: IMPORT_SESSION_ID,
      sourceTurnIndex: draft.chunkIndex,
      emotionalContext: emo,
    })
    linkedFactIds.push(result.fact.id)
    if (result.isNew) factsWritten += 1
    else factsMerged += 1
  }

  let latestEpisode = epStore.latest()
  for (const draft of job.episodes) {
    if (!draft.enabled || disabled.has(draft.draftId)) continue
    const episode = epStore.add({
      summary: draft.timeRange && !draft.summary.includes(draft.timeRange)
        ? `(${draft.timeRange}) ${draft.summary}`
        : draft.summary,
      emotionalIntensity: draft.emotionalIntensity,
      dominantEmotion: draft.dominantEmotion,
      keywords: draft.keywords,
      prevEpisodeId: latestEpisode?.id ?? null,
      sourceSessionId: IMPORT_SESSION_ID,
      startTurn: 0,
      endTurn: 0,
    })
    latestEpisode = episode
    episodesWritten += 1
  }

  for (const draft of job.anchors) {
    if (!draft.enabled || disabled.has(draft.draftId)) continue
    if (writeImportAnchor(root, draft, linkedFactIds.slice(0, 5))) anchorsWritten += 1
  }

  store.flush()
  job.status = 'committed'
  saveImportJob(root, job)
  const { associationSeed } = handleWebIndexRebuild()
  return { ok: true, factsWritten, factsMerged, episodesWritten, anchorsWritten, associationSeed }
}

export const EXPECTED_WEB_DATA_WORKFLOW_CHANNELS = [
  'state:reset',
  'fs:writeAllowed',
  'session:create',
  'session:delete',
  'canon:get',
  'canon:creator-memory:get',
  'policy:decisionLogRecent',
  'personality:list',
  'personality:set',
  'memory:list',
  'memory:read',
  'memory:update',
  'memory:retire',
  'memory:feedback',
  'memory:clearAll',
  'memory:exportArchive',
  'memory:vectorSearch',
  'memory:stats',
  'memory:auditReport',
  'memory:consolidate',
  'mirror:check',
  'mirror:findings',
  'archive:list',
  'archive:read',
  'archive:export',
  'diary:list',
  'diary:read',
  'diary:generate',
  'diary:autoGenerated',
  'trace:latest',
  'desire:list',
  'desire:dismiss',
  'desire:clearActive',
  'profile:get',
  'profile:estimateScan',
  'profile:inferFromFiles',
  'profile:applyCompanionSuggestion',
  'episode:list',
  'kg:list',
  'kg:oneHop',
  'association:list',
  'anchor:list',
  'import:parseDocuments',
  'import:getJob',
  'import:commitJob',
] as const

export function assertWebDataWorkflowHandlersComplete(registry = webDataWorkflowHandlers): {
  ok: boolean
  missing: string[]
} {
  const missing = EXPECTED_WEB_DATA_WORKFLOW_CHANNELS.filter((channel) => !registry.has(channel))
  return { ok: missing.length === 0, missing }
}

export const webDataWorkflowHandlers: ReadonlyMap<string, WebInvokeHandler> = new Map<string, WebInvokeHandler>([
  ['state:reset', () => handleWebStateReset()],
  ['fs:writeAllowed', (rel, content, mode) => handleWebWriteAllowed(rel, content, mode)],
  ['session:create', (name) => handleWebSessionCreate(name)],
  ['session:delete', (sessionId) => handleWebSessionDelete(sessionId)],
  ['canon:get', () => handleWebCanonGet()],
  ['canon:creator-memory:get', () => handleWebCreatorMemoryGet()],
  ['policy:decisionLogRecent', (limit) => handleWebPolicyDecisionLogRecent(limit)],
  ['personality:list', (gender) => handleWebPersonalityList(gender)],
  ['personality:set', (id) => handleWebPersonalitySet(id)],
  ['memory:list', () => handleWebMemoryListFull()],
  ['memory:read', (id) => handleWebMemoryRead(id)],
  ['memory:update', (id, patch) => handleWebMemoryUpdate(id, patch)],
  ['memory:retire', (id) => handleWebMemoryRetire(id)],
  ['memory:feedback', (id, action, payload) => handleWebMemoryFeedback(id, action, payload)],
  ['memory:clearAll', () => handleWebMemoryClearAll()],
  ['memory:exportArchive', () => handleWebMemoryExportArchive()],
  ['memory:vectorSearch', (query, topK) => handleWebMemoryVectorSearch(query, topK)],
  ['memory:stats', () => handleWebMemoryStats()],
  ['memory:auditReport', (opts) => handleWebMemoryAuditReport(opts as Parameters<typeof handleWebMemoryAuditReport>[0])],
  ['memory:consolidate', () => handleWebMemoryConsolidate()],
  ['mirror:check', () => handleWebMirrorCheck()],
  ['mirror:findings', () => handleWebMirrorFindings()],
  ['archive:list', () => handleWebArchiveListFull()],
  ['archive:read', (relPath, maxBytes) => handleWebArchiveRead(relPath, maxBytes)],
  ['archive:export', () => handleWebArchiveExport()],
  ['diary:list', () => handleWebDiaryListFull()],
  ['diary:read', (date) => handleWebDiaryRead(date)],
  ['diary:generate', (opts) => handleWebDiaryGenerate(opts as DiaryGenerateOptions | undefined)],
  ['diary:autoGenerated', (limit) => handleWebDiaryAutoGenerated(limit)],
  ['trace:latest', (limit) => handleWebTraceLatest(limit)],
  ['desire:list', () => handleWebDesireList()],
  ['desire:dismiss', (desireId) => handleWebDesireDismiss(desireId)],
  ['desire:clearActive', () => handleWebDesireClearActive()],
  ['profile:get', () => handleWebProfileGet()],
  ['profile:estimateScan', (relPaths) => handleWebProfileEstimateScan(relPaths)],
  ['profile:inferFromFiles', (args) => handleWebProfileInferFromFiles(args as ProfileInferArgs | undefined)],
  ['profile:applyCompanionSuggestion', () => handleWebProfileApplyCompanionSuggestion()],
  ['episode:list', () => handleWebEpisodeList()],
  ['kg:list', () => handleWebKgList()],
  ['kg:oneHop', (entity) => handleWebKgOneHop(entity)],
  ['association:list', () => handleWebAssociationList()],
  ['anchor:list', () => handleWebAnchorList()],
  ['import:parseDocuments', (args) => handleWebImportParseDocuments(args as ImportParseArgs | undefined)],
  ['import:getJob', (jobId) => handleWebImportGetJob(jobId)],
  ['import:commitJob', (args) => handleWebImportCommitJob(args as ImportCommitArgs | undefined)],
  ['thought:generate', () => unsupported('thought:generate', 'offline thought generation is not yet pure Web-safe')],
])

export function registerWebDataWorkflowHandlers(registry: WebHandlerRegistry): void {
  for (const [channel, handler] of webDataWorkflowHandlers) registry.set(channel, handler)
}
