import type { Server } from 'node:http'
import type { WebSocketServer } from 'ws'
import type {
  AckemWebCapabilities,
  AckemWebEvent,
  AckemWebInvokeRequest,
  AckemWebInvokeResponse,
} from '../../shared/webTransport'

export type WebInvokeHandler = (...args: unknown[]) => unknown | Promise<unknown>

export type WebHandlerRegistry = Map<string, WebInvokeHandler>

export type WebInvokeContext = {
  registry: WebHandlerRegistry
}

export type WebEventListener = (event: AckemWebEvent) => void

export type WebEventSink = {
  send: (channel: string, payload: unknown) => void
}

export type AckemWebServerOptions = {
  host?: string
  port?: number
  staticRoot?: string
  spaFallback?: boolean
  registry?: WebHandlerRegistry
  eventBus?: {
    emit: (channel: string, payload: unknown) => AckemWebEvent
    subscribe: (listener: WebEventListener) => () => void
  }
  corsOrigin?: string
  maxBodyBytes?: number
  maxUploadBytes?: number
  allowNonLoopbackHost?: boolean
}

export type AckemWebServerHandle = {
  host: string
  port: number
  url: string
  server: Server
  wss: WebSocketServer
  registry: WebHandlerRegistry
  capabilities: () => AckemWebCapabilities
  close: () => Promise<void>
}

export type {
  AckemWebCapabilities,
  AckemWebEvent,
  AckemWebInvokeRequest,
  AckemWebInvokeResponse,
}
