// Montador de grade determinístico (embrião do Diretor da fase 4).
// Lê o catálogo do D1 LOCAL e preenche as próximas horas do canal com ritmo
// de TV: [vinheta "a seguir"] → programa (com intervalo nos cue points) →
// comerciais → próximo programa, em rodízio. Tudo alinhado à grade de 10s.
import { mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SEG = 10
const CANAL = process.env.CANAL ?? 'bieltv_1'
const HOURS = Number(process.env.HOURS ?? 3)

function d1(sql) {
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'biel-tv-db', '--local', '--json', '--command', sql], {
    cwd: join(ROOT, 'apps', 'stream'), encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`d1 falhou: ${r.stderr}`)
  return JSON.parse(r.stdout.slice(r.stdout.indexOf('[')))[0].results
}

// ── catálogo ───────────────────────────────────────────────────────────────
const media = d1("SELECT id, tipo, duracao_seg FROM media_items WHERE status='ready'")
const cueRows = d1('SELECT media_id, time_seg FROM media_cue_points ORDER BY time_seg')
const cuesOf = {}
for (const c of cueRows) (cuesOf[c.media_id] ??= []).push(c.time_seg)

const contents = media.filter((m) => m.tipo === 'episodio' || m.tipo === 'filme')
const ads = media.filter((m) => m.tipo === 'comercial')
const bumpers = media.filter((m) => m.tipo === 'vinheta')

if (contents.length === 0) {
  console.error('nenhum conteúdo (episodio/filme) com status ready no D1 — ingira algo antes')
  process.exit(1)
}

// ── montagem ───────────────────────────────────────────────────────────────
// Append-only: se o canal está no ar, a grade nova começa quando o bloco
// atual TERMINA — quem está assistindo não percebe nada. Só num canal vazio
// é que começamos 10 min no passado.
const now = Math.floor(Date.now() / 1000)
const onAir = d1(
  `SELECT end_time_virtual e FROM epg_virtual
   WHERE canal='${CANAL}' AND start_time_virtual <= ${now} AND end_time_virtual > ${now}
   ORDER BY start_time_virtual LIMIT 1`,
)[0]
const start = onAir ? onAir.e : Math.floor(now / SEG) * SEG - 600
const end = start + HOURS * 3600

const rows = [] // [media_id, start, end, segment_index_start]
let t = start
let ci = 0
let ai = 0
let bi = 0
const pick = (arr, i) => arr[i % arr.length]

while (t < end) {
  // vinheta anunciando o próximo programa
  if (bumpers.length > 0) {
    const b = pick(bumpers, bi++)
    rows.push([b.id, t, t + b.duracao_seg, 0])
    t += b.duracao_seg
  }

  // programa, fatiado nos cue points (se houver)
  const c = pick(contents, ci++)
  const cues = (cuesOf[c.id] ?? []).filter((x) => x > 0 && x < c.duracao_seg)
  let pos = 0
  for (const cue of cues) {
    rows.push([c.id, t, t + (cue - pos), pos / SEG])
    t += cue - pos
    pos = cue
    if (ads.length > 0) {
      const a = pick(ads, ai++)
      rows.push([a.id, t, t + a.duracao_seg, 0])
      t += a.duracao_seg
    }
  }
  rows.push([c.id, t, t + (c.duracao_seg - pos), pos / SEG])
  t += c.duracao_seg - pos

  // intervalo entre programas
  if (ads.length > 0) {
    const a = pick(ads, ai++)
    rows.push([a.id, t, t + a.duracao_seg, 0])
    t += a.duracao_seg
  }
}

// ── grava ──────────────────────────────────────────────────────────────────
const values = rows.map(([m, s, e, i]) => `('${CANAL}','${m}',${s},${e},${i})`)
const chunks = []
for (let i = 0; i < values.length; i += 80) {
  chunks.push(`INSERT INTO epg_virtual (canal, media_id, start_time_virtual, end_time_virtual, segment_index_start)
VALUES\n  ${values.slice(i, i + 80).join(',\n  ')};`)
}
const sql = [
  // remove só o futuro (a partir do início da grade nova) e faxina o passado distante
  `DELETE FROM epg_virtual WHERE canal = '${CANAL}' AND start_time_virtual >= ${start};`,
  `DELETE FROM epg_virtual WHERE canal = '${CANAL}' AND end_time_virtual < ${now - 86400};`,
  ...chunks,
].join('\n\n')

mkdirSync(join(ROOT, '.ingest-work'), { recursive: true })
const sqlPath = join(ROOT, '.ingest-work', 'seed.sql')
writeFileSync(sqlPath, sql)

const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'biel-tv-db', '--local', '--file', sqlPath], {
  cwd: join(ROOT, 'apps', 'stream'),
  stdio: ['ignore', 'ignore', 'inherit'],
})
if (r.status !== 0) {
  console.error('falha ao gravar a grade no D1 local')
  process.exit(1)
}

// ── resumo ─────────────────────────────────────────────────────────────────
const hora = (ts) =>
  new Date(ts * 1000).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })
console.log(`Grade montada: ${rows.length} blocos (~${HOURS}h) no canal "${CANAL}"` +
  (onAir ? ' — preservado o bloco no ar; grade nova a partir do fim dele' : ''))
console.log(`Catálogo usado: ${contents.length} programa(s), ${ads.length} comercial(is), ${bumpers.length} vinheta(s)`)
console.log('Início da grade (horário de São Paulo):')
for (const [m, s, e] of rows.slice(0, 12)) {
  console.log(`  ${hora(s)} → ${hora(e)}  ${m}`)
}
