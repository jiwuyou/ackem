import type { Dirent } from 'node:fs'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import type { MachineMapStatus } from '../../../shared/machineMap'
import { isMachineMapStale } from '../../../shared/machineMap'
import type {
  ReleaseChannelInfo,
  UpdateChannel,
  UpdateCheckResult,
  UpdateStartRequest,
} from '../../../shared/updateTypes'
import { ensureDataLayout } from '../../layout'
import {
  currentWebDataRoot,
  currentWebSessionId,
  loadWebSettings,
  saveWebSettings,
} from '../runtime'
import type { WebHandlerRegistry, WebInvokeHandler } from '../types'
import { clampInteger } from './safePaths'

type DesktopConfirmDecision = 'allowed' | 'allowed_session' | 'allowed_task_deletes' | 'denied'

type WebDesktopAuditEntry = {
  ts: string
  action: string
  result: string
  summary?: string
  sessionId?: string
  requestId?: string
  taskPlanId?: string
}

type StoredUpdateJob = {
  requestedAt: string
  request: UpdateStartRequest & { channel: UpdateChannel }
  reason: string
  jobPath?: string
}

type WebSystemWorkflowState = {
  version: 1
  desktopAgent: {
    sessionModes: Record<string, boolean>
    confirmDecisions: Array<{
      requestId: string
      decision: DesktopConfirmDecision
      sessionId?: string
      taskPlanId?: string
      at: string
    }>
    audit: WebDesktopAuditEntry[]
  }
  machineMap: MachineMapStatus
  update: {
    lastCheck: UpdateCheckResult | null
    jobs: StoredUpdateJob[]
    releaseOpenRequests: Array<{ url: string; at: string }>
    updaterActions: Array<{ action: string; at: string; jobPath?: string; url?: string }>
  }
  app: {
    uninstallRequests: Array<{
      at: string
      deleteData: boolean
      removeApp: boolean
      blocked: true
    }>
  }
}

const SYSTEM_STATE_VERSION = 1 as const
const DOCUMENT_EXTS = new Set(['.md', '.txt', '.json', '.csv', '.pdf', '.docx'])
const GAME_HINT_DIRS = new Set(['games', 'game', 'minecraft', 'mods', 'saves'])

export const WEB_SYSTEM_WORKFLOW_CHANNELS = [
  'desktop-agent:sessionMode:get',
  'desktop-agent:sessionMode:set',
  'desktop-agent:opening',
  'desktop-agent:confirm:allow',
  'desktop-agent:confirm:allowSession',
  'desktop-agent:confirm:allowTaskDeletes',
  'desktop-agent:confirm:deny',
  'desktop-agent:audit:recent',
  'machine-map:status',
  'machine-map:reindex',
  'update:getAppVersion',
  'update:check',
  'update:start',
  'update:openRelease',
  'update:getChannelPreference',
  'update:setChannelPreference',
  'updater:getJobPath',
  'updater:readJob',
  'updater:start',
  'updater:launchAckem',
  'updater:openRelease',
  'updater:quit',
  'app:uninstallInfo',
  'app:uninstall',
] as const

function defaultMachineMapStatus(): MachineMapStatus {
  return {
    status: 'idle',
    lastCompleteAt: null,
    gameCount: 0,
    documentCount: 0,
    lastScanRunId: null,
    isStale: true,
  }
}

function defaultSystemState(): WebSystemWorkflowState {
  return {
    version: SYSTEM_STATE_VERSION,
    desktopAgent: {
      sessionModes: {},
      confirmDecisions: [],
      audit: [],
    },
    machineMap: defaultMachineMapStatus(),
    update: {
      lastCheck: null,
      jobs: [],
      releaseOpenRequests: [],
      updaterActions: [],
    },
    app: {
      uninstallRequests: [],
    },
  }
}

function rootWithLayout(): string {
  const root = currentWebDataRoot()
  ensureDataLayout(root)
  return root
}

function statePath(root: string): string {
  return join(root, '_derived', 'web-system-state.json')
}

function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return fallback
  }
}

function normalizeState(input: Partial<WebSystemWorkflowState> | null | undefined): WebSystemWorkflowState {
  const base = defaultSystemState()
  return {
    version: SYSTEM_STATE_VERSION,
    desktopAgent: {
      sessionModes: input?.desktopAgent?.sessionModes ?? base.desktopAgent.sessionModes,
      confirmDecisions: Array.isArray(input?.desktopAgent?.confirmDecisions)
        ? input.desktopAgent.confirmDecisions.slice(-200)
        : base.desktopAgent.confirmDecisions,
      audit: Array.isArray(input?.desktopAgent?.audit)
        ? input.desktopAgent.audit.slice(-500)
        : base.desktopAgent.audit,
    },
    machineMap: {
      ...base.machineMap,
      ...(input?.machineMap ?? {}),
    },
    update: {
      lastCheck: input?.update?.lastCheck ?? null,
      jobs: Array.isArray(input?.update?.jobs) ? input.update.jobs.slice(-50) : [],
      releaseOpenRequests: Array.isArray(input?.update?.releaseOpenRequests)
        ? input.update.releaseOpenRequests.slice(-50)
        : [],
      updaterActions: Array.isArray(input?.update?.updaterActions)
        ? input.update.updaterActions.slice(-50)
        : [],
    },
    app: {
      uninstallRequests: Array.isArray(input?.app?.uninstallRequests)
        ? input.app.uninstallRequests.slice(-50)
        : [],
    },
  }
}

function loadSystemState(root = rootWithLayout()): WebSystemWorkflowState {
  return normalizeState(readJson<Partial<WebSystemWorkflowState> | null>(statePath(root), null))
}

function saveSystemState(root: string, state: WebSystemWorkflowState): WebSystemWorkflowState {
  mkdirSync(dirname(statePath(root)), { recursive: true })
  writeFileSync(statePath(root), JSON.stringify(normalizeState(state), null, 2), 'utf-8')
  return state
}

function mutateSystemState(
  fn: (state: WebSystemWorkflowState, root: string) => WebSystemWorkflowState | void
): WebSystemWorkflowState {
  const root = rootWithLayout()
  const state = loadSystemState(root)
  const next = fn(state, root) ?? state
  return saveSystemState(root, next)
}

function appendAudit(state: WebSystemWorkflowState, entry: Omit<WebDesktopAuditEntry, 'ts'>): void {
  state.desktopAgent.audit.push({
    ts: new Date().toISOString(),
    ...entry,
  })
  state.desktopAgent.audit = state.desktopAgent.audit.slice(-500)
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function requestIdFromArgs(args: unknown): string {
  if (typeof args === 'string') return args
  if (args && typeof args === 'object') {
    const id = (args as { requestId?: unknown }).requestId
    if (typeof id === 'string') return id
  }
  return ''
}

function taskPlanIdFromArgs(args: unknown): string | undefined {
  if (args && typeof args === 'object') {
    const id = (args as { taskPlanId?: unknown }).taskPlanId
    return typeof id === 'string' && id.trim() ? id.trim() : undefined
  }
  return undefined
}

function webDesktopSettingsReady(): boolean {
  const settings = loadWebSettings()
  return settings.desktopAgentEnabled === true && settings.desktopAgentRiskAccepted === true
}

function sessionIdOrCurrent(input: unknown): string {
  return asNonEmptyString(input) ?? currentWebSessionId()
}

function makeReleaseError(
  channel: Exclude<UpdateChannel, 'auto'>,
  version: string,
  checkedAt: string,
  error: string
): ReleaseChannelInfo {
  return {
    channel,
    version,
    notes: '',
    downloadUrl: '',
    size: 0,
    publishedAt: checkedAt,
    releasePageUrl:
      channel === 'github'
        ? 'https://github.com/JasonLiu0826/ackem/releases'
        : 'https://gitee.com',
    error,
  }
}

function readPackageVersion(): string {
  const envVersion = process.env.npm_package_version
  if (envVersion?.trim()) return envVersion.trim()
  try {
    const parsed = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as {
      version?: unknown
    }
    return typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : '1.0.0'
  } catch {
    return '1.0.0'
  }
}

function validateUpdateChannel(value: unknown): UpdateChannel {
  return value === 'github' || value === 'gitee' || value === 'auto' ? value : 'auto'
}

function webUpdateJobsDir(root: string): string {
  return join(root, '_derived', 'web-update-jobs')
}

function updateJobPathFromArg(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const cleaned = value.trim().replace(/^"|"$/g, '')
  if (!cleaned.endsWith('.json')) return null
  return cleaned
}

function updaterJobPathFromProcess(): string | null {
  const env = updateJobPathFromArg(process.env.ACKEM_UPDATER_JOB_PATH)
  if (env && existsSync(env)) return env
  const arg = process.argv.find((item) => item.startsWith('--ackem-updater='))
  const fromArg = arg ? updateJobPathFromArg(arg.slice('--ackem-updater='.length)) : null
  return fromArg && existsSync(fromArg) ? fromArg : null
}

function latestWebUpdateJobPath(root = rootWithLayout()): string | null {
  const fromProcess = updaterJobPathFromProcess()
  if (fromProcess) return fromProcess
  const dir = webUpdateJobsDir(root)
  try {
    const latest = readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .at(-1)
    return latest ? join(dir, latest) : null
  } catch {
    return null
  }
}

function releaseUrlFromJob(job: unknown): string {
  if (!job || typeof job !== 'object') return ''
  const raw = job as { releasePageUrl?: unknown; request?: { releasePageUrl?: unknown } }
  if (typeof raw.releasePageUrl === 'string') return raw.releasePageUrl
  if (typeof raw.request?.releasePageUrl === 'string') return raw.request.releasePageUrl
  return ''
}

function readUpdaterJob(path: string | null): unknown | null {
  if (!path) return null
  return readJson<unknown | null>(path, null)
}

function resolveWebUpdateJobPath(root: string, value: unknown): string | null {
  const raw = updateJobPathFromArg(value)
  if (!raw) return null
  const jobsDir = resolve(webUpdateJobsDir(root))
  const abs = resolve(raw)
  const back = relative(jobsDir, abs)
  if (back.startsWith('..') || back === '..' || back.includes(':')) return null
  return existsSync(abs) ? abs : null
}

function scanMachineMap(root: string): Pick<MachineMapStatus, 'gameCount' | 'documentCount'> {
  let documentCount = 0
  const gameHints = new Set<string>()
  const stack = [root]
  const rootDepth = root.split(/[\\/]+/).length

  while (stack.length > 0) {
    const dir = stack.pop()
    if (!dir) continue
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.minecraft') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        const depth = full.split(/[\\/]+/).length - rootDepth
        const lowered = entry.name.toLowerCase()
        if (GAME_HINT_DIRS.has(lowered) || lowered.endsWith('games')) gameHints.add(full)
        if (depth < 5 && !full.includes(`${join(root, '_derived')}`)) stack.push(full)
        continue
      }
      if (DOCUMENT_EXTS.has(extname(entry.name).toLowerCase())) documentCount += 1
    }
  }

  return {
    gameCount: gameHints.size,
    documentCount,
  }
}

export function handleWebDesktopSessionModeGet(sessionId?: unknown): {
  enabled: boolean
  settingsReady: boolean
  previewOnly: false
  webRuntime: true
} {
  const root = rootWithLayout()
  const state = loadSystemState(root)
  const sid = sessionIdOrCurrent(sessionId)
  const settingsReady = webDesktopSettingsReady()
  return {
    enabled: settingsReady && state.desktopAgent.sessionModes[sid] === true,
    settingsReady,
    previewOnly: false,
    webRuntime: true,
  }
}

export function handleWebDesktopSessionModeSet(input: unknown): {
  ok: boolean
  enabled?: boolean
  error?: string
  settingsReady?: boolean
  webRuntime: true
} {
  const args = input && typeof input === 'object' ? (input as { sessionId?: unknown; enabled?: unknown }) : {}
  const sid = sessionIdOrCurrent(args.sessionId)
  const enabled = args.enabled === true
  const settingsReady = webDesktopSettingsReady()
  if (enabled && !settingsReady) {
    return {
      ok: false,
      error: '请先在设置中启用电脑助手并确认风险',
      settingsReady,
      webRuntime: true,
    }
  }

  mutateSystemState((state) => {
    state.desktopAgent.sessionModes[sid] = enabled
    appendAudit(state, {
      action: 'session_mode',
      result: enabled ? 'enabled' : 'disabled',
      sessionId: sid,
      summary: enabled
        ? 'Web runtime enabled desktop-agent chat mode for this session.'
        : 'Web runtime disabled desktop-agent chat mode for this session.',
    })
  })
  return { ok: true, enabled, settingsReady, webRuntime: true }
}

export function handleWebDesktopOpening(): { ok: true; text: string } | { ok: false; error: string } {
  if (!webDesktopSettingsReady()) {
    return { ok: false, error: '电脑助手未启用' }
  }
  const companionName = loadWebSettings().companionName || 'Ackem'
  return {
    ok: true,
    text:
      `${companionName} 已进入 Web 电脑助手模式。当前 Web runtime 只保留任务状态、确认记录和本地数据服务；` +
      '窗口、托盘、应用聚焦等 Electron 桌面控制不会执行。',
  }
}

function recordConfirm(args: unknown, decision: DesktopConfirmDecision): boolean {
  const requestId = requestIdFromArgs(args)
  const taskPlanId = taskPlanIdFromArgs(args)
  const sessionId =
    args && typeof args === 'object' && typeof (args as { sessionId?: unknown }).sessionId === 'string'
      ? String((args as { sessionId: string }).sessionId)
      : currentWebSessionId()
  mutateSystemState((state) => {
    state.desktopAgent.confirmDecisions.push({
      requestId,
      decision,
      sessionId,
      taskPlanId,
      at: new Date().toISOString(),
    })
    state.desktopAgent.confirmDecisions = state.desktopAgent.confirmDecisions.slice(-200)
    appendAudit(state, {
      action: 'confirm',
      result: decision,
      requestId,
      sessionId,
      taskPlanId,
      summary: `Web runtime recorded desktop-agent confirmation: ${decision}.`,
    })
  })
  return true
}

export function handleWebMachineMapStatus(): MachineMapStatus {
  const root = rootWithLayout()
  const state = loadSystemState(root)
  return {
    ...state.machineMap,
    isStale: isMachineMapStale(state.machineMap.lastCompleteAt),
  }
}

export function handleWebMachineMapReindex(): { ok: boolean; status: MachineMapStatus } {
  const root = rootWithLayout()
  const scanRunId = `web-${Date.now().toString(36)}`
  const counts = scanMachineMap(root)
  const completedAt = new Date().toISOString()
  const state = mutateSystemState((draft) => {
    draft.machineMap = {
      status: 'complete',
      lastCompleteAt: completedAt,
      gameCount: counts.gameCount,
      documentCount: counts.documentCount,
      lastScanRunId: scanRunId,
      isStale: false,
    }
    appendAudit(draft, {
      action: 'machine_map_reindex',
      result: 'complete',
      summary: `Indexed ${counts.documentCount} local data documents and ${counts.gameCount} game hint directories.`,
    })
  })
  return { ok: true, status: state.machineMap }
}

export function handleWebDesktopAuditRecent(limitInput?: unknown): WebDesktopAuditEntry[] {
  const root = rootWithLayout()
  const state = loadSystemState(root)
  const limit = clampInteger(limitInput, 50, 1, 200)
  return state.desktopAgent.audit.slice(-limit).reverse()
}

export function handleWebUpdateGetAppVersion(): string {
  return readPackageVersion()
}

export function handleWebUpdateCheck(): UpdateCheckResult {
  const currentVersion = readPackageVersion()
  const checkedAt = new Date().toISOString()
  const result: UpdateCheckResult = {
    currentVersion,
    packaged: false,
    github: makeReleaseError('github', currentVersion, checkedAt, 'web_runtime_offline_check'),
    gitee: makeReleaseError('gitee', currentVersion, checkedAt, 'web_runtime_offline_check'),
    latest: undefined,
    updateAvailable: false,
    checkedAt,
  }
  saveWebSettings({ updateLastCheckAt: checkedAt })
  mutateSystemState((state) => {
    state.update.lastCheck = result
  })
  return result
}

export function handleWebUpdateStart(input: unknown): { ok: true; jobPath: string } | { ok: false; reason: string } {
  const req =
    input && typeof input === 'object'
      ? (input as Partial<UpdateStartRequest & { channel: UpdateChannel }>)
      : {}
  const channel = validateUpdateChannel(req.channel)
  const requestedAt = new Date().toISOString()
  const root = rootWithLayout()
  const jobsDir = webUpdateJobsDir(root)
  mkdirSync(jobsDir, { recursive: true })
  const jobPath = join(jobsDir, `${requestedAt.replace(/[:.]/g, '-')}.json`)
  const job: StoredUpdateJob = {
    requestedAt,
    request: {
      channel,
      targetVersion: typeof req.targetVersion === 'string' ? req.targetVersion : '',
      downloadUrl: typeof req.downloadUrl === 'string' ? req.downloadUrl : '',
      expectedSize: typeof req.expectedSize === 'number' ? req.expectedSize : 0,
      releasePageUrl: typeof req.releasePageUrl === 'string' ? req.releasePageUrl : '',
    },
    reason: 'not_packaged',
    jobPath,
  }
  writeFileSync(jobPath, JSON.stringify(job, null, 2), 'utf-8')
  mutateSystemState((state) => {
    state.update.jobs.push(job)
    state.update.jobs = state.update.jobs.slice(-50)
  })
  return { ok: false, reason: 'not_packaged' }
}

export function handleWebUpdateOpenRelease(urlInput: unknown): { ok: boolean; url?: string; error?: string } {
  const url = typeof urlInput === 'string' ? urlInput.trim() : ''
  if (!url) return { ok: false, error: 'missing_url' }
  mutateSystemState((state) => {
    state.update.releaseOpenRequests.push({ url, at: new Date().toISOString() })
    state.update.releaseOpenRequests = state.update.releaseOpenRequests.slice(-50)
  })
  return { ok: true, url }
}

export function handleWebUpdateGetChannelPreference(): UpdateChannel {
  return validateUpdateChannel(loadWebSettings().updateChannel)
}

export function handleWebUpdateSetChannelPreference(channelInput: unknown): UpdateChannel {
  const channel = validateUpdateChannel(channelInput)
  saveWebSettings({ updateChannel: channel })
  return channel
}

export function handleWebUpdaterGetJobPath(): string {
  return latestWebUpdateJobPath() ?? ''
}

export function handleWebUpdaterReadJob(pathInput?: unknown): unknown | null {
  const root = rootWithLayout()
  return readUpdaterJob(resolveWebUpdateJobPath(root, pathInput) ?? latestWebUpdateJobPath(root))
}

export function handleWebUpdaterStart(): { ok: boolean; reason: string; jobPath: string } {
  const jobPath = handleWebUpdaterGetJobPath()
  mutateSystemState((state) => {
    state.update.updaterActions.push({
      action: 'start',
      at: new Date().toISOString(),
      jobPath: jobPath || undefined,
    })
    state.update.updaterActions = state.update.updaterActions.slice(-50)
  })
  return {
    ok: false,
    reason: 'web_runtime_no_native_updater',
    jobPath,
  }
}

export function handleWebUpdaterLaunchAckem(): { ok: boolean; reason: string } {
  mutateSystemState((state) => {
    state.update.updaterActions.push({
      action: 'launchAckem',
      at: new Date().toISOString(),
      jobPath: handleWebUpdaterGetJobPath() || undefined,
    })
    state.update.updaterActions = state.update.updaterActions.slice(-50)
  })
  return { ok: false, reason: 'web_runtime_no_native_launcher' }
}

export function handleWebUpdaterOpenRelease(urlInput?: unknown): { ok: boolean; url?: string; error?: string } {
  const explicit = typeof urlInput === 'string' ? urlInput.trim() : ''
  const job = handleWebUpdaterReadJob()
  const url = explicit || releaseUrlFromJob(job)
  if (!url) return { ok: false, error: 'missing_release_url' }
  mutateSystemState((state) => {
    state.update.updaterActions.push({
      action: 'openRelease',
      at: new Date().toISOString(),
      jobPath: handleWebUpdaterGetJobPath() || undefined,
      url,
    })
    state.update.updaterActions = state.update.updaterActions.slice(-50)
    state.update.releaseOpenRequests.push({ url, at: new Date().toISOString() })
    state.update.releaseOpenRequests = state.update.releaseOpenRequests.slice(-50)
  })
  return { ok: true, url }
}

export function handleWebUpdaterQuit(): { ok: boolean; ignored: true } {
  mutateSystemState((state) => {
    state.update.updaterActions.push({ action: 'quit', at: new Date().toISOString() })
    state.update.updaterActions = state.update.updaterActions.slice(-50)
  })
  return { ok: true, ignored: true }
}

export function handleWebAppUninstallInfo(): {
  mode: 'dev' | 'portable' | 'installed'
  installDir: string
  dataRoot: string
  batPath: string | null
  nsisUninstaller: string | null
  webRuntime: true
} {
  return {
    mode: 'dev',
    installDir: process.cwd(),
    dataRoot: rootWithLayout(),
    batPath: null,
    nsisUninstaller: null,
    webRuntime: true,
  }
}

export function handleWebAppUninstall(opts?: unknown): {
  ok: boolean
  error: string
  requested: { deleteData: boolean; removeApp: boolean }
  dataRoot: string
} {
  const payload = opts && typeof opts === 'object' ? (opts as { deleteData?: unknown; removeApp?: unknown }) : {}
  const requested = {
    deleteData: payload.deleteData === true,
    removeApp: payload.removeApp === true,
  }
  const dataRoot = rootWithLayout()
  mutateSystemState((state) => {
    state.app.uninstallRequests.push({
      at: new Date().toISOString(),
      ...requested,
      blocked: true,
    })
    state.app.uninstallRequests = state.app.uninstallRequests.slice(-50)
  })
  return {
    ok: false,
    error: 'web_runtime_uninstall_disabled',
    requested,
    dataRoot,
  }
}

export const webSystemWorkflowHandlers: Readonly<Record<(typeof WEB_SYSTEM_WORKFLOW_CHANNELS)[number], WebInvokeHandler>> = {
  'desktop-agent:sessionMode:get': (sessionId) => handleWebDesktopSessionModeGet(sessionId),
  'desktop-agent:sessionMode:set': (args) => handleWebDesktopSessionModeSet(args),
  'desktop-agent:opening': () => handleWebDesktopOpening(),
  'desktop-agent:confirm:allow': (args) => recordConfirm(args, 'allowed'),
  'desktop-agent:confirm:allowSession': (args) => recordConfirm(args, 'allowed_session'),
  'desktop-agent:confirm:allowTaskDeletes': (args) => recordConfirm(args, 'allowed_task_deletes'),
  'desktop-agent:confirm:deny': (args) => recordConfirm(args, 'denied'),
  'desktop-agent:audit:recent': (limit) => handleWebDesktopAuditRecent(limit),
  'machine-map:status': () => handleWebMachineMapStatus(),
  'machine-map:reindex': () => handleWebMachineMapReindex(),
  'update:getAppVersion': () => handleWebUpdateGetAppVersion(),
  'update:check': () => handleWebUpdateCheck(),
  'update:start': (args) => handleWebUpdateStart(args),
  'update:openRelease': (url) => handleWebUpdateOpenRelease(url),
  'update:getChannelPreference': () => handleWebUpdateGetChannelPreference(),
  'update:setChannelPreference': (channel) => handleWebUpdateSetChannelPreference(channel),
  'updater:getJobPath': () => handleWebUpdaterGetJobPath(),
  'updater:readJob': (path) => handleWebUpdaterReadJob(path),
  'updater:start': () => handleWebUpdaterStart(),
  'updater:launchAckem': () => handleWebUpdaterLaunchAckem(),
  'updater:openRelease': (url) => handleWebUpdaterOpenRelease(url),
  'updater:quit': () => handleWebUpdaterQuit(),
  'app:uninstallInfo': () => handleWebAppUninstallInfo(),
  'app:uninstall': (opts) => handleWebAppUninstall(opts),
}

export function registerWebSystemWorkflowHandlers(registry: WebHandlerRegistry): void {
  for (const [channel, handler] of Object.entries(webSystemWorkflowHandlers)) {
    registry.set(channel, handler)
  }
}
