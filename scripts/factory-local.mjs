// A "fábrica" local: drena a fila de ingestão do admin usando o pipeline.
// Mesmo papel que a GitHub Action fará em produção — a API é idêntica:
// claim → baixa do staging → pipeline ingest → marca done → re-gera a grade.
import { spawnSync } from 'node:child_process'
import { createWriteStream, mkdirSync, rmSync } from 'node:fs'
import { pipeline as streamPipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787'
const TOKEN = process.env.ADMIN_TOKEN ?? 'bieltv-dev-2026'
// 'local' (padrão): grava no D1/R2 SIMULADOS do wrangler — uso em dev.
// 'remote': grava no D1/R2 DE VERDADE — necessário sempre que BASE aponta
// pro Worker de produção (senão o job "conclui" sem nunca sair do R2 local).
const TARGET = process.env.FACTORY_TARGET === 'remote' ? 'remote' : 'local'
// FACTORY_DRAIN=1: processa até a fila secar e ENCERRA (modo GitHub Actions).
// Sem a flag: daemon de polling infinito (modo dev na EC2).
const DRAIN = process.env.FACTORY_DRAIN === '1'
const POLL_MS = 5000
const HDR = { authorization: `Bearer ${TOKEN}` }

const log = (s) => console.log(`[fábrica ${new Date().toISOString().slice(11, 19)}] ${s}`)

// O processamento bloqueia o event loop por dezenas de segundos (spawnSync),
// e o servidor pode fechar a conexão keep-alive nesse meio-tempo — o primeiro
// POST depois disso falha com "fetch failed". Retry resolve (o done é idempotente).
async function post(path, body, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { ...HDR, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (e) {
      if (i >= tries) throw e
      await new Promise((r) => setTimeout(r, 800 * i))
    }
  }
}

async function processJob(job) {
  log(`processando "${job.id}" (${job.title})`)
  const dir = join(ROOT, '.ingest-work', '_staging')
  mkdirSync(dir, { recursive: true })
  const src = join(dir, `${job.id}__${job.original_name || 'video.bin'}`)

  const res = await fetch(`${BASE}/admin/staging/${encodeURIComponent(job.staging_key)}`, { headers: HDR })
  if (!res.ok) throw new Error(`staging download HTTP ${res.status}`)
  await streamPipeline(Readable.fromWeb(res.body), createWriteStream(src))

  const args = [
    // --dns-result-order=ipv4first: o endpoint S3 do R2 resolve IPv6 e o
    // fetch do Node dá SSL handshake failure nesta máquina — só IPv4 funciona.
    '--dns-result-order=ipv4first',
    join(ROOT, 'packages/pipeline/src/cli.mjs'), 'ingest', src,
    '--id', job.id, '--tipo', job.tipo, '--title', job.title,
    ...(job.series_id ? ['--series', job.series_id] : []),
    ...(job.episode ? ['--episode', String(job.episode)] : []),
    ...(job.tags ? ['--tags', job.tags] : []),
    ...(job.canais ? ['--canais', job.canais] : []),
    '--target', TARGET,
    // base_url '' = servido via rota /media/* do Worker (mesmo esquema do
    // resto do catálogo em produção — sem domínio público configurado ainda).
    ...(TARGET === 'remote' ? ['--base-url', ''] : []),
  ]
  const r = spawnSync('node', args, { encoding: 'utf8', env: process.env })
  rmSync(src, { force: true })
  if (r.status !== 0) {
    throw new Error((r.stderr || r.stdout || 'pipeline falhou').trim().split('\n').at(-1))
  }
  log(`"${job.id}" ingerido — replanejando a grade dos canais (bloco no ar preservado)`)
  await post('/admin/schedule/run', { rebuild: true })
}

async function tick() {
  const res = await fetch(`${BASE}/admin/jobs/claim`, { method: 'POST', headers: HDR })
  if (res.status === 204) return false
  if (!res.ok) throw new Error(`claim HTTP ${res.status}`)
  const job = await res.json()
  try {
    await processJob(job)
    await post(`/admin/jobs/${job.id}/done`, { ok: true })
    log(`✔ "${job.id}" concluído e no ar`)
  } catch (e) {
    await post(`/admin/jobs/${job.id}/done`, { ok: false, error: String(e.message ?? e).slice(0, 500) })
      .catch(() => log('não consegui nem marcar o erro — worker fora do ar?'))
    log(`✖ "${job.id}" falhou: ${e.message}`)
  }
  return true
}

log(`de olho na fila em ${BASE} [target=${TARGET}${DRAIN ? ', drain' : ''}] (poll a cada ${POLL_MS / 1000}s)`)
if (DRAIN) {
  // Actions: drena tudo e sai. Duas passadas vazias seguidas = fila seca de
  // verdade (uma só poderia ser um claim que perdeu a corrida). Erros
  // transitórios não encerram a run com trabalho pendente — só 5 seguidos.
  let vazias = 0
  let erros = 0
  while (vazias < 2) {
    try {
      if (await tick()) { vazias = 0; erros = 0; continue }
      vazias++
    } catch (e) {
      log(`erro no polling: ${e.message}`)
      if (++erros >= 5) { log('5 erros seguidos — desistindo'); process.exit(1) }
    }
    await new Promise((r) => setTimeout(r, 3000))
  }
  log('fila vazia — encerrando (modo drain)')
  process.exit(0)
}
for (;;) {
  try {
    // drena tudo que estiver na fila antes de dormir
    while (await tick()) { /* próximo job */ }
  } catch (e) {
    log(`erro no polling: ${e.message}`)
  }
  await new Promise((r) => setTimeout(r, POLL_MS))
}
