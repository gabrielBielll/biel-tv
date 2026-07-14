// A "fábrica": drena a fila de ingestão do admin usando o pipeline. Roda no
// GitHub Actions (FACTORY_DRAIN=1) ou como daemon de dev na EC2 — a API é a
// mesma: claim → baixa do staging → pipeline ingest → marca done → re-gera
// a grade. O pipeline emite linhas "progresso: N%" que a gente repassa pro
// Worker (POST /admin/jobs/:id/progress) — é o % que aparece na fila do painel.
import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { pipeline as streamPipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { concatParts } from '../packages/pipeline/src/ffmpeg.mjs'

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

// Cookies do YouTube (fase 11d): busca UMA vez os cookies self-service do
// painel (POST /admin/yt-cookies — sempre os mais frescos); se não houver,
// cai pro arquivo do secret do GitHub (YT_COOKIES_FILE). Cache por processo:
// cada reenfileiramento roda uma run nova, então fica sempre atualizado.
let cookiePathCache // undefined = ainda não buscou · null = nenhum · string = caminho
async function cookieFile() {
  if (cookiePathCache !== undefined) return cookiePathCache
  try {
    const res = await fetch(`${BASE}/admin/yt-cookies`, { headers: HDR })
    if (res.ok) {
      const { cookies } = await res.json()
      if (cookies) {
        const p = join(ROOT, '.ingest-work', '_yt-cookies.txt')
        mkdirSync(dirname(p), { recursive: true })
        writeFileSync(p, cookies)
        log('cookies do YouTube: usando os do painel')
        cookiePathCache = p
        return p
      }
    }
  } catch { /* cai pro fallback */ }
  cookiePathCache = process.env.YT_COOKIES_FILE || null
  if (cookiePathCache) log('cookies do YouTube: usando o secret do GitHub')
  return cookiePathCache
}

// Baixa UMA URL com yt-dlp (720p mp4). Mesma receita da fase 11d: cliente de
// TV + cookies do painel + Deno no PATH (resolvedor do "n challenge" do YouTube).
async function baixarUrl(url, dest, cookies) {
  const { spawnSync: run } = await import('node:child_process')
  const r = run('yt-dlp', [
    '--no-playlist', '--force-overwrites',
    '-f', 'bv*[height<=720]+ba/b[height<=720]/b',
    '--merge-output-format', 'mp4',
    '--extractor-args', 'youtube:player_client=default,tv_simply,tv',
    ...(cookies ? ['--cookies', cookies] : []),
    '-o', dest,
    url,
  ], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${process.env.HOME}/.deno/bin:${process.env.PATH}` },
  })
  if (r.error?.code === 'ENOENT') throw new Error('yt-dlp não instalado nesta máquina (pip install yt-dlp)')
  if (r.status !== 0) {
    const tail = (r.stderr || r.stdout || '').trim().split('\n').filter((l) => l.trim()).at(-1) ?? 'yt-dlp falhou'
    if (/Sign in to confirm/i.test(tail)) {
      throw new Error('🍪 cookies do YouTube venceram — exporte de novo (perfil/janela nova, feche sem navegar) e cole no painel em "🍪 cookies do YouTube" (aceita .txt ou JSON); os vídeos voltam pra fila sozinhos.')
    }
    throw new Error(`download falhou: ${tail.slice(0, 300)}`)
  }
}

// download OK: o yt-dlp reescreveu o --cookies com os cookies ROTACIONADOS
// (o Google gira o __Secure-3PSIDTS a cada uso) — devolve pro D1 pra eles se
// manterem frescos entre lotes. Silencioso e best-effort.
async function devolveCookies(cookies) {
  if (cookies !== cookiePathCache || !cookiePathCache) return
  try {
    const atualizados = readFileSync(cookiePathCache, 'utf8')
    await fetch(`${BASE}/admin/yt-cookies`, {
      method: 'PUT',
      headers: { ...HDR, 'content-type': 'application/json' },
      body: JSON.stringify({ cookies: atualizados }),
    })
  } catch { /* melhor esforço — não atrapalha o ingest */ }
}

// Lista uma playlist SEM baixar (yt-dlp --flat-playlist) — devolve os títulos
// crus pro Worker classificar. A ordem da parte vem do TÍTULO, não daqui.
async function listaPlaylist(pl) {
  log(`listando playlist ${pl.id} (${String(pl.url).slice(0, 70)}…)`)
  const cookies = await cookieFile()
  const { spawnSync: run } = await import('node:child_process')
  const r = run('yt-dlp', [
    '--flat-playlist', '--dump-single-json', '--no-warnings',
    ...(cookies ? ['--cookies', cookies] : []),
    pl.url,
  ], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PATH: `${process.env.HOME}/.deno/bin:${process.env.PATH}` },
  })
  if (r.error?.code === 'ENOENT') throw new Error('yt-dlp não instalado nesta máquina (pip install yt-dlp)')
  if (r.status !== 0) {
    const tail = (r.stderr || r.stdout || '').trim().split('\n').filter((l) => l.trim()).at(-1) ?? 'yt-dlp falhou'
    if (/Sign in to confirm/i.test(tail)) {
      throw new Error('🍪 cookies do YouTube venceram — renove no painel e reanalise a playlist.')
    }
    throw new Error(`listagem falhou: ${tail.slice(0, 300)}`)
  }
  const data = JSON.parse(r.stdout)
  return (data.entries ?? [])
    .filter(Boolean)
    .map((e, i) => ({
      video_id: String(e.id ?? ''),
      url: e.url && /^https?:/.test(e.url) ? e.url : `https://www.youtube.com/watch?v=${e.id}`,
      title: String(e.title ?? ''),
      playlist_index: Number.isFinite(e.playlist_index) ? e.playlist_index : i,
    }))
    .filter((e) => e.video_id)
}

async function tickPlaylist() {
  const res = await fetch(`${BASE}/admin/playlist/claim`, { method: 'POST', headers: HDR })
  if (res.status === 204) return false
  if (!res.ok) throw new Error(`playlist claim HTTP ${res.status}`)
  const pl = await res.json()
  try {
    const entries = await listaPlaylist(pl)
    await post(`/admin/playlist/${pl.id}/entries`, { entries })
    log(`✔ playlist ${pl.id} listada (${entries.length} vídeos) — Worker classificando`)
    await devolveCookies(await cookieFile())
  } catch (e) {
    await post(`/admin/playlist/${pl.id}/error`, { error: String(e.message ?? e).slice(0, 500) })
      .catch(() => log('não consegui nem marcar o erro da playlist — worker fora do ar?'))
    log(`✖ playlist ${pl.id} falhou: ${e.message}`)
  }
  return true
}

async function processJob(job) {
  log(`processando "${job.id}" (${job.title})`)
  const dir = join(ROOT, '.ingest-work', '_staging')
  mkdirSync(dir, { recursive: true })
  const src = join(dir, `${job.id}__${job.original_name || 'video.mp4'}`)

  const partDir = join(dir, `${job.id}__parts`)
  // partes ordenadas (playlist "episódios em partes"): baixa CADA parte em
  // ordem e junta CRU (concatParts) — o pipeline normaliza o TODO uma vez só,
  // pondo os keyframes na grade global de 10s. Normalizar cada parte antes
  // quebraria a segmentação (ver regra de ouro dos 10s em ARQUITETURA.md).
  const sourceUrls = (() => { try { return JSON.parse(job.source_urls ?? 'null') } catch { return null } })()
  if (Array.isArray(sourceUrls) && sourceUrls.length > 0) {
    const cookies = await cookieFile()
    mkdirSync(partDir, { recursive: true })
    const partFiles = []
    for (const [i, url] of sourceUrls.entries()) {
      const pf = join(partDir, `part${String(i).padStart(3, '0')}.mp4`)
      log(`baixando parte ${i + 1}/${sourceUrls.length} de ${String(url).slice(0, 60)}…`)
      await baixarUrl(url, pf, cookies)
      partFiles.push(pf)
    }
    log(`juntando ${partFiles.length} partes…`)
    const jr = await concatParts(partFiles, src)
    log(`partes juntadas (${jr.metodo}${jr.metodo === 'filter' ? ' — re-encode: partes com encoding diferente' : ' — sem re-encode'})`)
    await devolveCookies(cookies)
  } else if (job.source_url) {
    // job de LINK (YouTube/acervos): baixa 1 vídeo (perfil do canal é 720p).
    log(`baixando de ${job.source_url.slice(0, 80)}…`)
    const cookies = await cookieFile()
    await baixarUrl(job.source_url, src, cookies)
    await devolveCookies(cookies)
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
    rmSync(partDir, { recursive: true, force: true })
  }
  log(`"${job.id}" ingerido — replanejando a grade dos canais (bloco no ar preservado)`)
  await post('/admin/schedule/run', { rebuild: true })
}

async function tick() {
  // análise de playlist tem prioridade: é rápida (só lista os títulos) e
  // destrava a revisão no painel antes dos downloads pesados
  if (await tickPlaylist()) return true
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
