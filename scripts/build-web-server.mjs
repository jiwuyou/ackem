#!/usr/bin/env node
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'out', 'web')
const outfile = join(outDir, 'server.mjs')
const rendererIndex = join(root, 'out', 'renderer', 'index.html')

if (!existsSync(rendererIndex)) {
  throw new Error('Missing out/renderer/index.html. Run npm run build before building the Web server.')
}

mkdirSync(outDir, { recursive: true })

await esbuild.build({
  entryPoints: [join(root, 'src', 'main', 'web', 'cli.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: false,
  logLevel: 'info',
})

console.log(`Ackem Web server built: ${outfile}`)
