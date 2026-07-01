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
import { webEvents, webInvoke, webUploadFiles, type Unsubscribe } from './webTransport'

type MaybeUnsubscribe = void | Unsubscribe

type ChatDoneMeta = { memoryWrites?: string[]; assistantText?: string; turnId?: string }
type ChatWaveStartPayload = { waveIndex: number; waveCount: number; newBubble: boolean }
type ChatWaveEndPayload = { waveIndex: number; text: string; partial?: boolean }
type SessionRow = { id: string; name: string; createdAt: string; lastActive: string }
type SessionSwitchResult = { ok: boolean; sessionId?: string; settings?: AppSettings; error?: string }
type I18nResources = { zh: Record<string, string>; en: Record<string, string>; locale: string }
type EmbeddingReadiness = Awaited<ReturnType<AckemApi['embeddingReadiness']>>
type EmbeddingStatus = Awaited<ReturnType<AckemApi['embeddingStatus']>>
type ArchiveListResult = Awaited<ReturnType<AckemApi['archiveList']>>
type ArchiveReadResult = Awaited<ReturnType<AckemApi['archiveRead']>>
type ArchiveExportResult = Awaited<ReturnType<AckemApi['archiveExport']>>
type DiaryListResult = Awaited<ReturnType<AckemApi['diaryList']>>
type DiaryReadResult = Awaited<ReturnType<AckemApi['diaryRead']>>
type DiaryGenerateResult = Awaited<ReturnType<AckemApi['diaryGenerate']>>
type BuildContextArgs = Parameters<AckemApi['buildContext']>[0]
type StartChatPayload = Parameters<AckemApi['startChat']>[0]
type ImportFilesResult = Awaited<ReturnType<AckemApi['importFiles']>>
type ImportParseArgs = Parameters<AckemApi['importParseDocuments']>[0]
type ImportCommitArgs = Parameters<AckemApi['importCommitJob']>[0]
type ProfileEstimateResult = Awaited<ReturnType<AckemApi['profileEstimateScan']>>
type ProfileInferArgs = Parameters<AckemApi['profileInferFromFiles']>[0]
type ProfileInferResult = Awaited<ReturnType<AckemApi['profileInferFromFiles']>>
type ProfileGetResult = Awaited<ReturnType<AckemApi['profileGet']>>
type SearchHit = Awaited<ReturnType<AckemApi['search']>>[number]
type ReadRelResult = Awaited<ReturnType<AckemApi['readRel']>>
type MemoryUpdatePatch = Parameters<AckemApi['memoryUpdate']>[1]
type MemoryUpdatedPayload = Parameters<AckemApi['onMemoryUpdated']>[0] extends (payload: infer P) => void ? P : unknown
type TraceLatestResult = Awaited<ReturnType<AckemApi['traceLatest']>>
type DesireStackResult = Awaited<ReturnType<AckemApi['desireList']>>
type SessionCreateResult = Awaited<ReturnType<AckemApi['sessionCreate']>>
type SessionDeleteResult = Awaited<ReturnType<AckemApi['sessionDelete']>>
type ExtPluginRow = Awaited<ReturnType<AckemApi['ext']['plugins']['list']>>[number]
type ExtSkillRow = Awaited<ReturnType<AckemApi['ext']['skills']['list']>>[number]
type OpenForUListExtensionsResult = Awaited<ReturnType<AckemApi['openforu']['listExtensions']>>
type OpenForUPlanRefineOpenResult = Awaited<ReturnType<AckemApi['openforu']['planRefineOpen']>>
type OpenForUWorkspaceListResult = Awaited<ReturnType<AckemApi['openforu']['workspaces']['list']>>
type OpenForUWorkspaceCreateResult = Awaited<ReturnType<AckemApi['openforu']['workspaces']['create']>>
type OpenForUWorkspaceSwitchResult = Awaited<ReturnType<AckemApi['openforu']['workspaces']['switch']>>
type OpenForUWorkspaceDeleteResult = Awaited<ReturnType<AckemApi['openforu']['workspaces']['delete']>>
type OpenForURemoveExtensionResult = Awaited<ReturnType<AckemApi['openforu']['removeExtension']>>
type OpenForUApproveAndActivateResult = Awaited<ReturnType<AckemApi['openforu']['permissions']['approveAndActivate']>>
type OpenForUOpenSurfaceWindowResult = Awaited<ReturnType<AckemApi['openforu']['openSurfaceWindow']>>

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
  getDataRoot: () => Promise<Awaited<ReturnType<AckemApi['getDataRoot']>>>
  ensureLayout: () => Promise<{ path: string }>
  openDataFolder: () => Promise<void>
  selectFiles: () => Promise<Awaited<ReturnType<AckemApi['selectFiles']>>>
  getPathForFile: (file: File) => string
  getState: () => Promise<unknown>
  resetState: () => Promise<unknown>
  traceLatest: (limit?: number) => Promise<TraceLatestResult>
  embeddingReadiness: () => Promise<EmbeddingReadiness>
  embeddingStatus: () => Promise<EmbeddingStatus>
  embeddingSwitch: (modelId: string) => Promise<Awaited<ReturnType<AckemApi['embeddingSwitch']>>>
  embeddingDownload: (modelId: string) => Promise<Awaited<ReturnType<AckemApi['embeddingDownload']>>>
  embeddingDownloadCancel: (modelId: string) => Promise<Awaited<ReturnType<AckemApi['embeddingDownloadCancel']>>>
  rebuildIndex: () => Promise<Awaited<ReturnType<AckemApi['rebuildIndex']>>>
  search: (query: string, limit?: number) => Promise<SearchHit[]>
  readRel: (relPath: string, maxBytes?: number) => Promise<ReadRelResult>
  buildContext: (args: BuildContextArgs) => Promise<BuildContextResult>
  startChat: (payload: StartChatPayload) => Promise<void>
  archiveList: () => Promise<ArchiveListResult>
  archiveRead: (relPath: string) => Promise<ArchiveReadResult>
  archiveExport: () => Promise<ArchiveExportResult>
  diaryList: () => Promise<DiaryListResult>
  diaryRead: (date: string) => Promise<DiaryReadResult>
  diaryGenerate: (opts?: { date?: string; force?: boolean }) => Promise<DiaryGenerateResult>
  memoryList: () => Promise<unknown[]>
  memoryRetire: (id: string) => Promise<boolean>
  memoryUpdate: (id: string, patch: MemoryUpdatePatch) => Promise<boolean>
  memoryClearAll: () => Promise<{ ok: boolean }>
  memoryFeedback: (id: string, action: 'thumbs_up' | 'thumbs_down') => Promise<boolean>
  memoryConsolidate: () => Promise<Awaited<ReturnType<AckemApi['memoryConsolidate']>>>
  memoryStats: () => Promise<Awaited<ReturnType<AckemApi['memoryStats']>>>
  associationList: () => Promise<Awaited<ReturnType<AckemApi['associationList']>>>
  anchorList: () => Promise<Awaited<ReturnType<AckemApi['anchorList']>>>
  kgList: () => Promise<Awaited<ReturnType<AckemApi['kgList']>>>
  kgOneHop: (entity: string) => Promise<Awaited<ReturnType<AckemApi['kgOneHop']>>>
  episodeList: () => Promise<Awaited<ReturnType<AckemApi['episodeList']>>>
  memoryAuditReport: (opts?: Parameters<AckemApi['memoryAuditReport']>[0]) => Promise<Awaited<ReturnType<AckemApi['memoryAuditReport']>>>
  mirrorCheck: () => Promise<Awaited<ReturnType<AckemApi['mirrorCheck']>>>
  mirrorFindings: () => Promise<Awaited<ReturnType<AckemApi['mirrorFindings']>>>
  desireList: () => Promise<DesireStackResult>
  desireDismiss: (desireId: string) => Promise<DesireStackResult>
  desireClearActive: () => Promise<DesireStackResult>
  importFiles: (paths: string[]) => Promise<ImportFilesResult>
  importBrowserFiles: (files: File[]) => Promise<ImportFilesResult>
  importParseDocuments: (args: ImportParseArgs) => Promise<Awaited<ReturnType<AckemApi['importParseDocuments']>>>
  importGetJob: (jobId: string) => Promise<Awaited<ReturnType<AckemApi['importGetJob']>>>
  importCommitJob: (args: ImportCommitArgs) => Promise<Awaited<ReturnType<AckemApi['importCommitJob']>>>
  profileEstimateScan: (relPaths: string[]) => Promise<ProfileEstimateResult>
  profileGet: () => Promise<ProfileGetResult>
  profileInferFromFiles: (args: ProfileInferArgs) => Promise<ProfileInferResult>
  extPluginsList: (type?: string) => Promise<ExtPluginRow[]>
  extPluginsActivate: (id: string) => Promise<{ ok: boolean; error?: string }>
  extPluginsDeactivate: (id: string) => Promise<{ ok: boolean; error?: string }>
  extSkillsList: () => Promise<ExtSkillRow[]>
  extSkillsActivate: (id: string) => Promise<{ ok: boolean }>
  extSkillsDeactivate: (id: string) => Promise<{ ok: boolean }>
  openForuListExtensions: () => Promise<OpenForUListExtensionsResult>
  openForuPlanRefineOpen: (
    extensionId: string,
    opts?: { instruction?: string; displayName?: string }
  ) => Promise<OpenForUPlanRefineOpenResult>
  openForuWorkspacesList: () => Promise<OpenForUWorkspaceListResult>
  openForuWorkspacesCreate: (name?: string) => Promise<OpenForUWorkspaceCreateResult>
  openForuWorkspacesSwitch: (workspaceId: string) => Promise<OpenForUWorkspaceSwitchResult>
  openForuWorkspacesDelete: (workspaceId: string) => Promise<OpenForUWorkspaceDeleteResult>
  openForuRemoveExtension: (kind: 'uskill' | 'uplugin', id: string) => Promise<OpenForURemoveExtensionResult>
  openForuApproveAndActivate: (pluginId: string) => Promise<OpenForUApproveAndActivateResult>
  openForuOpenSurfaceWindow: (extensionId: string) => Promise<OpenForUOpenSurfaceWindowResult>
  openForuOnNotify: (fn: Parameters<AckemApi['openforu']['onNotify']>[0]) => MaybeUnsubscribe
  loadChatHistory: () => Promise<unknown[]>
  saveChatHistory: (rows: unknown[]) => Promise<void>
  sessionList: () => Promise<SessionRow[]>
  sessionCreate: (name: string) => Promise<SessionCreateResult>
  sessionSwitch: (sessionId: string) => Promise<SessionSwitchResult>
  sessionDelete: (sessionId: string) => Promise<SessionDeleteResult>
  appReload: () => Promise<{ ok: boolean }>
  onEmbeddingReadinessChanged: (fn: (snap: EmbeddingReadiness) => void) => MaybeUnsubscribe
  onEmbeddingDownloadProgress: (fn: (payload: { modelId: string; bytes: number; total: number; speed: number }) => void) => MaybeUnsubscribe
  onMemoryUpdated: (fn: (payload: MemoryUpdatedPayload) => void) => MaybeUnsubscribe
  onDiaryAutoGenerated: (fn: (payload: { date: string; type: string; pendingCount?: number }) => void) => MaybeUnsubscribe
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
  | 'getDataRoot'
  | 'ensureLayout'
  | 'openDataFolder'
  | 'getState'
  | 'resetState'
  | 'traceLatest'
  | 'embeddingReadiness'
  | 'embeddingStatus'
  | 'embeddingSwitch'
  | 'embeddingDownload'
  | 'embeddingDownloadCancel'
  | 'rebuildIndex'
  | 'search'
  | 'readRel'
  | 'writeAllowed'
  | 'buildContext'
  | 'startChat'
  | 'archiveList'
  | 'archiveRead'
  | 'archiveExport'
  | 'diaryList'
  | 'diaryRead'
  | 'diaryGenerate'
  | 'memoryList'
  | 'memoryRetire'
  | 'memoryUpdate'
  | 'memoryClearAll'
  | 'memoryFeedback'
  | 'memoryConsolidate'
  | 'memoryStats'
  | 'associationList'
  | 'anchorList'
  | 'kgList'
  | 'kgOneHop'
  | 'episodeList'
  | 'memoryAuditReport'
  | 'mirrorCheck'
  | 'mirrorFindings'
  | 'desireList'
  | 'desireDismiss'
  | 'desireClearActive'
  | 'importFiles'
  | 'importParseDocuments'
  | 'importGetJob'
  | 'importCommitJob'
  | 'profileEstimateScan'
  | 'profileGet'
  | 'profileInferFromFiles'
  | 'loadChatHistory'
  | 'saveChatHistory'
  | 'sessionList'
  | 'sessionCreate'
  | 'sessionSwitch'
  | 'sessionDelete'
  | 'appReload'
>> = {
  'settings:get': 'getSettings',
  'settings:set': 'setSettings',
  'data:getRoot': 'getDataRoot',
  'data:ensureLayout': 'ensureLayout',
  'shell:openData': 'openDataFolder',
  'state:get': 'getState',
  'state:reset': 'resetState',
  'trace:latest': 'traceLatest',
  'embedding:readiness': 'embeddingReadiness',
  'embedding:status': 'embeddingStatus',
  'embedding:switch': 'embeddingSwitch',
  'embedding:download': 'embeddingDownload',
  'embedding:downloadCancel': 'embeddingDownloadCancel',
  'index:rebuild': 'rebuildIndex',
  'index:search': 'search',
  'fs:readRel': 'readRel',
  'fs:writeAllowed': 'writeAllowed',
  'context:build': 'buildContext',
  'chat:start': 'startChat',
  'archive:list': 'archiveList',
  'archive:read': 'archiveRead',
  'memory:exportArchive': 'archiveExport',
  'diary:list': 'diaryList',
  'diary:read': 'diaryRead',
  'diary:generate': 'diaryGenerate',
  'memory:list': 'memoryList',
  'memory:retire': 'memoryRetire',
  'memory:update': 'memoryUpdate',
  'memory:clearAll': 'memoryClearAll',
  'memory:feedback': 'memoryFeedback',
  'memory:consolidate': 'memoryConsolidate',
  'memory:stats': 'memoryStats',
  'association:list': 'associationList',
  'anchor:list': 'anchorList',
  'kg:list': 'kgList',
  'kg:oneHop': 'kgOneHop',
  'episode:list': 'episodeList',
  'memory:auditReport': 'memoryAuditReport',
  'mirror:check': 'mirrorCheck',
  'mirror:findings': 'mirrorFindings',
  'desire:list': 'desireList',
  'desire:dismiss': 'desireDismiss',
  'desire:clearActive': 'desireClearActive',
  'import:files': 'importFiles',
  'import:parseDocuments': 'importParseDocuments',
  'import:getJob': 'importGetJob',
  'import:commitJob': 'importCommitJob',
  'profile:estimateScan': 'profileEstimateScan',
  'profile:get': 'profileGet',
  'profile:inferFromFiles': 'profileInferFromFiles',
  'chat:loadHistory': 'loadChatHistory',
  'chat:saveHistory': 'saveChatHistory',
  'session:list': 'sessionList',
  'session:create': 'sessionCreate',
  'session:switch': 'sessionSwitch',
  'session:delete': 'sessionDelete',
  'app:reload': 'appReload'
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
  getDataRoot: () => invoke<Awaited<ReturnType<AckemApi['getDataRoot']>>>('data:getRoot'),
  ensureLayout: () => invoke<{ path: string }>('data:ensureLayout'),
  openDataFolder: async () => {
    const electron = getElectronAckem()
    if (electron) return electron.openDataFolder()
    throw new Error('Ackem Web cannot open the native file manager. Use the displayed data path instead.')
  },
  selectFiles: async () => {
    const electron = getElectronAckem()
    if (electron) return electron.selectFiles()
    throw new Error('Ackem Web cannot use the native file picker. Use browser upload or Termux path import.')
  },
  getPathForFile: (file) => getElectronAckem()?.getPathForFile(file) ?? '',
  getState: () => invoke<unknown>('state:get'),
  resetState: () => invoke<unknown>('state:reset'),
  traceLatest: (limit) => invoke<TraceLatestResult>('trace:latest', [limit]),
  embeddingReadiness: () => invoke<EmbeddingReadiness>('embedding:readiness'),
  embeddingStatus: () => invoke<EmbeddingStatus>('embedding:status'),
  embeddingSwitch: (modelId) => invoke<Awaited<ReturnType<AckemApi['embeddingSwitch']>>>('embedding:switch', [modelId]),
  embeddingDownload: (modelId) => invoke<Awaited<ReturnType<AckemApi['embeddingDownload']>>>('embedding:download', [modelId]),
  embeddingDownloadCancel: (modelId) =>
    invoke<Awaited<ReturnType<AckemApi['embeddingDownloadCancel']>>>('embedding:downloadCancel', [modelId]),
  rebuildIndex: () => invoke<Awaited<ReturnType<AckemApi['rebuildIndex']>>>('index:rebuild'),
  search: (query, limit) => invoke<SearchHit[]>('index:search', [query, limit]),
  readRel: (relPath, maxBytes) => invoke<ReadRelResult>('fs:readRel', [relPath, maxBytes]),
  buildContext: (args) => invoke<BuildContextResult>('context:build', [args]),
  startChat: (payload) => invoke<void>('chat:start', [payload]),
  archiveList: () => invoke<ArchiveListResult>('archive:list'),
  archiveRead: (relPath) => invoke<ArchiveReadResult>('archive:read', [relPath]),
  archiveExport: () => invoke<ArchiveExportResult>('memory:exportArchive'),
  diaryList: () => invoke<DiaryListResult>('diary:list'),
  diaryRead: (date) => invoke<DiaryReadResult>('diary:read', [date]),
  diaryGenerate: (opts) => invoke<DiaryGenerateResult>('diary:generate', [opts]),
  memoryList: () => invoke<unknown[]>('memory:list'),
  memoryRetire: (id) => invoke<boolean>('memory:retire', [id]),
  memoryUpdate: (id, patch) => invoke<boolean>('memory:update', [id, patch]),
  memoryClearAll: () => invoke<{ ok: boolean }>('memory:clearAll'),
  memoryFeedback: (id, action) => invoke<boolean>('memory:feedback', [id, action]),
  memoryConsolidate: () => invoke<Awaited<ReturnType<AckemApi['memoryConsolidate']>>>('memory:consolidate'),
  memoryStats: () => invoke<Awaited<ReturnType<AckemApi['memoryStats']>>>('memory:stats'),
  associationList: () => invoke<Awaited<ReturnType<AckemApi['associationList']>>>('association:list'),
  anchorList: () => invoke<Awaited<ReturnType<AckemApi['anchorList']>>>('anchor:list'),
  kgList: () => invoke<Awaited<ReturnType<AckemApi['kgList']>>>('kg:list'),
  kgOneHop: (entity) => invoke<Awaited<ReturnType<AckemApi['kgOneHop']>>>('kg:oneHop', [entity]),
  episodeList: () => invoke<Awaited<ReturnType<AckemApi['episodeList']>>>('episode:list'),
  memoryAuditReport: (opts) =>
    invoke<Awaited<ReturnType<AckemApi['memoryAuditReport']>>>('memory:auditReport', [opts]),
  mirrorCheck: () => invoke<Awaited<ReturnType<AckemApi['mirrorCheck']>>>('mirror:check'),
  mirrorFindings: () => invoke<Awaited<ReturnType<AckemApi['mirrorFindings']>>>('mirror:findings'),
  desireList: () => invoke<DesireStackResult>('desire:list'),
  desireDismiss: (desireId) => invoke<DesireStackResult>('desire:dismiss', [desireId]),
  desireClearActive: () => invoke<DesireStackResult>('desire:clearActive'),
  importFiles: (paths) => invoke<ImportFilesResult>('import:files', [paths]),
  importBrowserFiles: async (files) => {
    const electron = getElectronAckem()
    if (electron) {
      const paths = files.map((file) => electron.getPathForFile(file)).filter(Boolean)
      return electron.importFiles(paths)
    }
    return webUploadFiles(files)
  },
  importParseDocuments: (args) =>
    invoke<Awaited<ReturnType<AckemApi['importParseDocuments']>>>('import:parseDocuments', [args]),
  importGetJob: (jobId) => invoke<Awaited<ReturnType<AckemApi['importGetJob']>>>('import:getJob', [jobId]),
  importCommitJob: (args) => invoke<Awaited<ReturnType<AckemApi['importCommitJob']>>>('import:commitJob', [args]),
  profileEstimateScan: (relPaths) => invoke<ProfileEstimateResult>('profile:estimateScan', [relPaths]),
  profileGet: () => invoke<ProfileGetResult>('profile:get'),
  profileInferFromFiles: (args) => invoke<ProfileInferResult>('profile:inferFromFiles', [args]),
  extPluginsList: (type) => {
    const electron = getElectronAckem()
    if (electron) return electron.ext.plugins.list(type) as Promise<ExtPluginRow[]>
    return webInvoke<ExtPluginRow[]>('ext:plugins:list', [type])
  },
  extPluginsActivate: (id) => {
    const electron = getElectronAckem()
    if (electron) return electron.ext.plugins.activate(id)
    return webInvoke<{ ok: boolean; error?: string }>('ext:plugins:activate', [id])
  },
  extPluginsDeactivate: (id) => {
    const electron = getElectronAckem()
    if (electron) return electron.ext.plugins.deactivate(id)
    return webInvoke<{ ok: boolean; error?: string }>('ext:plugins:deactivate', [id])
  },
  extSkillsList: () => {
    const electron = getElectronAckem()
    if (electron) return electron.ext.skills.list() as Promise<ExtSkillRow[]>
    return webInvoke<ExtSkillRow[]>('ext:skills:list')
  },
  extSkillsActivate: (id) => {
    const electron = getElectronAckem()
    if (electron) return electron.ext.skills.activate(id)
    return webInvoke<{ ok: boolean }>('ext:skills:activate', [id])
  },
  extSkillsDeactivate: (id) => {
    const electron = getElectronAckem()
    if (electron) return electron.ext.skills.deactivate(id)
    return webInvoke<{ ok: boolean }>('ext:skills:deactivate', [id])
  },
  openForuListExtensions: () => {
    const electron = getElectronAckem()
    if (electron) return electron.openforu.listExtensions()
    return webInvoke<OpenForUListExtensionsResult>('openforu:extensions:list')
  },
  openForuPlanRefineOpen: (extensionId, opts) => {
    const electron = getElectronAckem()
    if (electron) return electron.openforu.planRefineOpen(extensionId, opts)
    return webInvoke<OpenForUPlanRefineOpenResult>('openforu:plan:refineOpen', [{ extensionId, ...opts }])
  },
  openForuWorkspacesList: () => {
    const electron = getElectronAckem()
    if (electron) return electron.openforu.workspaces.list()
    return webInvoke<OpenForUWorkspaceListResult>('openforu:workspaces:list')
  },
  openForuWorkspacesCreate: (name) => {
    const electron = getElectronAckem()
    if (electron) return electron.openforu.workspaces.create(name)
    return webInvoke<OpenForUWorkspaceCreateResult>('openforu:workspaces:create', [name ? { name } : undefined])
  },
  openForuWorkspacesSwitch: (workspaceId) => {
    const electron = getElectronAckem()
    if (electron) return electron.openforu.workspaces.switch(workspaceId)
    return webInvoke<OpenForUWorkspaceSwitchResult>('openforu:workspaces:switch', [workspaceId])
  },
  openForuWorkspacesDelete: (workspaceId) => {
    const electron = getElectronAckem()
    if (electron) return electron.openforu.workspaces.delete(workspaceId)
    return webInvoke<OpenForUWorkspaceDeleteResult>('openforu:workspaces:delete', [workspaceId])
  },
  openForuRemoveExtension: (kind, id) => {
    const electron = getElectronAckem()
    if (electron) return electron.openforu.removeExtension(kind, id)
    return webInvoke<OpenForURemoveExtensionResult>('openforu:extensions:remove', [{ kind, id }])
  },
  openForuApproveAndActivate: (pluginId) => {
    const electron = getElectronAckem()
    if (electron) return electron.openforu.permissions.approveAndActivate(pluginId)
    return webInvoke<OpenForUApproveAndActivateResult>('openforu:permissions:approveAndActivate', [{ pluginId }])
  },
  openForuOpenSurfaceWindow: async (extensionId) => {
    const electron = getElectronAckem()
    if (electron) return electron.openforu.openSurfaceWindow(extensionId)
    return { ok: false, message: 'Surface windows are Electron-only in Ackem Web.' }
  },
  openForuOnNotify: (fn) => {
    const electron = getElectronAckem()
    if (electron) return electron.openforu.onNotify(fn)
    return webEvents.on('openforu:notify', fn)
  },
  loadChatHistory: () => invoke<unknown[]>('chat:loadHistory'),
  saveChatHistory: (rows) => invoke<void>('chat:saveHistory', [rows]),
  sessionList: () => invoke<SessionRow[]>('session:list'),
  sessionCreate: (name) => invoke<SessionCreateResult>('session:create', [name]),
  sessionSwitch: (sessionId) => invoke<SessionSwitchResult>('session:switch', [sessionId]),
  sessionDelete: (sessionId) => invoke<SessionDeleteResult>('session:delete', [sessionId]),
  appReload: async () => {
    const electron = getElectronAckem()
    if (electron) return electron.appReload()
    window.location.reload()
    return { ok: true }
  },
  onEmbeddingReadinessChanged: (fn) =>
    subscribe<EmbeddingReadiness>(
      'embedding:readiness-changed',
      (api) => api.onEmbeddingReadinessChanged((snap) => fn(snap as EmbeddingReadiness)),
      fn
    ),
  onEmbeddingDownloadProgress: (fn) =>
    subscribe<{ modelId: string; bytes: number; total: number; speed: number }>(
      'embedding:downloadProgress',
      (api) => api.onEmbeddingDownloadProgress(fn),
      fn
    ),
  onMemoryUpdated: (fn) =>
    subscribe<MemoryUpdatedPayload>('memory:updated', (api) => api.onMemoryUpdated(fn), fn),
  onDiaryAutoGenerated: (fn) =>
    subscribe<{ date: string; type: string; pendingCount?: number }>(
      'diary:autoGenerated',
      (api) => api.onDiaryAutoGenerated(fn),
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
    getAppVersion: () => webInvoke('update:getAppVersion'),
    checkUpdate: () => webInvoke('update:check'),
    startUpdate: (req) => webInvoke('update:start', [req]),
    openUpdateRelease: (url) => webInvoke('update:openRelease', [url]),
    getUpdateChannelPreference: () => webInvoke('update:getChannelPreference'),
    setUpdateChannelPreference: (channel) => webInvoke('update:setChannelPreference', [channel]),
    getCanon: () => webInvoke('canon:get'),
    getCreatorMemory: () => webInvoke('canon:creator-memory:get'),
    getDataRoot: ackemClient.getDataRoot,
    ensureLayout: ackemClient.ensureLayout,
    openDataFolder: ackemClient.openDataFolder,
    selectFiles: ackemClient.selectFiles,
    getPathForFile: ackemClient.getPathForFile,
    importFiles: ackemClient.importFiles,
    promoteImport: (rel: string) => webInvoke('import:promote', [rel]),
    importParseDocuments: ackemClient.importParseDocuments,
    importGetJob: ackemClient.importGetJob,
    importCommitJob: ackemClient.importCommitJob,
    rebuildIndex: ackemClient.rebuildIndex,
    search: ackemClient.search,
    readRel: ackemClient.readRel,
    writeAllowed: (rel, content, mode) => webInvoke('fs:writeAllowed', [rel, content, mode]),
    getState: ackemClient.getState,
    resetState: ackemClient.resetState,
    traceLatest: ackemClient.traceLatest,
    embeddingReadiness: ackemClient.embeddingReadiness,
    embeddingStatus: ackemClient.embeddingStatus,
    embeddingSwitch: ackemClient.embeddingSwitch,
    embeddingDownload: ackemClient.embeddingDownload,
    embeddingDownloadCancel: ackemClient.embeddingDownloadCancel,
    onEmbeddingDownloadProgress: ackemClient.onEmbeddingDownloadProgress,
    policyDecisionLogRecent: (limit?: number) => webInvoke('policy:decisionLogRecent', [limit]),
    personalityList: (gender) => webInvoke('personality:list', [gender]),
    personalitySet: (id) => webInvoke('personality:set', [id]),
    profileEstimateScan: ackemClient.profileEstimateScan,
    profileGet: ackemClient.profileGet,
    profileInferFromFiles: ackemClient.profileInferFromFiles,
    profileApplyCompanionSuggestion: () => webInvoke('profile:applyCompanionSuggestion'),
    onEmbeddingReadinessChanged: (fn) => ackemClient.onEmbeddingReadinessChanged(fn as (snap: EmbeddingReadiness) => void) ?? noOpUnsubscribe,
    buildContext: ackemClient.buildContext,
    startChat: ackemClient.startChat,
    archiveList: ackemClient.archiveList,
    archiveRead: ackemClient.archiveRead,
    archiveExport: ackemClient.archiveExport,
    diaryList: ackemClient.diaryList,
    diaryRead: ackemClient.diaryRead,
    diaryGenerate: ackemClient.diaryGenerate,
    onDiaryAutoGenerated: ackemClient.onDiaryAutoGenerated,
    thoughtGenerate: () => webInvoke('thought:generate'),
    memoryList: ackemClient.memoryList,
    memoryAuditReport: ackemClient.memoryAuditReport,
    memoryRetire: ackemClient.memoryRetire,
    memoryUpdate: ackemClient.memoryUpdate,
    memoryClearAll: ackemClient.memoryClearAll,
    memoryFeedback: ackemClient.memoryFeedback,
    memoryConsolidate: ackemClient.memoryConsolidate,
    associationList: ackemClient.associationList,
    anchorList: ackemClient.anchorList,
    memoryStats: ackemClient.memoryStats,
    kgList: ackemClient.kgList,
    kgOneHop: ackemClient.kgOneHop,
    episodeList: ackemClient.episodeList,
    desireList: ackemClient.desireList,
    desireDismiss: ackemClient.desireDismiss,
    desireClearActive: ackemClient.desireClearActive,
    mirrorCheck: ackemClient.mirrorCheck,
    mirrorFindings: ackemClient.mirrorFindings,
    onMemoryUpdated: (fn) => ackemClient.onMemoryUpdated(fn) ?? noOpUnsubscribe,
    mediaStatus: () => webInvoke('ext:media:status'),
    loadChatHistory: ackemClient.loadChatHistory,
    saveChatHistory: ackemClient.saveChatHistory,
    sessionList: ackemClient.sessionList,
    sessionCreate: ackemClient.sessionCreate,
    sessionSwitch: ackemClient.sessionSwitch,
    sessionDelete: ackemClient.sessionDelete,
    appReload: ackemClient.appReload,
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
      workspaces: {
        list: () => webInvoke('openforu:workspaces:list'),
        open: () => webInvoke('openforu:workspaces:open'),
        create: (name?: string) => webInvoke('openforu:workspaces:create', [name ? { name } : undefined]),
        switch: (workspaceId: string) => webInvoke('openforu:workspaces:switch', [workspaceId]),
        delete: (workspaceId: string) => webInvoke('openforu:workspaces:delete', [workspaceId])
      },
      planStart: () => webInvoke('openforu:plan:start'),
      planSend: (sessionId: string, text: string) => webInvoke('openforu:plan:send', [{ sessionId, text }]),
      planConfirm: (sessionId: string) => webInvoke('openforu:plan:confirm', [sessionId]),
      planApproveWireframe: (sessionId: string) => webInvoke('openforu:plan:approveWireframe', [sessionId]),
      planDeploy: (sessionId: string) => webInvoke('openforu:plan:deploy', [sessionId]),
      planRedeploy: (sessionId: string, userText?: string) =>
        webInvoke('openforu:plan:redeploy', [{ sessionId, userText }]),
      planRefineOpen: (extensionId: string, opts?: { instruction?: string; displayName?: string }) =>
        webInvoke('openforu:plan:refineOpen', [{ extensionId, ...opts }]),
      onPlanSessionUpdated: (fn: Parameters<AckemApi['openforu']['onPlanSessionUpdated']>[0]) =>
        webEvents.on('openforu:plan:session-updated', fn),
      planStatus: (sessionId: string) => webInvoke('openforu:plan:status', [sessionId]),
      listArtifacts: () => webInvoke('openforu:listArtifacts'),
      previewArtifact: (sessionId: string) => webInvoke('openforu:artifact:preview', [sessionId]),
      readArtifact: (extensionId: string) => webInvoke('openforu:artifact:read', [extensionId]),
      listExtensions: () => webInvoke('openforu:extensions:list'),
      openSurfaceWindow: unsupportedAsync(
        'window.ackem.openforu.openSurfaceWindow; surface windows are Electron-only'
      ) as AckemApi['openforu']['openSurfaceWindow'],
      removeExtension: (kind: 'uskill' | 'uplugin', id: string) =>
        webInvoke('openforu:extensions:remove', [{ kind, id }]),
      onNotify: (fn: Parameters<AckemApi['openforu']['onNotify']>[0]) => webEvents.on('openforu:notify', fn),
      permissions: {
        onRequest: (fn: Parameters<AckemApi['openforu']['permissions']['onRequest']>[0]) =>
          webEvents.on('openforu:permissions:request', fn),
        approve: (requestId: string) => webInvoke('openforu:permissions:approve', [{ requestId }]),
        deny: (requestId: string) => webInvoke('openforu:permissions:deny', [{ requestId }]),
        approveAndActivate: (pluginId: string) =>
          webInvoke('openforu:permissions:approveAndActivate', [{ pluginId }])
      },
      agent: {
        getStatus: (sessionId: string) => webInvoke('openforu:agent:status', [sessionId]),
        cancel: (sessionId: string) => webInvoke('openforu:agent:cancel', [sessionId]),
        onEvent: (fn: Parameters<AckemApi['openforu']['agent']['onEvent']>[0]) =>
          webEvents.on('openforu:agent:event', fn)
      },
      refine: {
        preview: (extensionId: string, instruction: string) =>
          webInvoke('openforu:refine:preview', [{ extensionId, instruction }]),
        apply: (extensionId: string, instruction: string) =>
          webInvoke('openforu:refine:apply', [{ extensionId, instruction }]),
        history: (extensionId: string) => webInvoke('openforu:refine:history', [extensionId]),
        rollback: (extensionId: string, targetVersion: string, kind?: 'uskill' | 'uplugin') =>
          webInvoke('openforu:refine:rollback', [{ extensionId, targetVersion, kind }])
      }
    } as unknown as AckemApi['openforu'],
    ext: {
      gamemode: {
        list: () => webInvoke('ext:gamemode:list'),
        activate: (gameId: string, config: unknown) => webInvoke('ext:gamemode:activate', [gameId, config]),
        deactivate: () => webInvoke('ext:gamemode:deactivate'),
        status: () => webInvoke('ext:gamemode:status'),
        invoke: (gameId: string, method: string, params?: Record<string, unknown>) =>
          webInvoke('ext:gamemode:invoke', [{ gameId, method, params }]),
        minecraft: {
          react: (event: Parameters<AckemApi['ext']['gamemode']['minecraft']['react']>[0]) =>
            webInvoke('mc:react', [event]),
          parseLog: (line: string) => webInvoke('mc:parseLog', [line]),
          getWsStatus: () => webInvoke('mc:status'),
          syncEngineState: () => webInvoke('mc:setEngineState'),
          botStart: (cfg: Parameters<AckemApi['ext']['gamemode']['minecraft']['botStart']>[0]) =>
            webInvoke('mc:botStart', [cfg]),
          botStop: () => webInvoke('mc:botStop'),
          botStatus: () => webInvoke('mc:botStatus'),
          botDebug: () => webInvoke('mc:botDebug'),
          logStart: (logPath: string) => webInvoke('mc:logStart', [logPath]),
          logStop: () => webInvoke('mc:logStop'),
          logStatus: () => webInvoke('mc:logStatus')
        },
        onEvent: (gameId: string, fn: Parameters<AckemApi['ext']['gamemode']['onEvent']>[1]) =>
          webEvents.on('ext:gamemode:event', (payload: { gameId?: string; event: unknown; reaction: unknown }) => {
            if (!payload?.gameId || payload.gameId === gameId) {
              fn(payload as { gameId: string; event: unknown; reaction: unknown })
            }
          })
      },
      plugins: {
        list: (type?: string) => webInvoke('ext:plugins:list', [type]),
        activate: (id: string) => webInvoke('ext:plugins:activate', [id]),
        deactivate: (id: string) => webInvoke('ext:plugins:deactivate', [id])
      } as Partial<AckemApi['ext']['plugins']> as AckemApi['ext']['plugins'],
      skills: {
        list: () => webInvoke('ext:skills:list'),
        activate: (id: string) => webInvoke('ext:skills:activate', [id]),
        deactivate: (id: string) => webInvoke('ext:skills:deactivate', [id])
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
