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
import { SEG, FFMPEG, probe, normalize, segment, detectBlack } from './ffmpeg.mjs'
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
    // 'disabled' = a mídia nasce FORA do ar, esperando aprovação no editor.
    // Usado pelo cortador automático (peça recortada é palpite da máquina até o
    // Gabriel ver). Default 'ready': upload manual/episódio/filme é escolha dele,
    // já é a aprovação. ⚠️ parseArgs RECUSA flag não declarada
    // (ERR_PARSE_ARGS_UNKNOWN_OPTION) — passar --status sem esta linha derruba o
    // ingest inteiro antes de começar.
    status: { type: 'string', default: 'ready' },
    'base-url': { type: 'string' },
    'min-edge': { type: 'string', default: '60' },
    crf: { type: 'string', default: '23' },
    'no-cues': { type: 'boolean', default: false },
    'no-transcript': { type: 'boolean', default: false },
    'keep-workdir': { type: 'boolean', default: false },
  },
})

const [cmd, input] = positionals
const TIPOS = ['episodio', 'filme', 'comercial', 'vinheta', 'placeholder']

function die(msg) {
  console.error(`✖ ${msg}`)
  process.exit(1)
}

// Qualquer passo async que estoure sem catch vira uma mensagem limpa "✖ …"
// em vez de um crash dump do Node (cuja última linha, "Node.js vX", acabava
// gravada como "erro" do job — inútil pra diagnosticar).
process.on('uncaughtException', (e) => die(String(e?.message ?? e)))
process.on('unhandledRejection', (e) => die(String(e?.message ?? e)))

if (cmd !== 'ingest') die('uso: pnpm ingest <arquivo> --id <id> --tipo <tipo> [...opções]')
if (!input || !existsSync(input)) die(`arquivo de entrada não encontrado: ${input}`)
if (!opt.id || !/^[a-z0-9_]+$/.test(opt.id)) die('--id obrigatório (minúsculas, dígitos e _)')
if (!TIPOS.includes(opt.tipo)) die(`--tipo obrigatório: ${TIPOS.join('|')}`)
if (!['local', 'remote'].includes(opt.target)) die('--target deve ser local ou remote')
const canais = (opt.canais ?? '').split(',').map((s) => s.trim()).filter(Boolean)
for (const c of canais) if (!/^[a-z0-9_]{2,40}$/.test(c)) die(`canal inválido: ${c}`)
const baseUrl = opt['base-url'] ?? (opt.target === 'local' ? '' : process.env.R2_PUBLIC_BASE_URL)
// baseUrl === '' é válido e intencional (mídia servida via /media/* do Worker,
// sem domínio público próprio) — só falha quando REALMENTE não foi informado.
if (opt.target === 'remote' && baseUrl === undefined) die('para remote informe --base-url (domínio público do bucket)')

const workdir = join(ROOT, '.ingest-work', opt.id)
rmSync(workdir, { recursive: true, force: true })
mkdirSync(join(workdir, 'segments'), { recursive: true })

// 1/5 probe
const info = await probe(input)
const paddedDur = Math.ceil(info.duration / SEG) * SEG
const pad = paddedDur - info.duration
console.log(`1/5 probe: ${info.duration.toFixed(1)}s, ${info.width}x${info.height}, ` +
  `${info.vcodec}/${info.acodec ?? 'sem áudio'} → alvo ${paddedDur}s (${paddedDur / SEG} segmentos)`)

// Progresso do job inteiro (0–100) em linhas "progresso: N%" no stdout —
// a fábrica parseia e repassa pro painel. Normalização domina o tempo real:
// 0→90; segmentação 92; cues 94; upload 94→99; o "done" da fila fecha em 100.
let ultimoPct = -1
function progresso(pct) {
  if (pct > ultimoPct) {
    ultimoPct = pct
    console.log(`progresso: ${pct}%`)
  }
}

// 2/5 normalização (a etapa demorada — re-encode completo)
console.log(`2/5 normalizando p/ 720p H.264 (crf ${opt.crf})${pad > 0.01 ? ` + pad de ${pad.toFixed(1)}s` : ''}…`)
const normalized = join(workdir, 'normalized.mp4')
await normalize(input, normalized, {
  paddedDur, pad, hasAudio: info.hasAudio, crf: Number(opt.crf),
  onProgress: (pct) => progresso(Math.floor(pct * 0.9)),
})

// 3/5 segmentação (cópia, sem re-encode)
const segDir = join(workdir, 'segments')
await segment(normalized, segDir)
progresso(92)
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
progresso(94)

// transcrição (fase 12): só comercial/vinheta — o texto falado é a fonte da
// "promessa" ("a seguir...", "sábado às 20h") que o Worker extrai via LLM.
// NUNCA bloqueia a ingestão: sem whisper/erro → segue sem transcript.
let transcript = null
if (!opt['no-transcript'] && (opt.tipo === 'comercial' || opt.tipo === 'vinheta')) {
  try {
    const { execFileSync } = await import('node:child_process')
    const wav = join(workdir, 'audio16k.wav')
    execFileSync(FFMPEG(), ['-y', '-hide_banner', '-loglevel', 'error', '-i', normalized,
      '-vn', '-ac', '1', '-ar', '16000', wav], { stdio: ['ignore', 'ignore', 'inherit'] })
    const out = execFileSync('python3', [join(ROOT, 'scripts/transcreve.py'), wav],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
    transcript = out.trim() || null
    console.log(transcript
      ? `4.5/5 transcrição: "${transcript.slice(0, 90)}${transcript.length > 90 ? '…' : ''}"`
      : '4.5/5 transcrição: (sem fala detectada)')
  } catch (e) {
    const code = e?.status
    console.log(code === 3
      ? '4.5/5 transcrição: pulada (faster-whisper não instalado aqui)'
      : `4.5/5 transcrição: falhou (${String(e?.message ?? e).split('\n')[0].slice(0, 120)}) — seguindo sem`)
  }
}

// 5/5 upload + registro
const progress = (done, total) => {
  process.stdout.write(`\r5/5 upload ${opt.target}: ${done}/${total} segmentos`)
  const pct = 94 + Math.floor((done / total) * 5)
  if (pct > ultimoPct) {
    ultimoPct = pct
    process.stdout.write(`\nprogresso: ${pct}%\n`)
  }
}
if (opt.target === 'local') uploadLocal(ROOT, segDir, opt.id, progress)
else await uploadRemote(segDir, opt.id, progress)
console.log()

const metadata = {
  title: opt.title ?? opt.id,
  ...(opt.series ? { series_id: opt.series } : {}),
  ...(opt.episode ? { episode: Number(opt.episode) } : {}),
  tags: opt.tags ? opt.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
}
// --status disabled: a mídia nasce FORA do ar, esperando aprovação. É o que o
// cortador usa — peça recortada é palpite até o Gabriel ver.
runD1(ROOT, buildRegisterSql({
  id: opt.id, tipo: opt.tipo, paddedDur, segmentCount: segCount, baseUrl, metadata, cues, canais, transcript,
  status: opt.status === 'disabled' ? 'disabled' : 'ready',
}), { local: opt.target === 'local', label: `register-${opt.id}` })

if (!opt['keep-workdir']) rmSync(normalized, { force: true })
console.log(`✔ "${opt.id}" pronto: ${segCount} segmentos em ${opt.target === 'local' ? 'R2 local' : baseUrl}, ` +
  `${cues.length} cue point(s), registrado no D1 (${opt.target}).`)
console.log(`  segmentos mantidos em ${join(workdir, 'segments')}`)
