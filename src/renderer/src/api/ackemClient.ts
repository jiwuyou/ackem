import type { AckemApi, AppSettings, BuildContextResult } from '../ackem'
import type { SearchCardPayload } from '../../../shared/searchCard'
import type { MemoryAuditCardPayload } from '../../../shared/memoryAudit'
import type { InvestigationProgressPayload } from '../../../shared/investigation'
import type { TaskPlanProgressPayload } from '../../../shared/desktopAgentTaskPlan'
import type {
  AckemRuntimeCapabilities,
} from './runtime'
import {
  ACKEM_WEB_SHIM_MARKER,
  getAckemCapabilities,
  getElectronAckem,
  isAckemWebShim
} from './runtime'
import { webEvents, webInvoke, type Unsubscribe } from './webTransport'

type MaybeUnsubscribe = void | Unsubscribe

type ChatDoneMeta = { memoryWrites?: string[]; assistantText?: string; turnId?: string }
type ChatWaveStartPayload = { waveIndex: number; waveCount: number; newBubble: boolean }
type ChatWaveEndPayload = { waveIndex: number; text: string; partial?: boolean }
type SessionRow = { id: string; name: string; createdAt: string; lastActive: string }
type SessionSwitchResult = { ok: boolean; sessionId?: string; settings?: AppSettings; error?: string }
type I18nResources = { zh: Record<string, string>; en: Record<string, string>; locale: string }
type EmbeddingReadiness = Awaited<ReturnType<AckemApi['embeddingReadiness']>>
type ArchiveListResult = Awaited<ReturnType<AckemApi['archiveList']>>
type DiaryListResult = Awaited<ReturnType<AckemApi['diaryList']>>
type BuildContextArgs = Parameters<AckemApi['buildContext']>[0]
type StartChatPayload = Parameters<AckemApi['startChat']>[0]

export type AckemClient = {
  capabilities: () => AckemRuntimeCapabilities
  invoke: <T>(channel: string, args?: unknown[]) => Promise<T>
  i18n: {
    t: (key: string, params?: Record<string, string | number>) => Promise<string>
    getLocale: () => Promise<string>
    setLocale: (locale: string) => Promise<void>
    getAllResources: () => Promise<I18nResources>
  }
  getSettings: () => Promise<AppSettings>
  setSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
  ensureLayout: () => Promise<{ path: string }>
  getState: () => Promise<unknown>
  embeddingReadiness: () => Promise<EmbeddingReadiness>
  buildContext: (args: BuildContextArgs) => Promise<BuildContextResult>
  startChat: (payload: StartChatPayload) => Promise<void>
  archiveList: () => Promise<ArchiveListResult>
  diaryList: () => Promise<DiaryListResult>
  memoryList: () => Promise<unknown[]>
  loadChatHistory: () => Promise<unknown[]>
  saveChatHistory: (rows: unknown[]) => Promise<void>
  sessionList: () => Promise<SessionRow[]>
  sessionSwitch: (sessionId: string) => Promise<SessionSwitchResult>
  onEmbeddingReadinessChanged: (fn: (snap: EmbeddingReadiness) => void) => MaybeUnsubscribe
  onChatStreamStart: (fn: () => void) => MaybeUnsubscribe
  onChatWaveStart: (fn: (payload: ChatWaveStartPayload) => void) => MaybeUnsubscribe
  onChatChunk: (fn: (chunk: string) => void) => MaybeUnsubscribe
  onChatWaveEnd: (fn: (payload: ChatWaveEndPayload) => void) => MaybeUnsubscribe
  onChatReplace: (fn: (text: string) => void) => MaybeUnsubscribe
  onChatStatus: (fn: (text: string) => void) => MaybeUnsubscribe
  onInvestigationProgress: (fn: (payload: InvestigationProgressPayload | null) => void) => MaybeUnsubscribe
  onTaskPlanProgress: (fn: (payload: TaskPlanProgressPayload | null) => void) => MaybeUnsubscribe
  onChatSearchCard: (fn: (payload: SearchCardPayload) => void) => MaybeUnsubscribe
  onChatMemoryAudit: (fn: (payload: MemoryAuditCardPayload) => void) => MaybeUnsubscribe
  onChatDone: (fn: (meta?: ChatDoneMeta) => void) => MaybeUnsubscribe
  onChatError: (fn: (err: string) => void) => MaybeUnsubscribe
  onWindowFocused: (fn: () => void) => MaybeUnsubscribe
}

const channelMethodMap: Record<string, keyof Pick<
  AckemApi,
  | 'getSettings'
  | 'setSettings'
  | 'ensureLayout'
  | 'getState'
  | 'embeddingReadiness'
  | 'buildContext'
  | 'startChat'
  | 'archiveList'
  | 'diaryList'
  | 'memoryList'
  | 'loadChatHistory'
  | 'saveChatHistory'
  | 'sessionList'
  | 'sessionSwitch'
>> = {
  'settings:get': 'getSettings',
  'settings:set': 'setSettings',
  'data:ensureLayout': 'ensureLayout',
  'state:get': 'getState',
  'embedding:readiness': 'embeddingReadiness',
  'context:build': 'buildContext',
  'chat:start': 'startChat',
  'archive:list': 'archiveList',
  'diary:list': 'diaryList',
  'memory:list': 'memoryList',
  'chat:loadHistory': 'loadChatHistory',
  'chat:saveHistory': 'saveChatHistory',
  'session:list': 'sessionList',
  'session:switch': 'sessionSwitch'
}

function electronInvoke<T>(api: AckemApi, channel: string, args: unknown[]): Promise<T> {
  const method = channelMethodMap[channel]
  if (!method) throw new Error(`Electron invoke channel is not mapped in ackemClient: ${channel}`)
  const fn = api[method] as (...methodArgs: unknown[]) => Promise<T>
  return fn(...args)
}

function invoke<T>(channel: string, args: unknown[] = []): Promise<T> {
  const electron = getElectronAckem()
  if (electron) return electronInvoke<T>(electron, channel, args)
  return webInvoke<T>(channel, args)
}

function subscribe<T>(
  channel: string,
  electronSubscribe: (api: AckemApi, fn: (payload: T) => void) => MaybeUnsubscribe,
  fn: (payload: T) => void
): MaybeUnsubscribe {
  const electron = getElectronAckem()
  if (electron) return electronSubscribe(electron, fn)
  return webEvents.on(channel, fn)
}

export const ackemClient: AckemClient = {
  capabilities: getAckemCapabilities,
  invoke,
  i18n: {
    t: (key, params) => {
      const electron = getElectronAckem()
      if (electron) return electron.i18n.t(key, params)
      return webInvoke<string>('i18n:t', [key, params])
    },
    getLocale: () => {
      const electron = getElectronAckem()
      if (electron) return electron.i18n.getLocale()
      return webInvoke<string>('i18n:getLocale')
    },
    setLocale: (locale) => {
      const electron = getElectronAckem()
      if (electron) return electron.i18n.setLocale(locale)
      return webInvoke<void>('i18n:setLocale', [locale])
    },
    getAllResources: () => {
      const electron = getElectronAckem()
      if (electron) return electron.i18n.getAllResources()
      return webInvoke<I18nResources>('i18n:getAllResources')
    }
  },
  getSettings: () => invoke<AppSettings>('settings:get'),
  setSettings: (patch) => invoke<AppSettings>('settings:set', [patch]),
  ensureLayout: () => invoke<{ path: string }>('data:ensureLayout'),
  getState: () => invoke<unknown>('state:get'),
  embeddingReadiness: () => invoke<EmbeddingReadiness>('embedding:readiness'),
  buildContext: (args) => invoke<BuildContextResult>('context:build', [args]),
  startChat: (payload) => invoke<void>('chat:start', [payload]),
  archiveList: () => invoke<ArchiveListResult>('archive:list'),
  diaryList: () => invoke<DiaryListResult>('diary:list'),
  memoryList: () => invoke<unknown[]>('memory:list'),
  loadChatHistory: () => invoke<unknown[]>('chat:loadHistory'),
  saveChatHistory: (rows) => invoke<void>('chat:saveHistory', [rows]),
  sessionList: () => invoke<SessionRow[]>('session:list'),
  sessionSwitch: (sessionId) => invoke<SessionSwitchResult>('session:switch', [sessionId]),
  onEmbeddingReadinessChanged: (fn) =>
    subscribe<EmbeddingReadiness>(
      'embedding:readiness-changed',
      (api) => api.onEmbeddingReadinessChanged((snap) => fn(snap as EmbeddingReadiness)),
      fn
    ),
  onChatStreamStart: (fn) => subscribe<void>('chat:stream-start', (api) => api.onChatStreamStart(fn), fn),
  onChatWaveStart: (fn) => subscribe<ChatWaveStartPayload>('chat:wave-start', (api) => api.onChatWaveStart(fn), fn),
  onChatChunk: (fn) => subscribe<string>('chat:chunk', (api) => api.onChatChunk(fn), fn),
  onChatWaveEnd: (fn) => subscribe<ChatWaveEndPayload>('chat:wave-end', (api) => api.onChatWaveEnd(fn), fn),
  onChatReplace: (fn) => subscribe<string>('chat:replace', (api) => api.onChatReplace(fn), fn),
  onChatStatus: (fn) => subscribe<string>('chat:status', (api) => api.onChatStatus(fn), fn),
  onInvestigationProgress: (fn) =>
    subscribe<InvestigationProgressPayload | null>(
      'investigation:progress',
      (api) => api.onInvestigationProgress(fn),
      fn
    ),
  onTaskPlanProgress: (fn) =>
    subscribe<TaskPlanProgressPayload | null>('taskplan:progress', (api) => api.onTaskPlanProgress(fn), fn),
  onChatSearchCard: (fn) => subscribe<SearchCardPayload>('chat:searchCard', (api) => api.onChatSearchCard(fn), fn),
  onChatMemoryAudit: (fn) =>
    subscribe<MemoryAuditCardPayload>('chat:memoryAudit', (api) => api.onChatMemoryAudit(fn), fn),
  onChatDone: (fn) => subscribe<ChatDoneMeta | undefined>('chat:done', (api) => api.onChatDone(fn), fn),
  onChatError: (fn) => subscribe<string>('chat:error', (api) => api.onChatError(fn), fn),
  onWindowFocused: (fn) => subscribe<void>('window-focused', (api) => api.onWindowFocused(fn), fn)
}

const noOpUnsubscribe: Unsubscribe = () => undefined

function unsupportedAsync(path: string): (...args: unknown[]) => Promise<never> {
  return async () => {
    throw new Error(`${path} is not available in Ackem Web runtime yet`)
  }
}

function unsupportedSubscribe(path: string): (...args: unknown[]) => Unsubscribe {
  return () => {
    console.info(`[ackemClient] ${path} is not available in Ackem Web runtime yet`)
    return noOpUnsubscribe
  }
}

function createWebAckemShim(): AckemApi {
  const root: Partial<AckemApi> & { [ACKEM_WEB_SHIM_MARKER]: true } = {
    [ACKEM_WEB_SHIM_MARKER]: true,
    i18n: {
      t: ackemClient.i18n.t,
      getLocale: ackemClient.i18n.getLocale,
      setLocale: ackemClient.i18n.setLocale,
      getAllResources: ackemClient.i18n.getAllResources
    },
    getSettings: ackemClient.getSettings,
    setSettings: ackemClient.setSettings,
    ensureLayout: ackemClient.ensureLayout,
    getState: ackemClient.getState,
    embeddingReadiness: ackemClient.embeddingReadiness,
    onEmbeddingReadinessChanged: (fn) => ackemClient.onEmbeddingReadinessChanged(fn as (snap: EmbeddingReadiness) => void) ?? noOpUnsubscribe,
    buildContext: ackemClient.buildContext,
    startChat: ackemClient.startChat,
    archiveList: ackemClient.archiveList,
    archiveRead: (relPath: string) => webInvoke('archive:read', [relPath]),
    archiveExport: () => webInvoke('memory:exportArchive'),
    diaryList: ackemClient.diaryList,
    diaryRead: (date: string) => webInvoke('diary:read', [date]),
    diaryGenerate: (opts?: { date?: string; force?: boolean }) => webInvoke('diary:generate', [opts]),
    onDiaryAutoGenerated: (fn) => webEvents.on('diary:autoGenerated', fn),
    memoryList: ackemClient.memoryList,
    memoryRetire: (id: string) => webInvoke('memory:retire', [id]),
    memoryUpdate: (id, patch) => webInvoke('memory:update', [id, patch]),
    memoryClearAll: () => webInvoke('memory:clearAll'),
    memoryFeedback: (id, action) => webInvoke('memory:feedback', [id, action]),
    onMemoryUpdated: (fn) => webEvents.on('memory:updated', fn),
    loadChatHistory: ackemClient.loadChatHistory,
    saveChatHistory: ackemClient.saveChatHistory,
    sessionList: ackemClient.sessionList,
    sessionSwitch: ackemClient.sessionSwitch,
    onChatStreamStart: ackemClient.onChatStreamStart,
    onChatWaveStart: ackemClient.onChatWaveStart,
    onChatChunk: ackemClient.onChatChunk,
    onChatWaveEnd: ackemClient.onChatWaveEnd,
    onChatReplace: ackemClient.onChatReplace,
    onChatStatus: ackemClient.onChatStatus,
    onInvestigationProgress: ackemClient.onInvestigationProgress,
    onTaskPlanProgress: ackemClient.onTaskPlanProgress,
    onChatSearchCard: ackemClient.onChatSearchCard,
    onChatMemoryAudit: ackemClient.onChatMemoryAudit,
    onChatDone: ackemClient.onChatDone,
    onChatError: ackemClient.onChatError,
    onWindowFocused: ackemClient.onWindowFocused,
    onMcEvent: unsupportedSubscribe('window.ackem.onMcEvent') as AckemApi['onMcEvent'],
    onCompanionSkinChanged: unsupportedSubscribe(
      'window.ackem.onCompanionSkinChanged'
    ) as AckemApi['onCompanionSkinChanged'],
    machineMap: {
      status: async () =>
        ({
          status: 'unavailable',
          gameCount: 0,
          documentCount: 0,
          updatedAt: null
        }) as unknown as Awaited<ReturnType<AckemApi['machineMap']['status']>>,
      reindex: async () => ({ ok: false }),
      onProgress: () => undefined
    },
    ui: {
      getTheme: async () => 'light',
      setTheme: async (mode) => ({ ok: true, mode }),
      onThemeChanged: () => noOpUnsubscribe,
      getLevel: async () => ({ level: 0, petVisible: false }),
      showPet: async () => ({ ok: false, level: 0 }),
      hidePet: async () => ({ ok: true }),
      expandToMain: async () => ({ ok: true, level: 0 }),
      setAlwaysOnTop: async () => ({ ok: true }),
      setLevel: async (level) => ({ ok: true, level }),
      onChatBubble: () => undefined,
      onLevel: () => undefined,
      onExpand: () => undefined,
      onExtensionToast: () => undefined
    },
    openforu: {
      onNotify: () => noOpUnsubscribe,
      permissions: {
        onRequest: () => noOpUnsubscribe,
        approve: unsupportedAsync('window.ackem.openforu.permissions.approve') as AckemApi['openforu']['permissions']['approve'],
        deny: unsupportedAsync('window.ackem.openforu.permissions.deny') as AckemApi['openforu']['permissions']['deny'],
        approveAndActivate: unsupportedAsync(
          'window.ackem.openforu.permissions.approveAndActivate'
        ) as AckemApi['openforu']['permissions']['approveAndActivate']
      },
      workspaces: {
        list: unsupportedAsync('window.ackem.openforu.workspaces.list') as AckemApi['openforu']['workspaces']['list'],
        open: unsupportedAsync('window.ackem.openforu.workspaces.open') as AckemApi['openforu']['workspaces']['open'],
        create: unsupportedAsync('window.ackem.openforu.workspaces.create') as AckemApi['openforu']['workspaces']['create'],
        switch: unsupportedAsync('window.ackem.openforu.workspaces.switch') as AckemApi['openforu']['workspaces']['switch'],
        delete: unsupportedAsync('window.ackem.openforu.workspaces.delete') as AckemApi['openforu']['workspaces']['delete']
      }
    } as unknown as AckemApi['openforu'],
    ext: {
      gamemode: {
        list: unsupportedAsync('window.ackem.ext.gamemode.list') as AckemApi['ext']['gamemode']['list'],
        activate: unsupportedAsync('window.ackem.ext.gamemode.activate') as AckemApi['ext']['gamemode']['activate'],
        deactivate: unsupportedAsync('window.ackem.ext.gamemode.deactivate') as AckemApi['ext']['gamemode']['deactivate'],
        status: unsupportedAsync('window.ackem.ext.gamemode.status') as AckemApi['ext']['gamemode']['status'],
        invoke: unsupportedAsync('window.ackem.ext.gamemode.invoke') as AckemApi['ext']['gamemode']['invoke'],
        onEvent: () => undefined
      },
      plugins: {
        list: unsupportedAsync('window.ackem.ext.plugins.list') as AckemApi['ext']['plugins']['list'],
        activate: unsupportedAsync('window.ackem.ext.plugins.activate') as AckemApi['ext']['plugins']['activate'],
        deactivate: unsupportedAsync('window.ackem.ext.plugins.deactivate') as AckemApi['ext']['plugins']['deactivate']
      } as Partial<AckemApi['ext']['plugins']> as AckemApi['ext']['plugins'],
      skills: {
        list: unsupportedAsync('window.ackem.ext.skills.list') as AckemApi['ext']['skills']['list'],
        activate: unsupportedAsync('window.ackem.ext.skills.activate') as AckemApi['ext']['skills']['activate'],
        deactivate: unsupportedAsync('window.ackem.ext.skills.deactivate') as AckemApi['ext']['skills']['deactivate']
      } as Partial<AckemApi['ext']['skills']> as AckemApi['ext']['skills']
    } as unknown as AckemApi['ext']
  }

  return new Proxy(root, {
    get(target, prop) {
      if (prop in target) return target[prop as keyof typeof target]
      if (prop === 'then') return undefined
      const key = String(prop)
      if (key.startsWith('on')) return unsupportedSubscribe(`window.ackem.${key}`)
      return unsupportedAsync(`window.ackem.${key}`)
    }
  }) as AckemApi
}

export function installAckemWebFallback(): void {
  if (typeof window === 'undefined') return
  if (window.ackem && !isAckemWebShim(window.ackem)) return
  if (!window.ackem) {
    window.ackem = createWebAckemShim()
  }
}
