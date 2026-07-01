export type AckemRuntime = 'electron' | 'web'

export type AckemWebInvokeRequest = {
  id?: string
  channel: string
  args?: unknown[]
}

export type AckemWebInvokeError = {
  message: string
  code?: string
  channel?: string
  status?: AckemWebChannelStatus
  replacement?: string
  details?: Record<string, unknown>
  stack?: string
}

export type AckemWebInvokeSuccess<T = unknown> = {
  ok: true
  id?: string
  result: T
}

export type AckemWebInvokeFailure = {
  ok: false
  id?: string
  error: AckemWebInvokeError
}

export type AckemWebInvokeResponse<T = unknown> =
  | AckemWebInvokeSuccess<T>
  | AckemWebInvokeFailure

export type AckemWebEvent<T = unknown> = {
  channel: string
  payload: T
  ts: number
  source?: 'main' | 'web'
}

export type AckemWebChannelStatus = 'supported' | 'electronWindowOnly' | 'pending'

export type AckemWebChannelTransport = 'invoke' | 'event' | 'http'

export type AckemWebChannelContract = {
  channel: string
  status: AckemWebChannelStatus
  transport: AckemWebChannelTransport
  description: string
  owner?: string
  method?: 'GET' | 'POST' | 'WS'
  path?: string
  replacement?: string
  reason?: string
}

export type AckemWebChannelMatrix = {
  supported: AckemWebChannelContract[]
  electronWindowOnly: AckemWebChannelContract[]
  pending: AckemWebChannelContract[]
  all: AckemWebChannelContract[]
}

export type AckemWebUploadImportPath = '/api/upload/import' | '/api/import/upload'

export type AckemWebCapabilities = {
  runtime: AckemRuntime
  singleUser: true
  localOnly: boolean
  invokePath: '/api/invoke'
  eventsPath: '/api/events'
  uploadImportPath: '/api/upload/import'
  uploadImportPaths: AckemWebUploadImportPath[]
  channels: string[]
  unsupportedChannels: string[]
  pendingChannels: string[]
  electronWindowOnlyChannels: string[]
  channelMatrix: AckemWebChannelMatrix
}

export const ACKEM_WEB_INVOKE_PATH = '/api/invoke'
export const ACKEM_WEB_EVENTS_PATH = '/api/events'
export const ACKEM_WEB_UPLOAD_IMPORT_PATH = '/api/upload/import'
export const ACKEM_WEB_IMPORT_UPLOAD_COMPAT_PATH = '/api/import/upload'
export const ACKEM_WEB_UPLOAD_IMPORT_PATHS = [
  ACKEM_WEB_UPLOAD_IMPORT_PATH,
  ACKEM_WEB_IMPORT_UPLOAD_COMPAT_PATH,
] as const
