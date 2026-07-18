// Executa o Wrangler com Node mesmo quando a fábrica local foi iniciada pelo Bun.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function nodeForWrangler() {
  if (process.release?.name === 'node') return process.execPath
  if (process.env.NODE_BINARY && existsSync(process.env.NODE_BINARY)) return process.env.NODE_BINARY

  const nvm = join(homedir(), '.nvm', 'versions', 'node')
  try {
    const versions = readdirSync(nvm).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    const node = versions.map((v) => join(nvm, v, 'bin', 'node')).find(existsSync)
    if (node) return node
  } catch {
    /* sem nvm: usa o Node disponível no PATH */
  }
  return 'node'
}

export function runWrangler(rootDir, args) {
  const workerDir = join(rootDir, 'apps', 'stream')
  const cli = join(workerDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
  if (!existsSync(cli)) throw new Error('Wrangler não está instalado em apps/stream')
  return spawnSync(nodeForWrangler(), [cli, ...args], { cwd: workerDir, encoding: 'utf8' })
}

export function wranglerDetalhe(result) {
  return String(result.stderr || result.stdout || result.error?.message || '').trim().split('\n')
    .filter((line) => line.trim()).at(-1) ?? ''
}
