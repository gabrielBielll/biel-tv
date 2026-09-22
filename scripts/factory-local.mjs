// A "fábrica": drena a fila de ingestão do admin usando o pipeline. Roda no
// GitHub Actions (FACTORY_DRAIN=1) ou como daemon de dev na EC2 — a API é a
// mesma: claim → baixa do staging → pipeline ingest → marca done → re-gera
// a grade. O pipeline emite linhas "progresso: N%" que a gente repassa pro
// Worker (POST /admin/jobs/:id/progress) — é o % que aparece na fila do painel.
import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { pipeline as streamPipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FFMPEG, concatParts, extraiTrecho, detectSilence, detectBlack, detectScene, probe } from '../packages/pipeline/src/ffmpeg.mjs'
import { achaBuracos, ancoraCorte, fundePelaGrade, classificaPeca } from '../packages/pipeline/src/cortador.mjs'
import { montaComercialPrograma } from '../packages/pipeline/src/comerciais.mjs'

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

async function postJson(path, body, tries = 3) {
  const res = await post(path, body, tries)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

async function baixaR2Key(key, dest) {
  const res = await fetch(`${BASE}/admin/staging/${encodeURIComponent(key)}`, { headers: HDR })
  if (!res.ok) throw new Error(`download de asset ${key} HTTP ${res.status}`)
  await streamPipeline(Readable.fromWeb(res.body), createWriteStream(dest))
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

// Baixa UMA URL com yt-dlp (720p mp4). O runtime Node já presente na fábrica
// resolve o "n challenge" atual do YouTube; cookies seguem como plano B.
async function baixarUrl(url, dest, cookies) {
  const { spawnSync: run } = await import('node:child_process')
  const r = run('yt-dlp', [
    '--no-playlist', '--force-overwrites',
    '--js-runtimes', 'node',
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
    '--js-runtimes', 'node',
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
  // 5xx não derruba o processo — e aqui importa mais que nos outros: este é o
  // PRIMEIRO tick do laço de drenagem, então um 500 daqui mataria a fábrica
  // antes de ela chegar nos episódios. Ver a nota no tickFabricaComerciais.
  if (res.status >= 500) { log(`playlist indisponível (HTTP ${res.status}) — sigo com os outros ticks`); return false }
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
    ...(job.video_fit ? ['--fit', job.video_fit] : []),
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


// ── cortador de comerciais (docs/features/cortador-comerciais.md) ──────────
// A fábrica MEDE, o Worker JULGA. Aqui roda o caro e determinístico (baixar,
// transcrever, medir sinais, cortar); o "este buraco é limite?" e o "como se
// chama?" são LLM e ficam no Worker, onde a chave mora — a fábrica nunca chamou
// LLM e não recebe GEMINI/DEEPSEEK_API_KEY nos secrets do Actions. Manter assim.
//
// Sem staging no meio: o cli.mjs ingest já normaliza/segmenta/sobe/registra a
// partir de um arquivo em DISCO, e a peça recortada já está em disco aqui. O
// round-trip pelo R2 seria trabalho puro — a fábrica nem sabe subir pro staging
// (ela só baixa; quem sobe é o navegador do Gabriel).

/** transcreve.py --json: fala COM timestamps. Os buracos entre segmentos são os
 *  candidatos a limite. Ao contrário da ingestão normal (onde a transcrição é
 *  opcional e o exit 3 é tolerado), aqui SEM whisper não há cortador. */
async function transcreveComTempo(file, workdir) {
  const wav = join(workdir, 'audio16k.wav')
  await new Promise((ok, fail) => {
    const p = spawn(FFMPEG(), ['-y', '-hide_banner', '-loglevel', 'error', '-i', file,
      '-vn', '-ac', '1', '-ar', '16000', wav], { stdio: ['ignore', 'ignore', 'inherit'] })
    p.on('error', fail)
    p.on('exit', (c) => (c === 0 ? ok() : fail(new Error(`ffmpeg wav saiu ${c}`))))
  })
  const out = await new Promise((ok, fail) => {
    const p = spawn('python3', [join(ROOT, 'scripts/transcreve.py'), wav, '--json'],
      { stdio: ['ignore', 'pipe', 'pipe'] })
    let buf = '', err = ''
    p.stdout.on('data', (d) => (buf += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('error', fail)
    p.on('exit', (c) => {
      if (c === 3) return fail(new Error('faster-whisper não instalado — o cortador depende dele'))
      if (c !== 0) return fail(new Error(`transcreve.py saiu ${c}: ${err.slice(0, 200)}`))
      ok(buf)
    })
  })
  return JSON.parse(out)
}

/** Ingere UM arquivo já em disco pelo pipeline de sempre. */
async function ingerePeca(file, { id, title, canais, series, noTranscript = false }) {
  const args = [
    '--dns-result-order=ipv4first',
    join(ROOT, 'packages/pipeline/src/cli.mjs'), 'ingest', file,
    '--id', id, '--tipo', 'comercial', '--title', title,
    ...(series ? ['--series', series] : []),
    ...(canais ? ['--canais', canais] : []),
    ...(noTranscript ? ['--no-transcript'] : []),
    '--target', TARGET,
    ...(TARGET === 'remote' ? ['--base-url', ''] : []),
  ]
  await new Promise((ok, fail) => {
    const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    const come = (c) => { tail = (tail + c).slice(-2000) }
    p.stdout.on('data', (d) => come(String(d)))
    p.stderr.on('data', (d) => come(String(d)))
    p.on('error', fail)
    p.on('close', (code) => {
      if (code === 0) return ok()
      const linhas = tail.trim().split('\n').map((l) => l.trim())
        .filter((l) => l && !l.startsWith('progresso:') && !l.startsWith('at ') && !/^Node\.js v/.test(l))
      fail(new Error(linhas.filter((l) => l.includes('✖') || /error/i.test(l)).at(-1) ?? linhas.at(-1) ?? 'pipeline falhou'))
    })
  })
}

function extDeKey(key, fallback) {
  const ext = extname(String(key ?? '').split('?')[0] ?? '').toLowerCase()
  return ext && ext.length <= 8 ? ext : fallback
}

async function tickFabricaComerciais() {
  const res = await fetch(`${BASE}/admin/fabrica-comerciais/claim`, { method: 'POST', headers: HDR })
  if (res.status === 204) return false
  if (res.status === 404) return false
  // 5xx = problema do SERVIDOR, e o mais comum é cota diária de escrita do D1
  // estourada (o Worker devolve 500 nu; o erro real só aparece no wrangler
  // tail). Cota é transitória por definição — derrubar o processo por causa
  // dela troca "esperar" por "parar", e para a fila de EPISÓDIOS junto.
  //
  // Medido em 22/09/2026: a cota estourou, este claim passou a devolver 500, o
  // `throw` matou o processo em 9s e 33 episódios de Power Rangers S.P.D.
  // ficaram o dia inteiro em `queued` — por causa do subsistema de COMERCIAIS.
  // É a mesma lição do 404 logo abaixo (`tickComercial`), com outro status.
  if (res.status >= 500) { log(`fábrica de comerciais indisponível (HTTP ${res.status}) — sigo com os outros ticks`); return false }
  if (!res.ok) throw new Error(`fábrica de comerciais claim HTTP ${res.status}`)
  const job = await res.json()
  const workdir = join(ROOT, '.ingest-work', `fabcom_${job.id}`)
  mkdirSync(workdir, { recursive: true })
  try {
    log(`montando comercial "${job.media_id}" (${job.series_id} · ${job.slot.texto_tela})`)
    await postJson(`/admin/fabrica-comerciais/${job.id}/progress`, { pct: 5 }, 1).catch(() => {})

    const sample = join(workdir, `sample${job.sample.source_url ? '.mp4' : extDeKey(job.sample.video_key, '.mp4')}`)
    const molde = join(workdir, `molde${extDeKey(job.molde.molde_key, '.png')}`)
    const musica = job.molde.musica_key
      ? join(workdir, `musica${extDeKey(job.molde.musica_key, '.mp3')}`)
      : null
    if (job.sample.source_url) {
      log(`baixando amostra do YouTube: ${job.sample.source_url.slice(0, 80)}…`)
      const cookies = await cookieFile()
      await baixarUrl(job.sample.source_url, sample, cookies)
      await devolveCookies(cookies)
    } else {
      await baixaR2Key(job.sample.video_key, sample)
    }
    await baixaR2Key(job.molde.molde_key, molde)
    if (job.molde.musica_key && musica) await baixaR2Key(job.molde.musica_key, musica)

    const clips = []
    for (const [i, c] of job.clips.entries()) {
      const file = join(workdir, `clip_${i}_${c.papel}${extDeKey(c.audio_key, '.wav')}`)
      await baixaR2Key(c.audio_key, file)
      clips.push({ ...c, file })
    }
    await postJson(`/admin/fabrica-comerciais/${job.id}/progress`, { pct: 25 }, 1).catch(() => {})

    const out = join(workdir, `${job.media_id}.mp4`)
    const render = await montaComercialPrograma({
      sampleVideo: sample,
      moldePng: molde,
      musicaFile: musica,
      clips,
      canal: job.canal,
      tituloTela: job.slot.titulo_tela,
      textoTela: job.slot.texto_tela,
      textoBox: job.molde.texto_box,
      outFile: out,
      workdir,
    })
    await postJson(`/admin/fabrica-comerciais/${job.id}/progress`, { pct: 70 }, 1).catch(() => {})

    await ingerePeca(out, {
      id: job.media_id,
      title: job.title,
      canais: job.canal,
      series: job.series_id,
      noTranscript: true,
    })
    await postJson(`/admin/fabrica-comerciais/${job.id}/done`, {
      media_id: job.media_id,
      transcript: job.transcript,
      proposta: {
        tipo: 'bloco_horario',
        series_id: job.series_id,
        descricao: `${job.title} (${job.slot.texto_tela})`,
        confianca: 1,
      },
      render,
    })
    log(`✔ ${job.media_id}: comercial montado (${render.duration.toFixed(1)}s, ${render.transition})`)
  } catch (e) {
    await postJson(`/admin/fabrica-comerciais/${job.id}/error`, { error: String(e.message ?? e).slice(0, 500) }, 1)
      .catch(() => log('não consegui nem marcar o erro da fábrica de comerciais — worker fora do ar?'))
    log(`✖ ${job.id} falhou: ${e.message}`)
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
  return true
}

async function tickComercial() {
  const res = await fetch(`${BASE}/admin/comerciais/claim`, { method: 'POST', headers: HDR })
  if (res.status === 204) return false
  // ⚠️ 404 = os endpoints do cortador NÃO existem no Worker em produção (a
  // migration/rotas ainda não foram pra lá). Isso NÃO é erro: é feature não
  // implantada, e a fábrica tem que seguir pro resto da fila.
  //
  // Custou caro aprender: este tick foi commitado (64c727f) SEM os endpoints, e
  // como ele roda ANTES do claim de jobs, o throw daqui derrubava a fábrica
  // inteira — 5 erros seguidos e process.exit(1). A fila de ingestão do Gabriel
  // (22 episódios da Raven) ficou PARADA das 03:03 em diante, e o e-mail de
  // workflow falho foi o único aviso. O commit até dizia "ainda não roda:
  // faltam os endpoints" — mas "não roda" virou "derruba o que já rodava".
  //
  // Regra: um tick de feature nova nunca pode quebrar os ticks que já
  // funcionam. Endpoint ausente ⇒ sem trabalho, segue o baile.
  if (res.status === 404) return false
  // …e 5xx pelo mesmo motivo: servidor fora do ar ou cota estourada não pode
  // parar a fila de episódios. Ver a nota no tickFabricaComerciais.
  if (res.status >= 500) { log(`cortador indisponível (HTTP ${res.status}) — sigo com os outros ticks`); return false }
  if (!res.ok) throw new Error(`comerciais claim HTTP ${res.status}`)
  const cc = await res.json()
  const workdir = join(ROOT, '.ingest-work', `cc_${cc.id}`)
  mkdirSync(workdir, { recursive: true })
  try {
    // 1. o compilado em disco
    const src = join(workdir, 'compilado.mp4')
    if (cc.source_url) {
      const cookies = await cookieFile()
      await baixarUrl(cc.source_url, src, cookies)
      await devolveCookies(cookies)
    } else if (cc.staging_key) {
      const r = await fetch(`${BASE}/admin/staging/${encodeURIComponent(cc.staging_key)}`, { headers: HDR })
      if (!r.ok) throw new Error(`staging download HTTP ${r.status}`)
      await streamPipeline(Readable.fromWeb(r.body), createWriteStream(src))
    } else {
      throw new Error('comercial_cut sem source_url nem staging_key')
    }
    const { duration } = await probe(src)

    // 2. whisper diz QUAIS (o passo caro: ~3min de CPU por 600s)
    await post(`/admin/comerciais/${cc.id}/status`, { status: 'transcrevendo', dur_seg: duration })
    const fala = await transcreveComTempo(src, workdir)
    const buracos = achaBuracos(fala)
    log(`▸ ${cc.id}: ${duration.toFixed(0)}s · ${fala.length} falas · ${buracos.length} buracos candidatos`)

    // 3. o Worker JULGA (é ele que tem a chave do LLM)
    await post(`/admin/comerciais/${cc.id}/status`, { status: 'analisando', fala })
    const vered = await post(`/admin/comerciais/${cc.id}/julga`, { buracos })

    // 4. a MARGEM diz ONDE (o ffmpeg só ancora em ~1/3 dos casos — medido)
    const [s30, s24, preto, cena] = await Promise.all([
      detectSilence(src, { noise: -30, d: 0.25 }),
      detectSilence(src, { noise: -24, d: 0.25 }),
      detectBlack(src, { d: 0.15 }),
      detectScene(src, { th: 0.4 }),
    ])
    const sinais = { silencio_30db: s30, silencio_24db: s24, preto, cena }
    const pontos = []
    for (const [i, b] of buracos.entries()) {
      if (!vered.limites?.[i]) continue
      const a = ancoraCorte(b, sinais)
      // t === null = bloco sem locução (promo/mudo): não corta no escuro
      if (a.t !== null) pontos.push(a.t)
    }
    pontos.sort((x, y) => x - y)

    // 5. peças entre cortes, remontando o que o corte quebrou
    let pecas = []
    for (let i = 0; i <= pontos.length; i++) {
      const pIni = i === 0 ? 0 : pontos[i - 1]
      const pFim = i === pontos.length ? duration : pontos[i]
      if (pFim - pIni < 0.1) continue
      pecas.push({ i: pecas.length, ini: pIni, fim: pFim, dur: Math.round((pFim - pIni) * 100) / 100 })
    }
    pecas = fundePelaGrade(pecas)
    const entram = pecas.filter((p) => classificaPeca(p).ok)
    log(`▸ ${cc.id}: ${pecas.length} peças (${pecas.filter((p) => p.fundido).length} remontadas) · ${entram.length} entram`)

    // 6. o Worker nomeia (LLM + vocabulário do acervo) e devolve ids SEM colisão
    //    — INSERT OR REPLACE sobrescreve em silêncio se dois ids baterem.
    await post(`/admin/comerciais/${cc.id}/status`, { status: 'cortando' })
    const nomes = await post(`/admin/comerciais/${cc.id}/nomeia`, {
      pecas: entram.map((p) => ({
        ini: p.ini, fim: p.fim, dur: p.dur,
        texto: fala.filter((f) => f.start >= p.ini - 0.3 && f.end <= p.fim + 0.3).map((f) => f.text).join(' '),
      })),
    })

    // 7. corta e ingere cada peça pelo pipeline de sempre
    const feitas = []
    for (const [i, p] of entram.entries()) {
      const info = nomes.pecas?.[i] ?? {}
      const id = info.id ?? `${cc.id}_${i}`
      const out = join(workdir, `peca${i}.mp4`)
      // -ss DEPOIS do -i + re-encode: frame-accurate. -c copy grudaria no
      // keyframe e vazaria a peça vizinha.
      await extraiTrecho(src, p.ini, p.fim, out)
      await ingerePeca(out, { id, title: info.nome ?? `peça ${i} de ${cc.id}`, canais: cc.canal })
      rmSync(out, { force: true })
      feitas.push({ ...p, ...info, id })
      log(`  ✔ ${id} (${p.dur}s)${p.fundido ? ' [remontada]' : ''}`)
    }
    await post(`/admin/comerciais/${cc.id}/pronto`, {
      pecas: pecas.map((p, i) => ({ ...p, ...(nomes.pecas?.[i] ?? {}) })),
      n_pecas: feitas.length,
      n_descartadas: pecas.length - feitas.length,
    })
    log(`✔ ${cc.id}: ${feitas.length} peças no catálogo`)
    await post('/admin/schedule/run', { rebuild: true })
  } catch (e) {
    await post(`/admin/comerciais/${cc.id}/error`, { error: String(e.message ?? e).slice(0, 500) })
      .catch(() => log('não consegui nem marcar o erro do cortador — worker fora do ar?'))
    log(`✖ ${cc.id} falhou: ${e.message}`)
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
  return true
}

async function tick() {
  // análise de playlist tem prioridade: é rápida (só lista os títulos) e
  // destrava a revisão no painel antes dos downloads pesados
  if (await tickPlaylist()) return true
  // comerciais GERADOS são jobs leves o bastante para passar antes do cortador:
  // destravam rápido uma peça pronta do canal e ainda caem no pipeline normal.
  if (await tickFabricaComerciais()) return true
  // o cortador vem antes dos jobs pesados: transcrever 600s leva ~3min, mas
  // enfileira N peças de uma vez — quanto antes começar, antes a fila anda
  if (await tickComercial()) return true
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
