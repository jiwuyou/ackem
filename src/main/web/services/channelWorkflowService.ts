import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ensureDataLayout } from '../../layout'
import {
  disconnectWeixin,
  pollWeixinLogin,
  startWeixinLogin,
  type LoginPollResult,
} from '../../channels/weixin/auth'
import { loadWeixinAccount } from '../../channels/weixin/store'
import {
  currentWebDataRoot,
  loadWebSettings,
  saveWebSettings,
} from '../runtime'
import type { WebHandlerRegistry, WebInvokeHandler } from '../types'

type WebWeixinStatus = {
  connected: boolean
  enabled: boolean
  polling: boolean
  proactiveEnabled: boolean
  accountId?: string
  userId?: string
  lastError?: string | null
  tokenExpired: boolean
  embeddingReady?: boolean
}

type WebTimeOfDay = 'morning' | 'forenoon' | 'afternoon' | 'evening' | 'night' | 'late_night'
type WebPresenceMode = 'active' | 'quiet' | 'sleeping'

type WebTimeContext = {
  timeOfDay: WebTimeOfDay
  hour: number
  minute: number
  weekday: number
  isWeekend: boolean
  greeting: string
  atmosphereHint: string
  topicHints: string[]
}

type WebPresenceState = {
  mode: WebPresenceMode
  lastInteractionMs: number
  idleDurationMs: number
  timeOfDay: WebTimeOfDay
}

type WebCompanionConfig = {
  idleThresholdMs: number
  cooldownMs: number
  nightSuppression: boolean
  quietMode: boolean
}

type WebWeixinPollArgs = {
  qrcode?: unknown
  verifyCode?: unknown
  baseUrl?: unknown
}

type WebChannelState = {
  version: 1
  weixin: {
    lastError: string | null
    tokenExpired: boolean
    loginStartedAt: string | null
    lastPollAt: string | null
    lastRestartAt: string | null
  }
  companion: {
    lastInteractionMs: number
    config: WebCompanionConfig
    touchCount: number
    lastTouchAt: string | null
  }
}

export const WEB_CHANNEL_WORKFLOW_CHANNELS = [
  'weixin:getStatus',
  'weixin:startLogin',
  'weixin:pollLogin',
  'weixin:submitVerifyCode',
  'weixin:disconnect',
  'weixin:setEnabled',
  'weixin:setProactiveEnabled',
  'weixin:restart',
  'companion:timeContext',
  'companion:presence',
  'companion:touch',
  'companion:statusText',
  'companion:getConfig',
  'companion:setConfig',
] as const

const DEFAULT_COMPANION_CONFIG: WebCompanionConfig = {
  idleThresholdMs: 10 * 60 * 1000,
  cooldownMs: 15 * 60 * 1000,
  nightSuppression: true,
  quietMode: false,
}

function defaultChannelState(): WebChannelState {
  return {
    version: 1,
    weixin: {
      lastError: null,
      tokenExpired: false,
      loginStartedAt: null,
      lastPollAt: null,
      lastRestartAt: null,
    },
    companion: {
      lastInteractionMs: Date.now(),
      config: { ...DEFAULT_COMPANION_CONFIG },
      touchCount: 0,
      lastTouchAt: null,
    },
  }
}

function rootWithLayout(): string {
  const root = currentWebDataRoot()
  ensureDataLayout(root)
  return root
}

function statePath(root: string): string {
  return join(root, '_derived', 'web-channel-state.json')
}

function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return fallback
  }
}

function normalizeState(input: Partial<WebChannelState> | null | undefined): WebChannelState {
  const base = defaultChannelState()
  const rawConfig = input?.companion?.config
  const config = normalizeCompanionConfig(rawConfig)
  return {
    version: 1,
    weixin: {
      lastError:
        typeof input?.weixin?.lastError === 'string' || input?.weixin?.lastError === null
          ? input.weixin.lastError
          : base.weixin.lastError,
      tokenExpired: input?.weixin?.tokenExpired === true,
      loginStartedAt:
        typeof input?.weixin?.loginStartedAt === 'string' ? input.weixin.loginStartedAt : null,
      lastPollAt:
        typeof input?.weixin?.lastPollAt === 'string' ? input.weixin.lastPollAt : null,
      lastRestartAt:
        typeof input?.weixin?.lastRestartAt === 'string' ? input.weixin.lastRestartAt : null,
    },
    companion: {
      lastInteractionMs:
        typeof input?.companion?.lastInteractionMs === 'number' &&
        Number.isFinite(input.companion.lastInteractionMs)
          ? input.companion.lastInteractionMs
          : base.companion.lastInteractionMs,
      config,
      touchCount:
        typeof input?.companion?.touchCount === 'number' && Number.isFinite(input.companion.touchCount)
          ? Math.max(0, Math.trunc(input.companion.touchCount))
          : 0,
      lastTouchAt:
        typeof input?.companion?.lastTouchAt === 'string' ? input.companion.lastTouchAt : null,
    },
  }
}

function loadChannelState(root = rootWithLayout()): WebChannelState {
  return normalizeState(readJson<Partial<WebChannelState> | null>(statePath(root), null))
}

function saveChannelState(root: string, state: WebChannelState): WebChannelState {
  mkdirSync(dirname(statePath(root)), { recursive: true })
  const normalized = normalizeState(state)
  writeFileSync(statePath(root), JSON.stringify(normalized, null, 2), 'utf-8')
  return normalized
}

function mutateChannelState(fn: (state: WebChannelState) => WebChannelState | void): WebChannelState {
  const root = rootWithLayout()
  const state = loadChannelState(root)
  const next = fn(state) ?? state
  return saveChannelState(root, next)
}

function webWeixinStatus(state = loadChannelState()): WebWeixinStatus {
  const settings = loadWebSettings()
  const account = loadWeixinAccount(rootWithLayout())
  return {
    connected: Boolean(account?.token),
    enabled: settings.weixinChannelEnabled === true,
    polling: false,
    proactiveEnabled: settings.weixinProactiveEnabled !== false,
    accountId: account?.accountId,
    userId: account?.userId,
    lastError: state.weixin.lastError,
    tokenExpired: state.weixin.tokenExpired,
    embeddingReady: settings.embeddingActiveModel !== 'none',
  }
}

function normalizeWeixinPollArgs(args: unknown): {
  qrcode: string
  verifyCode?: string
  baseUrl?: string
} {
  const payload = args && typeof args === 'object' ? (args as WebWeixinPollArgs) : {}
  const qrcode = typeof payload.qrcode === 'string' ? payload.qrcode.trim() : ''
  if (!qrcode) {
    throw Object.assign(new Error('weixin:pollLogin requires qrcode'), { code: 'INVALID_ARGUMENT' })
  }
  const verifyCode = typeof payload.verifyCode === 'string' && payload.verifyCode.trim()
    ? payload.verifyCode.trim()
    : undefined
  const baseUrl = typeof payload.baseUrl === 'string' && payload.baseUrl.trim()
    ? payload.baseUrl.trim()
    : undefined
  return { qrcode, verifyCode, baseUrl }
}

function markWeixinPollResult(result: LoginPollResult): LoginPollResult {
  mutateChannelState((state) => {
    state.weixin.lastPollAt = new Date().toISOString()
    state.weixin.lastError = result.ok ? null : result.error ?? null
    state.weixin.tokenExpired = false
  })
  if (result.ok && result.account) {
    saveWebSettings({ weixinChannelEnabled: true })
  }
  return result
}

function clampMs(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(numeric)))
}

function normalizeCompanionConfig(input: unknown): WebCompanionConfig {
  const raw =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Partial<WebCompanionConfig>)
      : {}
  return {
    idleThresholdMs: clampMs(raw.idleThresholdMs, DEFAULT_COMPANION_CONFIG.idleThresholdMs, 5_000, 24 * 60 * 60 * 1000),
    cooldownMs: clampMs(raw.cooldownMs, DEFAULT_COMPANION_CONFIG.cooldownMs, 5_000, 24 * 60 * 60 * 1000),
    nightSuppression:
      typeof raw.nightSuppression === 'boolean'
        ? raw.nightSuppression
        : DEFAULT_COMPANION_CONFIG.nightSuppression,
    quietMode:
      typeof raw.quietMode === 'boolean'
        ? raw.quietMode
        : DEFAULT_COMPANION_CONFIG.quietMode,
  }
}

function companionConfigPatch(input: unknown): Partial<WebCompanionConfig> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const raw = input as Partial<WebCompanionConfig>
  const patch: Partial<WebCompanionConfig> = {}
  if ('idleThresholdMs' in raw) {
    patch.idleThresholdMs = clampMs(raw.idleThresholdMs, DEFAULT_COMPANION_CONFIG.idleThresholdMs, 5_000, 24 * 60 * 60 * 1000)
  }
  if ('cooldownMs' in raw) {
    patch.cooldownMs = clampMs(raw.cooldownMs, DEFAULT_COMPANION_CONFIG.cooldownMs, 5_000, 24 * 60 * 60 * 1000)
  }
  if (typeof raw.nightSuppression === 'boolean') patch.nightSuppression = raw.nightSuppression
  if (typeof raw.quietMode === 'boolean') patch.quietMode = raw.quietMode
  return patch
}

function getWebTimeContext(now = new Date()): WebTimeContext {
  const hour = now.getHours()
  const minute = now.getMinutes()
  const weekday = now.getDay()
  const isWeekend = weekday === 0 || weekday === 6

  if (hour >= 5 && hour < 8) {
    return {
      timeOfDay: 'morning',
      hour,
      minute,
      weekday,
      isWeekend,
      greeting: isWeekend ? '周末的清晨，不用急着起床…' : '早安，新的一天开始了。',
      atmosphereHint: '清晨的宁静中带着一丝慵懒。语气轻柔、不催促，像刚醒来的枕边人。',
      topicHints: ['今天有什么计划', '昨晚睡得好吗', '想吃什么早餐'],
    }
  }

  if (hour >= 8 && hour < 11) {
    return {
      timeOfDay: 'forenoon',
      hour,
      minute,
      weekday,
      isWeekend,
      greeting: isWeekend ? '上午好，周末的时间都是你的。' : '上午好，已经开始忙碌了吗？',
      atmosphereHint: '上午的精力充沛，语气可以稍微活泼一些。如果用户在工作，给予安静的陪伴感。',
      topicHints: ['工作/学习进度', '上午的心情', '咖啡或茶'],
    }
  }

  if (hour >= 11 && hour < 14) {
    return {
      timeOfDay: 'afternoon',
      hour,
      minute,
      weekday,
      isWeekend,
      greeting: '中午了，记得吃点东西。',
      atmosphereHint: '午间慵懒，语气温暖随意。可以关心用户是否按时吃饭。',
      topicHints: ['午餐吃了什么', '下午的安排', '要不要休息一下'],
    }
  }

  if (hour >= 14 && hour < 18) {
    return {
      timeOfDay: 'afternoon',
      hour,
      minute,
      weekday,
      isWeekend,
      greeting: '下午好，一天过去大半了呢。',
      atmosphereHint: '下午容易犯困，语气带一点温柔的督促。如果用户看起来累了，提醒ta休息。',
      topicHints: ['下午茶时间', '今天完成了什么', '傍晚想做什么'],
    }
  }

  if (hour >= 18 && hour < 22) {
    return {
      timeOfDay: 'evening',
      hour,
      minute,
      weekday,
      isWeekend,
      greeting: isWeekend ? '晚上好，周末的夜晚最适合放松了。' : '晚上好，一天辛苦了。',
      atmosphereHint: '晚上的氛围放松，语气温柔亲密。可以聊一些更深的话题，或者单纯陪伴。',
      topicHints: ['晚餐', '今天发生的事', '想怎么放松', '看什么电影/听什么歌'],
    }
  }

  if (hour >= 22 || hour < 2) {
    return {
      timeOfDay: 'night',
      hour,
      minute,
      weekday,
      isWeekend,
      greeting: '夜深了…',
      atmosphereHint: '深夜的氛围私密、安静。语气低沉温柔，音量像耳语。',
      topicHints: ['睡不着在想什么', '今天的感受', '明天的期待'],
    }
  }

  return {
    timeOfDay: 'late_night',
    hour,
    minute,
    weekday,
    isWeekend,
    greeting: '这么晚了还没睡…',
    atmosphereHint: '凌晨时分，世界都在沉睡。语气极度轻柔、关切。提醒用户早点休息。',
    topicHints: ['为什么还没睡', '需要我陪你吗', '要不要试着躺下'],
  }
}

function resolvePresence(state: WebChannelState): WebPresenceState {
  const now = Date.now()
  const context = getWebTimeContext()
  const idleDurationMs = Math.max(0, now - state.companion.lastInteractionMs)
  let mode: WebPresenceMode = 'active'
  if (
    (context.timeOfDay === 'late_night' || (context.timeOfDay === 'night' && context.hour >= 23)) &&
    idleDurationMs > 30 * 60 * 1000
  ) {
    mode = 'sleeping'
  } else if (state.companion.config.quietMode || idleDurationMs > state.companion.config.idleThresholdMs) {
    mode = 'quiet'
  }
  return {
    mode,
    lastInteractionMs: state.companion.lastInteractionMs,
    idleDurationMs,
    timeOfDay: context.timeOfDay,
  }
}

function statusTextForPresence(presence: WebPresenceState): string {
  if (presence.mode === 'sleeping') return '在安静休息'
  if (presence.mode === 'quiet') return '安静陪伴中'
  return '在你身边'
}

export function handleWebWeixinGetStatus(): WebWeixinStatus {
  return webWeixinStatus()
}

export async function handleWebWeixinStartLogin(): Promise<{
  qrcode: string
  qrcodeImgContent: string
  qrcodeScanUrl: string
}> {
  const root = rootWithLayout()
  mutateChannelState((state) => {
    state.weixin.loginStartedAt = new Date().toISOString()
    state.weixin.lastError = null
    state.weixin.tokenExpired = false
  })
  try {
    return await startWeixinLogin(root)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    mutateChannelState((state) => {
      state.weixin.lastError = message
    })
    throw Object.assign(new Error(message), { code: 'WEIXIN_LOGIN_START_FAILED' })
  }
}

export async function handleWebWeixinPollLogin(args: unknown): Promise<LoginPollResult> {
  const root = rootWithLayout()
  const payload = normalizeWeixinPollArgs(args)
  const result = await pollWeixinLogin(root, payload.qrcode, payload.verifyCode, payload.baseUrl)
  return markWeixinPollResult(result)
}

export async function handleWebWeixinSubmitVerifyCode(args: unknown): Promise<LoginPollResult> {
  const root = rootWithLayout()
  const payload = normalizeWeixinPollArgs(args)
  const result = await pollWeixinLogin(root, payload.qrcode, payload.verifyCode, payload.baseUrl)
  return markWeixinPollResult(result)
}

export function handleWebWeixinDisconnect(): { ok: boolean } {
  disconnectWeixin(rootWithLayout())
  saveWebSettings({ weixinChannelEnabled: false })
  mutateChannelState((state) => {
    state.weixin.lastError = null
    state.weixin.tokenExpired = false
  })
  return { ok: true }
}

export function handleWebWeixinSetEnabled(enabled: unknown): WebWeixinStatus {
  const next = enabled === true
  saveWebSettings({ weixinChannelEnabled: next })
  const state = mutateChannelState((draft) => {
    draft.weixin.lastError = next && !loadWeixinAccount(rootWithLayout()) ? 'weixin_account_not_bound' : null
    draft.weixin.tokenExpired = false
  })
  return webWeixinStatus(state)
}

export function handleWebWeixinSetProactiveEnabled(enabled: unknown): WebWeixinStatus {
  const next = enabled !== false
  saveWebSettings({ weixinProactiveEnabled: next })
  const state = mutateChannelState((draft) => {
    draft.weixin.lastError = draft.weixin.lastError ?? null
  })
  return webWeixinStatus(state)
}

export function handleWebWeixinRestart(): WebWeixinStatus {
  const state = mutateChannelState((draft) => {
    draft.weixin.lastRestartAt = new Date().toISOString()
    draft.weixin.lastError =
      loadWebSettings().weixinChannelEnabled === true && !loadWeixinAccount(rootWithLayout())
        ? 'weixin_account_not_bound'
        : null
    draft.weixin.tokenExpired = false
  })
  return webWeixinStatus(state)
}

export function handleWebCompanionTimeContext(): WebTimeContext {
  return getWebTimeContext()
}

export function handleWebCompanionPresence(): WebPresenceState {
  return resolvePresence(loadChannelState())
}

export function handleWebCompanionTouch(): { ok: boolean } {
  mutateChannelState((state) => {
    state.companion.lastInteractionMs = Date.now()
    state.companion.touchCount += 1
    state.companion.lastTouchAt = new Date().toISOString()
  })
  return { ok: true }
}

export function handleWebCompanionStatusText(): string {
  return statusTextForPresence(handleWebCompanionPresence())
}

export function handleWebCompanionGetConfig(): WebCompanionConfig {
  return { ...loadChannelState().companion.config }
}

export function handleWebCompanionSetConfig(patch: unknown): { ok: boolean; config: WebCompanionConfig } {
  const state = mutateChannelState((draft) => {
    draft.companion.config = normalizeCompanionConfig({
      ...draft.companion.config,
      ...companionConfigPatch(patch),
    })
  })
  return { ok: true, config: { ...state.companion.config } }
}

export const webChannelWorkflowHandlers: Readonly<Record<(typeof WEB_CHANNEL_WORKFLOW_CHANNELS)[number], WebInvokeHandler>> = {
  'weixin:getStatus': () => handleWebWeixinGetStatus(),
  'weixin:startLogin': () => handleWebWeixinStartLogin(),
  'weixin:pollLogin': (args) => handleWebWeixinPollLogin(args),
  'weixin:submitVerifyCode': (args) => handleWebWeixinSubmitVerifyCode(args),
  'weixin:disconnect': () => handleWebWeixinDisconnect(),
  'weixin:setEnabled': (enabled) => handleWebWeixinSetEnabled(enabled),
  'weixin:setProactiveEnabled': (enabled) => handleWebWeixinSetProactiveEnabled(enabled),
  'weixin:restart': () => handleWebWeixinRestart(),
  'companion:timeContext': () => handleWebCompanionTimeContext(),
  'companion:presence': () => handleWebCompanionPresence(),
  'companion:touch': () => handleWebCompanionTouch(),
  'companion:statusText': () => handleWebCompanionStatusText(),
  'companion:getConfig': () => handleWebCompanionGetConfig(),
  'companion:setConfig': (patch) => handleWebCompanionSetConfig(patch),
}

export function registerWebChannelWorkflowHandlers(registry: WebHandlerRegistry): void {
  for (const [channel, handler] of Object.entries(webChannelWorkflowHandlers)) {
    registry.set(channel, handler)
  }
}
