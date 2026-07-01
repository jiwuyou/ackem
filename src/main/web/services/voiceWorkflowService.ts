import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ensureDataLayout } from '../../layout'
import { currentWebDataRoot } from '../runtime'
import type { WebHandlerRegistry, WebInvokeHandler } from '../types'

type WebVoiceMode = 'vad' | 'ptt' | 'off'
type WebVoiceInputChannel = 'dual' | 'voice-only' | 'text-only'

type WebVoiceHealth = {
  asr_ready: boolean
  tts_ready: boolean
  tts_engine: string
  tts_model_loaded: boolean
  gpu_available: boolean
  gpu_name: string
  port: number
  piper_voices?: Array<{ id: string; label: string; language: string }>
  gpt_sovits_voices?: Array<{ id: string; label: string; language: string }>
}

type WebVoiceEnvReport = {
  ready: boolean
  python: {
    ok: boolean
    source: 'bundled' | 'system' | 'missing'
    path?: string
    version?: string
    message: string
  }
  scriptOk: boolean
  scriptPath: string
  dependenciesOk: boolean
  missingDependencies: string[]
  serviceRunning: boolean
  canAutoInstall: boolean
  summary: string
  detail: string
}

type WebVoiceState = {
  version: 1
  mode: WebVoiceMode
  inputChannel: WebVoiceInputChannel
  pttActive: boolean
  theaterSession: boolean
  settings: Record<string, unknown>
  audioChunksReceived: number
  lastAudioChunkAt: string | null
  lastRestartAt: string | null
  lastCancelTtsAt: string | null
}

export const WEB_VOICE_WORKFLOW_CHANNELS = [
  'voice:audio-chunk',
  'voice:cancel-tts',
  'voice:set-mode',
  'voice:set-input-channel',
  'voice:apply-settings',
  'voice:restart-service',
  'voice:ptt-active',
  'voice:check-environment',
  'voice:install-environment',
  'voice:set-theater-session',
  'voice:health',
] as const

function defaultVoiceState(): WebVoiceState {
  return {
    version: 1,
    mode: 'off',
    inputChannel: 'dual',
    pttActive: false,
    theaterSession: false,
    settings: {},
    audioChunksReceived: 0,
    lastAudioChunkAt: null,
    lastRestartAt: null,
    lastCancelTtsAt: null,
  }
}

function rootWithLayout(): string {
  const root = currentWebDataRoot()
  ensureDataLayout(root)
  return root
}

function statePath(root: string): string {
  return join(root, '_derived', 'web-voice-state.json')
}

function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return fallback
  }
}

function normalizeMode(value: unknown): WebVoiceMode {
  return value === 'vad' || value === 'ptt' || value === 'off' ? value : 'off'
}

function normalizeInputChannel(value: unknown): WebVoiceInputChannel {
  return value === 'dual' || value === 'voice-only' || value === 'text-only' ? value : 'dual'
}

function normalizeState(input: Partial<WebVoiceState> | null | undefined): WebVoiceState {
  const base = defaultVoiceState()
  return {
    version: 1,
    mode: normalizeMode(input?.mode ?? base.mode),
    inputChannel: normalizeInputChannel(input?.inputChannel ?? base.inputChannel),
    pttActive: input?.pttActive === true,
    theaterSession: input?.theaterSession === true,
    settings:
      input?.settings && typeof input.settings === 'object' && !Array.isArray(input.settings)
        ? input.settings
        : {},
    audioChunksReceived:
      typeof input?.audioChunksReceived === 'number' && Number.isFinite(input.audioChunksReceived)
        ? Math.max(0, Math.trunc(input.audioChunksReceived))
        : 0,
    lastAudioChunkAt: typeof input?.lastAudioChunkAt === 'string' ? input.lastAudioChunkAt : null,
    lastRestartAt: typeof input?.lastRestartAt === 'string' ? input.lastRestartAt : null,
    lastCancelTtsAt: typeof input?.lastCancelTtsAt === 'string' ? input.lastCancelTtsAt : null,
  }
}

function loadVoiceState(root = rootWithLayout()): WebVoiceState {
  return normalizeState(readJson<Partial<WebVoiceState> | null>(statePath(root), null))
}

function saveVoiceState(root: string, state: WebVoiceState): WebVoiceState {
  mkdirSync(dirname(statePath(root)), { recursive: true })
  const normalized = normalizeState(state)
  writeFileSync(statePath(root), JSON.stringify(normalized, null, 2), 'utf-8')
  return normalized
}

function mutateVoiceState(fn: (state: WebVoiceState) => WebVoiceState | void): WebVoiceState {
  const root = rootWithLayout()
  const state = loadVoiceState(root)
  const next = fn(state) ?? state
  return saveVoiceState(root, next)
}

function plainPatch(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function unavailableHealth(): WebVoiceHealth {
  return {
    asr_ready: false,
    tts_ready: false,
    tts_engine: 'none',
    tts_model_loaded: false,
    gpu_available: false,
    gpu_name: '',
    port: 0,
    piper_voices: [],
    gpt_sovits_voices: [],
  }
}

export function handleWebVoiceHealth(): WebVoiceHealth {
  return unavailableHealth()
}

export function handleWebVoiceCheckEnvironment(): WebVoiceEnvReport {
  return {
    ready: false,
    python: {
      ok: false,
      source: 'missing',
      message: 'Voice service is not configured for Ackem Web runtime.',
    },
    scriptOk: false,
    scriptPath: '',
    dependenciesOk: false,
    missingDependencies: ['web-voice-service'],
    serviceRunning: false,
    canAutoInstall: false,
    summary: 'Web runtime has no configured ASR/TTS backend.',
    detail:
      'Ackem Web keeps voice IPC channels available, but it does not start Python, microphone, GPU, or native audio services.',
  }
}

export function handleWebVoiceApplySettings(patch: unknown): { ok: boolean; state: WebVoiceState } {
  const state = mutateVoiceState((draft) => {
    const nextPatch = plainPatch(patch)
    draft.settings = {
      ...draft.settings,
      ...nextPatch,
    }
    if ('voiceMode' in nextPatch) draft.mode = normalizeMode(nextPatch.voiceMode)
    if ('inputChannel' in nextPatch) draft.inputChannel = normalizeInputChannel(nextPatch.inputChannel)
    if ('enabled' in nextPatch && nextPatch.enabled !== true) draft.mode = 'off'
  })
  return { ok: true, state }
}

export function handleWebVoiceSetMode(mode: unknown): { ok: boolean; mode: WebVoiceMode } {
  const normalized = normalizeMode(mode)
  mutateVoiceState((state) => {
    state.mode = normalized
  })
  return { ok: true, mode: normalized }
}

export function handleWebVoiceSetInputChannel(channel: unknown): { ok: boolean; channel: WebVoiceInputChannel } {
  const normalized = normalizeInputChannel(channel)
  mutateVoiceState((state) => {
    state.inputChannel = normalized
  })
  return { ok: true, channel: normalized }
}

export function handleWebVoiceAudioChunk(buffer: unknown): { ok: boolean; accepted: false; bytes: number } {
  const bytes =
    buffer instanceof ArrayBuffer
      ? buffer.byteLength
      : ArrayBuffer.isView(buffer)
        ? buffer.byteLength
        : 0
  mutateVoiceState((state) => {
    state.audioChunksReceived += 1
    state.lastAudioChunkAt = new Date().toISOString()
  })
  return { ok: true, accepted: false, bytes }
}

export function handleWebVoiceCancelTts(): { ok: boolean } {
  mutateVoiceState((state) => {
    state.lastCancelTtsAt = new Date().toISOString()
  })
  return { ok: true }
}

export function handleWebVoiceRestartService(): { ok: boolean; error: string } {
  mutateVoiceState((state) => {
    state.lastRestartAt = new Date().toISOString()
  })
  return { ok: false, error: 'voice_service_not_configured' }
}

export function handleWebVoicePttActive(active: unknown): { ok: boolean; active: boolean } {
  const next = active === true
  mutateVoiceState((state) => {
    state.pttActive = next
  })
  return { ok: true, active: next }
}

export function handleWebVoiceSetTheaterSession(active: unknown): { ok: boolean; active: boolean } {
  const next = active === true
  mutateVoiceState((state) => {
    state.theaterSession = next
  })
  return { ok: true, active: next }
}

export function handleWebVoiceInstallEnvironment(): { ok: boolean; error: string } {
  return {
    ok: false,
    error: 'voice_auto_install_is_not_available_in_web_runtime',
  }
}

export const webVoiceWorkflowHandlers: Readonly<Record<(typeof WEB_VOICE_WORKFLOW_CHANNELS)[number], WebInvokeHandler>> = {
  'voice:audio-chunk': (buffer) => handleWebVoiceAudioChunk(buffer),
  'voice:cancel-tts': () => handleWebVoiceCancelTts(),
  'voice:set-mode': (mode) => handleWebVoiceSetMode(mode),
  'voice:set-input-channel': (channel) => handleWebVoiceSetInputChannel(channel),
  'voice:apply-settings': (patch) => handleWebVoiceApplySettings(patch),
  'voice:restart-service': () => handleWebVoiceRestartService(),
  'voice:ptt-active': (active) => handleWebVoicePttActive(active),
  'voice:check-environment': () => handleWebVoiceCheckEnvironment(),
  'voice:install-environment': () => handleWebVoiceInstallEnvironment(),
  'voice:set-theater-session': (active) => handleWebVoiceSetTheaterSession(active),
  'voice:health': () => handleWebVoiceHealth(),
}

export function registerWebVoiceWorkflowHandlers(registry: WebHandlerRegistry): void {
  for (const [channel, handler] of Object.entries(webVoiceWorkflowHandlers)) {
    registry.set(channel, handler)
  }
}
