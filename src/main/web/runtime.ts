import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AppSettings } from '../../shared/types'
import { clampOpenForUTemperature, OPENFORU_DEFAULT_MAX_TOKENS } from '../../shared/openforuConfig'
import {
  rendererI18nOverlayEn,
  rendererI18nOverlayZh,
} from '../../shared/i18n/rendererOverlay'
import { databasePath } from '../db/paths'
import { loadChatHistoryFromDb, saveChatHistoryToDb } from '../db/repos/chatHistory'
import { defaultFullState, loadState, saveState } from '../engine/state-persistence'
import type { FullState } from '../engine/types'
import { ensureDataLayout } from '../layout'
import { enResources } from '../i18n/en'
import { zhResources } from '../i18n/zh'
import { defaultPersonalitySlice } from '../personalityPresets'
import type { Locale } from '../i18n/types'

const DEFAULT_SETTINGS: AppSettings = {
  dataRootMode: 'portable',
  llmProvider: 'openai',
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiApiKey: '',
  anthropicBaseUrl: 'https://api.anthropic.com/v1',
  anthropicApiVersion: '2023-06-01',
  anthropicMaxTokens: 8192,
  model: 'gpt-4o-mini',
  timeoutMs: 120_000,
  ageConfirmed18: false,
  adultContentMode: false,
  adultPrivacyLevel: 'enhanced',
  tierBDiaryDays: 7,
  singleFileSoftLimitBytes: 120_000,
  memoryBudgetChars: 8000,
  companionName: '伴侣',
  companionSystemHint: '温柔、真诚，用「我」指代自己（AI 伴侣），不用「我」指代用户。',
  companionGender: 'male',
  personalityPresetId: 'boy_next_door',
  personalityConfigMode: 'manual',
  inferenceConsentVersion: 1,
  apiKeyHeaderMode: 'bearer',
  llmExtraHeadersJson: '',
  disableChatTools: true,
  openforuBaseUrl: '',
  openforuApiKey: '',
  openforuModel: '',
  openforuTemperature: 0.2,
  openforuMaxTokens: OPENFORU_DEFAULT_MAX_TOKENS,
  openforuAgentCoreEnabled: false,
  openforuGenerateStrategy: 'auto',
  locale: 'zh',
  embeddingActiveModel: 'none',
  asyncMultiMessageEnabled: false,
  localChatEnabled: false,
  localChatBaseUrl: 'http://127.0.0.1:11434/v1',
  localChatModel: 'qwen2.5:7b',
  localChatMaxTokens: 80,
  weixinChannelEnabled: false,
  companionHarassEnabled: false,
  desktopAgentEnabled: false,
  desktopAgentRiskAccepted: false,
  desktopAgentAllowAppControl: false,
  desktopAgentAllowFileWrite: false,
  desktopAgentAllowDownload: false,
  desktopAgentAllowInstall: false,
  desktopAgentAllowDocumentRead: false,
  desktopAgentAllowDelete: false,
  desktopAgentDownloadDir: '',
  updateChannel: 'auto',
  updateSkippedVersion: '',
  updateLastCheckAt: '',
}

type SettingsFile = AppSettings
type WebMemoryFact = Record<string, unknown> & { status?: string; subject?: unknown; summary?: unknown }

const zhMerged: Record<string, string> = { ...zhResources, ...rendererI18nOverlayZh }
const enMerged: Record<string, string> = { ...enResources, ...rendererI18nOverlayEn }
let currentLocale: Locale = 'zh'

function trimTrailingSlash(value: string): string {
  return value.replace(/[\\/]+$/, '')
}

function portableRoot(): string {
  return resolve(process.env.ACKEM_DATA_ROOT || join(process.cwd(), 'data'))
}

function localAppDataRoot(): string {
  if (process.env.ACKEM_DATA_ROOT) return resolve(process.env.ACKEM_DATA_ROOT)
  const xdg = process.env.XDG_DATA_HOME
  const base = xdg?.trim() ? xdg : join(homedir(), '.local', 'share')
  return join(base, 'Ackem')
}

export function resolveWebDataRoot(settings: Pick<AppSettings, 'dataRootMode'>): string {
  return settings.dataRootMode === 'localappdata' ? localAppDataRoot() : portableRoot()
}

function webSettingsPath(): string {
  return resolve(process.env.ACKEM_WEB_SETTINGS_PATH || join(portableRoot(), 'ackem-app-settings.json'))
}

function normalizeSettings(input: Partial<AppSettings> | null | undefined): AppSettings {
  const merged: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...(input ?? {}),
    asyncMultiMessageEnabled: false,
    disableChatTools: true,
    openforuMaxTokens: OPENFORU_DEFAULT_MAX_TOKENS,
  }
  merged.openforuTemperature = clampOpenForUTemperature(
    merged.openforuTemperature ?? DEFAULT_SETTINGS.openforuTemperature ?? 0.2
  )
  return merged
}

function readSettingsFile(): SettingsFile | null {
  try {
    const path = webSettingsPath()
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf-8')) as SettingsFile
  } catch {
    return null
  }
}

function writeSettingsFile(settings: SettingsFile): void {
  const path = webSettingsPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(settings, null, 2), 'utf-8')
}

export function loadWebSettings(): AppSettings {
  const settings = normalizeSettings(readSettingsFile())
  currentLocale = (settings.locale ?? 'zh') as Locale
  return settings
}

export function saveWebSettings(patch: Partial<AppSettings>): AppSettings {
  const current = loadWebSettings()
  const next = normalizeSettings({ ...current, ...(patch ?? {}) })
  writeSettingsFile(next)
  currentLocale = (next.locale ?? 'zh') as Locale
  return next
}

export function formatWebDataRootDisplayPaths(settings: AppSettings): {
  absolutePath: string
  relativePath: string
  mode: AppSettings['dataRootMode']
} {
  const absolutePath = resolveWebDataRoot(settings)
  const rel = relative(process.cwd(), absolutePath).replace(/\\/g, '/')
  return {
    absolutePath,
    relativePath: rel && !rel.startsWith('..') ? `./${rel}` : absolutePath,
    mode: settings.dataRootMode,
  }
}

export function currentWebDataRoot(): string {
  return resolveWebDataRoot(loadWebSettings())
}

export function currentWebSessionId(): string {
  return loadWebSettings().activeSessionId || 'default'
}

export function mergeWebEngineState(root: string, settings: AppSettings): FullState {
  const personality = defaultPersonalitySlice(settings)
  const sessionId = settings.activeSessionId || 'default'
  const loaded = loadState(root, sessionId)
  if (!loaded) return defaultFullState(personality)
  const state = { ...loaded }
  if (!state.counters) {
    state.counters = { totalTurns: 0, sharedEventsCount: 0, consecutiveMeaningfulTurns: 0 }
  }
  if (!state.personality || state.personality.presetId !== settings.personalityPresetId) {
    state.personality = personality
    state.personalityBaseline = {
      T: personality.T,
      I: personality.I,
      S: personality.S,
      O: personality.O,
      R: personality.R,
    }
  }
  if (!state.userProfile) state.userProfile = defaultFullState(personality).userProfile
  if (!state.externalAtmosphere) state.externalAtmosphere = { level: 0, label: 'neutral' }
  if (!state.desireStack) state.desireStack = { slots: [null, null, null, null, null] }
  if (!state.offlineThoughts) state.offlineThoughts = []
  return state
}

export function loadWebSessionsFile(
  root: string
): Array<{ id: string; name: string; createdAt: string; lastActive: string }> {
  const path = join(root, 'sessions.json')
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
      if (Array.isArray(parsed)) {
        return parsed as Array<{ id: string; name: string; createdAt: string; lastActive: string }>
      }
    }
  } catch {
    /* ignore */
  }
  const now = new Date().toISOString()
  return [{ id: 'default', name: '默认会话', createdAt: now, lastActive: now }]
}

export function saveWebSessionsFile(
  root: string,
  sessions: Array<{ id: string; name: string; createdAt: string; lastActive: string }>
): void {
  writeFileSync(join(root, 'sessions.json'), JSON.stringify(sessions, null, 2), 'utf-8')
}

export function handleWebSettingsGet(): AppSettings {
  return loadWebSettings()
}

export function handleWebSettingsSet(patch: Partial<AppSettings>): AppSettings {
  return saveWebSettings(patch ?? {})
}

export function handleWebDataGetRoot(): {
  path: string
  relativePath: string
  mode: AppSettings['dataRootMode']
  databasePath: string
} {
  const settings = loadWebSettings()
  const display = formatWebDataRootDisplayPaths(settings)
  return {
    path: display.absolutePath,
    relativePath: display.relativePath,
    mode: display.mode,
    databasePath: databasePath(display.absolutePath),
  }
}

export function handleWebDataEnsureLayout(): { path: string } {
  const root = currentWebDataRoot()
  ensureDataLayout(root)
  return { path: root }
}

export function handleWebChatLoadHistory(): unknown[] {
  const root = currentWebDataRoot()
  ensureDataLayout(root)
  const sid = currentWebSessionId()
  const fromDb = loadChatHistoryFromDb(root, sid)
  if (fromDb.length > 0) return fromDb
  const file = join(root, 'companion', `chat-history-${sid}.json`)
  if (!existsSync(file)) return []
  try {
    const rows = JSON.parse(readFileSync(file, 'utf-8')) as unknown
    if (Array.isArray(rows) && rows.length > 0) saveChatHistoryToDb(root, sid, rows)
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

export function handleWebChatSaveHistory(rows: unknown[]): void {
  if (!Array.isArray(rows)) {
    throw Object.assign(new Error('chat:saveHistory requires rows array'), {
      code: 'INVALID_ARGUMENT',
    })
  }
  const root = currentWebDataRoot()
  ensureDataLayout(root)
  const sid = currentWebSessionId()
  const dir = join(root, 'companion')
  mkdirSync(dir, { recursive: true })
  const trimmed = rows.slice(-2000)
  writeFileSync(join(dir, `chat-history-${sid}.json`), JSON.stringify(trimmed), 'utf-8')
  saveChatHistoryToDb(root, sid, trimmed)
}

export function handleWebStateGet(): FullState & {
  _reunion: { gapHours: number; active: true } | { active: false }
} {
  const settings = loadWebSettings()
  const root = resolveWebDataRoot(settings)
  ensureDataLayout(root)
  const state = mergeWebEngineState(root, settings)
  const gapHours = (Date.now() - new Date(state.lastActive).getTime()) / 3600000
  const shock =
    gapHours >= 1 ? { gapHours: Math.round(gapHours), active: true as const } : { active: false as const }
  return { ...state, _reunion: shock }
}

export function handleWebSessionList(): ReturnType<typeof loadWebSessionsFile> {
  const root = currentWebDataRoot()
  ensureDataLayout(root)
  return loadWebSessionsFile(root)
}

export function handleWebSessionSwitch(sessionId: string): {
  ok: boolean
  sessionId?: string
  settings?: AppSettings
  error?: string
} {
  const root = currentWebDataRoot()
  ensureDataLayout(root)
  const sessions = loadWebSessionsFile(root)
  const session = sessions.find((s) => s.id === sessionId)
  if (!session) return { ok: false, error: '会话不存在' }
  session.lastActive = new Date().toISOString()
  saveWebSessionsFile(root, sessions)
  const settings = saveWebSettings({ activeSessionId: sessionId })
  return { ok: true, sessionId, settings }
}

export function handleWebMemoryList(): WebMemoryFact[] {
  const root = currentWebDataRoot()
  ensureDataLayout(root)
  const factsPath = join(root, 'memory', 'facts', 'facts.v2.json')
  try {
    const parsed = JSON.parse(readFileSync(factsPath, 'utf-8')) as { facts?: WebMemoryFact[] }
    return (parsed.facts ?? []).filter((fact) => (fact.status ?? 'active') === 'active')
  } catch {
    return []
  }
}

export function handleWebArchiveList(): {
  files: Array<{ path: string; name: string; isDir: boolean; size: number }>
  domains: string[]
  lastExportAt: string | null
} {
  const root = currentWebDataRoot()
  const archiveDir = join(root, 'memory', 'archive')
  if (!existsSync(archiveDir)) return { files: [], domains: [], lastExportAt: null }
  const walk = (
    dir: string,
    base: string
  ): Array<{ path: string; name: string; isDir: boolean; size: number }> => {
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((name) => name !== '_meta.json')
      .map((name) => {
        const full = join(dir, name)
        const st = statSync(full)
        return {
          path: join(base, name).replace(/\\/g, '/'),
          name,
          isDir: st.isDirectory(),
          size: st.size,
        }
      })
      .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)))
  }
  const domains = walk(archiveDir, '')
  const allFiles = domains.filter((d) => d.isDir).flatMap((d) => walk(join(archiveDir, d.name), d.name))
  let lastExportAt: string | null = null
  const metaPath = join(archiveDir, '_meta.json')
  if (existsSync(metaPath)) {
    try {
      lastExportAt = (JSON.parse(readFileSync(metaPath, 'utf-8')) as { lastExportAt?: string }).lastExportAt ?? null
    } catch {
      /* ignore */
    }
  }
  return {
    files: [...domains.filter((d) => !d.isDir), ...allFiles],
    domains: domains.filter((d) => d.isDir).map((d) => d.name),
    lastExportAt,
  }
}

export function handleWebDiaryList(): {
  entries: Array<{ date: string; path: string; size: number; type: string; tier?: string; gapHours?: number }>
  pendingSnapshots: string[]
} {
  const root = currentWebDataRoot()
  const diaryDir = join(root, 'diary')
  if (!existsSync(diaryDir)) return { entries: [], pendingSnapshots: [] }
  let meta: Record<string, { type?: string; tier?: string; gapHours?: number }> = {}
  const metaPath = join(diaryDir, 'meta.json')
  if (existsSync(metaPath)) {
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
    } catch {
      /* ignore */
    }
  }
  const entries: Array<{ date: string; path: string; size: number; type: string; tier?: string; gapHours?: number }> = []
  const existingDates = new Set<string>()
  for (const name of readdirSync(diaryDir)) {
    const match = name.match(/^(\d{4}-\d{2}-\d{2})\.md$/)
    if (!match) continue
    const date = match[1]
    existingDates.add(date)
    const m = meta[date]
    entries.push({
      date,
      path: name,
      size: statSync(join(diaryDir, name)).size,
      type: m?.type ?? 'daily',
      tier: m?.tier,
      gapHours: m?.gapHours,
    })
  }
  entries.sort((a, b) => b.date.localeCompare(a.date))
  const pendingSnapshots = readdirSync(diaryDir)
    .map((name) => name.match(/^\.snapshot-(\d{4}-\d{2}-\d{2})\.json$/)?.[1])
    .filter((date): date is string => Boolean(date && !existingDates.has(date)))
    .sort((a, b) => b.localeCompare(a))
  return { entries, pendingSnapshots }
}

export function handleWebEmbeddingReadiness(): {
  phase: 'degraded'
  progress: number
  providerReady: boolean
  factEmbeddingsReady: boolean
  preLlmWarmReady: boolean
} {
  return {
    phase: 'degraded',
    progress: 1,
    providerReady: false,
    factEmbeddingsReady: false,
    preLlmWarmReady: true,
  }
}

export function handleWebI18nT(key: string, params?: Record<string, string | number>): string {
  const resources = currentLocale === 'en' ? enMerged : zhMerged
  let value = resources[key] ?? zhMerged[key] ?? key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      value = value.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
    }
  }
  return value
}

export function handleWebI18nGetLocale(): Locale {
  const settings = loadWebSettings()
  return (settings.locale ?? currentLocale) as Locale
}

export function handleWebI18nSetLocale(locale: Locale): void {
  if (locale !== 'zh' && locale !== 'en') {
    throw Object.assign(new Error('Unsupported locale'), { code: 'INVALID_ARGUMENT' })
  }
  saveWebSettings({ locale })
  currentLocale = locale
}

export function handleWebI18nGetAllResources(): {
  zh: Record<string, string>
  en: Record<string, string>
  locale: Locale
} {
  return {
    zh: zhMerged,
    en: enMerged,
    locale: handleWebI18nGetLocale(),
  }
}

export function newWebTurnId(): string {
  return randomUUID()
}

export function saveWebState(root: string, state: FullState, sessionId?: string): void {
  saveState(root, state, sessionId)
}
