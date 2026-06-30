import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startAckemWebServer } from './server'

type CliOptions = {
  host?: string
  port?: number
  staticRoot?: string
}

function readOption(name: string): string | undefined {
  const exact = `--${name}=`
  const index = process.argv.findIndex((arg) => arg === `--${name}`)
  if (index >= 0) return process.argv[index + 1]
  const inline = process.argv.find((arg) => arg.startsWith(exact))
  return inline ? inline.slice(exact.length) : undefined
}

function parseCliOptions(): CliOptions {
  const portRaw = readOption('port') ?? process.env.ACKEM_WEB_PORT
  const port = portRaw ? Number(portRaw) : undefined
  return {
    host: readOption('host') ?? process.env.ACKEM_WEB_HOST,
    port: Number.isFinite(port) && port ? port : undefined,
    staticRoot: readOption('static-root') ?? process.env.ACKEM_WEB_STATIC_ROOT,
  }
}

function resolveStaticRoot(configured?: string): string {
  if (configured) return resolve(configured)

  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(process.cwd(), 'out', 'renderer'),
    resolve(here, '..', 'renderer'),
  ]
  const found = candidates.find((candidate) => existsSync(join(candidate, 'index.html')))
  return found ?? candidates[0]
}

async function main(): Promise<void> {
  const options = parseCliOptions()
  const staticRoot = resolveStaticRoot(options.staticRoot)
  if (!existsSync(join(staticRoot, 'index.html'))) {
    throw new Error(`Missing renderer build at ${staticRoot}. Run npm run build:web first.`)
  }

  const handle = await startAckemWebServer({
    host: options.host,
    port: options.port,
    staticRoot,
    spaFallback: true,
  })

  console.log(`[Ackem Web] ${handle.url}`)
  console.log(`[Ackem Web] serving ${staticRoot}`)

  const shutdown = async () => {
    await handle.close()
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())
}

main().catch((error) => {
  console.error('[Ackem Web] failed to start:', error instanceof Error ? error.message : error)
  process.exit(1)
})
