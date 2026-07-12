// Backfill da fase 12: transcreve comerciais/vinhetas JÁ ingeridos (não têm
// mais staging — reconstrói o áudio a partir dos próprios segmentos .ts no
// R2) e envia o texto pro Worker, que extrai a promessa via LLM e joga na
// fila de revisão do painel.
//
// Uso: BASE=https://... ADMIN_TOKEN=... node scripts/backfill-promessas.mjs
// Requer: ffmpeg e faster-whisper (python3) — roda onde a fábrica roda.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787'
const TOKEN = process.env.ADMIN_TOKEN ?? 'bieltv-dev-2026'
const HDR = { authorization: `Bearer ${TOKEN}` }

function ffmpeg() {
  for (const c of [process.env.FFMPEG, 'ffmpeg', join(homedir(), '.local/bin/ffmpeg')].filter(Boolean)) {
    try { execFileSync(c, ['-version'], { stdio: 'ignore' }); return c } catch { /* próximo */ }
  }
  throw new Error('ffmpeg não encontrado')
}

const log = (s) => console.log(`[backfill] ${s}`)

const media = await fetch(`${BASE}/admin/media`, { headers: HDR }).then((r) => r.json())
const promessas = await fetch(`${BASE}/admin/promessas`, { headers: HDR }).then((r) => r.json())
const jaTem = new Set(promessas.filter((p) => p.transcript).map((p) => p.media_id))

const alvos = media.filter((m) =>
  (m.tipo === 'comercial' || m.tipo === 'vinheta') && m.status === 'ready' && !jaTem.has(m.id))
log(`${alvos.length} comerciais/vinhetas sem transcrição`)

const work = join(ROOT, '.ingest-work', '_backfill')
let ok = 0
let falhas = 0
for (const m of alvos) {
  try {
    rmSync(work, { recursive: true, force: true })
    mkdirSync(work, { recursive: true })
    const partes = []
    for (let i = 0; i < m.segment_count; i++) {
      const seg = `seg${String(i).padStart(5, '0')}.ts`
      const res = await fetch(`${BASE}/media/${m.id}/${seg}`)
      if (!res.ok) throw new Error(`GET ${seg} → ${res.status}`)
      const f = join(work, seg)
      writeFileSync(f, Buffer.from(await res.arrayBuffer()))
      partes.push(f)
    }
    const wav = join(work, 'audio.wav')
    execFileSync(ffmpeg(), ['-y', '-hide_banner', '-loglevel', 'error',
      '-i', `concat:${partes.join('|')}`, '-vn', '-ac', '1', '-ar', '16000', wav],
      { stdio: ['ignore', 'ignore', 'inherit'] })
    const texto = execFileSync('python3', [join(ROOT, 'scripts/transcreve.py'), wav],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim()
    if (!texto) { log(`— "${m.id}": sem fala detectada, pulando`); continue }
    const res = await fetch(`${BASE}/admin/promessas/${m.id}/transcript`, {
      method: 'POST', headers: { ...HDR, 'content-type': 'application/json' },
      body: JSON.stringify({ transcript: texto }),
    })
    if (!res.ok) throw new Error(`transcript POST → ${res.status}`)
    ok++
    log(`✔ "${m.id}": "${texto.slice(0, 80)}${texto.length > 80 ? '…' : ''}"`)
  } catch (e) {
    falhas++
    log(`✖ "${m.id}": ${e.message}`)
  }
}
rmSync(work, { recursive: true, force: true })
log(`fim: ${ok} transcritos, ${falhas} falhas — revise as promessas no painel`)
