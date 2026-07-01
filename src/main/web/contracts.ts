import {
  ACKEM_WEB_EVENTS_PATH,
  ACKEM_WEB_IMPORT_UPLOAD_COMPAT_PATH,
  ACKEM_WEB_INVOKE_PATH,
  ACKEM_WEB_UPLOAD_IMPORT_PATH,
  ACKEM_WEB_UPLOAD_IMPORT_PATHS,
  type AckemWebCapabilities,
  type AckemWebChannelContract,
  type AckemWebChannelMatrix,
  type AckemWebChannelStatus,
} from '../../shared/webTransport'
import type { WebHandlerRegistry } from './types'

const SUPPORTED: AckemWebChannelContract[] = [
  {
    channel: 'settings:get',
    status: 'supported',
    transport: 'invoke',
    description: 'Load local Web settings.',
  },
  {
    channel: 'settings:set',
    status: 'supported',
    transport: 'invoke',
    description: 'Patch local Web settings.',
  },
  {
    channel: 'data:getRoot',
    status: 'supported',
    transport: 'invoke',
    description: 'Resolve the active local data root.',
  },
  {
    channel: 'data:ensureLayout',
    status: 'supported',
    transport: 'invoke',
    description: 'Create the Ackem data directory layout.',
  },
  {
    channel: 'state:get',
    status: 'supported',
    transport: 'invoke',
    description: 'Load the current engine state snapshot.',
  },
  {
    channel: 'session:list',
    status: 'supported',
    transport: 'invoke',
    description: 'List local chat sessions.',
  },
  {
    channel: 'session:switch',
    status: 'supported',
    transport: 'invoke',
    description: 'Switch the active local chat session.',
  },
  {
    channel: 'chat:loadHistory',
    status: 'supported',
    transport: 'invoke',
    description: 'Load chat history for the active session.',
  },
  {
    channel: 'chat:saveHistory',
    status: 'supported',
    transport: 'invoke',
    description: 'Persist chat history for the active session.',
  },
  {
    channel: 'context:build',
    status: 'supported',
    transport: 'invoke',
    description: 'Build the Web chat context payload.',
  },
  {
    channel: 'chat:start',
    status: 'supported',
    transport: 'invoke',
    description: 'Start a local Web chat turn and stream events over WebSocket.',
  },
  {
    channel: 'embedding:readiness',
    status: 'supported',
    transport: 'invoke',
    description: 'Report embedding readiness for Web chat gating.',
  },
  {
    channel: 'memory:list',
    status: 'supported',
    transport: 'invoke',
    description: 'List active memory facts.',
  },
  {
    channel: 'diary:list',
    status: 'supported',
    transport: 'invoke',
    description: 'List diary entries.',
  },
  {
    channel: 'archive:list',
    status: 'supported',
    transport: 'invoke',
    description: 'List archived memory files.',
  },
  {
    channel: 'i18n:t',
    status: 'supported',
    transport: 'invoke',
    description: 'Translate a renderer i18n key.',
  },
  {
    channel: 'i18n:getLocale',
    status: 'supported',
    transport: 'invoke',
    description: 'Read the active locale.',
  },
  {
    channel: 'i18n:setLocale',
    status: 'supported',
    transport: 'invoke',
    description: 'Set the active locale.',
  },
  {
    channel: 'i18n:getAllResources',
    status: 'supported',
    transport: 'invoke',
    description: 'Load Web renderer i18n resources.',
  },
  {
    channel: 'import:fromPath',
    status: 'supported',
    transport: 'invoke',
    description: 'Stage one or more local/Termux files from an allowed root into data/imports/web.',
  },
  {
    channel: 'import:files',
    status: 'supported',
    transport: 'invoke',
    description: 'Compatibility alias for path-based import staging.',
  },
  {
    channel: 'web:events',
    status: 'supported',
    transport: 'event',
    method: 'WS',
    path: ACKEM_WEB_EVENTS_PATH,
    description: 'Push local Web runtime events to the browser.',
  },
  {
    channel: 'http:uploadImport',
    status: 'supported',
    transport: 'http',
    method: 'POST',
    path: ACKEM_WEB_UPLOAD_IMPORT_PATH,
    description:
      'Stage browser-uploaded files into data/imports/web. Supports raw body with x-ackem-filename and multipart/form-data.',
  },
  {
    channel: 'http:uploadImportCompat',
    status: 'supported',
    transport: 'http',
    method: 'POST',
    path: ACKEM_WEB_IMPORT_UPLOAD_COMPAT_PATH,
    description:
      'Compatibility path for browser upload. Same payload contract as http:uploadImport.',
  },
]

const ELECTRON_WINDOW_ONLY: AckemWebChannelContract[] = [
  {
    channel: 'dialog:selectFiles',
    status: 'electronWindowOnly',
    transport: 'invoke',
    replacement: ACKEM_WEB_UPLOAD_IMPORT_PATH,
    reason: 'Native OS file picker is an Electron window-layer API.',
    description: 'Open a native file picker.',
  },
  {
    channel: 'shell:openData',
    status: 'electronWindowOnly',
    transport: 'invoke',
    replacement: 'data:getRoot',
    reason: 'Browser cannot open a native file manager window.',
    description: 'Open the data root in the OS file manager.',
  },
  {
    channel: 'app:reload',
    status: 'electronWindowOnly',
    transport: 'invoke',
    replacement: 'window.location.reload',
    reason: 'Electron app reload targets a native BrowserWindow.',
    description: 'Reload the Electron renderer window.',
  },
  {
    channel: 'surface:*',
    status: 'electronWindowOnly',
    transport: 'invoke',
    replacement: 'openforu:artifact:preview',
    reason: 'Extension surfaces are Electron BrowserWindow surfaces.',
    description: 'Extension surface BrowserWindow channels.',
  },
  {
    channel: 'ui:*',
    status: 'electronWindowOnly',
    transport: 'invoke',
    reason: 'BrowserWindow control is intentionally not part of the local Web runtime.',
    description: 'Electron window management channels.',
  },
  {
    channel: 'pet:*',
    status: 'electronWindowOnly',
    transport: 'invoke',
    reason: 'The desktop pet is implemented as an Electron window surface.',
    description: 'Desktop pet window channels.',
  },
  {
    channel: 'tray:*',
    status: 'electronWindowOnly',
    transport: 'invoke',
    reason: 'System tray integration is an Electron desktop shell feature.',
    description: 'System tray channels.',
  },
  {
    channel: 'openforu:surface:open',
    status: 'electronWindowOnly',
    transport: 'invoke',
    replacement: 'openforu:artifact:preview',
    reason: 'OpenForU surface windows are Electron BrowserWindow surfaces.',
    description: 'Open an OpenForU surface in a native Electron window.',
  },
]

function pendingInvokeChannels(
  channels: readonly string[],
  owner: string,
  description: string
): AckemWebChannelContract[] {
  return channels.map((channel) => ({
    channel,
    status: 'pending' as const,
    transport: 'invoke' as const,
    owner,
    description,
  }))
}

const PENDING: AckemWebChannelContract[] = [
  {
    channel: 'import:promote',
    status: 'pending',
    transport: 'invoke',
    owner: 'Worker-4',
    description: 'Promote a staged import into memory/index workflows.',
  },
  {
    channel: 'import:parseDocuments',
    status: 'pending',
    transport: 'invoke',
    owner: 'Worker-4',
    description: 'Parse staged documents into an import job.',
  },
  {
    channel: 'import:getJob',
    status: 'pending',
    transport: 'invoke',
    owner: 'Worker-4',
    description: 'Read a document import job.',
  },
  {
    channel: 'import:commitJob',
    status: 'pending',
    transport: 'invoke',
    owner: 'Worker-4',
    description: 'Commit a parsed document import job.',
  },
  {
    channel: 'index:rebuild',
    status: 'pending',
    transport: 'invoke',
    owner: 'Worker-4',
    description: 'Rebuild the local search/embedding index.',
  },
  {
    channel: 'index:search',
    status: 'pending',
    transport: 'invoke',
    owner: 'Worker-4',
    description: 'Search local indexed content.',
  },
  {
    channel: 'state:reset',
    status: 'pending',
    transport: 'invoke',
    owner: 'Worker-4',
    description: 'Reset the active engine state.',
  },
  {
    channel: 'fs:writeAllowed',
    status: 'pending',
    transport: 'invoke',
    owner: 'Worker-4',
    description: 'Write allowed relative data files from Web workflows.',
  },
  {
    channel: 'session:create',
    status: 'pending',
    transport: 'invoke',
    owner: 'Worker-4',
    description: 'Create a local chat session.',
  },
  {
    channel: 'session:delete',
    status: 'pending',
    transport: 'invoke',
    owner: 'Worker-4',
    description: 'Delete a local chat session.',
  },
  {
    channel: 'settings:probeLocalChat',
    status: 'pending',
    transport: 'invoke',
    owner: 'Worker-2',
    description: 'Probe a local OpenAI-compatible chat endpoint.',
  },
  ...pendingInvokeChannels(
    ['fs:readRel'],
    'Worker-4',
    'Allowed data file read channels.'
  ),
  ...pendingInvokeChannels(
    [
      'memory:auditReport',
      'memory:update',
      'memory:retire',
      'memory:clearAll',
      'memory:feedback',
      'memory:exportArchive',
      'memory:consolidate',
      'memory:stats',
    ],
    'Worker-4',
    'Memory management, audit, archive export, and consolidation channels.'
  ),
  ...pendingInvokeChannels(
    ['archive:read'],
    'Worker-4',
    'Archive file read channels.'
  ),
  ...pendingInvokeChannels(
    ['diary:read', 'diary:generate'],
    'Worker-4',
    'Diary read and generation channels.'
  ),
  ...pendingInvokeChannels(
    ['trace:latest'],
    'Worker-4',
    'Trace inspection channels.'
  ),
  ...pendingInvokeChannels(
    ['desire:list', 'desire:dismiss', 'desire:clearActive'],
    'Worker-4',
    'Desire stack inspection and mutation channels.'
  ),
  ...pendingInvokeChannels(
    ['profile:get'],
    'Worker-4',
    'Profile read channels.'
  ),
  ...pendingInvokeChannels(
    ['episode:list', 'kg:list', 'kg:oneHop', 'association:list', 'anchor:list'],
    'Worker-4',
    'Knowledge graph, episode, association, and anchor channels.'
  ),
  ...pendingInvokeChannels(
    ['thought:generate'],
    'Worker-4',
    'Offline thought generation channel.'
  ),
  ...pendingInvokeChannels(
    ['embedding:status', 'embedding:switch', 'embedding:download', 'embedding:downloadCancel'],
    'Worker-4',
    'Embedding model status, switch, and download channels.'
  ),
  ...pendingInvokeChannels(
    ['canon:get', 'canon:creator-memory:get'],
    'later-worker',
    'Canon and creator-memory read channels.'
  ),
  ...pendingInvokeChannels(
    ['policy:decisionLogRecent'],
    'later-worker',
    'Policy decision log channels.'
  ),
  ...pendingInvokeChannels(
    ['personality:list', 'personality:set'],
    'later-worker',
    'Personality preset management channels.'
  ),
  ...pendingInvokeChannels(
    [
      'companion:timeContext',
      'companion:presence',
      'companion:touch',
      'companion:statusText',
      'companion:getConfig',
      'companion:setConfig',
    ],
    'later-worker',
    'Companion presence, touch, status, and configuration channels.'
  ),
  ...pendingInvokeChannels(
    [
      'ext:plugins:list',
      'ext:plugins:activate',
      'ext:plugins:deactivate',
      'ext:skills:list',
      'ext:skills:activate',
      'ext:skills:deactivate',
      'ext:media:status',
      'ext:companionSkin:active',
      'ext:companionSkin:list',
      'ext:companionSkin:setActive',
      'ext:gamemode:list',
      'ext:gamemode:activate',
      'ext:gamemode:deactivate',
      'ext:gamemode:status',
      'ext:gamemode:invoke',
    ],
    'later-worker',
    'Extension center, skills, plugins, media, companion skin, and game-mode channels.'
  ),
  ...pendingInvokeChannels(
    [
      'openforu:workspaces:list',
      'openforu:workspaces:open',
      'openforu:workspaces:create',
      'openforu:workspaces:switch',
      'openforu:workspaces:delete',
      'openforu:plan:start',
      'openforu:plan:send',
      'openforu:plan:confirm',
      'openforu:plan:approveWireframe',
      'openforu:plan:deploy',
      'openforu:plan:redeploy',
      'openforu:plan:refineOpen',
      'openforu:plan:status',
      'openforu:listArtifacts',
      'openforu:artifact:preview',
      'openforu:artifact:read',
      'openforu:extensions:list',
      'openforu:extensions:remove',
      'openforu:permissions:approve',
      'openforu:permissions:deny',
      'openforu:permissions:approveAndActivate',
      'openforu:agent:status',
      'openforu:agent:cancel',
      'openforu:refine:preview',
      'openforu:refine:apply',
      'openforu:refine:history',
      'openforu:refine:rollback',
    ],
    'later-worker',
    'OpenForU workspace, plan, artifact, permission, agent, and refine channels.'
  ),
  ...pendingInvokeChannels(
    [
      'mc:react',
      'mc:parseLog',
      'mc:status',
      'mc:setEngineState',
      'mc:botStart',
      'mc:botStop',
      'mc:botStatus',
      'mc:botDebug',
      'mc:logStart',
      'mc:logStop',
      'mc:logStatus',
    ],
    'later-worker',
    'Minecraft control, bot, log, and event reaction channels.'
  ),
  ...pendingInvokeChannels(
    [
      'weixin:getStatus',
      'weixin:startLogin',
      'weixin:pollLogin',
      'weixin:submitVerifyCode',
      'weixin:disconnect',
      'weixin:setEnabled',
      'weixin:setProactiveEnabled',
      'weixin:restart',
    ],
    'later-worker',
    'Weixin bridge channels as backend services.'
  ),
  ...pendingInvokeChannels(
    [
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
    ],
    'later-worker',
    'Voice/TTS channels for browser or backend audio streaming.'
  ),
  ...pendingInvokeChannels(
    [
      'update:getAppVersion',
      'update:check',
      'update:start',
      'update:openRelease',
      'update:getChannelPreference',
      'update:setChannelPreference',
    ],
    'later-worker',
    'CLI/script-style update channels for the local Web runtime.'
  ),
  ...pendingInvokeChannels(
    [
      'updater:getJobPath',
      'updater:readJob',
      'updater:start',
      'updater:launchAckem',
      'updater:openRelease',
      'updater:quit',
    ],
    'later-worker',
    'Standalone updater process channels.'
  ),
  ...pendingInvokeChannels(
    [
      'desktop-agent:sessionMode:get',
      'desktop-agent:sessionMode:set',
      'desktop-agent:opening',
      'desktop-agent:confirm:allow',
      'desktop-agent:confirm:allowSession',
      'desktop-agent:confirm:allowTaskDeletes',
      'desktop-agent:confirm:deny',
      'desktop-agent:audit:recent',
    ],
    'later-worker',
    'Desktop-agent task execution without Electron window control.'
  ),
  ...pendingInvokeChannels(
    ['machine-map:status', 'machine-map:reindex'],
    'later-worker',
    'Machine-map indexing and status channels.'
  ),
  ...pendingInvokeChannels(
    ['mirror:check', 'mirror:findings'],
    'Worker-4',
    'Mirror consistency check and findings channels.'
  ),
  {
    channel: 'profile:estimateScan',
    status: 'pending',
    transport: 'invoke',
    owner: 'Worker-4',
    description: 'Estimate profile data from staged import files.',
  },
  {
    channel: 'profile:inferFromFiles',
    status: 'pending',
    transport: 'invoke',
    owner: 'Worker-4',
    description: 'Infer profile data from staged import files.',
  },
  {
    channel: 'profile:applyCompanionSuggestion',
    status: 'pending',
    transport: 'invoke',
    owner: 'Worker-4',
    description: 'Apply companion profile suggestions.',
  },
  {
    channel: 'app:uninstallInfo',
    status: 'pending',
    transport: 'invoke',
    owner: 'later-worker',
    description: 'Read local uninstall information in Web runtime.',
  },
  {
    channel: 'app:uninstall',
    status: 'pending',
    transport: 'invoke',
    owner: 'later-worker',
    description: 'Run local uninstall flow outside Electron window runtime.',
  },
]

export const WEB_CHANNEL_CONTRACTS: readonly AckemWebChannelContract[] = [
  ...SUPPORTED,
  ...ELECTRON_WINDOW_ONLY,
  ...PENDING,
]

export function matchesWebChannelContract(contractChannel: string, channel: string): boolean {
  if (contractChannel === channel) return true
  if (!contractChannel.endsWith(':*')) return false
  return channel.startsWith(contractChannel.slice(0, -1))
}

export function findWebChannelContract(channel: string): AckemWebChannelContract | undefined {
  return WEB_CHANNEL_CONTRACTS.find((contract) => matchesWebChannelContract(contract.channel, channel))
}

export function createWebChannelError(channel: string, status: AckemWebChannelStatus): Error {
  const contract = findWebChannelContract(channel)
  const message =
    status === 'electronWindowOnly'
      ? `Electron window-only channel is not available in local Web: ${channel}`
      : `Web channel is not implemented yet: ${channel}`
  return Object.assign(new Error(contract?.reason ?? message), {
    code: status === 'electronWindowOnly' ? 'WEB_ELECTRON_WINDOW_ONLY' : 'WEB_CHANNEL_PENDING',
    channel,
    status,
    replacement: contract?.replacement,
  })
}

function mergeRegistryContracts(registry: WebHandlerRegistry): AckemWebChannelContract[] {
  const byChannel = new Map(WEB_CHANNEL_CONTRACTS.map((contract) => [contract.channel, contract]))
  for (const channel of registry.keys()) {
    const existing = byChannel.get(channel)
    byChannel.set(channel, {
      channel,
      status: 'supported',
      transport: 'invoke',
      description:
        existing && existing.status !== 'supported'
          ? `${existing.description} Registered in the local Web handler registry.`
          : existing?.description ?? 'Registered local Web invoke channel.',
      owner: existing?.owner,
      replacement: existing?.replacement,
      reason: existing?.reason,
    })
  }
  return [...byChannel.values()].sort((a, b) => a.channel.localeCompare(b.channel))
}

export function buildWebChannelMatrix(registry: WebHandlerRegistry): AckemWebChannelMatrix {
  const all = mergeRegistryContracts(registry)
  return {
    supported: all.filter((contract) => contract.status === 'supported'),
    electronWindowOnly: all.filter((contract) => contract.status === 'electronWindowOnly'),
    pending: all.filter((contract) => contract.status === 'pending'),
    all,
  }
}

export function buildWebCapabilities(
  registry: WebHandlerRegistry,
  localOnly: boolean
): AckemWebCapabilities {
  const channelMatrix = buildWebChannelMatrix(registry)
  const supportedInvokeChannels = channelMatrix.supported
    .filter((contract) => contract.transport === 'invoke')
    .map((contract) => contract.channel)
    .sort()
  return {
    runtime: 'web',
    singleUser: true,
    localOnly,
    invokePath: ACKEM_WEB_INVOKE_PATH,
    eventsPath: ACKEM_WEB_EVENTS_PATH,
    uploadImportPath: ACKEM_WEB_UPLOAD_IMPORT_PATH,
    uploadImportPaths: [...ACKEM_WEB_UPLOAD_IMPORT_PATHS],
    channels: supportedInvokeChannels,
    unsupportedChannels: channelMatrix.electronWindowOnly.map((contract) => contract.channel).sort(),
    pendingChannels: channelMatrix.pending.map((contract) => contract.channel).sort(),
    electronWindowOnlyChannels: channelMatrix.electronWindowOnly.map((contract) => contract.channel).sort(),
    channelMatrix,
  }
}
