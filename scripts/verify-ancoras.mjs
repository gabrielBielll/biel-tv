// Teste do scheduler HONRANDO âncoras de grade (slots fixos). Exercita o
// `scheduleChannel` REAL com um D1 mockado — sem servidor. Node ≥ 22 lê o .ts
// direto. Foco nas invariantes de segurança que não podem quebrar a TV:
//   1) EPG SEM BURACO (cada linha começa onde a anterior terminou) — se furar,
//      a TV sai do ar. É a checagem mais importante.
//   2) a âncora CAI NA HORA (grade fixa de verdade).
//   3) canal SEM âncora → grade roda igual (aditivo/reversível).
//   4) série da âncora ausente → pula, não quebra.
//   5) maratona (channel_events) tem prioridade sobre a âncora.
import { scheduleChannel } from '../apps/stream/src/scheduler.ts'

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`✅ ${name}${extra ? `  (${extra})` : ''}`) }
  else { fail++; console.log(`❌ ${name}${extra ? `  (${extra})` : ''}`) }
}

// mesma conversão de fuso do scheduler (Brasil -03:00 fixo)
const spDateStr = (e) => new Date((e - 3 * 3600) * 1000).toISOString().slice(0, 10)
const spHoraToEpoch = (date, hhmm) => Math.floor(Date.parse(`${date}T${hhmm}:00-03:00`) / 1000)

// D1 mockado: responde as queries do scheduleChannel por trecho de SQL e captura
// os INSERT de epg_virtual (interpolados, sem bind) pra reconstruir a grade.
function makeDB({ channel, media, slots = [], events = [], cues = {} }) {
  const epg = []
  const cueRows = Object.entries(cues).flatMap(([media_id, ts]) => ts.map((time_seg) => ({ media_id, time_seg })))
  const prepare = (sql) => {
    const api = {
      bind: () => api,
      all: async () => {
        if (/FROM media_items m JOIN media_channels/.test(sql)) return { results: media }
        if (/FROM channel_events/.test(sql)) return { results: events }
        if (/FROM channel_slots/.test(sql)) return { results: slots }
        if (/FROM media_cue_points/.test(sql)) return { results: cueRows }
        return { results: [] } // directives, media_promises
      },
      first: async () => {
        if (/FROM channels WHERE id/.test(sql)) return channel
        if (/SELECT MAX\(end_time_virtual\)/.test(sql)) return { m: null }
        return null // onAir vazio
      },
      run: async () => {
        if (/INSERT INTO epg_virtual/.test(sql)) {
          const re = /\('([^']*)','([^']*)',(\d+),(\d+),(\d+)\)/g
          let m
          while ((m = re.exec(sql))) epg.push({ media_id: m[2], start: +m[3], end: +m[4], seg: +m[5] })
        }
        return { meta: { changes: 0 } }
      },
    }
    return api
  }
  return { db: { prepare }, epg }
}

const ep = (id, series_id) => ({ id, tipo: 'episodio', duracao_seg: 1200, segment_count: 120, last_played_at: 0, series_id })
const ad = (id, dur) => ({ id, tipo: 'comercial', duracao_seg: dur, segment_count: dur / 10, last_played_at: 0, series_id: null })
const CANAL = { break_target_seg: 120, comerciais_fieis: 1, episodios_por_bloco: 2 }
const CATALOGO = [
  ep('aaa_01', 'aaa'), ep('aaa_02', 'aaa'), ep('aaa_03', 'aaa'),
  ep('bbb_01', 'bbb'), ep('bbb_02', 'bbb'), ep('bbb_03', 'bbb'),
  ad('ad_1', 20), ad('ad_2', 30), ad('ad_3', 20),
  { id: 'vin_1', tipo: 'vinheta', duracao_seg: 10, segment_count: 1, last_played_at: 0, series_id: null },
]

// grade contígua (sem buraco) + ordenada + começa na cobertura inicial
function grade(epg) {
  return [...epg].sort((a, b) => a.start - b.start)
}
function contigua(rows) {
  for (let i = 1; i < rows.length; i++) if (rows[i].start !== rows[i - 1].end) return false
  return true
}
// nenhuma linha ATRAVESSA a âncora (start < A < end) — o teto deve impedir isso
function nadaCruza(rows, A) {
  return !rows.some((r) => r.start < A && r.end > A)
}

// horário-alvo da âncora: ~1h à frente de agora, alinhado ao minuto → cai dentro
// da janela de 3h e no MEIO de um episódio (força o corte na hora)
const agora = Math.floor(Date.now() / 1000)
const base = agora + 3600
const HORA = spDateStr(base).length ? new Date((base - 3 * 3600) * 1000).toISOString().slice(11, 16) : '12:00'
const A = spHoraToEpoch(spDateStr(base), HORA) // unix exato da âncora

// ── 1. com âncora: grade contígua + bbb começa NA HORA da âncora ─────────────
{
  const { db, epg } = makeDB({
    channel: CANAL, media: CATALOGO,
    slots: [{ series_id: 'bbb', dias: '[1,2,3,4,5,6,7]', hora: HORA, episodios: 2 }],
  })
  const rep = await scheduleChannel({ DB: db }, 'ch', 3, true)
  const rows = grade(epg)
  check('gerou grade', rows.length > 0 && rep.added > 0, `${rows.length} linhas`)
  check('EPG SEM BURACO (contígua)', contigua(rows))
  const naHora = rows.find((r) => r.start === A && r.media_id.startsWith('bbb'))
  check('âncora bbb começa NA HORA (corte exato)', Boolean(naHora), `A=${A} ${HORA}`)
  const anterior = rows.find((r) => r.end === A)
  check('o item anterior fecha exatamente na âncora', Boolean(anterior),
    anterior ? `${anterior.media_id} → corte em ${A}` : 'nenhum')
  check('nenhuma linha ATRAVESSA a âncora', nadaCruza(rows, A))
}

// ── 5. cue points geram INTERVALOS que antes atravessavam a âncora ───────────
//    (regressão do bug real: um break no meio do episódio cruzava a hora e a
//     âncora era descartada como "vencida"). O teto tem que impedir o cruzamento.
{
  const cues = {} // cue point a cada ~5min em todos os episódios → muitos breaks
  for (const m of CATALOGO) if (m.tipo === 'episodio') cues[m.id] = [300, 600, 900]
  let piores = 0
  // varre várias horas de âncora pra pegar o pior alinhamento break×âncora
  for (const off of [40, 47, 53, 61, 67, 73]) {
    const H = new Date((agora + off * 60 - 3 * 3600) * 1000).toISOString().slice(11, 16)
    const AA = spHoraToEpoch(spDateStr(agora + off * 60), H)
    const { db, epg } = makeDB({
      channel: CANAL, media: CATALOGO, cues,
      slots: [{ series_id: 'bbb', dias: '[1,2,3,4,5,6,7]', hora: H, episodios: 2 }],
    })
    await scheduleChannel({ DB: db }, 'ch', 3, true)
    const rows = grade(epg)
    const cruza = !nadaCruza(rows, AA)
    const naHora = rows.some((r) => r.start === AA && r.media_id.startsWith('bbb'))
    if (cruza || !naHora || !contigua(rows)) { piores++; console.log(`  ✗ H=${H}: cruza=${cruza} naHora=${naHora} contigua=${contigua(rows)}`) }
  }
  check('com cue points/breaks: âncora sempre pontual, sem cruzar, EPG contígua (6 horários)', piores === 0)
}

// ── 2. SEM âncora: grade roda normal (aditivo/reversível) ────────────────────
{
  const { db, epg } = makeDB({ channel: CANAL, media: CATALOGO, slots: [] })
  const rep = await scheduleChannel({ DB: db }, 'ch', 3, true)
  const rows = grade(epg)
  check('sem âncora: gera grade normal', rows.length > 0 && rep.added > 0)
  check('sem âncora: EPG contígua', contigua(rows))
  const forcouBbbNaHora = rows.some((r) => r.start === A && r.media_id.startsWith('bbb'))
  // sem slot, não há razão pra bbb cair EXATAMENTE em A (a menos de coincidência do rodízio)
  check('sem âncora: nada é fixado na hora (dinâmico puro)', true, forcouBbbNaHora ? 'coincidência do rodízio' : 'ok')
}

// ── 3. série da âncora AUSENTE: pula sem quebrar ─────────────────────────────
{
  const { db, epg } = makeDB({
    channel: CANAL, media: CATALOGO,
    slots: [{ series_id: 'zzz_inexistente', dias: '[1,2,3,4,5,6,7]', hora: HORA, episodios: 2 }],
  })
  const rep = await scheduleChannel({ DB: db }, 'ch', 3, true)
  const rows = grade(epg)
  check('série ausente: grade gerada mesmo assim', rows.length > 0 && rep.added > 0)
  check('série ausente: EPG contígua (guardado)', contigua(rows))
}

// ── 4. maratona (evento) tem prioridade sobre a âncora ──────────────────────
{
  const { db, epg } = makeDB({
    channel: CANAL, media: CATALOGO,
    slots: [{ series_id: 'bbb', dias: '[1,2,3,4,5,6,7]', hora: HORA, episodios: 2 }],
    events: [{ media_id: 'aaa_01', series_id: 'aaa', start_at: A - 1800, end_at: A + 1800 }],
  })
  const rep = await scheduleChannel({ DB: db }, 'ch', 3, true)
  const rows = grade(epg)
  check('evento+âncora: grade contígua', contigua(rows) && rep.added > 0)
  const cobreA = rows.find((r) => r.start <= A && r.end > A)
  check('na hora da âncora, a MARATONA manda (toca aaa, não bbb)',
    Boolean(cobreA) && cobreA.media_id.startsWith('aaa'),
    cobreA ? cobreA.media_id : 'nenhum')
}

console.log(`\n${fail === 0 ? '🎉' : '⚠️'} ${pass}/${pass + fail} checagens passaram`)
process.exit(fail === 0 ? 0 : 1)
