import { ACKEM_WEB_UPLOAD_IMPORT_PATH } from '../../../shared/webTransport'

export type AckemInvokeRequest = {
  channel: string
  args?: unknown[]
}

export type AckemInvokeErrorPayload = {
  message?: string
  code?: string
  details?: unknown
}

export type AckemInvokeResponse<T> =
  | { ok: true; result: T }
  | { ok: false; error?: AckemInvokeErrorPayload | string }
  | { result: T }

export type AckemEventEnvelope = {
  channel?: string
  type?: string
  event?: string
  payload?: unknown
  data?: unknown
}

export type AckemEventHandler<T = unknown> = (payload: T) => void
export type Unsubscribe = () => void

const DEFAULT_INVOKE_PATH = '/api/invoke'
const DEFAULT_EVENTS_PATH = '/api/events'
const LEGACY_IMPORT_UPLOAD_PATH = '/api/import/upload'

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

export function getAckemApiBase(): string {
  const configured = import.meta.env.VITE_ACKEM_API_BASE as string | undefined
  if (configured?.trim()) return trimTrailingSlash(configured.trim())
  return ''
}

function apiUrl(path: string): string {
  const base = getAckemApiBase()
  return base ? `${base}${path}` : path
}

function eventsUrl(): string {
  const configured = import.meta.env.VITE_ACKEM_EVENTS_URL as string | undefined
  if (configured?.trim()) return configured.trim()
  const base = getAckemApiBase()
  if (base) {
    const url = new URL(DEFAULT_EVENTS_PATH, base)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return url.toString()
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}${DEFAULT_EVENTS_PATH}`
}

function responseErrorMessage(error: AckemInvokeErrorPayload | string | undefined): string {
  if (!error) return 'Ackem Web API request failed'
  if (typeof error === 'string') return error
  return error.message || error.code || 'Ackem Web API request failed'
}

export async function webInvoke<T>(channel: string, args: unknown[] = []): Promise<T> {
  const res = await fetch(apiUrl(DEFAULT_INVOKE_PATH), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel, args } satisfies AckemInvokeRequest)
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Ackem Web API ${channel} returned HTTP ${res.status}${text ? `: ${text.slice(0, 240)}` : ''}`)
  }

  const payload = (await res.json()) as AckemInvokeResponse<T> | T
  if (payload && typeof payload === 'object' && 'ok' in payload) {
    if (payload.ok === false) throw new Error(responseErrorMessage(payload.error))
    return payload.result
  }
  if (payload && typeof payload === 'object' && 'result' in payload) {
    return payload.result
  }
  return payload as T
}

function headerSafeFilename(name: string): string {
  const safe = name.replace(/[^\x20-\x7e]/g, '_').replace(/[\\/:*?"<>|]/g, '_').trim()
  return safe || 'upload.bin'
}

async function webUploadOneFile(path: string, file: File): Promise<unknown> {
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: {
      'content-type': file.type || 'application/octet-stream',
      'x-ackem-filename': headerSafeFilename(file.name)
    },
    body: await file.arrayBuffer()
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const error = new Error(
      `Ackem Web import upload endpoint ${path} returned HTTP ${res.status}${text ? `: ${text.slice(0, 240)}` : ''}`
    )
    Object.assign(error, { status: res.status })
    throw error
  }

  return res.json()
}

function shouldTryLegacyUpload(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status
  return status === 404 || status === 405
}

type UploadResponseLike = {
  ok?: boolean
  result?: unknown
  error?: AckemInvokeErrorPayload | string
  copied?: unknown
  errors?: unknown
  files?: Array<{ relPath?: string }>
}

function normalizeUploadResult(payload: unknown): { copied: string[]; errors: string[] } {
  if (payload && typeof payload === 'object' && 'ok' in payload) {
    const wrapped = payload as UploadResponseLike
    if (wrapped.ok === false) throw new Error(responseErrorMessage(wrapped.error))
    if ('result' in wrapped) return normalizeUploadResult(wrapped.result)
    const files = Array.isArray(wrapped.files) ? wrapped.files : []
    return {
      copied: files.map((file: { relPath?: string }) => file.relPath).filter((relPath: string | undefined): relPath is string => Boolean(relPath)),
      errors: []
    }
  }

  const direct = payload as UploadResponseLike
  if (Array.isArray(direct?.copied)) {
    return {
      copied: direct.copied.filter((relPath): relPath is string => typeof relPath === 'string'),
      errors: Array.isArray(direct.errors) ? direct.errors.filter((msg): msg is string => typeof msg === 'string') : []
    }
  }
  if (Array.isArray(direct?.files)) {
    return {
      copied: direct.files.map((file) => file.relPath).filter((relPath): relPath is string => Boolean(relPath)),
      errors: []
    }
  }
  return { copied: [], errors: ['Upload succeeded but returned no imported files'] }
}

export async function webUploadFiles(files: File[]): Promise<{ copied: string[]; errors: string[] }> {
  const copied: string[] = []
  const errors: string[] = []
  const paths = [ACKEM_WEB_UPLOAD_IMPORT_PATH, LEGACY_IMPORT_UPLOAD_PATH]

  for (const file of files) {
    try {
      let payload: unknown
      try {
        payload = await webUploadOneFile(paths[0], file)
      } catch (error) {
        if (!shouldTryLegacyUpload(error)) throw error
        payload = await webUploadOneFile(paths[1], file)
      }
      const result = normalizeUploadResult(payload)
      copied.push(...result.copied)
      errors.push(...result.errors)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }

  if (files.length > 0 && copied.length === 0 && errors.length === 0) {
    errors.push('No files were staged by the Ackem Web upload endpoint')
  }

  return { copied, errors }
}

class AckemWebEventBus {
  private socket: WebSocket | null = null
  private reconnectTimer: number | null = null
  private listeners = new Map<string, Set<AckemEventHandler>>()

  on<T>(channel: string, handler: AckemEventHandler<T>): Unsubscribe {
    const set = this.listeners.get(channel) ?? new Set<AckemEventHandler>()
    set.add(handler as AckemEventHandler)
    this.listeners.set(channel, set)
    this.connect()
    return () => {
      const current = this.listeners.get(channel)
      current?.delete(handler as AckemEventHandler)
      if (current && current.size === 0) this.listeners.delete(channel)
      if (this.listenerCount() === 0) this.close()
    }
  }

  private listenerCount(): number {
    let total = 0
    for (const set of this.listeners.values()) total += set.size
    return total
  }

  private connect(): void {
    if (typeof window === 'undefined' || typeof WebSocket === 'undefined') return
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return
    }
    if (this.reconnectTimer != null) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    try {
      this.socket = new WebSocket(eventsUrl())
    } catch {
      this.scheduleReconnect()
      return
    }

    this.socket.addEventListener('message', (event) => {
      this.dispatch(event.data)
    })
    this.socket.addEventListener('close', () => {
      this.socket = null
      this.scheduleReconnect()
    })
    this.socket.addEventListener('error', () => {
      this.socket?.close()
    })
  }

  private scheduleReconnect(): void {
    if (typeof window === 'undefined' || this.listenerCount() === 0 || this.reconnectTimer != null) return
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, 1500)
  }

  private dispatch(raw: unknown): void {
    let envelope: AckemEventEnvelope
    try {
      envelope = typeof raw === 'string' ? (JSON.parse(raw) as AckemEventEnvelope) : (raw as AckemEventEnvelope)
    } catch {
      return
    }

    const channel = envelope.channel ?? envelope.type ?? envelope.event
    if (!channel) return
    const payload = 'payload' in envelope ? envelope.payload : envelope.data
    const set = this.listeners.get(channel)
    if (!set?.size) return
    for (const handler of [...set]) handler(payload)
  }

  private close(): void {
    if (this.reconnectTimer != null) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.socket?.close()
    this.socket = null
  }
}

export const webEvents = new AckemWebEventBus()
