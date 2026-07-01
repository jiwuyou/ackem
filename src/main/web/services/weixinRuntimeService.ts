import { loadChatHistoryFromDb, saveChatHistoryToDb } from '../../db/repos/chatHistory'
import {
  extractTextFromMessage,
  fetchTypingTicket,
  fetchUpdates,
  isStaleWeixinToken,
  notifyWeixinStart,
  notifyWeixinStop,
  sendWeixinMessage,
  sendWeixinTyping,
} from '../../channels/weixin/api'
import { ensureActivityBaselines, recordWeixinAckemActivity } from '../../channels/weixin/activity'
import { enqueuePeerTurn } from '../../channels/weixin/queue'
import {
  loadContextToken,
  loadSyncBuf,
  loadWeixinAccount,
  markMessageSeen,
  normalizePeerSessionId,
  saveContextToken,
  saveSyncBuf,
} from '../../channels/weixin/store'
import type { WeixinAccount, WeixinMessage } from '../../channels/weixin/types'
import { createLogger } from '../../logger'
import { handleWebChatStart, handleWebContextBuild } from '../chatRuntime'
import { loadWebSettings } from '../runtime'
import type { WebEventSink } from '../types'

const log = createLogger('web-weixin-runtime')

export type WebWeixinRuntimeStatus = {
  connected: boolean
  enabled: boolean
  polling: boolean
  proactiveEnabled: boolean
  accountId?: string
  userId?: string
  lastError?: string | null
  tokenExpired: boolean
}

type WebWeixinMonitorHandle = {
  stop: () => void
  isRunning: () => boolean
}

let monitor: WebWeixinMonitorHandle | null = null
let lastError: string | null = null
let tokenExpired = false
let eventSink: WebEventSink | null = null

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function configureWebWeixinRuntime(sink: WebEventSink): void {
  eventSink = sink
}

function emitStatus(dataRoot: string): void {
  eventSink?.send('weixin:status-changed', getWebWeixinRuntimeStatus(dataRoot))
}

export function getWebWeixinRuntimeStatus(dataRoot: string): WebWeixinRuntimeStatus {
  const settings = loadWebSettings()
  const account = loadWeixinAccount(dataRoot)
  return {
    connected: Boolean(account?.token),
    enabled: settings.weixinChannelEnabled === true,
    polling: monitor?.isRunning() ?? false,
    proactiveEnabled: settings.weixinProactiveEnabled !== false,
    accountId: account?.accountId,
    userId: account?.userId,
    lastError,
    tokenExpired,
  }
}

async function typing(
  account: WeixinAccount,
  peerId: string,
  contextToken: string | undefined,
  status: 1 | 2
): Promise<void> {
  try {
    const ticket = await fetchTypingTicket({
      token: account.token,
      baseUrl: account.baseUrl,
      ilinkUserId: peerId,
      contextToken,
    })
    if (!ticket) return
    await sendWeixinTyping({
      token: account.token,
      baseUrl: account.baseUrl,
      ilinkUserId: peerId,
      typingTicket: ticket,
      status,
    })
  } catch {
    /* typing state is best effort */
  }
}

function formatWeixinText(raw: string, maxLen = 3800): string {
  let text = raw
    .replace(/\[(?:SPLIT|emoji:[^\]]+|sticker:[a-zA-Z0-9_-]+)\]/gi, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '- ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (!text) text = '...'
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen - 1)}...`
}

async function sendTextReply(args: {
  account: WeixinAccount
  peerId: string
  contextToken?: string
  text: string
  dataRoot: string
}): Promise<void> {
  const text = formatWeixinText(args.text)
  await typing(args.account, args.peerId, args.contextToken, 1)
  const res = await sendWeixinMessage({
    token: args.account.token,
    baseUrl: args.account.baseUrl,
    toUserId: args.peerId,
    text,
    contextToken: args.contextToken,
  })
  if (res.ret !== 0) log.warn('send failed', { ret: res.ret, errmsg: res.errmsg })
  await typing(args.account, args.peerId, args.contextToken, 2)
  recordWeixinAckemActivity(args.dataRoot)
}

function loadRecentMessages(
  dataRoot: string,
  sessionId: string,
  limit = 24
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const raw = loadChatHistoryFromDb(dataRoot, sessionId)
  const rows = Array.isArray(raw) ? raw : []
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const item = row as { kind?: string; role?: string; content?: string }
    if (item.kind !== 'message') continue
    if (item.role !== 'user' && item.role !== 'assistant') continue
    if (!item.content?.trim()) continue
    messages.push({ role: item.role, content: item.content })
  }
  return messages.slice(-limit)
}

function appendChatHistory(dataRoot: string, sessionId: string, userText: string, assistantText: string): void {
  const rows = loadChatHistoryFromDb(dataRoot, sessionId)
  const next = Array.isArray(rows) ? rows.slice() : []
  next.push({ kind: 'message', role: 'user', content: userText })
  next.push({ kind: 'message', role: 'assistant', content: assistantText })
  saveChatHistoryToDb(dataRoot, sessionId, next.slice(-2000))
}

async function runWebWeixinTurn(args: {
  sessionId: string
  userText: string
  recentMessages: Array<{ role: 'user' | 'assistant'; content: string }>
}): Promise<string> {
  const context = await handleWebContextBuild({
    userText: args.userText,
    recentMessages: args.recentMessages,
    sessionId: args.sessionId,
    systemHint: 'This turn came from WeChat. Reply naturally and concisely for a mobile chat.',
  })

  let assistantText = ''
  let errorText = ''
  await handleWebChatStart(
    {
      settings: loadWebSettings(),
      messages: context.messages,
      turnId: context.turnId,
      sessionId: args.sessionId,
      useWaveChat: false,
    },
    {
      send: (channel, payload) => {
        if (channel === 'chat:done' && payload && typeof payload === 'object') {
          const text = (payload as { assistantText?: unknown }).assistantText
          assistantText = typeof text === 'string' ? text : ''
        } else if (channel === 'chat:error') {
          errorText = typeof payload === 'string' ? payload : JSON.stringify(payload)
        }
      },
    }
  )

  if (errorText) throw new Error(errorText)
  return assistantText.trim() || '...'
}

function enqueueInboundMessage(msg: WeixinMessage, account: WeixinAccount, dataRoot: string): void {
  if (msg.message_type !== 1) return
  const peerId = msg.from_user_id
  if (!peerId) return
  if (msg.message_id != null && markMessageSeen(dataRoot, msg.message_id)) return

  if (msg.context_token) saveContextToken(dataRoot, peerId, msg.context_token)
  recordWeixinAckemActivity(dataRoot)

  void enqueuePeerTurn(peerId, () => handleInboundMessage(msg, account, dataRoot))
}

async function handleInboundMessage(
  msg: WeixinMessage,
  account: WeixinAccount,
  dataRoot: string
): Promise<void> {
  const peerId = msg.from_user_id
  if (!peerId) return
  const contextToken = msg.context_token ?? loadContextToken(dataRoot, peerId) ?? undefined
  const text = extractTextFromMessage(msg)

  if (!text) {
    await sendTextReply({
      account,
      peerId,
      contextToken,
      text: '我暂时只能读懂文字消息哦，直接打字给我就好。',
      dataRoot,
    })
    return
  }

  const sessionId = normalizePeerSessionId(peerId)
  const recentMessages = loadRecentMessages(dataRoot, sessionId)
  let assistantText = ''
  try {
    assistantText = await runWebWeixinTurn({ sessionId, userText: text, recentMessages })
  } catch (error) {
    log.error('turn failed', error)
    assistantText = error instanceof Error && /api|key|model|configured/i.test(error.message)
      ? '我这边还没配置好对话模型，请先在 Ackem 设置里填好 API。'
      : '刚才有点卡，你再发一次好吗？'
  }

  appendChatHistory(dataRoot, sessionId, text, assistantText)
  await sendTextReply({ account, peerId, contextToken, text: assistantText, dataRoot })
}

function startMonitor(account: WeixinAccount, dataRoot: string): WebWeixinMonitorHandle {
  let aborted = false
  let running = false
  let consecutiveFailures = 0
  const abortController = new AbortController()

  const loop = async () => {
    running = true
    emitStatus(dataRoot)
    let buf = loadSyncBuf(dataRoot, account.accountId)
    let nextTimeout = 35_000
    log.info('poll loop started', { accountId: account.accountId })

    while (!aborted) {
      try {
        const resp = await fetchUpdates({
          token: account.token,
          baseUrl: account.baseUrl,
          getUpdatesBuf: buf,
          timeoutMs: nextTimeout,
          abortSignal: abortController.signal,
        })
        if (aborted) break

        if (isStaleWeixinToken(resp)) {
          tokenExpired = true
          lastError = 'token_expired'
          break
        }

        if (resp.ret != null && resp.ret !== 0) {
          lastError = `getupdates:${resp.ret}`
          consecutiveFailures += 1
          log.warn('getupdates api error', { ret: resp.ret, errmsg: resp.errmsg })
          await sleep(consecutiveFailures >= 3 ? 30_000 : 2_000)
          continue
        }

        nextTimeout = resp.longpolling_timeout_ms ?? 35_000
        if (resp.get_updates_buf) {
          saveSyncBuf(dataRoot, account.accountId, resp.get_updates_buf)
          buf = resp.get_updates_buf
        }

        for (const inbound of resp.msgs ?? []) {
          enqueueInboundMessage(inbound, account, dataRoot)
        }
        consecutiveFailures = 0
      } catch (error) {
        if (aborted) break
        consecutiveFailures += 1
        lastError = error instanceof Error ? error.message : String(error)
        log.error('poll error', error)
        await sleep(consecutiveFailures >= 3 ? 30_000 : 2_000)
      }
    }

    running = false
    if (tokenExpired) void stopWebWeixinChannel(dataRoot)
    emitStatus(dataRoot)
    log.info('poll loop stopped', { accountId: account.accountId })
  }

  void loop()

  return {
    stop: () => {
      aborted = true
      abortController.abort()
    },
    isRunning: () => running && !aborted,
  }
}

export async function startWebWeixinChannel(dataRoot: string): Promise<void> {
  if (loadWebSettings().weixinChannelEnabled !== true) {
    await stopWebWeixinChannel(dataRoot)
    return
  }

  const account = loadWeixinAccount(dataRoot)
  if (!account?.token) {
    lastError = 'weixin_account_not_bound'
    emitStatus(dataRoot)
    return
  }

  await stopWebWeixinChannel(dataRoot)
  tokenExpired = false
  lastError = null

  const notify = await notifyWeixinStart(account.token, account.baseUrl)
  if (notify.ret !== 0) {
    lastError = `notifystart:${notify.ret}`
    log.warn('notifystart returned non-zero', notify)
  }

  monitor = startMonitor(account, dataRoot)
  ensureActivityBaselines(dataRoot)
  emitStatus(dataRoot)
}

export async function stopWebWeixinChannel(dataRoot?: string): Promise<void> {
  const account = dataRoot ? loadWeixinAccount(dataRoot) : null
  monitor?.stop()
  monitor = null
  if (account?.token) {
    await notifyWeixinStop(account.token, account.baseUrl)
  }
  if (dataRoot) emitStatus(dataRoot)
}

export async function restartWebWeixinChannel(dataRoot: string): Promise<void> {
  if (loadWebSettings().weixinChannelEnabled !== true) {
    await stopWebWeixinChannel(dataRoot)
    return
  }
  await startWebWeixinChannel(dataRoot)
}

export async function onWebWeixinAccountSaved(dataRoot: string): Promise<void> {
  tokenExpired = false
  lastError = null
  if (loadWebSettings().weixinChannelEnabled === true) {
    await startWebWeixinChannel(dataRoot)
  } else {
    emitStatus(dataRoot)
  }
}

export function clearWebWeixinRuntimeError(dataRoot: string): void {
  lastError = null
  tokenExpired = false
  emitStatus(dataRoot)
}

export function setWebWeixinRuntimeError(dataRoot: string, error: string | null): void {
  lastError = error
  tokenExpired = false
  emitStatus(dataRoot)
}
