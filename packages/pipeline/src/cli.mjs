#!/usr/bin/env node
// Biel TV — pipeline de ingestão (fase 2).
//
//   pnpm ingest <video> --id ep_pr_s1e01 --tipo episodio --title "Power Rangers S1E01" \
//     [--series pr_s1] [--episode 1] [--tags acao,anos90] \
//     [--target local|remote] [--base-url https://media1.dominio.com] \
//     [--min-edge 60] [--crf 23] [--no-cues] [--keep-workdir]
//
// Fluxo: probe → normaliza (perfil único + pad p/ múltiplo de 10s) →
// segmenta (.ts de 10s exatos) → blackdetect → upload R2 → registro D1.
import { parseArgs } from 'node:util'
import { existsSync, rmSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SEG, probe, normalize, segment, detectBlack } from './ffmpeg.mjs'
import { snapCuePoints } from './cuepoints.mjs'
import { buildRegisterSql, runD1 } from './registry.mjs'
import { listSegments, uploadLocal, uploadRemote } from './upload.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    id: { type: 'string' },
    tipo: { type: 'string' },
    title: { type: 'string' },
    series: { type: 'string' },
    episode: { type: 'string' },
    tags: { type: 'string' },
    target: { type: 'string', default: 'local' },
    canais: { type: 'string' },
    'base-url': { type: 'string' },
    'min-edge': { type: 'string', default: '60' },
    crf: { type: 'string', default: '23' },
    'no-cues': { type: 'boolean', default: false },
    'keep-workdir': { type: 'boolean', default: false },
  },
})

const [cmd, input] = positionals
const TIPOS = ['episodio', 'filme', 'comercial', 'vinheta', 'placeholder']

function die(msg) {
  console.error(`✖ ${msg}`)
  process.exit(1)
}

if (cmd !== 'ingest') die('uso: pnpm ingest <arquivo> --id <id> --tipo <tipo> [...opções]')
if (!input || !existsSync(input)) die(`arquivo de entrada não encontrado: ${input}`)
if (!opt.id || !/^[a-z0-9_]+$/.test(opt.id)) die('--id obrigatório (minúsculas, dígitos e _)')
if (!TIPOS.includes(opt.tipo)) die(`--tipo obrigatório: ${TIPOS.join('|')}`)
if (!['local', 'remote'].includes(opt.target)) die('--target deve ser local ou remote')
const canais = (opt.canais ?? '').split(',').map((s) => s.trim()).filter(Boolean)
for (const c of canais) if (!/^[a-z0-9_]{2,40}$/.test(c)) die(`canal inválido: ${c}`)
const baseUrl = opt['base-url'] ?? (opt.target === 'local' ? '' : process.env.R2_PUBLIC_BASE_URL)
if (opt.target === 'remote' && !baseUrl) die('para remote informe --base-url (domínio público do bucket)')

const workdir = join(ROOT, '.ingest-work', opt.id)
rmSync(workdir, { recursive: true, force: true })
mkdirSync(join(workdir, 'segments'), { recursive: true })

// 1/5 probe
const info = await probe(input)
const paddedDur = Math.ceil(info.duration / SEG) * SEG
const pad = paddedDur - info.duration
console.log(`1/5 probe: ${info.duration.toFixed(1)}s, ${info.width}x${info.height}, ` +
  `${info.vcodec}/${info.acodec ?? 'sem áudio'} → alvo ${paddedDur}s (${paddedDur / SEG} segmentos)`)

// 2/5 normalização (a etapa demorada — re-encode completo)
console.log(`2/5 normalizando p/ 720p H.264 (crf ${opt.crf})${pad > 0.01 ? ` + pad de ${pad.toFixed(1)}s` : ''}…`)
const normalized = join(workdir, 'normalized.mp4')
await normalize(input, normalized, {
  paddedDur, pad, hasAudio: info.hasAudio, crf: Number(opt.crf),
})

// 3/5 segmentação (cópia, sem re-encode)
const segDir = join(workdir, 'segments')
await segment(normalized, segDir)
rmSync(join(segDir, '_index.m3u8'), { force: true })
const segCount = listSegments(segDir).length
if (segCount !== paddedDur / SEG) {
  die(`segmentação gerou ${segCount} segmentos, esperava ${paddedDur / SEG} — keyframes fora da grade?`)
}
console.log(`3/5 segmentado: ${segCount} × ${SEG}.0s ✓`)

// 4/5 cue points
let cues = []
if (!opt['no-cues'] && opt.tipo !== 'comercial' && opt.tipo !== 'vinheta') {
  const blacks = await detectBlack(normalized)
  cues = snapCuePoints(blacks, { duration: paddedDur, minEdge: Number(opt['min-edge']) })
  const desc = blacks.map((b) => `${b.start.toFixed(1)}–${b.end.toFixed(1)}s`).join(', ') || 'nenhum'
  console.log(`4/5 cue points: preto em [${desc}] → cortes em [${cues.join(', ') || '—'}]s`)
} else {
  console.log('4/5 cue points: pulado')
}

// 5/5 upload + registro
const progress = (done, total) => process.stdout.write(`\r5/5 upload ${opt.target}: ${done}/${total} segmentos`)
if (opt.target === 'local') uploadLocal(ROOT, segDir, opt.id, progress)
else await uploadRemote(segDir, opt.id, progress)
console.log()

const metadata = {
  title: opt.title ?? opt.id,
  ...(opt.series ? { series_id: opt.series } : {}),
  ...(opt.episode ? { episode: Number(opt.episode) } : {}),
  tags: opt.tags ? opt.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
}
runD1(ROOT, buildRegisterSql({
  id: opt.id, tipo: opt.tipo, paddedDur, segmentCount: segCount, baseUrl, metadata, cues, canais,
}), { local: opt.target === 'local', label: `register-${opt.id}` })

if (!opt['keep-workdir']) rmSync(normalized, { force: true })
console.log(`✔ "${opt.id}" pronto: ${segCount} segmentos em ${opt.target === 'local' ? 'R2 local' : baseUrl}, ` +
  `${cues.length} cue point(s), registrado no D1 (${opt.target}).`)
console.log(`  segmentos mantidos em ${join(workdir, 'segments')}`)
