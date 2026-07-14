// Verificação e2e da ingestão de PLAYLIST (episódios em partes).
//
// Não depende do YouTube: injeta os títulos crus direto no endpoint /entries
// (o mesmo payload que a fábrica devolveria da listagem) e usa mp4s servidos
// pelo próprio Worker local como "partes". Assim testa o caminho inteiro —
// classificação por TÍTULO, agrupamento/ordenação, detecção de buraco, criação
// dos jobs com partes ordenadas, e o download+concat da fábrica — sem tocar no
// yt-dlp --flat-playlist real (mesma fronteira do verify-link).
//
// A checagem-chave: as partes entram EMBARALHADAS na playlist e têm que sair
// ORDENADAS pelo número do título (1,2,3), nunca pela posição — a regra de ouro.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchRetry as fetch } from './_lib.mjs'
import { concatParts } from '../packages/pipeline/src/ffmpeg.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787'
const TOKEN = process.env.ADMIN_TOKEN ?? 'bieltv-dev-2026'
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const SERIE = 'jake_long'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`✅ ${name}${extra ? `  (${extra})` : ''}`) }
  else { fail++; console.log(`❌ ${name}${extra ? `  (${extra})` : ''}`) }
}

function d1(sql) {
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'biel-tv-db', '--local', '--json', '--command', sql], {
    cwd: join(ROOT, 'apps', 'stream'), encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`d1 falhou: ${r.stderr}`)
  return JSON.parse(r.stdout.slice(r.stdout.indexOf('[')))[0].results
}

function bin(name) {
  for (const c of [process.env[name.toUpperCase()], name, join(homedir(), '.local/bin', name)].filter(Boolean)) {
    try { execFileSync(c, ['-version'], { stdio: 'ignore' }); return c } catch { /* próximo */ }
  }
  throw new Error(`${name} não encontrado`)
}

const post = (path, body) => fetch(`${BASE}${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body ?? {}) })

const health = await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null)
if (health?.status !== 'ok') {
  console.error('✖ wrangler dev fora do ar — rode `pnpm dev` antes')
  process.exit(1)
}

// ── limpeza + fixtures ──────────────────────────────────────────────────────
function cleanup() {
  d1(`DELETE FROM playlist_ingests WHERE series_id='${SERIE}' OR url LIKE '%_pltest%'`)
  for (const t of ['ingest_jobs', 'media_promises', 'epg_virtual', 'media_channels', 'media_cue_points', 'media_items']) {
    d1(`DELETE FROM ${t} WHERE ${t === 'media_promises' || t === 'epg_virtual' || t === 'media_channels' || t === 'media_cue_points' ? 'media_id' : 'id'} LIKE 'ep_${SERIE}_%'`)
  }
}
cleanup()

const ff = bin('ffmpeg')
const srcDir = join(ROOT, '.ingest-work', '_src')
mkdirSync(srcDir, { recursive: true })
// 3 partes de 4s (distintas, pra provar a ORDEM pela URL) + 1 de resolução
// diferente (pro teste unitário do fallback de concat)
function fixture(nome, size) {
  const fx = join(srcDir, nome)
  execFileSync(ff, ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=25`, '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', '4', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', fx])
  spawnSync('npx', ['wrangler', 'r2', 'object', 'put', `biel-tv-media/media/_pltest/${nome}`, '--file', fx, '--local'],
    { cwd: join(ROOT, 'apps', 'stream'), stdio: 'ignore' })
  return fx
}
const p1 = fixture('p1.mp4', '640x360')
const p2 = fixture('p2.mp4', '640x360')
const p3 = fixture('p3.mp4', '640x360')
const pDiff = fixture('pdiff.mp4', '426x240') // resolução diferente pro fallback
const urlDe = (nome) => `${BASE}/media/_pltest/${nome}`

// ── 1. validação do endpoint ────────────────────────────────────────────────
let r = await post('/admin/playlist', { url: 'https://youtube.com/watch?v=abc', canais: 'jetix', series_id: SERIE })
check('link sem list= é recusado', r.status === 400)
r = await post('/admin/playlist', { url: 'https://youtube.com/playlist?list=PL_pltest', canais: 'inexistente', series_id: SERIE })
check('canal desconhecido é recusado', r.status === 400)

r = await post('/admin/playlist', { url: 'https://youtube.com/playlist?list=PL_pltest', canais: 'jetix', series_id: SERIE })
const criacao = await r.json()
check('análise de playlist criada', r.status === 201 && !!criacao.id, criacao.id)
const PL = criacao.id

// ── 2. injeta os títulos EMBARALHADOS (papel da fábrica) ────────────────────
// Ep 01: partes 1,2,3 completas mas fora de ordem (2,3,1) e com URLs distintas.
// Ep 02: idem. Ep 03: só partes 1 e 3 (falta a 2) → tem que ser marcado.
const entries = [
  { video_id: 'v012', url: urlDe('p2.mp4'), title: 'Jake Long Episódio 01 - O Dragão (Parte 2)', playlist_index: 0 },
  { video_id: 'v013', url: urlDe('p3.mp4'), title: 'Jake Long Episódio 01 - O Dragão (Parte 3)', playlist_index: 1 },
  { video_id: 'v021', url: urlDe('p1.mp4'), title: 'Jake Long Episódio 02 - A Escola (Parte 1)', playlist_index: 2 },
  { video_id: 'v011', url: urlDe('p1.mp4'), title: 'Jake Long Episódio 01 - O Dragão (Parte 1)', playlist_index: 3 },
  { video_id: 'v023', url: urlDe('p3.mp4'), title: 'Jake Long Episódio 02 - A Escola (Parte 3)', playlist_index: 4 },
  { video_id: 'v031', url: urlDe('p1.mp4'), title: 'Jake Long Episódio 03 - O Torneio (Parte 1)', playlist_index: 5 },
  { video_id: 'v022', url: urlDe('p2.mp4'), title: 'Jake Long Episódio 02 - A Escola (Parte 2)', playlist_index: 6 },
  { video_id: 'v033', url: urlDe('p3.mp4'), title: 'Jake Long Episódio 03 - O Torneio (Parte 3)', playlist_index: 7 },
]
await post(`/admin/playlist/${PL}/entries`, { entries })

// espera a classificação (LLM+regex) terminar
async function esperaRevisar() {
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`${BASE}/admin/playlist`, { headers: auth })).json()
    const row = list.find((x) => x.id === PL)
    if (row?.status === 'revisar') return row
    if (row?.status === 'error') throw new Error(`análise deu erro: ${row.error}`)
    await sleep(500)
  }
  throw new Error('timeout esperando status revisar')
}
const rowRev = await esperaRevisar()
const grupos = JSON.parse(rowRev.grupos)
const byEp = Object.fromEntries(grupos.episodios.map((e) => [e.episodio, e]))

check('agrupou em 3 episódios', grupos.episodios.length === 3, grupos.episodios.map((e) => e.episodio).join(','))

// A REGRA DE OURO: partes ordenadas pelo TÍTULO, não pela posição na playlist
const ordemEp01 = (byEp[1]?.partes ?? []).map((p) => p.parte)
check('ep 01: partes REORDENADAS 1,2,3 apesar da playlist embaralhada', JSON.stringify(ordemEp01) === '[1,2,3]', ordemEp01.join(','))
const urlsEp01 = (byEp[1]?.partes ?? []).map((p) => p.url)
check('ep 01: URLs seguem a ordem da PARTE (p1,p2,p3), não a da playlist',
  JSON.stringify(urlsEp01) === JSON.stringify([urlDe('p1.mp4'), urlDe('p2.mp4'), urlDe('p3.mp4')]))

check('ep 01 e 02 estão OK (6 partes completas)', byEp[1]?.ok === true && byEp[2]?.ok === true)
check('ep 03 marcado com aviso de parte faltando', byEp[3]?.ok === false && /faltando/.test(byEp[3]?.aviso ?? ''), byEp[3]?.aviso)
check('media_id proposto no padrão ep_<serie>_eNN', byEp[1]?.media_id === `ep_${SERIE}_e01`, byEp[1]?.media_id)

// ── 3. confirmar com SUBCONJUNTO (feature "baixar só alguns episódios") ──────
r = await post(`/admin/playlist/${PL}/confirmar`, { episodios: [3] }) // ep quebrado
let body = await r.json()
check('confirmar um episódio COM BURACO é recusado (pulado, não junta errado)',
  r.status === 200 && body.criados.length === 0 && body.pulados.some((p) => p.episodio === 3), JSON.stringify(body.pulados))

r = await post(`/admin/playlist/${PL}/confirmar`, { episodios: [1] }) // só o ep 01
body = await r.json()
check('confirmar só o ep 01 cria 1 job (baixa só o que foi escolhido)',
  r.status === 200 && body.criados.length === 1 && body.criados[0] === `ep_${SERIE}_e01`, JSON.stringify(body.criados))

const job = d1(`SELECT source_urls, tipo, series_id, episode, canais FROM ingest_jobs WHERE id='ep_${SERIE}_e01'`)[0]
const jobUrls = JSON.parse(job?.source_urls ?? '[]')
check('job carrega as 3 partes na ORDEM certa (source_urls)',
  JSON.stringify(jobUrls) === JSON.stringify([urlDe('p1.mp4'), urlDe('p2.mp4'), urlDe('p3.mp4')]))
check('job herdou tipo/série/episódio/canais', job?.tipo === 'episodio' && job?.series_id === SERIE && job?.episode === 1 && job?.canais === 'jetix')

// ── 4. a fábrica baixa as partes, concatena e o pipeline vira 1 mídia ───────
const fac = spawnSync('node', [join(ROOT, 'scripts/factory-local.mjs')], {
  encoding: 'utf8', timeout: 240_000,
  env: { ...process.env, FACTORY_DRAIN: '1', ADMIN_TOKEN: TOKEN, BASE },
})
const saida = (fac.stdout ?? '') + (fac.stderr ?? '')
check('fábrica juntou as partes e concluiu o job', /concluído e no ar/.test(saida) && saida.includes(`ep_${SERIE}_e01`),
  saida.split('\n').filter((l) => l.includes('✖')).at(-1) ?? 'ok')
check('concat usou junção CRUA (-c copy, sem re-encode)', /partes juntadas \(copy/.test(saida))

const m = d1(`SELECT status, segment_count, duracao_seg FROM media_items WHERE id='ep_${SERIE}_e01'`)[0]
// 3 partes de 4s = 12s → padded p/ 20s → 2 segmentos (1 parte só daria 1 seg)
check('mídia pronta = as 3 partes juntadas (12s → 2 segmentos)', m?.status === 'ready' && m.segment_count === 2,
  `status=${m?.status} segs=${m?.segment_count} dur=${m?.duracao_seg}`)

// ── 5. concatParts: teste unitário direto dos dois caminhos ─────────────────
const outCopy = join(srcDir, '_joined_copy.mp4')
const rc = await concatParts([p1, p2, p3], outCopy)
check('concatParts: 3 partes iguais → método copy, duração ≈ soma', rc.metodo === 'copy', `metodo=${rc.metodo}`)
const outFilter = join(srcDir, '_joined_filter.mp4')
const rf = await concatParts([p1, pDiff], outFilter, { forcarFiltro: true })
const durFiltro = Number(execFileSync(bin('ffprobe'),
  ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', outFilter], { encoding: 'utf8' }).trim())
check('concatParts: plano B (concat filter) re-encoda e junta parte de resolução diferente',
  rf.metodo === 'filter' && Math.abs(durFiltro - 8) < 2, `metodo=${rf.metodo} dur=${durFiltro.toFixed(1)}s`)

// ── limpeza ─────────────────────────────────────────────────────────────────
await post(`/admin/media/ep_${SERIE}_e01/status`, { status: 'disabled' })
cleanup()
for (const nome of ['p1.mp4', 'p2.mp4', 'p3.mp4', 'pdiff.mp4']) {
  spawnSync('npx', ['wrangler', 'r2', 'object', 'delete', `biel-tv-media/media/_pltest/${nome}`, '--local'],
    { cwd: join(ROOT, 'apps', 'stream'), stdio: 'ignore' })
}
await post('/admin/schedule/run', { canal: 'jetix', rebuild: true })
check('estado de teste limpo', d1(`SELECT COUNT(*) c FROM media_items WHERE id LIKE 'ep_${SERIE}_%'`)[0].c === 0)

console.log(`\n${fail === 0 ? '🎉' : '💥'} ${pass}/${pass + fail} checagens passaram`)
process.exit(fail === 0 ? 0 : 1)
