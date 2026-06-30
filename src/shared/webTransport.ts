export type AckemRuntime = 'electron' | 'web'

export type AckemWebInvokeRequest = {
  id?: string
  channel: string
  args?: unknown[]
}

export type AckemWebInvokeError = {
  message: string
  code?: string
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

export type AckemWebCapabilities = {
  runtime: AckemRuntime
  singleUser: true
  localOnly: boolean
  invokePath: '/api/invoke'
  eventsPath: '/api/events'
  channels: string[]
  unsupportedChannels: string[]
}

export const ACKEM_WEB_INVOKE_PATH = '/api/invoke'
export const ACKEM_WEB_EVENTS_PATH = '/api/events'
