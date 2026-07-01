import type {
  AckemWebCapabilities,
  AckemWebInvokeError,
  AckemWebInvokeRequest,
  AckemWebInvokeResponse,
} from '../../shared/webTransport'
import {
  buildWebCapabilities,
  createWebChannelError,
  findWebChannelContract,
} from './contracts'
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
import {
  handleWebChatStart,
  handleWebContextBuild,
  registerWebChatProbeHandlers,
  type WebContextBuildArgs,
} from './chatRuntime'
import { defaultWebEventSink } from './events'
import { registerWebChannelWorkflowHandlers } from './services/channelWorkflowService'
import { registerWebDataWorkflowHandlers } from './services/dataWorkflowService'
import { registerWebEmbeddingWorkflowHandlers } from './services/embeddingWorkflowService'
import { registerWebExtensionWorkflowHandlers } from './services/extensionWorkflowService'
import { registerWebGamemodeWorkflowHandlers } from './services/gamemodeWorkflowService'
import { handleWebImportFromPath, type WebImportFromPathInput } from './services/importService'
import { registerWebOpenForUWorkflowHandlers } from './services/openforuWorkflowService'
import { registerWebSystemWorkflowHandlers } from './services/systemWorkflowService'
import { registerWebVoiceWorkflowHandlers } from './services/voiceWorkflowService'
import type { AppSettings } from '../../shared/types'
import type { Locale } from '../i18n/types'
import type { WebEventSink, WebHandlerRegistry, WebInvokeHandler } from './types'

export const WEB_UNSUPPORTED_CHANNELS = [
  'dialog:selectFiles',
  'shell:openData',
  'app:reload',
  'surface:*',
  'ui:*',
  'pet:*',
  'tray:*',
  'openforu:surface:open',
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
  registry.set('import:fromPath', (input) => handleWebImportFromPath(input as WebImportFromPathInput))
  registry.set('import:files', (paths) => handleWebImportFromPath(paths as WebImportFromPathInput))
  registerWebChatProbeHandlers(registry)
  registerWebDataWorkflowHandlers(registry)
  registerWebEmbeddingWorkflowHandlers(registry)
  registerWebSystemWorkflowHandlers(registry)
  registerWebVoiceWorkflowHandlers(registry)
  registerWebChannelWorkflowHandlers(registry)
  registerWebExtensionWorkflowHandlers(registry)
  registerWebGamemodeWorkflowHandlers(registry)
  registerWebOpenForUWorkflowHandlers(registry, eventSink)

  return registry
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

export function getWebCapabilities(
  registry: WebHandlerRegistry,
  host = '127.0.0.1'
): AckemWebCapabilities {
  return buildWebCapabilities(registry, isLoopbackHost(host))
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
    channel: typeof (err as { channel?: unknown })?.channel === 'string' ? (err as { channel: string }).channel : undefined,
    status:
      (err as { status?: unknown })?.status === 'supported' ||
      (err as { status?: unknown })?.status === 'electronWindowOnly' ||
      (err as { status?: unknown })?.status === 'pending'
        ? ((err as { status: AckemWebInvokeError['status'] }).status)
        : undefined,
    replacement:
      typeof (err as { replacement?: unknown })?.replacement === 'string'
        ? (err as { replacement: string }).replacement
        : undefined,
    details:
      (err as { details?: unknown })?.details &&
      typeof (err as { details?: unknown }).details === 'object' &&
      !Array.isArray((err as { details?: unknown }).details)
        ? ((err as { details: Record<string, unknown> }).details)
        : undefined,
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
    const contract = findWebChannelContract(request.channel)
    if (contract && contract.status !== 'supported') {
      return {
        ok: false,
        id: request.id,
        error: normalizeInvokeError(createWebChannelError(request.channel, contract.status)),
      }
    }
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
