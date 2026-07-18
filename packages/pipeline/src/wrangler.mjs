// Executa o Wrangler com Node mesmo quando a fábrica local foi iniciada pelo Bun.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

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
  const node = nodeForWrangler()
  const cli = join(workerDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
  if (existsSync(cli)) {
    return spawnSync(node, [cli, ...args], { cwd: workerDir, encoding: 'utf8' })
  }
  // Wrangler ausente em node_modules: a fábrica no GitHub Actions instala com
  // `pnpm install --prod` e o wrangler é devDependency, então ele não está aqui.
  // Cai pro `npx`, que baixa sob demanda — é exatamente como o registro no D1
  // funcionava ANTES deste helper (`spawnSync('npx', ['wrangler', …])`). Sem
  // este fallback, todo ingest morreria no registro. Põe o Node resolvido à
  // frente no PATH pra o npx (e o wrangler que ele baixa) rodarem sob Node mesmo
  // se quem iniciou a fábrica foi o Bun.
  const PATH = node === 'node' ? process.env.PATH : `${dirname(node)}${delimiter}${process.env.PATH ?? ''}`
  return spawnSync('npx', ['--yes', 'wrangler', ...args], {
    cwd: workerDir,
    encoding: 'utf8',
    env: { ...process.env, PATH },
  })
}

export function wranglerDetalhe(result) {
  return String(result.stderr || result.stdout || result.error?.message || '').trim().split('\n')
    .filter((line) => line.trim()).at(-1) ?? ''
}
