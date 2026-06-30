import { getAckemRuntime, isAckemRuntimeAvailable, isElectronAckemAvailable } from '../api'

export function isAckemPreloadAvailable(): boolean {
  return isElectronAckemAvailable()
}

export function isAckemRendererRuntimeAvailable(): boolean {
  return isAckemRuntimeAvailable()
}

export function formatMissingPreloadError(): string {
  const en =
    'window.ackem is missing. If you opened http://localhost:5173 in a browser, close it and start Electron instead (npm run dev or 一键启动.bat). In Electron, check preload errors in DevTools.'
  const zh =
    '未检测到 window.ackem。若在浏览器打开 http://localhost:5173 会出现此情况，请关闭浏览器并用 npm run dev / 一键启动.bat 启动 Electron；若在 Electron 内仍如此，请检查 preload 是否报错。'
  if (typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('en')) {
    return en
  }
  return zh
}

export function formatMissingRuntimeError(): string {
  const en =
    'Ackem runtime is unavailable. In Electron, check preload errors in DevTools. In Web mode, start the local Ackem Web service and open its served URL.'
  const zh =
    '未检测到 Ackem 运行时。若在 Electron 内请检查 preload 是否报错；若使用 Web 模式，请先启动本机 Ackem Web 服务，并打开它提供的页面地址。'
  if (typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('en')) {
    return en
  }
  return zh
}

export const BOOT_CONNECTING_ZH = '正在连接主进程…'
export const BOOT_CONNECTING_EN = 'Connecting to main process…'
export const BOOT_CONNECTING_WEB_ZH = '正在连接本机 Web 服务…'
export const BOOT_CONNECTING_WEB_EN = 'Connecting to local Web service…'

export function formatBootConnectingMessage(): string {
  if (typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('en')) {
    return getAckemRuntime() === 'web' ? BOOT_CONNECTING_WEB_EN : BOOT_CONNECTING_EN
  }
  return getAckemRuntime() === 'web' ? BOOT_CONNECTING_WEB_ZH : BOOT_CONNECTING_ZH
}
