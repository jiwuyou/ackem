import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, extname, join, relative, resolve } from 'node:path'
import { ensureDataLayout } from '../../layout'
import { currentWebDataRoot } from '../runtime'

const DEFAULT_MAX_PATH_IMPORT_BYTES = 200 * 1024 * 1024
const IMPORT_STAGE_DIR = 'imports/web'

export type WebImportSource = 'path' | 'upload-raw' | 'upload-form'

export type WebImportFileResult = {
  source: WebImportSource
  relPath: string
  filename: string
  size: number
  sha256: string
  stagedAt: string
  mimeType?: string
  originalPath?: string
  allowedRoot?: string
}

export type WebImportBatchResult = {
  ok: true
  stagedOnly: true
  dataRoot: string
  stagingDir: typeof IMPORT_STAGE_DIR
  files: WebImportFileResult[]
}

export type WebImportFromPathInput =
  | string
  | string[]
  | {
      path?: string
      paths?: string[]
      maxBytes?: number
    }

export type WebImportUploadInput = {
  body: Buffer
  filename: string
  contentType?: string
  maxBytes?: number
  source?: Extract<WebImportSource, 'upload-raw' | 'upload-form'>
}

export type WebImportUploadFileInput = Omit<WebImportUploadInput, 'maxBytes'>

function webImportError(message: string, code: string, details?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code, details })
}

function parseContentTypeBoundary(contentType: string): string {
  const match = contentType.match(/(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/i)
  const boundary = (match?.[1] ?? match?.[2] ?? '').trim()
  if (!boundary) {
    throw webImportError('Multipart upload is missing a boundary', 'IMPORT_UPLOAD_BOUNDARY_REQUIRED')
  }
  return boundary
}

function parseHeaderParams(value: string): Record<string, string> {
  const params: Record<string, string> = {}
  const re = /;\s*([^=;\s]+)=(?:"([^"]*)"|([^;]*))/g
  let match: RegExpExecArray | null
  while ((match = re.exec(value))) {
    params[match[1].toLowerCase()] = (match[2] ?? match[3] ?? '').trim()
  }
  return params
}

function parseMultipartHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim()
  }
  return headers
}

export function parseMultipartImportUpload(body: Buffer, contentType: string): WebImportUploadFileInput[] {
  const boundary = parseContentTypeBoundary(contentType)
  const delimiter = Buffer.from(`--${boundary}`)
  const headerEndNeedle = Buffer.from('\r\n\r\n')
  let cursor = body.indexOf(delimiter)
  if (cursor < 0) {
    throw webImportError('Multipart boundary was not found in upload body', 'IMPORT_UPLOAD_BOUNDARY_NOT_FOUND')
  }
  cursor += delimiter.length

  const files: WebImportUploadFileInput[] = []
  while (cursor < body.length) {
    const marker = body.slice(cursor, cursor + 2).toString('utf-8')
    if (marker === '--') break
    if (marker === '\r\n') cursor += 2

    const headerEnd = body.indexOf(headerEndNeedle, cursor)
    if (headerEnd < 0) {
      throw webImportError('Malformed multipart upload part', 'IMPORT_UPLOAD_MALFORMED')
    }
    const headers = parseMultipartHeaders(body.slice(cursor, headerEnd).toString('utf-8'))
    const partStart = headerEnd + headerEndNeedle.length
    const nextBoundary = body.indexOf(Buffer.from(`\r\n--${boundary}`), partStart)
    if (nextBoundary < 0) {
      throw webImportError('Multipart upload part is missing a closing boundary', 'IMPORT_UPLOAD_MALFORMED')
    }

    const disposition = headers['content-disposition'] ?? ''
    const params = parseHeaderParams(disposition)
    const filename = params.filename || params['filename*']
    if (filename) {
      files.push({
        body: body.slice(partStart, nextBoundary),
        filename,
        contentType: headers['content-type'],
        source: 'upload-form',
      })
    }
    cursor = nextBoundary + 2 + delimiter.length
  }

  if (files.length === 0) {
    throw webImportError('Multipart upload did not contain any file parts', 'IMPORT_UPLOAD_NO_FILES')
  }
  return files
}

function splitConfiguredRoots(value: string | undefined): string[] {
  if (!value?.trim()) return []
  return value
    .split(',')
    .flatMap((part) => part.split(delimiter))
    .map((part) => part.trim())
    .filter(Boolean)
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function configuredImportRoots(dataRoot: string): string[] {
  const roots = [
    dataRoot,
    process.cwd(),
    homedir(),
    ...splitConfiguredRoots(process.env.ACKEM_WEB_IMPORT_ROOTS),
  ]
  return unique(
    roots
      .map((root) => resolve(root))
      .map((root) => safeRealpath(root) ?? root)
      .filter((root) => existsSync(root))
  )
}

function isInsideRoot(root: string, file: string): boolean {
  const rel = relative(root, file)
  return rel === '' || (!rel.startsWith('..') && !rel.includes(':'))
}

function resolveAllowedImportPath(inputPath: string, dataRoot: string): { path: string; allowedRoot: string } {
  const requested = resolve(inputPath)
  const real = safeRealpath(requested)
  if (!real) {
    throw webImportError('Import source does not exist', 'IMPORT_SOURCE_NOT_FOUND', { path: inputPath })
  }
  const roots = configuredImportRoots(dataRoot)
  const allowedRoot = roots.find((root) => isInsideRoot(root, real))
  if (!allowedRoot) {
    throw webImportError(
      'Import source is outside allowed roots. Set ACKEM_WEB_IMPORT_ROOTS to allow additional Termux paths.',
      'IMPORT_PATH_NOT_ALLOWED',
      { path: inputPath, allowedRoots: roots }
    )
  }
  return { path: real, allowedRoot }
}

function sanitizeFilename(input: string, fallback = 'upload.bin'): string {
  const name = basename(input.replace(/\0/g, '').replace(/\\/g, '/')).trim() || fallback
  const safe = name.replace(/[^\w.\-\u4e00-\u9fff]+/g, '_').replace(/^_+|_+$/g, '')
  const normalized = safe || fallback
  if (normalized.length <= 160) return normalized
  const ext = extname(normalized)
  const stem = normalized.slice(0, 160 - ext.length)
  return `${stem}${ext}`
}

function stagedTarget(dataRoot: string, filename: string): { relPath: string; absPath: string } {
  const stageRoot = join(dataRoot, IMPORT_STAGE_DIR)
  mkdirSync(stageRoot, { recursive: true })
  const safe = sanitizeFilename(filename)
  const parsedExt = extname(safe)
  const parsedStem = parsedExt ? safe.slice(0, -parsedExt.length) : safe
  let candidate = safe
  let absPath = join(stageRoot, candidate)
  if (existsSync(absPath)) {
    const suffix = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
    candidate = `${parsedStem}-${suffix}${parsedExt}`
    absPath = join(stageRoot, candidate)
  }
  return {
    relPath: `${IMPORT_STAGE_DIR}/${candidate}`.replace(/\\/g, '/'),
    absPath,
  }
}

async function copyAndHashFile(from: string, to: string): Promise<{ size: number; sha256: string }> {
  return await new Promise<{ size: number; sha256: string }>((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256')
    const input = createReadStream(from)
    const output = createWriteStream(to, { flags: 'wx' })
    let size = 0
    let settled = false

    const settle = (error: Error | undefined, result?: { size: number; sha256: string }) => {
      if (settled) return
      settled = true
      if (error) rejectPromise(error)
      else if (result) resolvePromise(result)
      else rejectPromise(new Error('Import copy finished without a result'))
    }

    input.on('data', (chunk: string | Buffer) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buf.length
      hash.update(buf)
    })
    input.on('error', (error) => settle(error))
    output.on('error', (error) => settle(error))
    output.on('finish', () => {
      settle(undefined, {
        size,
        sha256: hash.digest('hex'),
      })
    })
    input.pipe(output)
  })
}

function normalizePathImportInput(input: WebImportFromPathInput): { paths: string[]; maxBytes: number } {
  if (typeof input === 'string') {
    return { paths: [input], maxBytes: DEFAULT_MAX_PATH_IMPORT_BYTES }
  }
  if (Array.isArray(input)) {
    return { paths: input.filter((path): path is string => typeof path === 'string') , maxBytes: DEFAULT_MAX_PATH_IMPORT_BYTES }
  }
  if (input && typeof input === 'object') {
    const paths = [
      ...(typeof input.path === 'string' ? [input.path] : []),
      ...(Array.isArray(input.paths) ? input.paths.filter((path): path is string => typeof path === 'string') : []),
    ]
    return {
      paths,
      maxBytes:
        typeof input.maxBytes === 'number' && Number.isFinite(input.maxBytes) && input.maxBytes > 0
          ? input.maxBytes
          : DEFAULT_MAX_PATH_IMPORT_BYTES,
    }
  }
  return { paths: [], maxBytes: DEFAULT_MAX_PATH_IMPORT_BYTES }
}

export function allowedWebImportRoots(): string[] {
  return configuredImportRoots(currentWebDataRoot())
}

export async function handleWebImportFromPath(input: WebImportFromPathInput): Promise<WebImportBatchResult> {
  const dataRoot = currentWebDataRoot()
  ensureDataLayout(dataRoot)
  const { paths, maxBytes } = normalizePathImportInput(input)
  if (paths.length === 0) {
    throw webImportError('import:fromPath requires a path or paths array', 'INVALID_ARGUMENT')
  }

  const files: WebImportFileResult[] = []
  for (const path of paths) {
    const resolved = resolveAllowedImportPath(path, dataRoot)
    const stat = statSync(resolved.path)
    if (!stat.isFile()) {
      throw webImportError('Import source must be a file', 'IMPORT_SOURCE_NOT_FILE', { path })
    }
    if (stat.size > maxBytes) {
      throw webImportError('Import source is too large', 'IMPORT_SOURCE_TOO_LARGE', {
        path,
        size: stat.size,
        maxBytes,
      })
    }
    const target = stagedTarget(dataRoot, basename(resolved.path))
    const copied = await copyAndHashFile(resolved.path, target.absPath)
    files.push({
      source: 'path',
      relPath: target.relPath,
      filename: basename(target.relPath),
      size: copied.size,
      sha256: copied.sha256,
      stagedAt: new Date().toISOString(),
      originalPath: resolved.path,
      allowedRoot: resolved.allowedRoot,
    })
  }

  return {
    ok: true,
    stagedOnly: true,
    dataRoot,
    stagingDir: IMPORT_STAGE_DIR,
    files,
  }
}

async function stageUploadedFile(
  dataRoot: string,
  input: WebImportUploadFileInput,
  maxBytes: number
): Promise<WebImportFileResult> {
  if (!input.filename.trim()) {
    throw webImportError('Upload requires a filename', 'IMPORT_UPLOAD_FILENAME_REQUIRED')
  }
  if (input.body.byteLength > maxBytes) {
    throw webImportError('Upload body is too large', 'IMPORT_UPLOAD_TOO_LARGE', {
      size: input.body.byteLength,
      maxBytes,
    })
  }
  const target = stagedTarget(dataRoot, input.filename)
  mkdirSync(dirname(target.absPath), { recursive: true })
  const hash = createHash('sha256').update(input.body).digest('hex')
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createWriteStream(target.absPath, { flags: 'wx' })
    stream.on('error', rejectPromise)
    stream.on('finish', resolvePromise)
    stream.end(input.body)
  })
  return {
    source: input.source ?? 'upload-raw',
    relPath: target.relPath,
    filename: basename(target.relPath),
    size: input.body.byteLength,
    sha256: hash,
    stagedAt: new Date().toISOString(),
    mimeType: input.contentType,
  }
}

export async function handleWebImportUploadFiles(
  inputs: WebImportUploadFileInput[],
  maxBytes = DEFAULT_MAX_PATH_IMPORT_BYTES
): Promise<WebImportBatchResult> {
  const dataRoot = currentWebDataRoot()
  ensureDataLayout(dataRoot)
  if (inputs.length === 0) {
    throw webImportError('Upload requires at least one file', 'IMPORT_UPLOAD_NO_FILES')
  }
  const files: WebImportFileResult[] = []
  for (const input of inputs) {
    files.push(await stageUploadedFile(dataRoot, input, maxBytes))
  }
  return {
    ok: true,
    stagedOnly: true,
    dataRoot,
    stagingDir: IMPORT_STAGE_DIR,
    files,
  }
}

export async function handleWebImportUpload(input: WebImportUploadInput): Promise<WebImportBatchResult> {
  return handleWebImportUploadFiles(
    [
      {
        body: input.body,
        filename: input.filename,
        contentType: input.contentType,
        source: input.source ?? 'upload-raw',
      },
    ],
    input.maxBytes
  )
}
