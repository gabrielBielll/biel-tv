// A "fábrica": drena a fila de ingestão do admin usando o pipeline. Roda no
// GitHub Actions (FACTORY_DRAIN=1) ou como daemon de dev na EC2 — a API é a
// mesma: claim → baixa do staging → pipeline ingest → marca done → re-gera
// a grade. O pipeline emite linhas "progresso: N%" que a gente repassa pro
// Worker (POST /admin/jobs/:id/progress) — é o % que aparece na fila do painel.
import { spawn } from 'node:child_process'
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
  const src = join(dir, `${job.id}__${job.original_name || 'video.mp4'}`)

  if (job.source_url) {
    // job de LINK (YouTube/acervos): o yt-dlp baixa aqui no runner —
    // 720p no máximo (perfil do canal é 720p, mais que isso é bit jogado
    // fora), sempre mp4, nunca playlist inteira por engano.
    log(`baixando de ${job.source_url.slice(0, 80)}…`)
    const { spawnSync: run } = await import('node:child_process')
    const r = run('yt-dlp', [
      '--no-playlist', '--force-overwrites',
      '-f', 'bv*[height<=720]+ba/b[height<=720]/b',
      '--merge-output-format', 'mp4',
      // IP de datacenter (runner) toma "Sign in to confirm you're not a bot"
      // do cliente web — o cliente de TV costuma passar sem token; cookies
      // (secret opcional YT_COOKIES → arquivo) são o plano B definitivo.
      '--extractor-args', 'youtube:player_client=default,tv_simply,tv',
      ...(process.env.YT_COOKIES_FILE ? ['--cookies', process.env.YT_COOKIES_FILE] : []),
      '-o', src,
      job.source_url,
    ], {
      encoding: 'utf8',
      // Deno no PATH (EC2 instala em ~/.deno/bin): runtime do resolvedor de
      // desafios JS do YouTube — no runner o setup-deno já cuida disso
      env: { ...process.env, PATH: `${process.env.HOME}/.deno/bin:${process.env.PATH}` },
    })
    if (r.error?.code === 'ENOENT') throw new Error('yt-dlp não instalado nesta máquina (pip install yt-dlp)')
    if (r.status !== 0) {
      const tail = (r.stderr || r.stdout || '').trim().split('\n').filter((l) => l.trim()).at(-1) ?? 'yt-dlp falhou'
      // o caso recorrente merece uma mensagem que diz O QUE FAZER
      if (/Sign in to confirm/i.test(tail)) {
        throw new Error('🍪 cookies do YouTube expiraram — reexporte em JANELA ANÔNIMA (senão o Google rotaciona e mata em horas), atualize o secret YT_COOKIES e clique ↻ no job. Receita: docs/GOTCHAS.md')
      }
      throw new Error(`download falhou: ${tail.slice(0, 300)}`)
    }
  } else {
    const res = await fetch(`${BASE}/admin/staging/${encodeURIComponent(job.staging_key)}`, { headers: HDR })
    if (!res.ok) throw new Error(`staging download HTTP ${res.status}`)
    await streamPipeline(Readable.fromWeb(res.body), createWriteStream(src))
  }

  const args = [
    // --dns-result-order=ipv4first: o endpoint S3 do R2 resolve IPv6 e o
    // fetch do Node dá SSL handshake failure em algumas máquinas — só IPv4.
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

  // spawn assíncrono: enquanto o pipeline trabalha, a gente lê o stdout,
  // pesca as linhas "progresso: N%" e repassa pro painel a cada ~5s.
  let pct = -1
  let pctEnviado = -1
  const reporter = setInterval(() => {
    if (pct > pctEnviado) {
      pctEnviado = pct
      post(`/admin/jobs/${job.id}/progress`, { pct }, 1).catch(() => { /* melhor esforço */ })
    }
  }, 5000)

  try {
    await new Promise((resolvePromise, reject) => {
      const p = spawn('node', args, { env: process.env })
      let saidaTail = ''
      let lineBuf = ''
      const come = (chunk) => {
        saidaTail = (saidaTail + chunk).slice(-3000)
        lineBuf += chunk
        const lines = lineBuf.split('\n')
        lineBuf = lines.pop() ?? ''
        for (const line of lines) {
          const m = line.match(/^progresso: (\d+)%$/)
          if (m) pct = Math.min(99, Number(m[1]))
        }
      }
      p.stdout.on('data', (d) => come(String(d)))
      p.stderr.on('data', (d) => come(String(d)))
      p.on('error', reject)
      p.on('close', (code) => {
        if (code === 0) return resolvePromise(undefined)
        // pesca a linha de erro REAL: prefere a última com "✖"/"Error",
        // ignorando rodapé de crash do Node ("Node.js vX"), frames de stack
        // ("at …") e linhas de progresso — senão a última linha útil qualquer
        const linhas = saidaTail.trim().split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('progresso:') && !l.startsWith('at ') && !/^Node\.js v/.test(l) && !l.startsWith('^'))
        const comErro = linhas.filter((l) => l.includes('✖') || /error/i.test(l))
        reject(new Error(comErro.at(-1) ?? linhas.at(-1) ?? 'pipeline falhou'))
      })
    })
  } finally {
    clearInterval(reporter)
    rmSync(src, { force: true })
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
