import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { currentWebDataRoot } from '../runtime'
import type { WebHandlerRegistry, WebInvokeHandler } from '../types'

type McGameEvent = {
  type: string
  raw: string
  timestamp: string
  payload?: Record<string, unknown>
}

type ReactionResult = {
  text: string
  isEasterEgg: boolean
  emotionGroup: 'CALM' | 'AROUSED' | 'NEGATIVE'
}

type GamemodeState = {
  version: 1
  activeGameId: string | null
  activatedAt?: string
  lastConfig?: Record<string, unknown>
  bot: {
    requested: boolean
    running: boolean
    config?: Record<string, unknown>
    lastError?: string
  }
  log: {
    requested: boolean
    active: boolean
    path?: string
    lastError?: string
  }
  eventsReceived: number
  reactionsSent: number
  lastEventAt?: string
}

const MINECRAFT_RPC_METHODS = [
  'react',
  'parseLog',
  'getWsStatus',
  'syncEngineState',
  'botStart',
  'botStop',
  'botStatus',
  'botDebug',
  'logStart',
  'logStop',
  'logStatus',
]

const MINECRAFT_MANIFEST = {
  id: 'ackem/mc-companion@0.2.0',
  name: 'Minecraft Companion',
  version: '0.2.0',
  category: 'gamemode',
  gameId: 'minecraft',
  gameName: 'Minecraft',
  eventSources: ['log_file', 'manual', 'websocket'],
  description:
    'Web-safe Minecraft companion facade: event parsing and local status are available; real bot, log tailing, and WebSocket game bridge are not started by Ackem Web.',
  author: 'JasonLiu0826',
  license: 'AGPL-3.0',
  main: 'web-gamemode-placeholder',
  engineVersion: '0.1.0',
  tags: ['minecraft', 'gaming', 'companion', 'web'],
  recommendedPersonalityTags: ['loyal', 'warm', 'energetic'],
  rpcMethods: [...MINECRAFT_RPC_METHODS],
}

function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return fallback
  }
}

function runtimeDir(): string {
  const root = currentWebDataRoot()
  const dir = join(root, '_derived', 'web-runtime')
  mkdirSync(dir, { recursive: true })
  return dir
}

function statePath(): string {
  return join(runtimeDir(), 'gamemode-workflow-state.json')
}

function emptyState(): GamemodeState {
  return {
    version: 1,
    activeGameId: null,
    bot: { requested: false, running: false },
    log: { requested: false, active: false },
    eventsReceived: 0,
    reactionsSent: 0,
  }
}

function loadState(): GamemodeState {
  const parsed = readJson<GamemodeState>(statePath(), emptyState())
  return {
    ...emptyState(),
    ...parsed,
    bot: { ...emptyState().bot, ...(parsed.bot ?? {}) },
    log: { ...emptyState().log, ...(parsed.log ?? {}) },
  }
}

function saveState(state: GamemodeState): void {
  writeFileSync(statePath(), JSON.stringify(state, null, 2), 'utf-8')
}

function stripLogPrefix(line: string): string {
  return line.replace(/^\[.*?\] \[.*?\]: /, '').replace(/^\[.*?\]: /, '')
}

function parseLogLine(line: string): McGameEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  const timeMatch = trimmed.match(/^\[(\d{2}:\d{2}:\d{2})\]/)
  const timestamp = timeMatch ? timeMatch[1] : new Date().toISOString()
  const chatMatch = trimmed.match(/<(.+?)> (.+)/)
  if (chatMatch) {
    const message = chatMatch[2]
    const lower = message.toLowerCase()
    if (/哈哈|hhh|www|lol|lmao|笑死/.test(lower)) {
      return { type: 'mc:player_chat_laugh', raw: trimmed, timestamp, payload: { chatMessage: message } }
    }
    if (/救命|完了|creeper|fuck|shit|苦力怕|我死了/.test(lower)) {
      return { type: 'mc:player_chat_panic', raw: trimmed, timestamp, payload: { chatMessage: message } }
    }
    return {
      type: 'mc:player_chat',
      raw: trimmed,
      timestamp,
      payload: { playerName: chatMatch[1], chatMessage: message },
    }
  }
  if (!/\[Server thread|INFO|WARN|ERROR/i.test(trimmed)) return null
  const eventPart = stripLogPrefix(trimmed)
  const patterns: Array<[RegExp, string, (match: RegExpMatchArray) => Record<string, string> | undefined]> = [
    [/fell out of the world/i, 'mc:death_by_void', () => undefined],
    [/froze to death/i, 'mc:death_by_freeze', () => undefined],
    [/was struck by lightning/i, 'mc:death_by_lightning', () => undefined],
    [/tried to swim in lava|went up in flames|burned to death/i, 'mc:death_by_lava', () => undefined],
    [/drowned/i, 'mc:death_by_drown', () => undefined],
    [/fell from a high place|hit the ground too hard/i, 'mc:death_by_fall', () => undefined],
    [/blew up|was slain by Creeper/i, 'mc:death_by_creeper', () => ({ mobType: 'Creeper' })],
    [
      /has (?:made the advancement|completed the challenge|reached the goal) \[(.+?)\]/i,
      'mc:achievement_unlock',
      (match) => ({ achievementName: match[1] }),
    ],
    [/entered the Nether/i, 'mc:dimension_nether_enter', () => ({ dimensionName: 'the Nether' })],
    [/entered the End/i, 'mc:dimension_end_enter', () => ({ dimensionName: 'the End' })],
    [/entered the Overworld|left the (Nether|End)/i, 'mc:dimension_overworld_return', () => ({ dimensionName: 'the Overworld' })],
    [/Raid (?:has been )?defeated/i, 'mc:raid_victory', () => undefined],
    [/A Raid has begun/i, 'mc:raid_start', () => undefined],
    [/slain the Ender Dragon/i, 'mc:dragon_defeat', () => undefined],
    [/slain the Wither/i, 'mc:wither_defeat', () => undefined],
    [/joined the game/i, 'mc:player_return', () => undefined],
    [/left the game/i, 'mc:player_afk_30s', () => undefined],
  ]
  for (const [regex, type, extract] of patterns) {
    const match = eventPart.match(regex)
    if (match) {
      const payload = extract(match)
      return { type, raw: trimmed, timestamp, payload }
    }
  }
  return null
}

function reactionForEvent(event: McGameEvent): ReactionResult {
  const type = event.type.toLowerCase()
  if (type.includes('achievement') || type.includes('victory') || type.includes('defeat')) {
    return {
      text: 'Nice. I saw that Minecraft milestone and saved the context locally.',
      isEasterEgg: false,
      emotionGroup: 'AROUSED',
    }
  }
  if (type.includes('death') || type.includes('panic') || type.includes('lava') || type.includes('creeper')) {
    return {
      text: 'That looked dangerous. Ackem Web can react to the event, but the real Minecraft bot is not running here.',
      isEasterEgg: false,
      emotionGroup: 'NEGATIVE',
    }
  }
  return {
    text: 'Minecraft event received. Ackem Web is in local status mode, so no bot action was sent.',
    isEasterEgg: false,
    emotionGroup: 'CALM',
  }
}

function handleReact(event: unknown): ReactionResult {
  const parsed = event as Partial<McGameEvent> | null | undefined
  const mcEvent: McGameEvent = {
    type: typeof parsed?.type === 'string' ? parsed.type : 'mc:game_event',
    raw: typeof parsed?.raw === 'string' ? parsed.raw : '',
    timestamp: typeof parsed?.timestamp === 'string' ? parsed.timestamp : new Date().toISOString(),
    payload:
      parsed?.payload && typeof parsed.payload === 'object' && !Array.isArray(parsed.payload)
        ? parsed.payload as Record<string, unknown>
        : undefined,
  }
  const state = loadState()
  state.eventsReceived += 1
  state.reactionsSent += 1
  state.lastEventAt = new Date().toISOString()
  saveState(state)
  return reactionForEvent(mcEvent)
}

function handleStatus(): Record<string, unknown> {
  const state = loadState()
  return {
    gameId: state.activeGameId,
    status: state.activeGameId
      ? {
          connected: false,
          gameRunning: false,
          eventsReceived: state.eventsReceived,
          reactionsSent: state.reactionsSent,
          lastEventAt: state.lastEventAt,
          errors: [
            'Ackem Web exposes local Minecraft status and parsing only; no game WebSocket, log tail, or bot process is running.',
          ],
        }
      : null,
  }
}

function handleActivate(gameId: unknown, config: unknown): { ok: boolean; error?: string } {
  if (gameId !== 'minecraft') return { ok: false, error: `Game provider is not available in Ackem Web: ${String(gameId)}` }
  const state = loadState()
  state.activeGameId = 'minecraft'
  state.activatedAt = new Date().toISOString()
  state.lastConfig =
    config && typeof config === 'object' && !Array.isArray(config) ? config as Record<string, unknown> : {}
  saveState(state)
  return { ok: true }
}

function handleDeactivate(): { ok: boolean } {
  const state = loadState()
  state.activeGameId = null
  state.bot.running = false
  state.log.active = false
  saveState(state)
  return { ok: true }
}

function handleWsStatus(): Record<string, unknown> {
  const state = loadState()
  const configuredPort =
    typeof state.lastConfig?.wsPort === 'number' && Number.isFinite(state.lastConfig.wsPort)
      ? state.lastConfig.wsPort
      : 19532
  return {
    running: false,
    wsPort: configuredPort,
    wsClients: 0,
    logPath: state.log.path,
    mode: 'web-placeholder',
    error: 'Minecraft WebSocket bridge is not started in Ackem Web.',
  }
}

function handleBotStart(cfg: unknown): Record<string, unknown> {
  const state = loadState()
  state.bot = {
    requested: true,
    running: false,
    config: cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg as Record<string, unknown> : {},
    lastError: 'Minecraft bot startup is not available in Ackem Web.',
  }
  saveState(state)
  return {
    ok: false,
    error: state.bot.lastError,
    requested: state.bot.config,
  }
}

function handleBotStop(): { ok: boolean; stopped: boolean } {
  const state = loadState()
  const stopped = state.bot.running
  state.bot.running = false
  saveState(state)
  return { ok: true, stopped }
}

function handleBotStatus(): Record<string, unknown> {
  const state = loadState()
  return {
    connected: false,
    username: typeof state.bot.config?.username === 'string' ? state.bot.config.username : undefined,
    wsConnected: false,
    requested: state.bot.requested,
    error: state.bot.lastError,
  }
}

function handleLogStart(logPath: unknown): Record<string, unknown> {
  const state = loadState()
  state.log = {
    requested: true,
    active: false,
    path: typeof logPath === 'string' ? logPath : '',
    lastError: 'Minecraft log tailing is not available in Ackem Web.',
  }
  saveState(state)
  return { ok: false, path: state.log.path, error: state.log.lastError }
}

function handleLogStop(): { ok: boolean; stopped: boolean } {
  const state = loadState()
  const stopped = state.log.active
  state.log.active = false
  saveState(state)
  return { ok: true, stopped }
}

function handleLogStatus(): Record<string, unknown> {
  const state = loadState()
  return {
    active: false,
    requested: state.log.requested,
    path: state.log.path,
    error: state.log.lastError,
  }
}

function handleGamemodeInvoke(req: unknown): Record<string, unknown> {
  const payload = req as { gameId?: unknown; method?: unknown; params?: unknown } | null | undefined
  if (payload?.gameId !== 'minecraft') {
    return { ok: false, error: `Game provider is not available in Ackem Web: ${String(payload?.gameId)}` }
  }
  const method = typeof payload.method === 'string' ? payload.method : ''
  const params = payload.params && typeof payload.params === 'object' ? payload.params as Record<string, unknown> : {}
  switch (method) {
    case 'react':
      return { ok: true, data: handleReact(params.event) }
    case 'parseLog':
      return { ok: true, data: parseLogLine(String(params.line ?? '')) }
    case 'getWsStatus':
      return { ok: true, data: handleWsStatus() }
    case 'syncEngineState':
      return { ok: true, data: { ok: true, mode: 'web-placeholder' } }
    case 'botStart':
      return { ok: false, error: 'Minecraft bot startup is not available in Ackem Web.', data: handleBotStart(params) }
    case 'botStop':
      return { ok: true, data: handleBotStop() }
    case 'botStatus':
      return { ok: true, data: handleBotStatus() }
    case 'botDebug':
      return { ok: true, data: null }
    case 'logStart':
      return { ok: false, error: 'Minecraft log tailing is not available in Ackem Web.', data: handleLogStart(params.logPath) }
    case 'logStop':
      return { ok: true, data: handleLogStop() }
    case 'logStatus':
      return { ok: true, data: handleLogStatus() }
    default:
      return { ok: false, error: `Minecraft RPC is not available in Ackem Web: ${method}` }
  }
}

const gamemodeHandlers: Array<[string, WebInvokeHandler]> = [
  ['ext:gamemode:list', () => [MINECRAFT_MANIFEST]],
  ['ext:gamemode:activate', (gameId, config) => handleActivate(gameId, config)],
  ['ext:gamemode:deactivate', () => handleDeactivate()],
  ['ext:gamemode:status', () => handleStatus()],
  ['ext:gamemode:invoke', (req) => handleGamemodeInvoke(req)],
  ['mc:react', (event) => handleReact(event)],
  ['mc:parseLog', (line) => parseLogLine(String(line ?? ''))],
  ['mc:status', () => handleWsStatus()],
  ['mc:setEngineState', () => ({ ok: true, mode: 'web-placeholder' })],
  ['mc:botStart', (cfg) => handleBotStart(cfg)],
  ['mc:botStop', () => handleBotStop()],
  ['mc:botStatus', () => handleBotStatus()],
  ['mc:botDebug', () => null],
  ['mc:logStart', (logPath) => handleLogStart(logPath)],
  ['mc:logStop', () => handleLogStop()],
  ['mc:logStatus', () => handleLogStatus()],
]

export function registerWebGamemodeWorkflowHandlers(registry: WebHandlerRegistry): void {
  for (const [channel, handler] of gamemodeHandlers) registry.set(channel, handler)
}
