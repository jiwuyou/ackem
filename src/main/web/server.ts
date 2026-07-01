import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { isIP, type AddressInfo } from 'node:net'
import { extname, join, relative, resolve } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import {
  ACKEM_WEB_EVENTS_PATH,
  ACKEM_WEB_INVOKE_PATH,
  ACKEM_WEB_UPLOAD_IMPORT_PATHS,
  type AckemWebInvokeResponse,
} from '../../shared/webTransport'
import { createLogger } from '../logger'
import { createWebEventSink, defaultWebEventBus } from './events'
import {
  createDefaultWebHandlerRegistry,
  getWebCapabilities,
  invokeWebHandler,
  isInvokeRequest,
} from './handlers'
import {
  handleWebImportUpload,
  handleWebImportUploadFiles,
  parseMultipartImportUpload,
} from './services/importService'
import type { AckemWebServerHandle, AckemWebServerOptions, WebEventListener } from './types'

const log = createLogger('web-server')
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8787
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024
const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const CORS_ALLOW_HEADERS = 'content-type,x-ackem-filename'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

function cacheControlForStaticFile(ext: string): string {
  if (['.html', '.js', '.mjs', '.css', '.json', '.webmanifest'].includes(ext)) {
    return 'no-cache'
  }
  return 'public, max-age=31536000, immutable'
}

function hostnameFromHostHeader(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null
  const value = hostHeader.trim().toLowerCase()
  if (!value) return null
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end > 0 ? value.slice(1, end) : null
  }
  return value.split(':')[0] || null
}

function isLoopbackHostname(hostname: string | null): boolean {
  if (!hostname) return false
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host === '::1') return true
  if (isIP(host) === 4) return host === '127.0.0.1' || host.startsWith('127.')
  return false
}

function originAllowed(
  req: IncomingMessage,
  corsOrigin: string | undefined
): { ok: true } | { ok: false; message: string } {
  const origin = req.headers.origin
  if (!origin) return { ok: true }
  if (corsOrigin && (corsOrigin === '*' || origin === corsOrigin)) return { ok: true }
  try {
    const parsed = new URL(origin)
    const requestHost = req.headers.host?.toLowerCase()
    if (requestHost && parsed.host.toLowerCase() === requestHost && isLoopbackHostname(parsed.hostname)) {
      return { ok: true }
    }
  } catch {
    /* invalid origin */
  }
  return { ok: false, message: 'Forbidden Origin' }
}

function localRequestAllowed(
  req: IncomingMessage,
  options: Pick<AckemWebServerOptions, 'allowNonLoopbackHost' | 'corsOrigin'>
): { ok: true } | { ok: false; statusCode: number; message: string } {
  const host = hostnameFromHostHeader(req.headers.host)
  if (!options.allowNonLoopbackHost && !isLoopbackHostname(host)) {
    return { ok: false, statusCode: 403, message: 'Forbidden Host' }
  }
  const origin = originAllowed(req, options.corsOrigin)
  if (!origin.ok) return { ok: false, statusCode: 403, message: origin.message }
  return { ok: true }
}

function requestPath(req: IncomingMessage, host: string): string {
  try {
    return new URL(req.url ?? '/', `http://${req.headers.host ?? host}`).pathname
  } catch {
    return '/'
  }
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
  corsOrigin?: string
): void {
  const payload = JSON.stringify(body)
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', Buffer.byteLength(payload))
  if (corsOrigin) {
    res.setHeader('access-control-allow-origin', corsOrigin)
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
    res.setHeader('access-control-allow-headers', CORS_ALLOW_HEADERS)
  }
  res.end(payload)
}

function writeText(res: ServerResponse, statusCode: number, text: string, corsOrigin?: string): void {
  res.statusCode = statusCode
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  res.setHeader('content-length', Buffer.byteLength(text))
  if (corsOrigin) {
    res.setHeader('access-control-allow-origin', corsOrigin)
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
    res.setHeader('access-control-allow-headers', CORS_ALLOW_HEADERS)
  }
  res.end(text)
}

function isInsideRoot(root: string, file: string): boolean {
  const rel = relative(root, file)
  return rel === '' || (!rel.startsWith('..') && !rel.includes(':'))
}

function staticCandidate(staticRoot: string, path: string, spaFallback: boolean): string | null {
  let decoded = '/'
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return null
  }

  const normalizedPath = decoded.split('?')[0].replace(/\\/g, '/')
  const withoutSlash = normalizedPath.replace(/^\/+/, '')
  const root = resolve(staticRoot)
  const direct = resolve(root, withoutSlash || 'index.html')
  if (!isInsideRoot(root, direct)) return null

  if (existsSync(direct) && statSync(direct).isFile()) return direct
  if (existsSync(direct) && statSync(direct).isDirectory()) {
    const index = join(direct, 'index.html')
    if (isInsideRoot(root, index) && existsSync(index) && statSync(index).isFile()) return index
  }

  if (!spaFallback || normalizedPath.startsWith('/api/') || extname(normalizedPath)) return null
  const index = join(root, 'index.html')
  return existsSync(index) && statSync(index).isFile() ? index : null
}

function serveStaticFile(
  req: IncomingMessage,
  res: ServerResponse,
  staticRoot: string,
  path: string,
  spaFallback: boolean
): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const file = staticCandidate(staticRoot, path, spaFallback)
  if (!file) return false

  const stat = statSync(file)
  const ext = extname(file).toLowerCase()
  res.statusCode = 200
  res.setHeader('content-type', MIME_TYPES[ext] ?? 'application/octet-stream')
  res.setHeader('content-length', stat.size)
  res.setHeader('cache-control', cacheControlForStaticFile(ext))
  if (req.method === 'HEAD') {
    res.end()
    return true
  }
  createReadStream(file).pipe(res)
  return true
}

async function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > maxBytes) {
      throw Object.assign(new Error('Request body too large'), { code: 'BODY_TOO_LARGE' })
    }
    chunks.push(buf)
  }

  return Buffer.concat(chunks)
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const raw = (await readRequestBody(req, maxBytes)).toString('utf-8').trim()
  if (!raw) return null
  return JSON.parse(raw)
}

function invokeStatus(response: AckemWebInvokeResponse): number {
  if (response.ok) return 200
  if (response.error.code === 'CHANNEL_NOT_FOUND') return 404
  if (response.error.code === 'INVALID_ARGUMENT') return 400
  if (response.error.code === 'WEB_ELECTRON_WINDOW_ONLY') return 501
  if (response.error.code === 'WEB_CHANNEL_PENDING') return 501
  return 500
}

function errorStatus(error: unknown): number {
  const code = (error as { code?: unknown })?.code
  if (code === 'BODY_TOO_LARGE' || code === 'IMPORT_UPLOAD_TOO_LARGE' || code === 'IMPORT_SOURCE_TOO_LARGE') {
    return 413
  }
  if (typeof code === 'string' && (code.startsWith('IMPORT_') || code === 'INVALID_ARGUMENT')) {
    return 400
  }
  return 500
}

function sendWsJson(ws: WebSocket, value: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return
  try {
    ws.send(JSON.stringify(value))
  } catch {
    /* ignore dead sockets */
  }
}

function headerString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? ''
  return value ?? ''
}

function isUploadImportPath(path: string): boolean {
  return (ACKEM_WEB_UPLOAD_IMPORT_PATHS as readonly string[]).includes(path)
}

export async function startAckemWebServer(
  options: AckemWebServerOptions = {}
): Promise<AckemWebServerHandle> {
  const host = options.host ?? DEFAULT_HOST
  const requestedPort = options.port ?? DEFAULT_PORT
  const eventBus = options.eventBus ?? defaultWebEventBus
  const registry = options.registry ?? createDefaultWebHandlerRegistry(createWebEventSink(eventBus))
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const maxUploadBytes = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES
  const staticRoot = options.staticRoot ? resolve(options.staticRoot) : undefined
  const spaFallback = options.spaFallback ?? true
  const startedAt = Date.now()

  const server = createServer((req, res) => {
    void (async () => {
      const allowed = localRequestAllowed(req, options)
      if (!allowed.ok) {
        writeText(res, allowed.statusCode, allowed.message, options.corsOrigin)
        return
      }

      const path = requestPath(req, host)

      if (req.method === 'OPTIONS') {
        res.statusCode = 204
        if (options.corsOrigin) {
          res.setHeader('access-control-allow-origin', options.corsOrigin)
          res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
          res.setHeader('access-control-allow-headers', CORS_ALLOW_HEADERS)
        }
        res.end()
        return
      }

      if (req.method === 'GET' && path === '/api/health') {
        writeJson(
          res,
          200,
          {
            ok: true,
            mode: 'local-web',
            uptimeMs: Date.now() - startedAt,
            pid: process.pid,
            capabilities: getWebCapabilities(registry, host),
          },
          options.corsOrigin
        )
        return
      }

      if (req.method === 'POST' && path === ACKEM_WEB_INVOKE_PATH) {
        const body = await readJsonBody(req, maxBodyBytes)
        if (!isInvokeRequest(body)) {
          writeJson(
            res,
            400,
            {
              ok: false,
              error: {
                message: 'Invalid invoke request. Expected { channel: string, args?: unknown[] }',
                code: 'INVALID_REQUEST',
              },
            },
            options.corsOrigin
          )
          return
        }

        const response = await invokeWebHandler(registry, body)
        writeJson(res, invokeStatus(response), response, options.corsOrigin)
        return
      }

      if (req.method === 'POST' && isUploadImportPath(path)) {
        const contentType = headerString(req.headers['content-type'])
        const body = await readRequestBody(req, maxUploadBytes)
        let result: Awaited<ReturnType<typeof handleWebImportUpload>>
        if (contentType.toLowerCase().startsWith('multipart/form-data')) {
          result = await handleWebImportUploadFiles(
            parseMultipartImportUpload(body, contentType),
            maxUploadBytes
          )
        } else {
          const filename = headerString(req.headers['x-ackem-filename']).trim()
          result = await handleWebImportUpload({
            body,
            filename,
            contentType: contentType || undefined,
            maxBytes: maxUploadBytes,
          })
        }
        writeJson(res, 200, { ok: true, result }, options.corsOrigin)
        return
      }

      if (staticRoot && serveStaticFile(req, res, staticRoot, path, spaFallback)) {
        return
      }

      writeText(res, 404, 'not found', options.corsOrigin)
    })().catch((error) => {
      log.warn('request failed', { error: error instanceof Error ? error.message : String(error) })
      writeJson(
        res,
        errorStatus(error),
        {
          ok: false,
          error: {
            message: error instanceof Error ? error.message : String(error),
            code: (error as { code?: unknown })?.code,
          },
        },
        options.corsOrigin
      )
    })
  })

  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    const allowed = localRequestAllowed(req, options)
    if (!allowed.ok) {
      socket.write(
        `HTTP/1.1 ${allowed.statusCode} ${allowed.message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
      )
      socket.destroy()
      return
    }

    const path = requestPath(req, host)
    if (path !== ACKEM_WEB_EVENTS_PATH) {
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })

  wss.on('connection', (ws) => {
    const listener: WebEventListener = (event) => sendWsJson(ws, event)
    const unsubscribe = eventBus.subscribe(listener)
    sendWsJson(ws, {
      channel: 'web:connected',
      payload: { ok: true, ts: Date.now() },
      ts: Date.now(),
      source: 'web',
    })
    ws.on('close', unsubscribe)
    ws.on('error', unsubscribe)
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }

    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(requestedPort, host)
  })

  const address = server.address() as AddressInfo | null
  const port = address?.port ?? requestedPort
  const url = `http://${host}:${port}`
  log.info('listening', { url })

  return {
    host,
    port,
    url,
    server,
    wss,
    registry,
    capabilities: () => getWebCapabilities(registry, host),
    close: async () => {
      for (const client of wss.clients) {
        client.close(1001, 'Ackem web server shutting down')
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve())
      })
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    },
  }
}
