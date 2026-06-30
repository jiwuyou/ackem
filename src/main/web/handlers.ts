import {
  ACKEM_WEB_EVENTS_PATH,
  ACKEM_WEB_INVOKE_PATH,
  type AckemWebCapabilities,
  type AckemWebInvokeError,
  type AckemWebInvokeRequest,
  type AckemWebInvokeResponse,
} from '../../shared/webTransport'
import {
  handleWebArchiveList,
  handleWebChatLoadHistory,
  handleWebChatSaveHistory,
  handleWebDataEnsureLayout,
  handleWebDataGetRoot,
  handleWebDiaryList,
  handleWebEmbeddingReadiness,
  handleWebI18nGetAllResources,
  handleWebI18nGetLocale,
  handleWebI18nSetLocale,
  handleWebI18nT,
  handleWebMemoryList,
  handleWebSessionList,
  handleWebSessionSwitch,
  handleWebSettingsGet,
  handleWebSettingsSet,
  handleWebStateGet,
} from './runtime'
import { handleWebChatStart, handleWebContextBuild, type WebContextBuildArgs } from './chatRuntime'
import { defaultWebEventSink } from './events'
import type { AppSettings } from '../../shared/types'
import type { Locale } from '../i18n/types'
import type { WebEventSink, WebHandlerRegistry, WebInvokeHandler } from './types'

export const WEB_UNSUPPORTED_CHANNELS = [
  'dialog:selectFiles',
  'shell:openData',
  'ui:*',
  'pet:*',
  'update:*',
] as const

function assertPlainObject(value: unknown, channel: string): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  throw Object.assign(new Error(`${channel} expects an object argument`), {
    code: 'INVALID_ARGUMENT',
  })
}

function assertArray(value: unknown, channel: string): unknown[] {
  if (Array.isArray(value)) return value
  throw Object.assign(new Error(`${channel} expects an array argument`), {
    code: 'INVALID_ARGUMENT',
  })
}

export function createDefaultWebHandlerRegistry(eventSink: WebEventSink = defaultWebEventSink): WebHandlerRegistry {
  const registry: WebHandlerRegistry = new Map<string, WebInvokeHandler>()

  registry.set('settings:get', () => handleWebSettingsGet())
  registry.set('settings:set', (patch) =>
    handleWebSettingsSet(assertPlainObject(patch, 'settings:set') as Partial<AppSettings>)
  )

  registry.set('data:getRoot', () => handleWebDataGetRoot())
  registry.set('data:ensureLayout', () => handleWebDataEnsureLayout())

  registry.set('chat:loadHistory', () => handleWebChatLoadHistory())
  registry.set('chat:saveHistory', (rows) => handleWebChatSaveHistory(assertArray(rows, 'chat:saveHistory')))
  registry.set('context:build', (args) =>
    handleWebContextBuild(assertPlainObject(args, 'context:build') as WebContextBuildArgs)
  )
  registry.set('chat:start', (payload) =>
    handleWebChatStart(assertPlainObject(payload, 'chat:start'), eventSink)
  )

  registry.set('state:get', () => handleWebStateGet())
  registry.set('session:list', () => handleWebSessionList())
  registry.set('session:switch', (sessionId) => handleWebSessionSwitch(String(sessionId || '')))
  registry.set('memory:list', () => handleWebMemoryList())
  registry.set('diary:list', () => handleWebDiaryList())
  registry.set('archive:list', () => handleWebArchiveList())
  registry.set('embedding:readiness', () => handleWebEmbeddingReadiness())
  registry.set('i18n:t', (key, params) =>
    handleWebI18nT(String(key || ''), params as Record<string, string | number> | undefined)
  )
  registry.set('i18n:getLocale', () => handleWebI18nGetLocale())
  registry.set('i18n:setLocale', (locale) => handleWebI18nSetLocale(locale as Locale))
  registry.set('i18n:getAllResources', () => handleWebI18nGetAllResources())

  return registry
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

export function getWebCapabilities(
  registry: WebHandlerRegistry,
  host = '127.0.0.1'
): AckemWebCapabilities {
  return {
    runtime: 'web',
    singleUser: true,
    localOnly: isLoopbackHost(host),
    invokePath: ACKEM_WEB_INVOKE_PATH,
    eventsPath: ACKEM_WEB_EVENTS_PATH,
    channels: [...registry.keys()].sort(),
    unsupportedChannels: [...WEB_UNSUPPORTED_CHANNELS],
  }
}

export function isInvokeRequest(value: unknown): value is AckemWebInvokeRequest {
  if (!value || typeof value !== 'object') return false
  const req = value as AckemWebInvokeRequest
  return typeof req.channel === 'string' && (req.args === undefined || Array.isArray(req.args))
}

function normalizeInvokeError(error: unknown): AckemWebInvokeError {
  const err = error as { message?: unknown; code?: unknown; stack?: unknown }
  return {
    message:
      typeof err?.message === 'string' && err.message.trim()
        ? err.message
        : String(error || 'Unknown invoke error'),
    code: typeof err?.code === 'string' ? err.code : undefined,
    stack:
      process.env.NODE_ENV === 'production'
        ? undefined
        : typeof err?.stack === 'string'
          ? err.stack
          : undefined,
  }
}

export async function invokeWebHandler(
  registry: WebHandlerRegistry,
  request: AckemWebInvokeRequest
): Promise<AckemWebInvokeResponse> {
  const handler = registry.get(request.channel)
  if (!handler) {
    return {
      ok: false,
      id: request.id,
      error: {
        message: `Unsupported invoke channel: ${request.channel}`,
        code: 'CHANNEL_NOT_FOUND',
      },
    }
  }

  try {
    const result = await handler(...(request.args ?? []))
    return { ok: true, id: request.id, result }
  } catch (error) {
    return {
      ok: false,
      id: request.id,
      error: normalizeInvokeError(error),
    }
  }
}
