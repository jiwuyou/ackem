import type { AckemApi } from '../ackem'

export type AckemRuntimeKind = 'electron' | 'web'

export type AckemRuntimeCapabilities = {
  runtime: AckemRuntimeKind
  hasElectronPreload: boolean
  canInvoke: boolean
  canSubscribeEvents: boolean
  desktopUi: boolean
  filePathImport: boolean
  autoUpdate: boolean
}

export const ACKEM_WEB_SHIM_MARKER = '__ackemWebShim'

type MaybeWebShim = Partial<AckemApi> & {
  [ACKEM_WEB_SHIM_MARKER]?: true
}

export function isAckemWebShim(api: unknown): boolean {
  return Boolean(api && typeof api === 'object' && (api as MaybeWebShim)[ACKEM_WEB_SHIM_MARKER])
}

export function getWindowAckem(): AckemApi | null {
  if (typeof window === 'undefined') return null
  const api = window.ackem as AckemApi | undefined
  return api ?? null
}

export function getElectronAckem(): AckemApi | null {
  const api = getWindowAckem()
  if (!api || isAckemWebShim(api)) return null
  return api
}

export function isElectronAckemAvailable(): boolean {
  return getElectronAckem() != null
}

export function getAckemRuntime(): AckemRuntimeKind {
  return isElectronAckemAvailable() ? 'electron' : 'web'
}

export function getAckemCapabilities(): AckemRuntimeCapabilities {
  const hasElectronPreload = isElectronAckemAvailable()
  return {
    runtime: hasElectronPreload ? 'electron' : 'web',
    hasElectronPreload,
    canInvoke: true,
    canSubscribeEvents: true,
    desktopUi: hasElectronPreload,
    filePathImport: hasElectronPreload,
    autoUpdate: hasElectronPreload
  }
}

export function isAckemRuntimeAvailable(): boolean {
  if (isElectronAckemAvailable()) return true
  return typeof window !== 'undefined' && typeof fetch === 'function'
}

