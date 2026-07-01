import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CompanionSkinBinding, CompanionSkinManifest } from '../../../shared/companionSkin'
import { currentWebDataRoot, loadWebSettings, saveWebSettings } from '../runtime'
import type { WebHandlerRegistry, WebInvokeHandler } from '../types'
import {
  activateWebOpenForUExtension,
  deactivateWebOpenForUExtension,
  listWebOpenForUExtensions,
} from './openforuWorkflowService'

type ExtensionStatus = 'planned' | 'deprecated' | 'installed' | 'active' | 'disabled' | 'error'

type DispatchConfig = {
  mode: string
  summary: string
  habits?: string[]
  scenarios?: string[]
  keywords?: string[]
}

type WebExtensionManifest = {
  id: string
  name: string
  description: string
  version: string
  category?: string
  pluginType?: string
  skillType?: string
  tags?: string[]
  implementationStatus?: 'complete' | 'stub' | 'preview' | 'planned' | 'deprecated'
  dispatch?: DispatchConfig
  companionSkin?: CompanionSkinManifest
}

type ExtensionRow = {
  manifest: WebExtensionManifest
  status: ExtensionStatus
  installedAt: string
  lastActiveAt?: string
  lastError?: string
  executionCount?: number
  runnable: boolean
}

type ExtensionWorkflowState = {
  version: 1
  activePlugins: Record<string, string>
  disabledPlugins: Record<string, string>
  activeSkills: Record<string, string>
  disabledSkills: Record<string, string>
}

const WEB_WINDOW_ONLY_PLUGIN_IDS = [
  'desktop-float',
  'live2d-desktop',
  'screen-effects',
]

const DEFAULT_COMPANION_SKIN: CompanionSkinBinding = {
  pluginId: '',
  pluginName: '默认几何形象',
  renderer: 'builtin-canvas',
  entry: '',
}

const LIVE2D_DESKTOP_PLUGIN_ID = 'ackem/live2d-desktop@0.0.1'

function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return fallback
  }
}

function runtimeDir(): string {
  const root = currentWebDataRoot()
  const dir = join(root, '_derived', 'web-runtime')
  mkdirSync(dir, { recursive: true })
  return dir
}

function statePath(): string {
  return join(runtimeDir(), 'extension-workflow-state.json')
}

function emptyState(): ExtensionWorkflowState {
  return {
    version: 1,
    activePlugins: {},
    disabledPlugins: {},
    activeSkills: {},
    disabledSkills: {},
  }
}

function loadState(): ExtensionWorkflowState {
  const parsed = readJson<ExtensionWorkflowState>(statePath(), emptyState())
  return {
    version: 1,
    activePlugins: parsed.activePlugins && typeof parsed.activePlugins === 'object' ? parsed.activePlugins : {},
    disabledPlugins: parsed.disabledPlugins && typeof parsed.disabledPlugins === 'object' ? parsed.disabledPlugins : {},
    activeSkills: parsed.activeSkills && typeof parsed.activeSkills === 'object' ? parsed.activeSkills : {},
    disabledSkills: parsed.disabledSkills && typeof parsed.disabledSkills === 'object' ? parsed.disabledSkills : {},
  }
}

function saveState(state: ExtensionWorkflowState): void {
  writeFileSync(statePath(), JSON.stringify(state, null, 2), 'utf-8')
}

function findExistingDir(relativePath: string): string | null {
  const candidates = [
    join(process.cwd(), relativePath),
    join(process.cwd(), '..', relativePath),
    join(process.cwd(), '..', '..', relativePath),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        if (statSync(candidate).isDirectory()) return candidate
      } catch {
        /* ignore */
      }
    }
  }
  return null
}

function collectManifestFiles(root: string, out: string[] = []): string[] {
  if (!existsSync(root)) return out
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      collectManifestFiles(full, out)
    } else if (entry.isFile() && entry.name === 'manifest.json') {
      out.push(full)
    }
  }
  return out
}

function normalizeManifest(input: unknown): WebExtensionManifest | null {
  const raw = input as Partial<WebExtensionManifest> | null | undefined
  if (!raw || typeof raw.id !== 'string' || !raw.id.trim()) return null
  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : raw.id,
    description: typeof raw.description === 'string' ? raw.description : '',
    version: typeof raw.version === 'string' && raw.version.trim() ? raw.version : '1.0.0',
    category: typeof raw.category === 'string' ? raw.category : undefined,
    pluginType: typeof raw.pluginType === 'string' ? raw.pluginType : undefined,
    skillType: typeof raw.skillType === 'string' ? raw.skillType : undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
    implementationStatus: raw.implementationStatus,
    dispatch: raw.dispatch,
    companionSkin:
      raw.companionSkin && typeof raw.companionSkin === 'object'
        ? (raw.companionSkin as CompanionSkinManifest)
        : undefined,
  }
}

function readManifest(path: string): WebExtensionManifest | null {
  return normalizeManifest(readJson<unknown>(path, null))
}

function implementationStatus(manifest: WebExtensionManifest): WebExtensionManifest['implementationStatus'] {
  if (manifest.implementationStatus) return manifest.implementationStatus
  if (manifest.tags?.includes('planned')) return 'planned'
  if (manifest.tags?.includes('deprecated')) return 'deprecated'
  return undefined
}

function isWebWindowOnlyPlugin(manifest: WebExtensionManifest): boolean {
  return WEB_WINDOW_ONLY_PLUGIN_IDS.some((fragment) => manifest.id.includes(fragment))
}

function statusFromState(
  id: string,
  active: Record<string, string>,
  disabled: Record<string, string>,
  fallback: ExtensionStatus
): ExtensionStatus {
  if (active[id]) return 'active'
  if (disabled[id]) return 'disabled'
  return fallback
}

function builtinRow(
  manifest: WebExtensionManifest,
  state: ExtensionWorkflowState,
  kind: 'plugin' | 'skill'
): ExtensionRow {
  const impl = implementationStatus(manifest)
  const runnable = impl !== 'planned' && impl !== 'deprecated'
  const activeMap = kind === 'plugin' ? state.activePlugins : state.activeSkills
  const disabledMap = kind === 'plugin' ? state.disabledPlugins : state.disabledSkills
  const fallback: ExtensionStatus =
    impl === 'planned' || impl === 'deprecated' ? impl : manifest.tags?.includes('builtin') ? 'installed' : 'installed'
  return {
    manifest: {
      ...manifest,
      implementationStatus: impl,
    },
    status: statusFromState(manifest.id, activeMap, disabledMap, fallback),
    installedAt: 'web-runtime',
    runnable,
    lastError:
      kind === 'plugin' && isWebWindowOnlyPlugin(manifest)
        ? 'This extension controls an Electron desktop window surface; Ackem Web can keep activation state but cannot open the surface.'
        : undefined,
  }
}

function listBuiltinManifests(kind: 'plugin' | 'skill'): WebExtensionManifest[] {
  const rel =
    kind === 'plugin'
      ? join('src', 'main', 'extensions', 'plugins', 'builtin')
      : join('src', 'main', 'extensions', 'skills', 'builtin')
  const root = findExistingDir(rel)
  if (!root) return []
  const expectedCategory = kind === 'plugin' ? 'plugin' : 'skill'
  const byId = new Map<string, WebExtensionManifest>()
  for (const path of collectManifestFiles(root)) {
    const manifest = readManifest(path)
    if (!manifest || manifest.category !== expectedCategory) continue
    if (!manifest.tags?.includes('builtin')) {
      manifest.tags = [...(manifest.tags ?? []), 'builtin']
    }
    byId.set(manifest.id, manifest)
  }
  return [...byId.values()]
}

function listPluginRows(type?: unknown): ExtensionRow[] {
  const state = loadState()
  const requestedType = typeof type === 'string' && type.trim() ? type.trim() : null
  const builtin = listBuiltinManifests('plugin')
    .filter((manifest) => !requestedType || manifest.pluginType === requestedType)
    .map((manifest) => builtinRow(manifest, state, 'plugin'))
  const user = listWebOpenForUExtensions().uplugins.map((row) => ({
    manifest: {
      ...row.manifest,
      category: 'plugin',
      pluginType: 'behavior',
    },
    status: row.status,
    installedAt: 'web-openforu',
    lastError: row.lastError,
    runnable: row.runnable,
  }))
  return [...builtin, ...user].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name, 'zh'))
}

function listSkillRows(): ExtensionRow[] {
  const state = loadState()
  const builtin = listBuiltinManifests('skill').map((manifest) => builtinRow(manifest, state, 'skill'))
  const user = listWebOpenForUExtensions().uskills.map((row) => ({
    manifest: {
      ...row.manifest,
      category: 'skill',
      skillType: 'rule',
    },
    status: row.status,
    installedAt: 'web-openforu',
    lastError: row.lastError,
    executionCount: 0,
    runnable: row.runnable,
  }))
  return [...builtin, ...user].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name, 'zh'))
}

function knownPlugin(id: string): ExtensionRow | null {
  return listPluginRows().find((row) => row.manifest.id === id) ?? null
}

function knownSkill(id: string): ExtensionRow | null {
  return listSkillRows().find((row) => row.manifest.id === id) ?? null
}

function setBuiltinStatus(kind: 'plugin' | 'skill', id: string, active: boolean): { ok: boolean; error?: string } {
  const row = kind === 'plugin' ? knownPlugin(id) : knownSkill(id)
  if (!row) return { ok: false, error: `${kind} not found: ${id}` }
  if (row.manifest.id.startsWith('u/')) {
    return active
      ? activateWebOpenForUExtension(kind === 'plugin' ? 'uplugin' : 'uskill', id)
      : deactivateWebOpenForUExtension(kind === 'plugin' ? 'uplugin' : 'uskill', id)
  }
  if (!row.runnable) return { ok: false, error: `${kind} is not runnable in Ackem Web: ${id}` }
  const now = new Date().toISOString()
  const state = loadState()
  const activeMap = kind === 'plugin' ? state.activePlugins : state.activeSkills
  const disabledMap = kind === 'plugin' ? state.disabledPlugins : state.disabledSkills
  if (active) {
    activeMap[id] = now
    delete disabledMap[id]
  } else {
    disabledMap[id] = now
    delete activeMap[id]
  }
  saveState(state)
  return { ok: true }
}

function formatMediaSession(info: { title: string; artist: string }): string {
  if (!info.title && !info.artist) return ''
  return [info.artist, info.title].filter(Boolean).join(' - ')
}

function handleWebMediaStatus(): {
  title: string
  artist: string
  album: string
  isPlaying: boolean
  formatted: string
} {
  const title = process.env.ACKEM_MEDIA_TITLE ?? ''
  const artist = process.env.ACKEM_MEDIA_ARTIST ?? ''
  const album = process.env.ACKEM_MEDIA_ALBUM ?? ''
  const isPlaying = process.env.ACKEM_MEDIA_PLAYING === '1'
  return {
    title,
    artist,
    album,
    isPlaying,
    formatted: formatMediaSession({ title, artist }),
  }
}

function companionSkinBindingForManifest(manifest: WebExtensionManifest): CompanionSkinBinding | null {
  const skin =
    manifest.companionSkin ??
    (manifest.id === LIVE2D_DESKTOP_PLUGIN_ID
      ? ({ renderer: 'react-builtin', entry: LIVE2D_DESKTOP_PLUGIN_ID } satisfies CompanionSkinManifest)
      : undefined)
  if (!skin?.renderer || !skin.entry) return null
  if (skin.renderer === 'html') {
    return {
      pluginId: manifest.id,
      pluginName: manifest.name,
      renderer: 'builtin-canvas',
      entry: '',
      statusLabels: skin.statusLabels,
      implementationStatus: 'stub',
    }
  }
  return {
    pluginId: manifest.id,
    pluginName: manifest.name,
    renderer: skin.renderer,
    entry: skin.entry,
    statusLabels: skin.statusLabels,
    implementationStatus:
      manifest.implementationStatus === 'complete' ||
      manifest.implementationStatus === 'stub' ||
      manifest.implementationStatus === 'preview'
        ? manifest.implementationStatus
        : undefined,
  }
}

function listWebCompanionSkins(): CompanionSkinBinding[] {
  const skins = [DEFAULT_COMPANION_SKIN]
  for (const row of listPluginRows('skin')) {
    const binding = companionSkinBindingForManifest(row.manifest)
    if (binding) skins.push(binding)
  }
  return skins
}

function handleWebCompanionSkinActive(): CompanionSkinBinding {
  const activeId = loadWebSettings().activeCompanionSkinPluginId
  if (!activeId) return DEFAULT_COMPANION_SKIN
  return listWebCompanionSkins().find((skin) => skin.pluginId === activeId) ?? DEFAULT_COMPANION_SKIN
}

function handleWebCompanionSkinSetActive(pluginId: unknown): { ok: boolean; error?: string } {
  const next = typeof pluginId === 'string' && pluginId.trim() ? pluginId.trim() : null
  if (!next) {
    saveWebSettings({ activeCompanionSkinPluginId: undefined })
    return { ok: true }
  }
  const found = listWebCompanionSkins().some((skin) => skin.pluginId === next)
  if (!found) return { ok: false, error: `companion skin not found: ${next}` }
  saveWebSettings({ activeCompanionSkinPluginId: next })
  return { ok: true }
}

const extensionHandlers: Array<[string, WebInvokeHandler]> = [
  ['ext:plugins:list', (type) => listPluginRows(type)],
  ['ext:plugins:activate', (id) => setBuiltinStatus('plugin', String(id ?? ''), true)],
  ['ext:plugins:deactivate', (id) => setBuiltinStatus('plugin', String(id ?? ''), false)],
  ['ext:skills:list', () => listSkillRows()],
  ['ext:skills:activate', (id) => setBuiltinStatus('skill', String(id ?? ''), true)],
  ['ext:skills:deactivate', (id) => setBuiltinStatus('skill', String(id ?? ''), false)],
  ['ext:media:status', () => handleWebMediaStatus()],
  ['ext:companionSkin:active', () => handleWebCompanionSkinActive()],
  ['ext:companionSkin:list', () => listWebCompanionSkins()],
  ['ext:companionSkin:setActive', (pluginId) => handleWebCompanionSkinSetActive(pluginId)],
]

export function registerWebExtensionWorkflowHandlers(registry: WebHandlerRegistry): void {
  for (const [channel, handler] of extensionHandlers) registry.set(channel, handler)
}
