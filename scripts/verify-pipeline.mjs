// Verificação e2e da fase 2 (pipeline de ingestão).
// Gera um vídeo propositalmente fora do padrão (640x360@25fps, áudio mono
// 44.1kHz, 47s, com 2s de tela preta em t=24–26s), ingere com o CLI e confere:
// normalização, padding p/ 50s, 5 segmentos de 10s, cue point em 20s,
// registro no D1 e reprodução via /live com viagem no tempo.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787'
const CANAL = 'bieltv_1'

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`✅ ${name}${extra ? `  (${extra})` : ''}`) }
  else { fail++; console.log(`❌ ${name}${extra ? `  (${extra})` : ''}`) }
}

function bin(name) {
  for (const c of [process.env[name.toUpperCase()], name, join(homedir(), '.local/bin', name)].filter(Boolean)) {
    try { execFileSync(c, ['-version'], { stdio: 'ignore' }); return c } catch { /* next */ }
  }
  throw new Error(`${name} não encontrado`)
}
const FF = bin('ffmpeg')
const FP = bin('ffprobe')

const ffprobeJson = (f) =>
  JSON.parse(execFileSync(FP, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', f]))

function d1json(sql) {
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'biel-tv-db', '--local', '--json', '--command', sql], {
    cwd: join(ROOT, 'apps', 'stream'), encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`d1 falhou: ${r.stderr}`)
  const out = r.stdout.slice(r.stdout.indexOf('['))
  return JSON.parse(out)[0].results
}

// ── 1. fabrica a fonte "bagunçada" ─────────────────────────────────────────
const srcDir = join(ROOT, '.ingest-work', '_src')
mkdirSync(srcDir, { recursive: true })
const src = join(srcDir, 'filme_src.mp4')
execFileSync(FF, [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25',
  '-f', 'lavfi', '-i', 'sine=frequency=600:sample_rate=44100',
  '-t', '47',
  '-vf', "drawbox=enable='between(t,24,26)':color=black:t=fill",
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-ac', '1', '-ar', '44100',
  src,
])
console.log('fonte de teste: 47s, 640x360@25fps, áudio mono 44.1kHz, preto em 24–26s\n')

// ── 2. ingere ──────────────────────────────────────────────────────────────
const ing = spawnSync('node', [
  join(ROOT, 'packages/pipeline/src/cli.mjs'), 'ingest', src,
  '--id', 'filme_test', '--tipo', 'filme', '--title', "Filme d'Teste",
  '--tags', 'teste,filme', '--min-edge', '10',
], { stdio: 'inherit' })
check('pipeline ingest terminou com exit 0', ing.status === 0)
if (ing.status !== 0) process.exit(1)
console.log()

// ── 3. segmentos no padrão do canal ────────────────────────────────────────
const segDir = join(ROOT, '.ingest-work', 'filme_test', 'segments')
const seg0 = join(segDir, 'seg00000.ts')
const seg4 = join(segDir, 'seg00004.ts')
check('47s viraram 5 segmentos (padding → 50s)', existsSync(seg4) && !existsSync(join(segDir, 'seg00005.ts')))

const p0 = ffprobeJson(seg0)
const v = p0.streams.find((s) => s.codec_type === 'video')
const a = p0.streams.find((s) => s.codec_type === 'audio')
check('vídeo normalizado p/ 1280x720 H.264', v?.codec_name === 'h264' && v?.width === 1280 && v?.height === 720)
check('áudio normalizado p/ AAC 48kHz stereo', a?.codec_name === 'aac' && a?.sample_rate === '48000' && a?.channels === 2)
const d4 = Number(ffprobeJson(seg4).format.duration)
check('último segmento (com pad de preto) tem ~10s', d4 > 9.5 && d4 < 10.6, `${d4.toFixed(3)}s`)

// ── 4. registro no D1 ──────────────────────────────────────────────────────
const media = d1json("SELECT duracao_seg, segment_count, status, metadata FROM media_items WHERE id='filme_test'")[0]
check('media_items registrado (50s, 5 segs, ready)',
  media?.duracao_seg === 50 && media?.segment_count === 5 && media?.status === 'ready')
check("metadata JSON com título escapado (Filme d'Teste)",
  (() => { try { return JSON.parse(media.metadata).title === "Filme d'Teste" } catch { return false } })())
const cues = d1json("SELECT time_seg FROM media_cue_points WHERE media_id='filme_test'").map((r) => r.time_seg)
check('cue point do preto (24s) arredondado p/ grade de 10s', cues.length === 1 && (cues[0] === 20 || cues[0] === 30),
  `[${cues.join(', ')}]`)

// ── 5. e2e: entra na grade e vai pro ar ────────────────────────────────────
const health = await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null)
if (health?.status !== 'ok') {
  console.log('⚠️  wrangler dev fora do ar — pulei a checagem de reprodução (rode: pnpm dev)')
} else {
  const maxEnd = d1json(`SELECT MAX(end_time_virtual) m FROM epg_virtual WHERE canal='${CANAL}'`)[0]?.m
  const T = maxEnd ?? Math.floor(Date.now() / 10000) * 10 + 600
  d1json(`DELETE FROM epg_virtual WHERE media_id='filme_test'`)
  d1json(`INSERT INTO epg_virtual (canal, media_id, start_time_virtual, end_time_virtual, segment_index_start)
          VALUES ('${CANAL}','filme_test',${T},${T + 50},0)`)

  const at = (t) => fetch(`${BASE}/live/${CANAL}?at=${t}`).then((r) => r.text())
  const entering = await at(T + 5)
  const inside = await at(T + 45)
  check('filme entra no ar com EXT-X-DISCONTINUITY', entering.includes('#EXT-X-DISCONTINUITY') && entering.includes('filme_test/seg00000'))
  check('45s depois o player está no seg00004', inside.includes('filme_test/seg00004'))

  const segUrl = inside.trim().split('\n').filter((l) => l && !l.startsWith('#')).at(-1)
  const segRes = await fetch(new URL(segUrl, BASE))
  const bytes = segRes.ok ? (await segRes.arrayBuffer()).byteLength : 0
  check('segmento ingerido é servido pelo Worker via R2', bytes > 10_000, `${(bytes / 1024).toFixed(0)}KB`)
}

console.log(`\n${fail === 0 ? '🎉' : '💥'} ${pass}/${pass + fail} checagens passaram`)
process.exit(fail === 0 ? 0 : 1)
