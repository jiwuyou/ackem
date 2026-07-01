import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  computePermissionState,
  type OpenForUPermissionId,
} from '../../../shared/openforuPermissions'
import { currentWebDataRoot } from '../runtime'
import type { WebEventSink, WebHandlerRegistry, WebInvokeHandler } from '../types'

type ExtensionStatus = 'installed' | 'active' | 'disabled' | 'error'
type OpenForUExtensionKind = 'uskill' | 'uplugin'

type DispatchConfig = {
  mode: string
  summary: string
  habits?: string[]
  scenarios?: string[]
  keywords?: string[]
}

type ExtensionManifest = {
  id: string
  name: string
  description: string
  version: string
  category?: string
  tags?: string[]
  dispatch?: DispatchConfig
  permissions?: string[]
}

type UpluginMeta = {
  grantedPermissions?: string[]
  surface?: {
    enabled?: boolean
    entry?: string
  }
}

type OpenForUExtensionRow = {
  kind: OpenForUExtensionKind
  manifest: {
    id: string
    name: string
    description: string
    version: string
    tags?: string[]
    dispatch?: DispatchConfig
  }
  status: ExtensionStatus
  runnable: boolean
  dirPath: string
  lastError?: string
  pendingPermissions?: string[]
  hasSurface?: boolean
}

type OpenForUWorkspace = {
  id: string
  name: string
  sessionId: string
  createdAt: string
  updatedAt: string
  userCreated?: boolean
}

type OpenForUWorkspaceIndex = {
  version: '1.0.0'
  activeWorkspaceId: string | null
  workspaces: OpenForUWorkspace[]
}

type PlanMsg = { role: 'user' | 'assistant'; content: string }

type WebPlanSession = {
  id: string
  createdAt: string
  updatedAt: string
  messages: PlanMsg[]
  dispatchDraft?: Record<string, unknown>
  planSummary?: Record<string, unknown> | null
  planConfirmed?: boolean
  planConfirmedAt?: string
  deployedUskillId?: string
  deployedAt?: string
  designSpec?: unknown
  linkedExtensionId?: string
  refineMode?: boolean
  composerPrefill?: string
}

type OpenForUWorkflowState = {
  version: 1
  statuses: Record<string, ExtensionStatus>
  deniedPermissionRequests: Record<string, string>
}

const MAX_OPENFORU_WORKSPACES = 6
const PLAN_WELCOME_MESSAGE =
  'Describe the capability you want to build. Ackem Web keeps this workspace locally; full OpenForU generation and deployment are not available in the Web service yet.'

function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return fallback
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf-8')
}

function dataRoot(): string {
  const root = currentWebDataRoot()
  mkdirSync(root, { recursive: true })
  return root
}

function openforuRoot(root = dataRoot()): string {
  const dir = join(root, 'openforu')
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'sessions'), { recursive: true })
  mkdirSync(join(dir, 'staging'), { recursive: true })
  mkdirSync(join(dir, 'uskills'), { recursive: true })
  mkdirSync(join(dir, 'uplugins'), { recursive: true })
  return dir
}

function runtimeDir(root = dataRoot()): string {
  const dir = join(root, '_derived', 'web-runtime')
  mkdirSync(dir, { recursive: true })
  return dir
}

function statePath(root = dataRoot()): string {
  return join(runtimeDir(root), 'openforu-workflow-state.json')
}

function workspaceIndexPath(root = dataRoot()): string {
  return join(openforuRoot(root), 'workspaces.json')
}

function sessionPath(sessionId: string, root = dataRoot()): string {
  return join(openforuRoot(root), 'sessions', `${sessionId}.json`)
}

function stagingPath(sessionId: string, root = dataRoot()): string {
  return join(openforuRoot(root), 'staging', `${sessionId}.md`)
}

function emptyState(): OpenForUWorkflowState {
  return { version: 1, statuses: {}, deniedPermissionRequests: {} }
}

function loadState(root = dataRoot()): OpenForUWorkflowState {
  const parsed = readJson<OpenForUWorkflowState>(statePath(root), emptyState())
  return {
    version: 1,
    statuses: parsed.statuses && typeof parsed.statuses === 'object' ? parsed.statuses : {},
    deniedPermissionRequests:
      parsed.deniedPermissionRequests && typeof parsed.deniedPermissionRequests === 'object'
        ? parsed.deniedPermissionRequests
        : {},
  }
}

function saveState(state: OpenForUWorkflowState, root = dataRoot()): void {
  writeJson(statePath(root), state)
}

function emptyIndex(): OpenForUWorkspaceIndex {
  return { version: '1.0.0', activeWorkspaceId: null, workspaces: [] }
}

function normalizeWorkspaceIndex(input: unknown): OpenForUWorkspaceIndex {
  const raw = input as Partial<OpenForUWorkspaceIndex> | null | undefined
  const workspaces = Array.isArray(raw?.workspaces)
    ? raw.workspaces.filter((w): w is OpenForUWorkspace => {
        return (
          Boolean(w) &&
          typeof w.id === 'string' &&
          typeof w.name === 'string' &&
          typeof w.sessionId === 'string'
        )
      })
    : []
  const activeWorkspaceId =
    typeof raw?.activeWorkspaceId === 'string' &&
    workspaces.some((w) => w.id === raw.activeWorkspaceId)
      ? raw.activeWorkspaceId
      : workspaces[0]?.id ?? null
  return { version: '1.0.0', activeWorkspaceId, workspaces }
}

function loadWorkspaceIndex(root = dataRoot()): OpenForUWorkspaceIndex {
  const path = workspaceIndexPath(root)
  if (!existsSync(path)) {
    const empty = emptyIndex()
    writeJson(path, empty)
    return empty
  }
  return normalizeWorkspaceIndex(readJson<unknown>(path, emptyIndex()))
}

function saveWorkspaceIndex(index: OpenForUWorkspaceIndex, root = dataRoot()): void {
  writeJson(workspaceIndexPath(root), normalizeWorkspaceIndex(index))
}

function nextWorkspaceName(workspaces: OpenForUWorkspace[]): string {
  const used = new Set(
    workspaces
      .map((workspace) => workspace.name.match(/^Workspace\s+(\d+)$/)?.[1])
      .filter((value): value is string => Boolean(value))
      .map((value) => Number(value))
  )
  let n = 1
  while (used.has(n)) n++
  return `Workspace ${n}`
}

function createEmptySession(sessionId: string): WebPlanSession {
  const now = new Date().toISOString()
  return {
    id: sessionId,
    createdAt: now,
    updatedAt: now,
    messages: [{ role: 'assistant', content: PLAN_WELCOME_MESSAGE }],
    planSummary: null,
    planConfirmed: false,
  }
}

function normalizeSession(input: unknown, sessionId: string): WebPlanSession {
  const fallback = createEmptySession(sessionId)
  const raw = input as Partial<WebPlanSession> | null | undefined
  const messages = Array.isArray(raw?.messages)
    ? raw.messages.filter((msg): msg is PlanMsg => {
        return (
          Boolean(msg) &&
          (msg.role === 'user' || msg.role === 'assistant') &&
          typeof msg.content === 'string'
        )
      })
    : fallback.messages
  return {
    ...fallback,
    ...raw,
    id: typeof raw?.id === 'string' && raw.id ? raw.id : sessionId,
    messages,
    createdAt: typeof raw?.createdAt === 'string' ? raw.createdAt : fallback.createdAt,
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : fallback.updatedAt,
  }
}

function loadSession(sessionId: string, root = dataRoot()): WebPlanSession {
  const path = sessionPath(sessionId, root)
  if (!existsSync(path)) {
    const session = createEmptySession(sessionId)
    writeJson(path, session)
    return session
  }
  return normalizeSession(readJson<unknown>(path, null), sessionId)
}

function saveSession(session: WebPlanSession, root = dataRoot()): void {
  writeJson(sessionPath(session.id, root), { ...session, updatedAt: new Date().toISOString() })
}

function deleteSessionArtifacts(sessionId: string, root = dataRoot()): void {
  for (const file of [sessionPath(sessionId, root), stagingPath(sessionId, root)]) {
    if (existsSync(file)) rmSync(file, { force: true })
  }
}

function listWorkspacesOnly(root = dataRoot()): {
  workspaces: OpenForUWorkspace[]
  activeWorkspaceId: string | null
  max: number
} {
  const index = loadWorkspaceIndex(root)
  return {
    workspaces: [...index.workspaces].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    activeWorkspaceId: index.activeWorkspaceId,
    max: MAX_OPENFORU_WORKSPACES,
  }
}

function findWorkspaceBySession(sessionId: string, root = dataRoot()): OpenForUWorkspace | null {
  return loadWorkspaceIndex(root).workspaces.find((workspace) => workspace.sessionId === sessionId) ?? null
}

function touchWorkspace(sessionId: string, root = dataRoot()): void {
  const index = loadWorkspaceIndex(root)
  const workspace = index.workspaces.find((row) => row.sessionId === sessionId)
  if (!workspace) return
  workspace.updatedAt = new Date().toISOString()
  saveWorkspaceIndex(index, root)
}

function sessionMeta(session: WebPlanSession): Record<string, unknown> {
  return {
    dispatchDraft: session.dispatchDraft,
    planSummary: session.planSummary ?? null,
    planConfirmed: Boolean(session.planConfirmed),
    planConfirmedAt: session.planConfirmedAt,
    deployedUskillId: session.deployedUskillId,
    deployedAt: session.deployedAt,
    designSpec: session.designSpec ?? null,
    linkedExtensionId: session.linkedExtensionId,
    refineMode: session.refineMode,
  }
}

function createWorkspace(name?: string, root = dataRoot()): {
  workspace: OpenForUWorkspace
  evicted: OpenForUWorkspace | null
} {
  const index = loadWorkspaceIndex(root)
  let evicted: OpenForUWorkspace | null = null
  if (index.workspaces.length >= MAX_OPENFORU_WORKSPACES) {
    const oldest = [...index.workspaces].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0]
    if (oldest) {
      evicted = oldest
      index.workspaces = index.workspaces.filter((workspace) => workspace.id !== oldest.id)
      deleteSessionArtifacts(oldest.sessionId, root)
    }
  }
  const now = new Date().toISOString()
  const sessionId = randomUUID()
  const workspace: OpenForUWorkspace = {
    id: randomUUID(),
    name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : nextWorkspaceName(index.workspaces),
    sessionId,
    createdAt: now,
    updatedAt: now,
    userCreated: true,
  }
  index.workspaces.unshift(workspace)
  index.activeWorkspaceId = workspace.id
  saveWorkspaceIndex(index, root)
  saveSession(createEmptySession(sessionId), root)
  return { workspace, evicted }
}

function openWorkspaceResult(workspace: OpenForUWorkspace, root = dataRoot()): Record<string, unknown> {
  const session = loadSession(workspace.sessionId, root)
  const listed = listWorkspacesOnly(root)
  return {
    sessionId: session.id,
    messages: session.messages,
    workspace,
    ...sessionMeta(session),
    ...listed,
  }
}

function openActiveWorkspace(root = dataRoot()): Record<string, unknown> {
  const index = loadWorkspaceIndex(root)
  const active = index.workspaces.find((workspace) => workspace.id === index.activeWorkspaceId)
  if (active) return openWorkspaceResult(active, root)
  const created = createWorkspace(undefined, root)
  return openWorkspaceResult(created.workspace, root)
}

function switchWorkspace(workspaceId: unknown, root = dataRoot()): Record<string, unknown> {
  if (typeof workspaceId !== 'string' || !workspaceId.trim()) {
    return { ok: false, error: 'Missing workspaceId', sessionId: '', messages: [], workspace: null }
  }
  const index = loadWorkspaceIndex(root)
  const workspace = index.workspaces.find((row) => row.id === workspaceId)
  if (!workspace) {
    return { ok: false, error: 'Workspace not found', sessionId: '', messages: [], workspace: null }
  }
  index.activeWorkspaceId = workspace.id
  workspace.updatedAt = new Date().toISOString()
  saveWorkspaceIndex(index, root)
  return { ok: true, ...openWorkspaceResult(workspace, root) }
}

function readManifest(path: string): ExtensionManifest | null {
  const manifest = readJson<ExtensionManifest | null>(path, null)
  if (!manifest || typeof manifest.id !== 'string' || !manifest.id.trim()) return null
  if (typeof manifest.name !== 'string') manifest.name = manifest.id
  if (typeof manifest.description !== 'string') manifest.description = ''
  if (typeof manifest.version !== 'string') manifest.version = '1.0.0'
  return manifest
}

function extensionDir(kind: OpenForUExtensionKind, root = dataRoot()): string {
  return join(openforuRoot(root), kind === 'uskill' ? 'uskills' : 'uplugins')
}

function listExtensionDirs(kind: OpenForUExtensionKind, root = dataRoot()): string[] {
  const dir = extensionDir(kind, root)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_'))
    .map((entry) => join(dir, entry.name))
}

function readUpluginMeta(dirPath: string): UpluginMeta {
  return readJson<UpluginMeta>(join(dirPath, 'plugin.meta.json'), {})
}

function toRow(
  kind: OpenForUExtensionKind,
  manifest: ExtensionManifest,
  dirPath: string,
  state: OpenForUWorkflowState
): OpenForUExtensionRow {
  const status = state.statuses[manifest.id] ?? 'installed'
  const meta = kind === 'uplugin' ? readUpluginMeta(dirPath) : undefined
  const permissionState =
    kind === 'uplugin' ? computePermissionState(manifest.permissions, meta?.grantedPermissions) : undefined
  const pendingPermissions = permissionState?.pending
  const forbiddenPermissions = permissionState?.forbidden
  const lastError = forbiddenPermissions?.length
    ? `Forbidden Web permissions: ${forbiddenPermissions.join(', ')}`
    : undefined
  return {
    kind,
    manifest: {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      tags: manifest.tags,
      dispatch: manifest.dispatch,
    },
    status: lastError ? 'error' : status,
    runnable: kind === 'uskill' || ((pendingPermissions?.length ?? 0) === 0 && !lastError),
    dirPath,
    lastError,
    pendingPermissions: pendingPermissions?.length ? pendingPermissions : undefined,
    hasSurface:
      kind === 'uplugin' &&
      (Boolean(meta?.surface?.enabled) || existsSync(join(dirPath, 'surface.html'))),
  }
}

export function listWebOpenForUExtensions(root = dataRoot()): {
  uskills: OpenForUExtensionRow[]
  uplugins: OpenForUExtensionRow[]
} {
  const state = loadState(root)
  const scan = (kind: OpenForUExtensionKind): OpenForUExtensionRow[] => {
    return listExtensionDirs(kind, root)
      .map((dirPath) => {
        const manifest = readManifest(join(dirPath, 'manifest.json'))
        if (!manifest || !manifest.id.startsWith('u/')) return null
        return toRow(kind, manifest, dirPath, state)
      })
      .filter((row): row is OpenForUExtensionRow => row != null)
      .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name, 'zh'))
  }
  return { uskills: scan('uskill'), uplugins: scan('uplugin') }
}

function findOpenForUExtension(kind: OpenForUExtensionKind, id: string, root = dataRoot()): OpenForUExtensionRow | null {
  const list = listWebOpenForUExtensions(root)
  const rows = kind === 'uskill' ? list.uskills : list.uplugins
  return rows.find((row) => row.manifest.id === id) ?? null
}

export function activateWebOpenForUExtension(kind: OpenForUExtensionKind, id: string): { ok: boolean; error?: string } {
  const root = dataRoot()
  const row = findOpenForUExtension(kind, id, root)
  if (!row) return { ok: false, error: `OpenForU ${kind} not found: ${id}` }
  if (row.lastError) return { ok: false, error: row.lastError }
  if ((row.pendingPermissions?.length ?? 0) > 0) {
    return { ok: false, error: `Permission approval required: ${row.pendingPermissions!.join(', ')}` }
  }
  const state = loadState(root)
  state.statuses[id] = 'active'
  saveState(state, root)
  return { ok: true }
}

export function deactivateWebOpenForUExtension(kind: OpenForUExtensionKind, id: string): { ok: boolean; error?: string } {
  const root = dataRoot()
  if (!findOpenForUExtension(kind, id, root)) {
    return { ok: false, error: `OpenForU ${kind} not found: ${id}` }
  }
  const state = loadState(root)
  state.statuses[id] = 'disabled'
  saveState(state, root)
  return { ok: true }
}

function removeOpenForUExtension(payload: unknown): { ok: boolean; error?: string } {
  const args = payload as { kind?: unknown; id?: unknown } | null | undefined
  if ((args?.kind !== 'uskill' && args?.kind !== 'uplugin') || typeof args.id !== 'string') {
    return { ok: false, error: 'Expected { kind, id }' }
  }
  const root = dataRoot()
  const row = findOpenForUExtension(args.kind, args.id, root)
  if (!row) return { ok: false, error: `OpenForU ${args.kind} not found: ${args.id}` }
  rmSync(row.dirPath, { recursive: true, force: true })
  const state = loadState(root)
  delete state.statuses[args.id]
  saveState(state, root)
  return { ok: true }
}

function handleWorkspaceList(): Record<string, unknown> {
  return { ok: true, ...listWorkspacesOnly() }
}

function handleWorkspaceOpen(): Record<string, unknown> {
  return { ok: true, ...openActiveWorkspace() }
}

function handleWorkspaceCreate(args?: unknown): Record<string, unknown> {
  const root = dataRoot()
  const name = typeof (args as { name?: unknown } | null | undefined)?.name === 'string'
    ? String((args as { name: string }).name)
    : undefined
  const created = createWorkspace(name, root)
  return {
    ok: true,
    evicted: created.evicted,
    ...openWorkspaceResult(created.workspace, root),
  }
}

function handleWorkspaceDelete(workspaceId: unknown): Record<string, unknown> {
  if (typeof workspaceId !== 'string' || !workspaceId.trim()) {
    return { ok: false, error: 'Missing workspaceId', activeWorkspaceId: null, workspaces: [], max: MAX_OPENFORU_WORKSPACES }
  }
  const root = dataRoot()
  const index = loadWorkspaceIndex(root)
  const workspace = index.workspaces.find((row) => row.id === workspaceId)
  if (!workspace) {
    return { ok: false, error: 'Workspace not found', activeWorkspaceId: null, workspaces: [], max: MAX_OPENFORU_WORKSPACES }
  }
  index.workspaces = index.workspaces.filter((row) => row.id !== workspaceId)
  if (index.activeWorkspaceId === workspaceId) {
    index.activeWorkspaceId = index.workspaces[0]?.id ?? null
  }
  deleteSessionArtifacts(workspace.sessionId, root)
  saveWorkspaceIndex(index, root)
  return { ok: true, deleted: workspace, ...listWorkspacesOnly(root) }
}

function handlePlanStart(): Record<string, unknown> {
  const opened = openActiveWorkspace()
  return {
    ok: true,
    sessionId: opened.sessionId,
    messages: opened.messages,
  }
}

function handlePlanSend(args: unknown): Record<string, unknown> {
  const root = dataRoot()
  const payload = args as { sessionId?: unknown; text?: unknown } | null | undefined
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
  const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
  if (!sessionId || !text) return { ok: false, error: 'Missing sessionId or text', messages: [] }
  const session = loadSession(sessionId, root)
  session.messages = [
    ...session.messages,
    { role: 'user', content: text },
    {
      role: 'assistant',
      content:
        'Saved locally. Ackem Web has not enabled OpenForU agent generation or deployment yet, so this workspace is a planning note for now.',
    },
  ]
  session.updatedAt = new Date().toISOString()
  session.planSummary = {
    artifactType: 'pending',
    trigger: 'web-local-note',
    output: text.slice(0, 160),
    permissions: '',
    extras: 'OpenForU Web generation is not ready.',
    rawLines: [text],
  }
  saveSession(session, root)
  touchWorkspace(sessionId, root)
  return {
    ok: true,
    messages: session.messages,
    workspaces: listWorkspacesOnly(root).workspaces,
    ...sessionMeta(session),
  }
}

function notReady(sessionId: unknown, action: string): Record<string, unknown> {
  const root = dataRoot()
  const id = typeof sessionId === 'string' ? sessionId : ''
  const session = id ? loadSession(id, root) : null
  return {
    ok: false,
    error: `${action} is not available in Ackem Web yet. The local Web service only stores workspace state.`,
    messages: session?.messages,
    ...(session ? sessionMeta(session) : {}),
  }
}

function handlePlanStatus(sessionId: unknown): Record<string, unknown> {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return { ok: false, messages: [] }
  const root = dataRoot()
  const session = loadSession(sessionId, root)
  return { ok: true, messages: session.messages, ...sessionMeta(session) }
}

function handlePlanRefineOpen(args: unknown): Record<string, unknown> {
  const root = dataRoot()
  const payload = args as { extensionId?: unknown; instruction?: unknown; displayName?: unknown } | null | undefined
  const extensionId = typeof payload?.extensionId === 'string' ? payload.extensionId.trim() : ''
  if (!extensionId) return { ok: false, error: 'Missing extensionId', sessionId: '', messages: [], workspace: null }

  const row =
    findOpenForUExtension('uskill', extensionId, root) ??
    findOpenForUExtension('uplugin', extensionId, root)
  const displayName =
    typeof payload?.displayName === 'string' && payload.displayName.trim()
      ? payload.displayName.trim()
      : row?.manifest.name ?? extensionId
  const created = createWorkspace(`Refine ${displayName}`.slice(0, 80), root)
  const session = loadSession(created.workspace.sessionId, root)
  const instruction =
    typeof payload?.instruction === 'string' && payload.instruction.trim()
      ? payload.instruction.trim()
      : `Refine ${displayName}`
  session.linkedExtensionId = extensionId
  session.refineMode = true
  session.composerPrefill = instruction
  session.messages = [
    ...session.messages,
    {
      role: 'assistant',
      content:
        'This Web workspace is ready for refine notes. Applying refinements still requires the full OpenForU agent/deploy backend.',
    },
  ]
  saveSession(session, root)
  return {
    ok: true,
    composerPrefill: instruction,
    ...openWorkspaceResult(created.workspace, root),
  }
}

function handleListArtifacts(): { paths: string[] } {
  const rows = listWebOpenForUExtensions()
  return { paths: [...rows.uskills, ...rows.uplugins].map((row) => row.dirPath) }
}

function readTextIfExists(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined
    return readFileSync(path, 'utf-8')
  } catch {
    return undefined
  }
}

function handleReadArtifact(extensionId: unknown): Record<string, unknown> {
  if (typeof extensionId !== 'string' || !extensionId.trim()) return { ok: false, error: 'Missing extensionId' }
  const root = dataRoot()
  const uskill = findOpenForUExtension('uskill', extensionId, root)
  if (uskill) {
    const files: Record<string, string> = {}
    const manifest = readTextIfExists(join(uskill.dirPath, 'manifest.json'))
    const skill = readTextIfExists(join(uskill.dirPath, 'skill.json'))
    if (manifest) files['manifest.json'] = manifest
    if (skill) files['skill.json'] = skill
    return {
      ok: true,
      extensionId,
      artifactKind: 'uskill',
      uskillId: extensionId,
      dirRel: `openforu/uskills/${basename(uskill.dirPath)}`,
      files,
      source: 'deployed',
    }
  }
  const uplugin = findOpenForUExtension('uplugin', extensionId, root)
  if (uplugin) {
    const files: Record<string, string> = {}
    const manifest = readTextIfExists(join(uplugin.dirPath, 'manifest.json'))
    const meta = readTextIfExists(join(uplugin.dirPath, 'plugin.meta.json'))
    if (manifest) files['manifest.json'] = manifest
    if (meta) files['plugin.meta.json'] = meta
    return {
      ok: true,
      extensionId,
      artifactKind: 'uplugin',
      dirRel: `openforu/uplugins/${basename(uplugin.dirPath)}`,
      files,
      source: 'deployed',
    }
  }
  return { ok: false, error: 'Deployed OpenForU extension not found' }
}

function handlePreviewArtifact(sessionId: unknown): Record<string, unknown> {
  return {
    ...notReady(sessionId, 'OpenForU artifact preview'),
    source: 'preview',
  }
}

function handleApproveAndActivate(args: unknown): { ok: boolean; error?: string } {
  const payload = args as { pluginId?: unknown } | null | undefined
  const pluginId = typeof payload?.pluginId === 'string' ? payload.pluginId : ''
  if (!pluginId) return { ok: false, error: 'Missing pluginId' }
  const root = dataRoot()
  const row = findOpenForUExtension('uplugin', pluginId, root)
  if (!row) return { ok: false, error: `OpenForU uplugin not found: ${pluginId}` }
  const manifest = readManifest(join(row.dirPath, 'manifest.json'))
  if (!manifest) return { ok: false, error: 'Invalid plugin manifest' }
  const meta = readUpluginMeta(row.dirPath)
  const permissionState = computePermissionState(manifest.permissions, meta.grantedPermissions)
  if (permissionState.forbidden.length) {
    return { ok: false, error: `Forbidden Web permissions: ${permissionState.forbidden.join(', ')}` }
  }
  const granted = Array.from(
    new Set<OpenForUPermissionId>([
      ...(meta.grantedPermissions as OpenForUPermissionId[] | undefined ?? []),
      ...permissionState.granted,
      ...permissionState.pending,
    ])
  )
  writeJson(join(row.dirPath, 'plugin.meta.json'), { ...meta, grantedPermissions: granted })
  return activateWebOpenForUExtension('uplugin', pluginId)
}

function handlePermissionDecision(args: unknown, decision: 'approved' | 'denied'): { ok: boolean } {
  const payload = args as { requestId?: unknown } | null | undefined
  const requestId = typeof payload?.requestId === 'string' ? payload.requestId : ''
  if (!requestId) return { ok: false }
  if (decision === 'denied') {
    const root = dataRoot()
    const state = loadState(root)
    state.deniedPermissionRequests[requestId] = new Date().toISOString()
    saveState(state, root)
  }
  return { ok: true }
}

function handleAgentStatus(sessionId: unknown): Record<string, unknown> {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return { ok: false, error: 'Missing sessionId' }
  return { ok: true, run: null }
}

function handleAgentCancel(sessionId: unknown): Record<string, unknown> {
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    return { ok: false, error: 'Missing sessionId' }
  }
  const root = dataRoot()
  const session = loadSession(sessionId, root)
  return {
    ok: true,
    cancelled: false,
    agentRun: null,
    messages: session.messages,
    workspaces: listWorkspacesOnly(root).workspaces,
    ...sessionMeta(session),
  }
}

function handleRefinePreview(args: unknown): Record<string, unknown> {
  const payload = args as { extensionId?: unknown; instruction?: unknown } | null | undefined
  if (typeof payload?.extensionId !== 'string' || typeof payload?.instruction !== 'string') {
    return { ok: false, error: 'Missing extensionId or instruction' }
  }
  return {
    ok: false,
    error: 'OpenForU refine preview is not available in Ackem Web yet.',
    preview: {
      ok: false,
      extensionId: payload.extensionId,
      error: 'Web refine preview requires the full OpenForU agent backend.',
    },
  }
}

function handleRefineHistory(extensionId: unknown): Record<string, unknown> {
  if (typeof extensionId !== 'string' || !extensionId.trim()) {
    return { ok: false, error: 'Missing extensionId', entries: [] }
  }
  return { ok: true, entries: [] }
}

function handleRefineRollback(args: unknown): Record<string, unknown> {
  const payload = args as { extensionId?: unknown; targetVersion?: unknown } | null | undefined
  if (typeof payload?.extensionId !== 'string' || typeof payload?.targetVersion !== 'string') {
    return { ok: false, error: 'Missing extensionId or targetVersion' }
  }
  return { ok: false, error: 'OpenForU rollback is not available in Ackem Web yet.' }
}

const openForUHandlers: Array<[string, WebInvokeHandler]> = [
  ['openforu:workspaces:list', () => handleWorkspaceList()],
  ['openforu:workspaces:open', () => handleWorkspaceOpen()],
  ['openforu:workspaces:create', (args) => handleWorkspaceCreate(args)],
  ['openforu:workspaces:switch', (workspaceId) => switchWorkspace(workspaceId)],
  ['openforu:workspaces:delete', (workspaceId) => handleWorkspaceDelete(workspaceId)],
  ['openforu:plan:start', () => handlePlanStart()],
  ['openforu:plan:send', (args) => handlePlanSend(args)],
  ['openforu:plan:confirm', (sessionId) => notReady(sessionId, 'OpenForU plan confirmation')],
  ['openforu:plan:approveWireframe', (sessionId) => notReady(sessionId, 'OpenForU wireframe approval')],
  ['openforu:plan:deploy', (sessionId) => notReady(sessionId, 'OpenForU deployment')],
  ['openforu:plan:redeploy', (args) => notReady((args as { sessionId?: unknown } | undefined)?.sessionId, 'OpenForU redeployment')],
  ['openforu:plan:status', (sessionId) => handlePlanStatus(sessionId)],
  ['openforu:plan:refineOpen', (args) => handlePlanRefineOpen(args)],
  ['openforu:listArtifacts', () => handleListArtifacts()],
  ['openforu:artifact:preview', (sessionId) => handlePreviewArtifact(sessionId)],
  ['openforu:artifact:read', (extensionId) => handleReadArtifact(extensionId)],
  ['openforu:extensions:list', () => listWebOpenForUExtensions()],
  ['openforu:extensions:remove', (payload) => removeOpenForUExtension(payload)],
  ['openforu:permissions:approve', (args) => handlePermissionDecision(args, 'approved')],
  ['openforu:permissions:deny', (args) => handlePermissionDecision(args, 'denied')],
  ['openforu:permissions:approveAndActivate', (args) => handleApproveAndActivate(args)],
  ['openforu:agent:status', (sessionId) => handleAgentStatus(sessionId)],
  ['openforu:agent:cancel', (sessionId) => handleAgentCancel(sessionId)],
  ['openforu:refine:preview', (args) => handleRefinePreview(args)],
  ['openforu:refine:apply', (args) => handleRefinePreview(args)],
  ['openforu:refine:history', (extensionId) => handleRefineHistory(extensionId)],
  ['openforu:refine:rollback', (args) => handleRefineRollback(args)],
]

export function registerWebOpenForUWorkflowHandlers(
  registry: WebHandlerRegistry,
  eventSink?: WebEventSink
): void {
  for (const [channel, handler] of openForUHandlers) registry.set(channel, handler)
  registry.set('openforu:notifyMain', (text) => {
    const payload = { text: String(text ?? '') }
    eventSink?.send('openforu:notify', payload)
    return { ok: true }
  })
}
