import { accessSync, constants, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { app } from 'electron'

export type UpdatePreflightResult =
  | { ok: true; installDir: string }
  | { ok: false; reason: 'not_packaged' | 'not_writable' | 'in_zip' }

export function runUpdatePreflight(): UpdatePreflightResult {
  if (!app.isPackaged) return { ok: false, reason: 'not_packaged' }

  const exePath = app.getPath('exe')
  const normalizedExePath = exePath.toLowerCase()
  if (normalizedExePath.includes('.zip\\') || normalizedExePath.includes('.zip/')) {
    return { ok: false, reason: 'in_zip' }
  }

  const installDir = dirname(exePath)
  try {
    accessSync(installDir, constants.W_OK)
  } catch {
    return { ok: false, reason: 'not_writable' }
  }

  return { ok: true, installDir }
}

export function resolveLauncherExePath(installDir: string): string {
  const launcher = `${installDir}\\AckemLauncher.exe`
  if (existsSync(launcher)) return launcher
  const cmd = `${installDir}\\AckemLauncher.cmd`
  if (existsSync(cmd)) return cmd
  // 兼容旧绿色版
  const legacy = `${installDir}\\AckemUpdater.exe`
  if (existsSync(legacy)) return legacy
  return app.getPath('exe')
}

/** @deprecated use resolveLauncherExePath */
export function resolveUpdaterExePath(installDir: string): string {
  return resolveLauncherExePath(installDir)
}

export function spawnLauncherProcess(installDir: string, jobPath: string): void {
  const target = resolveLauncherExePath(installDir)
  const arg = `--ackem-updater=${jobPath}`

  if (target.toLowerCase().endsWith('.cmd')) {
    const child = spawn('cmd.exe', ['/c', target, arg], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      cwd: installDir
    })
    child.unref()
    return
  }

  const child = spawn(target, [arg], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    cwd: installDir
  })
  child.unref()
}
