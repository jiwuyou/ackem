import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import type { AppSettings } from '../../../shared/types'
import { getEmbeddingReadiness, type EmbeddingReadinessSnapshot } from '../../embedding/embeddingReadiness'
import { getDatabase } from '../../db/database'
import { promoteImportToMemory } from '../../fsops'
import { FactStore, defaultFactsPath } from '../../memory/factStore'
import { AssociationIndex } from '../../memory/associationIndex'
import { batchSeedAssociationsFromTextOverlap } from '../../memory/associationColdStart'
import {
  BUNDLED_EMBEDDING_MODEL_IDS,
  MODEL_MANIFESTS,
  type LocalModelId,
  type ModelState,
} from '../../memory/embedding/types'
import { ensureDataLayout } from '../../layout'
import {
  currentWebDataRoot,
  loadWebSettings,
  saveWebSettings,
} from '../runtime'
import type { WebHandlerRegistry, WebInvokeHandler } from '../types'
import {
  clampInteger,
  normalizeSafeRelativePath,
  resolveSafeChildFile,
} from './safePaths'

type ChunkRecord = {
  id: string
  relPath: string
  start: number
  end: number
  text: string
  mtimeMs: number
}

type IndexSnapshot = {
  version: 1
  builtAt: string
  dataRoot: string
  chunks: ChunkRecord[]
  docFreq?: Record<string, number>
}

type WebModelStatus = {
  id: string
  extracted: boolean
  active: boolean
  bundled?: boolean
  zipPresent?: boolean
  dimension: number
  source: string
  memoryLabel: string
}

const INDEX_VERSION = 1 as const
const MAX_CHUNK_CHARS = 900
const DIARY_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/i
const WEB_IMPORT_STAGE_DIR = 'imports/web'
const indexCache = new Map<string, IndexSnapshot>()

function rootWithLayout(): string {
  const root = currentWebDataRoot()
  ensureDataLayout(root)
  return root
}

function unsupported(channel: string, reason: string): { ok: false; code: string; channel: string; reason: string } {
  return { ok: false, code: 'WEB_UNSUPPORTED', channel, reason }
}

function hashId(rel: string, start: number, end: number): string {
  return createHash('sha256').update(`${rel}:${start}:${end}`).digest('hex').slice(0, 16)
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((token) => token.length >= 2)
}

function splitIntoChunks(text: string): string[] {
  const parts = text.split(/\n{2,}/)
  const chunks: string[] = []
  let buffer = ''
  for (const part of parts) {
    const piece = part.trim()
    if (!piece) continue
    if (buffer && `${buffer}\n\n${piece}`.length > MAX_CHUNK_CHARS) {
      chunks.push(buffer)
      buffer = piece
    } else {
      buffer = buffer ? `${buffer}\n\n${piece}` : piece
    }
  }
  if (buffer) chunks.push(buffer)
  if (chunks.length === 0 && text.trim()) chunks.push(text.trim().slice(0, MAX_CHUNK_CHARS))

  const out: string[] = []
  for (const chunk of chunks) {
    if (chunk.length <= MAX_CHUNK_CHARS) {
      out.push(chunk)
      continue
    }
    for (let i = 0; i < chunk.length; i += MAX_CHUNK_CHARS) out.push(chunk.slice(i, i + MAX_CHUNK_CHARS))
  }
  return out
}

function isRecentDiary(relPath: string, days: number): boolean {
  const match = basename(relPath).match(DIARY_FILE)
  if (!match) return true
  const time = new Date(`${match[1]}T12:00:00`).getTime()
  if (!Number.isFinite(time)) return true
  return time >= Date.now() - days * 86_400_000
}

function listFilesRecursive(dir: string, base: string, acc: string[]): void {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      listFilesRecursive(full, base, acc)
      continue
    }
    const ext = extname(entry.name).toLowerCase()
    if (ext === '.md' || ext === '.txt') acc.push(relative(base, full).replace(/\\/g, '/'))
  }
}

function collectIndexedRelPaths(dataRoot: string, settings: AppSettings): string[] {
  const roots = [
    join(dataRoot, 'memory'),
    join(dataRoot, 'preferences'),
    join(dataRoot, 'portrait'),
    join(dataRoot, 'diary'),
    join(dataRoot, 'companion'),
  ]
  const rels: string[] = []
  for (const root of roots) listFilesRecursive(root, dataRoot, rels)
  const diaryDays = settings.tierBDiaryDays ?? 7
  return rels.filter((rel) => !rel.startsWith('diary/') || isRecentDiary(rel, diaryDays))
}

function computeDocFreq(chunks: ChunkRecord[]): Record<string, number> {
  const df = new Map<string, number>()
  for (const chunk of chunks) {
    for (const term of new Set(tokenize(chunk.text))) df.set(term, (df.get(term) ?? 0) + 1)
  }
  return Object.fromEntries(df)
}

function buildWebIndex(dataRoot: string, settings: AppSettings): IndexSnapshot {
  const chunks: ChunkRecord[] = []
  for (const relPath of collectIndexedRelPaths(dataRoot, settings)) {
    const abs = join(dataRoot, relPath)
    try {
      const st = statSync(abs)
      const pieces = splitIntoChunks(readFileSync(abs, 'utf-8'))
      pieces.forEach((text, index) => {
        const start = index * (MAX_CHUNK_CHARS + 1)
        const end = start + text.length
        chunks.push({
          id: hashId(relPath, start, end),
          relPath,
          start,
          end,
          text,
          mtimeMs: st.mtimeMs,
        })
      })
    } catch {
      /* skip unreadable files */
    }
  }
  return {
    version: INDEX_VERSION,
    builtAt: new Date().toISOString(),
    dataRoot,
    chunks,
    docFreq: computeDocFreq(chunks),
  }
}

function indexPath(dataRoot: string): string {
  return join(dataRoot, '_derived', 'chunk-index.v1.json')
}

function persistWebIndex(dataRoot: string, snap: IndexSnapshot): void {
  mkdirSync(dirname(indexPath(dataRoot)), { recursive: true })
  writeFileSync(indexPath(dataRoot), JSON.stringify(snap, null, 2), 'utf-8')
}

function tryLoadWebIndex(dataRoot: string): IndexSnapshot | null {
  try {
    const parsed = JSON.parse(readFileSync(indexPath(dataRoot), 'utf-8')) as IndexSnapshot
    if (parsed.version !== INDEX_VERSION || parsed.dataRoot !== dataRoot) return null
    return parsed
  } catch {
    return null
  }
}

function getOrBuildWebIndex(dataRoot: string): IndexSnapshot {
  const cached = indexCache.get(dataRoot)
  if (cached) return cached
  const loaded = tryLoadWebIndex(dataRoot)
  if (loaded) {
    indexCache.set(dataRoot, loaded)
    return loaded
  }
  return handleWebIndexRebuild().snapshot
}

function searchChunks(
  snap: IndexSnapshot,
  query: string,
  limit: number
): Array<{ chunk: ChunkRecord; score: number }> {
  const terms = tokenize(query)
  if (terms.length === 0) return []
  const df = new Map(Object.entries(snap.docFreq ?? computeDocFreq(snap.chunks)))
  const total = Math.max(1, snap.chunks.length)
  const scored: Array<{ chunk: ChunkRecord; score: number }> = []

  for (const chunk of snap.chunks) {
    const tokens = tokenize(chunk.text)
    if (tokens.length === 0) continue
    const tf = new Map<string, number>()
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
    let score = 0
    const maxTf = Math.max(...tf.values())
    for (const term of terms) {
      const count = tf.get(term) ?? 0
      if (count === 0) continue
      const termDf = df.get(term) ?? 1
      const idf = Math.log((1 + total) / (1 + termDf)) + 1
      score += (count / maxTf) * idf
    }
    if (score > 0) scored.push({ chunk, score })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit)
}

function modelStatePath(dataRoot: string): string {
  return join(dataRoot, 'models', '.model-state.json')
}

function readModelState(dataRoot: string): ModelState {
  try {
    return JSON.parse(readFileSync(modelStatePath(dataRoot), 'utf-8')) as ModelState
  } catch {
    return { activeModel: 'none', version: '0', activatedAt: '', dimension: 0, provider: 'none' }
  }
}

function writeModelState(dataRoot: string, state: ModelState): void {
  mkdirSync(join(dataRoot, 'models'), { recursive: true })
  writeFileSync(modelStatePath(dataRoot), JSON.stringify(state, null, 2), 'utf-8')
}

function isModelExtracted(dataRoot: string, modelId: string): boolean {
  const dir = join(dataRoot, 'models', modelId)
  const onnx = join(dir, 'model.onnx')
  const tokenizer = join(dir, 'tokenizer.json')
  if (!existsSync(onnx) || !existsSync(tokenizer)) return false
  try {
    return statSync(onnx).size > 1_000_000
  } catch {
    return false
  }
}

function modelZipPresent(dataRoot: string, modelId: string): boolean {
  const candidates = [
    join(dataRoot, 'models', `${modelId}-v1.5.onnx.zip`),
    join(process.cwd(), 'resources', 'models', `${modelId}-v1.5.onnx.zip`),
  ]
  return candidates.some((path) => existsSync(path))
}

function activeModelFromSettings(settings: AppSettings): string {
  return settings.embeddingActiveModel ?? 'none'
}

function modelStatuses(dataRoot: string, activeModel: string): WebModelStatus[] {
  return MODEL_MANIFESTS.map((manifest) => ({
    id: manifest.id,
    extracted: isModelExtracted(dataRoot, manifest.id),
    active: activeModel === manifest.id,
    bundled: (BUNDLED_EMBEDDING_MODEL_IDS as readonly string[]).includes(manifest.id),
    zipPresent: modelZipPresent(dataRoot, manifest.id),
    dimension: manifest.dimension,
    source: manifest.source,
    memoryLabel: manifest.memoryLabel,
  }))
}

function readinessForWeb(dataRoot: string): EmbeddingReadinessSnapshot {
  const snap = getEmbeddingReadiness()
  if (snap.phase === 'ready' || snap.phase === 'degraded') return snap
  const settings = loadWebSettings()
  const active = activeModelFromSettings(settings)
  if (active !== 'none' && isModelExtracted(dataRoot, active)) {
    return {
      phase: 'degraded',
      progress: 1,
      providerReady: false,
      factEmbeddingsReady: false,
      preLlmWarmReady: true,
      error: 'local model is present, but Web runtime has not initialized native embedding provider',
    }
  }
  return {
    phase: 'degraded',
    progress: 1,
    providerReady: false,
    factEmbeddingsReady: false,
    preLlmWarmReady: true,
    error: 'native embedding provider unavailable in Web runtime; TF-IDF fallback is active',
  }
}

function copyImportPathToDataRoot(dataRoot: string, absolutePath: string): { copied: string[]; errors: string[] } {
  const importsDir = join(dataRoot, WEB_IMPORT_STAGE_DIR)
  mkdirSync(importsDir, { recursive: true })
  const safeName = basename(absolutePath).replace(/[^\w.\-\u4e00-\u9fff]+/g, '_')
  const target = join(importsDir, safeName)
  try {
    copyFileSync(absolutePath, target)
    return { copied: [`${WEB_IMPORT_STAGE_DIR}/${safeName}`], errors: [] }
  } catch (error) {
    return { copied: [], errors: [`${absolutePath}: ${error instanceof Error ? error.message : String(error)}`] }
  }
}

function seedAssociationsTextOnly(dataRoot: string): { edgesCreated: number; factsConsidered: number; orphansLinked: number } {
  const store = new FactStore(defaultFactsPath(dataRoot))
  store.load()
  const index = new AssociationIndex()
  index.load(dataRoot)
  return batchSeedAssociationsFromTextOverlap({ factStore: store, associationIndex: index })
}

export function handleWebEmbeddingReadinessFull(): EmbeddingReadinessSnapshot {
  return readinessForWeb(rootWithLayout())
}

export function handleWebEmbeddingStatus(): {
  activeModel: string
  providerReady: boolean
  providerName: string
  providerDimension: number
  models: WebModelStatus[]
  state: ModelState
  bundledReady: string[]
  bundledMissing: string[]
  bundledZipPresent: string[]
  readiness: EmbeddingReadinessSnapshot
  chatReady: boolean
} {
  const root = rootWithLayout()
  const settings = loadWebSettings()
  const state = readModelState(root)
  const activeModel = state.activeModel !== 'none' ? state.activeModel : activeModelFromSettings(settings)
  const models = modelStatuses(root, activeModel)
  const readiness = readinessForWeb(root)
  return {
    activeModel,
    providerReady: false,
    providerName: 'tfidf-web-fallback',
    providerDimension: 0,
    models,
    state,
    bundledReady: models.filter((model) => model.bundled && model.extracted).map((model) => model.id),
    bundledMissing: models.filter((model) => model.bundled && !model.extracted).map((model) => model.id),
    bundledZipPresent: models.filter((model) => model.bundled && model.zipPresent).map((model) => model.id),
    readiness,
    chatReady: true,
  }
}

export function handleWebEmbeddingSwitch(modelIdArg: unknown): { ok: boolean; modelId?: string; error?: string } {
  const modelId = typeof modelIdArg === 'string' ? modelIdArg.trim() : ''
  const root = rootWithLayout()
  if (modelId === 'none') {
    saveWebSettings({ embeddingActiveModel: 'none' })
    writeModelState(root, {
      activeModel: 'none',
      version: '0',
      activatedAt: new Date().toISOString(),
      dimension: 0,
      provider: 'none',
    })
    return { ok: true, modelId }
  }
  const manifest = MODEL_MANIFESTS.find((item) => item.id === modelId)
  if (!manifest) return { ok: false, error: `unknown embedding model: ${modelId}` }
  if (!isModelExtracted(root, modelId)) {
    return {
      ok: false,
      error: `model ${modelId} is not extracted under data/models; Web runtime cannot download or extract it safely yet`,
    }
  }
  saveWebSettings({ embeddingActiveModel: modelId as LocalModelId })
  writeModelState(root, {
    activeModel: modelId as LocalModelId,
    version: 'web',
    activatedAt: new Date().toISOString(),
    dimension: manifest.dimension,
    provider: 'none',
  })
  return { ok: true, modelId }
}

export function handleWebIndexRebuild(): {
  chunks: number
  builtAt: string
  associationSeed: { edgesCreated: number; factsConsidered: number; orphansLinked: number }
  snapshot: IndexSnapshot
} {
  const root = rootWithLayout()
  const snap = buildWebIndex(root, loadWebSettings())
  persistWebIndex(root, snap)
  indexCache.set(root, snap)
  let associationSeed = { edgesCreated: 0, factsConsidered: 0, orphansLinked: 0 }
  try {
    associationSeed = seedAssociationsTextOnly(root)
  } catch {
    /* best effort */
  }
  return { chunks: snap.chunks.length, builtAt: snap.builtAt, associationSeed, snapshot: snap }
}

export function handleWebIndexSearch(queryArg: unknown, limitArg?: unknown): Array<{
  score: number
  id: string
  relPath: string
  preview: string
  mtimeMs: number
}> {
  if (typeof queryArg !== 'string' || !queryArg.trim()) return []
  const root = rootWithLayout()
  const snap = getOrBuildWebIndex(root)
  return searchChunks(snap, queryArg, clampInteger(limitArg, 20, 1, 100)).map((hit) => ({
    score: hit.score,
    id: hit.chunk.id,
    relPath: hit.chunk.relPath,
    preview: hit.chunk.text.slice(0, 240),
    mtimeMs: hit.chunk.mtimeMs,
  }))
}

export function handleWebImportPromote(relArg: unknown): { ok: true; to: string; associationSeed: unknown } | { ok: false; error: string } {
  const rel = normalizeSafeRelativePath(relArg)
  if (!rel) return { ok: false, error: 'invalid import path' }
  const root = rootWithLayout()
  const promoted = promoteImportToMemory(root, rel)
  if (!promoted.ok) return promoted
  const rebuilt = handleWebIndexRebuild()
  return { ...promoted, associationSeed: rebuilt.associationSeed }
}

function normalizeImportPathInput(input: unknown): string[] {
  if (typeof input === 'string') return [input]
  if (Array.isArray(input)) return input.filter((item): item is string => typeof item === 'string')
  if (input && typeof input === 'object') {
    const record = input as { path?: unknown; paths?: unknown }
    return [
      ...(typeof record.path === 'string' ? [record.path] : []),
      ...(Array.isArray(record.paths) ? record.paths.filter((item): item is string => typeof item === 'string') : []),
    ]
  }
  return []
}

export function handleWebImportPath(pathArg: unknown): { copied: string[]; errors: string[] } {
  const paths = normalizeImportPathInput(pathArg).map((path) => path.trim()).filter(Boolean)
  if (paths.length === 0) return { copied: [], errors: ['path required'] }
  const root = rootWithLayout()
  const copied: string[] = []
  const errors: string[] = []
  for (const path of paths) {
    const abs = resolve(path)
    if (!existsSync(abs)) {
      errors.push(`${path}: not found`)
      continue
    }
    const result = copyImportPathToDataRoot(root, abs)
    copied.push(...result.copied)
    errors.push(...result.errors)
  }
  return { copied, errors }
}

export function handleWebReadIndexedFile(relArg: unknown, maxBytesArg?: unknown): { ok: true; text: string } | { ok: false; error: string } {
  const root = rootWithLayout()
  const resolved = resolveSafeChildFile(root, relArg)
  if (!resolved.ok) return { ok: false, error: resolved.error }
  const rel = resolved.relPath
  const allowed =
    rel.startsWith('memory/') ||
    rel.startsWith('preferences/') ||
    rel.startsWith('portrait/') ||
    rel.startsWith('diary/') ||
    rel.startsWith('companion/') ||
    rel.startsWith('imports/') ||
    rel === 'README.md'
  if (!allowed) return { ok: false, error: 'read not allowed' }
  const maxBytes = clampInteger(maxBytesArg, loadWebSettings().singleFileSoftLimitBytes ?? 120_000, 1, 2_000_000)
  try {
    return { ok: true, text: readFileSync(resolved.absPath).slice(0, maxBytes).toString('utf-8') }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function handleWebEmbeddingModels(): {
  models: WebModelStatus[]
  state: ModelState
} {
  const root = rootWithLayout()
  const state = readModelState(root)
  const activeModel = state.activeModel !== 'none' ? state.activeModel : activeModelFromSettings(loadWebSettings())
  return { models: modelStatuses(root, activeModel), state }
}

export function handleWebIndexStatus(): {
  dataRoot: string
  chunks: number
  builtAt: string | null
  persisted: boolean
  sqliteReady: boolean
} {
  const root = rootWithLayout()
  const snap = indexCache.get(root) ?? tryLoadWebIndex(root)
  return {
    dataRoot: root,
    chunks: snap?.chunks.length ?? 0,
    builtAt: snap?.builtAt ?? null,
    persisted: existsSync(indexPath(root)),
    sqliteReady: getDatabase(root) !== null,
  }
}

export const EXPECTED_WEB_EMBEDDING_WORKFLOW_CHANNELS = [
  'embedding:readiness',
  'embedding:status',
  'embedding:models',
  'embedding:switch',
  'embedding:download',
  'embedding:downloadCancel',
  'index:status',
  'index:rebuild',
  'index:search',
  'index:import-promote',
  'import:promote',
  'import:files',
  'import:fromPath',
  'import:path',
  'fs:readRel',
] as const

export function assertWebEmbeddingWorkflowHandlersComplete(registry = webEmbeddingWorkflowHandlers): {
  ok: boolean
  missing: string[]
} {
  const missing = EXPECTED_WEB_EMBEDDING_WORKFLOW_CHANNELS.filter((channel) => !registry.has(channel))
  return { ok: missing.length === 0, missing }
}

export const webEmbeddingWorkflowHandlers: ReadonlyMap<string, WebInvokeHandler> = new Map<string, WebInvokeHandler>([
  ['embedding:readiness', () => handleWebEmbeddingReadinessFull()],
  ['embedding:status', () => handleWebEmbeddingStatus()],
  ['embedding:models', () => handleWebEmbeddingModels()],
  ['embedding:switch', (modelId) => handleWebEmbeddingSwitch(modelId)],
  ['embedding:download', (modelId) =>
    unsupported('embedding:download', `Web runtime cannot download embedding model ${String(modelId ?? '')} yet`)],
  ['embedding:downloadCancel', (modelId) =>
    unsupported('embedding:downloadCancel', `no Web download is active for ${String(modelId ?? '')}`)],
  ['index:status', () => handleWebIndexStatus()],
  ['index:rebuild', () => {
    const { snapshot, ...result } = handleWebIndexRebuild()
    return result
  }],
  ['index:search', (query, limit) => handleWebIndexSearch(query, limit)],
  ['index:import-promote', (rel) => handleWebImportPromote(rel)],
  ['import:promote', (rel) => handleWebImportPromote(rel)],
  ['import:files', (paths) => handleWebImportPath(paths)],
  ['import:fromPath', (input) => handleWebImportPath(input)],
  ['import:path', (path) => handleWebImportPath(path)],
  ['fs:readRel', (rel, maxBytes) => handleWebReadIndexedFile(rel, maxBytes)],
])

export function registerWebEmbeddingWorkflowHandlers(registry: WebHandlerRegistry): void {
  for (const [channel, handler] of webEmbeddingWorkflowHandlers) registry.set(channel, handler)
}
