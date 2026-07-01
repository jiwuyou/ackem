import { existsSync, statSync } from 'node:fs'
import { join, normalize, relative, resolve } from 'node:path'

export type SafePathResult =
  | { ok: true; relPath: string; absPath: string }
  | { ok: false; error: string }

function toPosix(input: string): string {
  return input.replace(/\\/g, '/')
}

export function normalizeSafeRelativePath(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const trimmed = toPosix(input).trim().replace(/^\/+/, '')
  if (!trimmed || trimmed.includes('\0')) return null
  const normalized = toPosix(normalize(trimmed))
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    return null
  }
  if (normalized.includes(':')) return null
  return normalized
}

export function resolveSafeChildPath(root: string, relInput: unknown): SafePathResult {
  const relPath = normalizeSafeRelativePath(relInput)
  if (!relPath) return { ok: false, error: 'invalid relative path' }

  const rootAbs = resolve(root)
  const absPath = resolve(join(rootAbs, relPath))
  const back = relative(rootAbs, absPath)
  if (back.startsWith('..') || back === '..' || back.includes(':')) {
    return { ok: false, error: 'path escapes root' }
  }
  return { ok: true, relPath, absPath }
}

export function resolveSafeChildFile(root: string, relInput: unknown): SafePathResult {
  const resolved = resolveSafeChildPath(root, relInput)
  if (!resolved.ok) return resolved
  if (!existsSync(resolved.absPath)) return { ok: false, error: 'not found' }
  try {
    if (!statSync(resolved.absPath).isFile()) return { ok: false, error: 'not a file' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  return resolved
}

export function isSafeIsoDate(input: unknown): input is string {
  return typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input)
}

export function clampNumber(input: unknown, fallback: number, min: number, max: number): number {
  const value = typeof input === 'number' ? input : Number(input)
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, value))
}

export function clampInteger(input: unknown, fallback: number, min: number, max: number): number {
  return Math.trunc(clampNumber(input, fallback, min, max))
}
