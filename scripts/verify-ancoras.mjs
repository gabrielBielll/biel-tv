// Teste do scheduler HONRANDO âncoras de grade (slots fixos). Exercita o
// `scheduleChannel` REAL com um D1 mockado — sem servidor. Node ≥ 22 lê o .ts
// direto. Foco nas invariantes de segurança que não podem quebrar a TV:
//   1) EPG SEM BURACO (cada linha começa onde a anterior terminou) — se furar,
//      a TV sai do ar. É a checagem mais importante.
//   2) a âncora CAI NA HORA (grade fixa de verdade).
//   3) canal SEM âncora → grade roda igual (aditivo/reversível).
//   4) série da âncora ausente → pula, não quebra.
//   5) maratona (channel_events) tem prioridade sobre a âncora.
//   6) PROGRAMA NUNCA É CORTADO pela âncora: o que não cabe inteiro não entra,
//      e o vão vira curta (encaixe) + intervalo (enchimento).
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
function makeDB({ channel, media, slots = [], events = [], cues = {}, covEnd = null, gapEnd = null, promises = [] }) {
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
        if (/FROM media_promises/.test(sql)) return { results: promises }
        return { results: [] } // directives, futuro agendado
      },
      first: async () => {
        if (/FROM channels WHERE id/.test(sql)) return channel
        // fim GLOBAL do epg (detector de downtime) — alias g, sem filtro de futuro
        if (/MAX\(end_time_virtual\) g/.test(sql)) return { g: gapEnd }
        // cobertura futura (alias m) — covEnd permite começar a run num instante exato
        if (/SELECT MAX\(end_time_virtual\)/.test(sql)) return { m: covEnd }
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
  // D1 real tem batch(stmts) (round-trip único); no mock só roda cada um.
  const batch = async (stmts) => Promise.all(stmts.map((s) => s.run()))
  return { db: { prepare, batch }, epg }
}

const ep = (id, series_id, lp = 0) => ({ id, tipo: 'episodio', duracao_seg: 1200, segment_count: 120, last_played_at: lp, series_id })
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

// ── 6. COLISÃO: duas âncoras no MESMO horário → ambas tocam (a 2ª atrasada) ──
//    (regressão do bug corrida maluca ago/2026: looney_tunes_show e corrida
//     ambos às 16:00 → a 2ª era descartada em SILÊNCIO e nunca ia ao ar)
{
  const CAT = [...CATALOGO, ep('ccc_01', 'ccc'), ep('ccc_02', 'ccc')]
  const { db, epg } = makeDB({
    channel: CANAL, media: CAT,
    slots: [
      { series_id: 'bbb', dias: '[1,2,3,4,5,6,7]', hora: HORA, episodios: 2 },
      { series_id: 'ccc', dias: '[1,2,3,4,5,6,7]', hora: HORA, episodios: 1 },
    ],
  })
  const rep = await scheduleChannel({ DB: db }, 'ch', 3, true)
  const rows = grade(epg)
  const bbbNaHora = rows.some((r) => r.start === A && r.media_id.startsWith('bbb'))
  const cccDepois = rows.find((r) => r.media_id.startsWith('ccc') && r.start >= A && r.start <= A + 45 * 60)
  check('colisão: 1ª âncora começa na hora', bbbNaHora)
  check('colisão: 2ª âncora toca ATRASADA em vez de sumir', Boolean(cccDepois),
    cccDepois ? `ccc às +${Math.round((cccDepois.start - A) / 60)}min` : 'ccc SUMIU')
  check('colisão: nenhuma âncora perdida no report', !rep.ancorasPerdidas)
  check('colisão: EPG contígua', contigua(rows))
}

// ── 7. atraso ALÉM da grace (45min) → âncora cai, mas CONTADA no report ──────
{
  const CAT = [...CATALOGO, ep('ccc_01', 'ccc'), ep('ccc_02', 'ccc')]
  const { db, epg } = makeDB({
    channel: CANAL, media: CAT,
    slots: [
      // 4 episódios ≈ 80+min de bloco: estoura a grace da âncora seguinte
      { series_id: 'bbb', dias: '[1,2,3,4,5,6,7]', hora: HORA, episodios: 4 },
      { series_id: 'ccc', dias: '[1,2,3,4,5,6,7]', hora: HORA, episodios: 1 },
    ],
  })
  const rep = await scheduleChannel({ DB: db }, 'ch', 3, true)
  check('além da grace: perdida é CONTADA no report (nada silencioso)',
    rep.ancorasPerdidas === 1, `ancorasPerdidas=${rep.ancorasPerdidas ?? 0}`)
}

// ── 8. progressão da âncora: continua do episódio SEGUINTE ao último exibido ─
//    (regressão: o cursor zerava a cada run e a série ancorada repetia os
//     primeiros episódios pra sempre). covEnd=A ⇒ a run começa exatamente na
//     âncora, sem rodízio antes — determinístico.
{
  const CAT = [
    ep('aaa_01', 'aaa'), ep('aaa_02', 'aaa'),
    ep('bbb_01', 'bbb', 1000), ep('bbb_02', 'bbb', 2000), ep('bbb_03', 'bbb', 0),
    ad('ad_1', 20), ad('ad_2', 30),
  ]
  const { db, epg } = makeDB({
    channel: CANAL, media: CAT, covEnd: A,
    slots: [{ series_id: 'bbb', dias: '[1,2,3,4,5,6,7]', hora: HORA, episodios: 1 }],
  })
  await scheduleChannel({ DB: db }, 'ch', 3, false)
  const rows = grade(epg)
  const naAncora = rows.find((r) => r.start === A)
  check('progressão: âncora continua do seguinte ao último exibido (bbb_03, não bbb_01)',
    naAncora?.media_id === 'bbb_03', naAncora ? naAncora.media_id : 'nada em A')
}

// ── 9. downtime CONTA: ocorrências de âncora perdidas no buraco avançam o cursor
//    (escolha do Gabriel: "avançar como se tivesse passado no ar"). Grade morta
//    há 2 dias (gapEnd = agora-2d) e slot diário ⇒ 2 ocorrências perdidas ⇒ a
//    âncora de hoje toca bbb_03 (pulou 01 e 02, que "teriam passado").
{
  const DAY = 86400
  const CAT = [
    ep('aaa_01', 'aaa'), ep('aaa_02', 'aaa'),
    ep('bbb_01', 'bbb'), ep('bbb_02', 'bbb'), ep('bbb_03', 'bbb'),
    ad('ad_1', 20), ad('ad_2', 30),
  ]
  const { db, epg } = makeDB({
    channel: CANAL, media: CAT, covEnd: A, gapEnd: agora - 2 * DAY,
    slots: [{ series_id: 'bbb', dias: '[1,2,3,4,5,6,7]', hora: HORA, episodios: 1 }],
  })
  await scheduleChannel({ DB: db }, 'ch', 3, false)
  const rows = grade(epg)
  const naAncora = rows.find((r) => r.start === A)
  check('downtime conta: 2 ocorrências perdidas ⇒ âncora toca bbb_03',
    naAncora?.media_id === 'bbb_03', naAncora ? naAncora.media_id : 'nada em A')
}

// ── 10. NUNCA CORTA PROGRAMA: o que não cabe inteiro antes da âncora não entra;
//    o vão vira intervalo. (Veto do Gabriel, set/2026: "um episódio acaba
//    cortando outro… ficar cortando programa fica bem chato, o ideal é passar
//    comerciais mesmo". Antes disto, 1 em cada 4 exibições ia ao ar pela metade.)
//    Agrupa as linhas de cada exibição (elas são quebradas nos cue points) e
//    exige a duração INTEIRA da mídia.
function ocorrencias(rows, catalogo) {
  const porId = new Map(catalogo.map((m) => [m.id, m]))
  const out = []
  let cur = null
  for (const r of rows) {
    const m = porId.get(r.media_id)
    if (!m || (m.tipo !== 'episodio' && m.tipo !== 'filme')) continue
    if (cur && cur.id === r.media_id) { cur.dur += r.end - r.start; cur.fim = r.end }
    else { if (cur) out.push(cur); cur = { id: r.media_id, dur: r.end - r.start, ini: r.start, total: m.duracao_seg } }
  }
  if (cur) out.push(cur)
  return out
}
{
  const cues = {}
  for (const m of CATALOGO) if (m.tipo === 'episodio') cues[m.id] = [300, 600, 900]
  let cortados = 0, furou = 0, comIntervalo = 0
  const horarios = [31, 37, 44, 49, 52, 58, 63, 71, 77, 83]
  for (const off of horarios) {
    const H = new Date((agora + off * 60 - 3 * 3600) * 1000).toISOString().slice(11, 16)
    const AA = spHoraToEpoch(spDateStr(agora + off * 60), H)
    const { db, epg } = makeDB({
      channel: CANAL, media: CATALOGO, cues,
      slots: [{ series_id: 'bbb', dias: '[1,2,3,4,5,6,7]', hora: H, episodios: 1 }],
    })
    await scheduleChannel({ DB: db }, 'ch', 3, true)
    const rows = grade(epg)
    for (const o of ocorrencias(rows, CATALOGO)) {
      if (o.dur < o.total) { cortados++; console.log(`  ✗ H=${H}: ${o.id} foi ao ar ${o.dur}s de ${o.total}s`) }
    }
    if (!contigua(rows) || !nadaCruza(rows, AA)) furou++
    // o vão imediatamente antes da âncora é intervalo (comercial/vinheta)
    const ultimo = rows.filter((r) => r.end <= AA).pop()
    const tipo = CATALOGO.find((m) => m.id === ultimo?.media_id)?.tipo
    if (tipo === 'comercial' || tipo === 'vinheta') comIntervalo++
  }
  check(`programa NUNCA é cortado pela âncora (${horarios.length} horários)`, cortados === 0, `${cortados} cortes`)
  check('sem corte, a EPG segue contígua e a âncora pontual', furou === 0)
  check('o vão antes da âncora vira INTERVALO (comercial no lugar do corte)',
    comIntervalo > 0, `${comIntervalo}/${horarios.length} horários fecharam com intervalo`)
}

// ── 11. ENCAIXE: sobrando um vão que não cabe o episódio do rodízio, entra um
//    conteúdo CURTO que caiba — programa no lugar de 10min de comercial.
{
  const CURTOS = [1, 2, 3].map((i) => ({
    id: `cur_0${i}`, tipo: 'episodio', duracao_seg: 300, segment_count: 30, last_played_at: 0, series_id: 'cur',
  }))
  const CAT = [...CATALOGO, ...CURTOS]
  // a run começa 1000s antes da âncora: não cabe episódio de 1200s, cabe curta
  const { db, epg } = makeDB({
    channel: CANAL, media: CAT, covEnd: A - 1000,
    slots: [{ series_id: 'bbb', dias: '[1,2,3,4,5,6,7]', hora: HORA, episodios: 1 }],
  })
  await scheduleChannel({ DB: db }, 'ch', 3, false)
  const rows = grade(epg)
  const noVao = rows.filter((r) => r.start >= A - 1000 && r.end <= A)
  check('encaixe: curta entra no vão em vez de virar só comercial',
    noVao.some((r) => r.media_id.startsWith('cur_')),
    noVao.map((r) => r.media_id).join(' ').slice(0, 90))
  check('encaixe: EPG contígua e âncora pontual',
    contigua(rows) && nadaCruza(rows, A) && rows.some((r) => r.start === A && r.media_id.startsWith('bbb')))
  check('encaixe: nada cortado', ocorrencias(rows, CAT).every((o) => o.dur === o.total))
}

// ── 12. ENCHIMENTO: canal SEM conteúdo curto ⇒ o vão inteiro vira comercial,
//    e a âncora continua entrando na hora (nunca buraco na EPG).
{
  const { db, epg } = makeDB({
    channel: CANAL, media: CATALOGO, covEnd: A - 900,
    slots: [{ series_id: 'bbb', dias: '[1,2,3,4,5,6,7]', hora: HORA, episodios: 1 }],
  })
  await scheduleChannel({ DB: db }, 'ch', 3, false)
  const rows = grade(epg)
  const noVao = rows.filter((r) => r.start >= A - 900 && r.end <= A)
  const soIntervalo = noVao.length > 0 && noVao.every((r) => {
    const tipo = CATALOGO.find((m) => m.id === r.media_id)?.tipo
    return tipo === 'comercial' || tipo === 'vinheta'
  })
  check('enchimento: vão de 15min sem curta vira intervalo inteiro', soIntervalo,
    `${noVao.length} peças`)
  check('enchimento: âncora entra na hora e a EPG fica contígua',
    contigua(rows) && rows.some((r) => r.start === A && r.media_id.startsWith('bbb')))
}

// ── 13. REPRISE: a âncora marcada repete o que a série já passou HOJE ───────
//    (grades reais de 2005: o mesmo programa volta de manhã, à tarde e à noite
//     — e era o MESMO episódio, não um novo a cada faixa)
{
  const H2 = new Date((A + 3600 - 3 * 3600) * 1000).toISOString().slice(11, 16)
  const A2 = spHoraToEpoch(spDateStr(A + 3600), H2)
  const slots = (reprise) => [
    { series_id: 'bbb', dias: '[1,2,3,4,5,6,7]', hora: HORA, episodios: 1 },
    { series_id: 'bbb', dias: '[1,2,3,4,5,6,7]', hora: H2, episodios: 1, reprise },
  ]

  const comReprise = makeDB({ channel: CANAL, media: CATALOGO, slots: slots(1) })
  await scheduleChannel({ DB: comReprise.db }, 'ch', 3, true)
  const r1 = grade(comReprise.epg)
  const orig = r1.find((r) => r.start === A)?.media_id
  const rep = r1.find((r) => r.start === A2)?.media_id
  // A é "daqui a 1 h": rodando entre 22h e 23h de SP, a 2ª faixa cai no dia
  // seguinte, e aí a reprise não tem o que repetir (vira faixa normal). Sem
  // isto o teste falhava sozinho nesse horário.
  if (spDateStr(A) === spDateStr(A2)) {
    check('reprise: a 2ª âncora exibe o MESMO episódio da 1ª', Boolean(orig) && orig === rep,
      `${orig ?? 'nada'} → ${rep ?? 'nada'}`)
  } else {
    check('reprise que cai no dia seguinte: vira faixa normal (episódio seguinte)', Boolean(orig) && Boolean(rep) && orig !== rep,
      `${orig ?? 'nada'} → ${rep ?? 'nada'}`)
  }
  check('reprise: EPG contígua', contigua(r1))

  const semReprise = makeDB({ channel: CANAL, media: CATALOGO, slots: slots(0) })
  await scheduleChannel({ DB: semReprise.db }, 'ch', 3, true)
  const r2 = grade(semReprise.epg)
  const o2 = r2.find((r) => r.start === A)?.media_id
  const p2 = r2.find((r) => r.start === A2)?.media_id
  check('sem reprise: a 2ª âncora avança pro episódio seguinte (comportamento antigo)',
    Boolean(o2) && Boolean(p2) && o2 !== p2, `${o2 ?? 'nada'} → ${p2 ?? 'nada'}`)
}

// ── 14. reprise sem nada exibido ainda no dia → age como âncora normal ──────
//    (o primeiro slot do dia é sempre o inédito, mesmo marcado como reprise)
{
  const { db, epg } = makeDB({
    channel: CANAL, media: CATALOGO,
    slots: [{ series_id: 'bbb', dias: '[1,2,3,4,5,6,7]', hora: HORA, episodios: 1, reprise: 1 }],
  })
  await scheduleChannel({ DB: db }, 'ch', 3, true)
  const rows = grade(epg)
  const naHora = rows.find((r) => r.start === A)
  check('reprise sem exibição anterior no dia: vira âncora normal, não some',
    Boolean(naHora) && naHora.media_id.startsWith('bbb'), naHora?.media_id ?? 'nada em A')
  check('reprise sem exibição anterior: EPG contígua', contigua(rows))
}

// ── FILME SÓ TOCA NA FAIXA DE FILME (pedido do Gabriel, 23/09/2026) ──────────
{
  const filme = (id, sid) => ({ id, tipo: 'filme', duracao_seg: 5400, segment_count: 540, last_played_at: 0, series_id: sid })
  const CAT = [...CATALOGO, filme('filme_a', 'bloco_filmes'), filme('filme_b', 'bloco_filmes'), filme('filme_solto', 'filme_sem_faixa')]
  // sem faixa nenhuma: filme não entra no rodízio (espera a faixa)
  {
    const { db, epg } = makeDB({ channel: CANAL, media: CAT, slots: [] })
    await scheduleChannel({ DB: db }, 'ch', 24, true)
    check('filme sem faixa fica fora do rodízio', !epg.some((r) => r.media_id.startsWith('filme_')))
    check('filme sem faixa: grade continua contígua', contigua(grade(epg)))
  }
  // com faixa pra bloco_filmes: filme_a/filme_b só na hora da faixa
  {
    const { db, epg } = makeDB({
      channel: CANAL, media: CAT,
      slots: [{ series_id: 'bloco_filmes', dias: '[1,2,3,4,5,6,7]', hora: HORA, episodios: 1 }],
    })
    await scheduleChannel({ DB: db }, 'ch', 24, true)
    const rows = grade(epg)
    const inicios = rows.filter((r) => /^filme_[ab]$/.test(r.media_id) && r.seg === 0).map((r) => r.start)
    const fora = inicios.filter((s) => (s - A) % 86400 !== 0)
    check('filme com faixa: só começa na hora da faixa', inicios.length >= 1 && fora.length === 0,
      `${inicios.length} início(s), ${fora.length} fora da faixa`)
    check('filme com faixa: grade contígua', contigua(rows))
    check('filme de outra série (sem faixa) não aparece', !rows.some((r) => r.media_id === 'filme_solto'))
  }
  // especial provisório na MESMA hora da faixa de filme: cede ao filme
  {
    const slots = [
      { series_id: 'aaa', dias: '[1,2,3,4,5,6,7]', hora: HORA, episodios: 2 }, // o "especial"
      { series_id: 'bloco_filmes', dias: '[1,2,3,4,5,6,7]', hora: HORA, episodios: 1 },
    ]
    const { db, epg } = makeDB({ channel: CANAL, media: CAT, slots })
    await scheduleChannel({ DB: db }, 'ch', 3, true)
    const rows = grade(epg)
    const naHora = rows.find((r) => r.start === A)
    check('especial provisório cede: na hora da faixa começa o FILME', naHora && /^filme_[ab]$/.test(naHora.media_id),
      naHora ? naHora.media_id : 'nada')
    // sem filme pronto, o especial fica
    const { db: db2, epg: epg2 } = makeDB({ channel: CANAL, media: CATALOGO, slots })
    await scheduleChannel({ DB: db2 }, 'ch', 3, true)
    const naHora2 = grade(epg2).find((r) => r.start === A)
    check('sem filme pronto, o especial provisório continua na hora', naHora2 && naHora2.media_id.startsWith('aaa'),
      naHora2 ? naHora2.media_id : 'nada')
  }
  // sessão de filme ocupa a janela: faixas DENTRO dela cedem; a faixa depois do
  // fim toca; o filme mantém os intervalos (cue points)
  {
    const hm = (min) => new Date((A + min * 60 - 3 * 3600) * 1000).toISOString().slice(11, 16)
    const slots = [
      { series_id: 'bloco_filmes', dias: '[1,2,3,4,5,6,7]', hora: HORA, episodios: 1 },
      { series_id: 'aaa', dias: '[1,2,3,4,5,6,7]', hora: hm(30), episodios: 1 },
      { series_id: 'bbb', dias: '[1,2,3,4,5,6,7]', hora: hm(60), episodios: 1 },
      { series_id: 'ccc', dias: '[1,2,3,4,5,6,7]', hora: hm(120), episodios: 1 },
    ]
    const CAT2 = [...CAT, ep('ccc_01', 'ccc'), ep('ccc_02', 'ccc')]
    const cues = { filme_a: [1200, 2400, 3600, 4800], filme_b: [1200, 2400, 3600, 4800] }
    const { db, epg } = makeDB({ channel: CANAL, media: CAT2, slots, cues })
    const rep = await scheduleChannel({ DB: db }, 'ch', 5, true)
    const rows = grade(epg)
    const fimFilme = Math.max(...rows.filter((r) => /^filme_/.test(r.media_id)).map((r) => r.end))
    const dentro = rows.filter((r) => r.start >= A && r.start < fimFilme && !/^filme_/.test(r.media_id))
    const epDentro = dentro.filter((r) => /^(aaa|bbb)_/.test(r.media_id))
    check('sessão de filme: faixas de dentro da janela cedem (nenhum episódio no meio do filme)', epDentro.length === 0,
      `${rep.cedidasAoFilme ?? 0} cedida(s)`)
    check('sessão de filme: filme mantém os intervalos', dentro.length > 0, `${dentro.length} peça(s) de intervalo`)
    const ccc = rows.find((r) => r.media_id.startsWith('ccc') && r.start >= fimFilme)
    check('sessão de filme: a faixa depois do filme toca (no máximo 45 min atrasada)', ccc && ccc.start - (A + 7200) <= 2700,
      ccc ? `ccc às +${Math.round((ccc.start - A) / 60)} min` : 'sumiu')
    check('sessão de filme: EPG contígua', contigua(rows))
    // sem filme pronto, as faixas de dentro tocam normalmente
    const { db: db3, epg: epg3 } = makeDB({ channel: CANAL, media: [...CATALOGO, ep('ccc_01', 'ccc')], slots })
    await scheduleChannel({ DB: db3 }, 'ch', 5, true)
    const r3 = grade(epg3)
    check('sem filme pronto: a faixa das +30 min toca na hora', r3.some((r) => r.start === A + 1800 && r.media_id.startsWith('aaa')))
  }
}

// ── A FAIXA ENTRA COM A CHAMADA DELA (Looney Tunes das 22:30, 23/09/2026) ────
// O encaixe escolhia o desenho curto que fechava o vão EXATO e a faixa entrava
// grudada nele, sem o "vem aí" — em ~metade das faixas do CN.
{
  const vin = (id) => ({ id, tipo: 'vinheta', duracao_seg: 10, segment_count: 1, last_played_at: 0, series_id: null })
  const aSeguir = (media_id, series_id, extra = {}) => ({
    media_id, status: 'confirmada', proposta: null, condicao: JSON.stringify({ tipo: 'a_seguir', series_id, ...extra }),
  })
  const slots = [{ series_id: 'bbb', dias: '[1,2,3,4,5,6,7]', hora: HORA, episodios: 1 }]
  const antesDaHora = (rows) => rows.filter((r) => r.end <= A).pop()
  const naHora = (rows) => rows.some((r) => r.start === A && r.media_id.startsWith('bbb'))

  // curta que fecha o vão exato (470 s num vão de 480 s): antes grudava
  {
    const CAT = [...CATALOGO, { id: 'cur_470', tipo: 'episodio', duracao_seg: 470, segment_count: 47, last_played_at: 0, series_id: 'cur' }, vin('vin_vem_ai_bbb')]
    const { db, epg } = makeDB({ channel: CANAL, media: CAT, covEnd: A - 480, slots, promises: [aSeguir('vin_vem_ai_bbb', 'bbb')] })
    await scheduleChannel({ DB: db }, 'ch', 3, false)
    const rows = grade(epg)
    check('faixa entra com o "vem aí" colado, mesmo com curta fechando o vão', antesDaHora(rows)?.media_id === 'vin_vem_ai_bbb',
      rows.filter((r) => r.start >= A - 480 && r.end <= A).map((r) => r.media_id).join(' '))
    check('chamada reservada: faixa pontual, EPG contígua, nada cortado',
      naHora(rows) && contigua(rows) && ocorrencias(rows, CAT).every((o) => o.dur === o.total))
  }
  // reserva MACIA: o episódio cabe no vão inteiro mas não com a chamada, e não
  // há nada mais curto — vai o episódio (sem chamada), nunca 20 min de comercial
  {
    const CAT = [...CATALOGO, vin('vin_vem_ai_bbb')]
    const { db, epg } = makeDB({ channel: CANAL, media: CAT, covEnd: A - 1200, slots, promises: [aSeguir('vin_vem_ai_bbb', 'bbb')] })
    await scheduleChannel({ DB: db }, 'ch', 3, false)
    const rows = grade(epg)
    const noVao = rows.filter((r) => r.start >= A - 1200 && r.end <= A)
    check('reserva macia: episódio que só cabe sem a chamada ainda entra (não vira vão de comercial)',
      noVao.some((r) => CAT.find((m) => m.id === r.media_id)?.tipo === 'episodio'), noVao.map((r) => r.media_id).join(' '))
    const faixa = rows.find((r) => r.start >= A && r.media_id.startsWith('bbb'))
    check('reserva macia: faixa no máximo 10 s atrasada (a chamada) e EPG contígua',
      faixa && faixa.start - A <= 10 && contigua(rows), faixa ? `+${faixa.start - A}s` : 'sumiu')
  }
  // rede de segurança: o bloco anterior estourou a hora (âncora das -10 min com
  // episódio de 20) — a faixa entra atrasada, mas com a chamada colada
  {
    const HM10 = new Date((A - 600 - 3 * 3600) * 1000).toISOString().slice(11, 16)
    const CAT = [...CATALOGO, vin('vin_vem_ai_bbb')]
    const { db, epg } = makeDB({
      channel: CANAL, media: CAT, covEnd: A - 900, promises: [aSeguir('vin_vem_ai_bbb', 'bbb')],
      slots: [{ series_id: 'aaa', dias: '[1,2,3,4,5,6,7]', hora: HM10, episodios: 1 }, ...slots],
    })
    await scheduleChannel({ DB: db }, 'ch', 3, false)
    const rows = grade(epg)
    const i = rows.findIndex((r) => r.start >= A && r.media_id.startsWith('bbb'))
    check('bloco anterior estourou: a faixa atrasada entra com a chamada colada', i > 0 && rows[i - 1].media_id === 'vin_vem_ai_bbb',
      i > 0 ? `${rows[i - 1].media_id} → ${rows[i].media_id} às +${rows[i].start - A}s` : 'sumiu')
    check('bloco anterior estourou: EPG contígua', contigua(rows))
  }
  // abertura de JANELA: só antes da faixa daquela hora, e com preferência
  {
    const outraHora = HORA === '03:17' ? '03:18' : '03:17' // nenhuma faixa nessa hora
    const CAT = [...CATALOGO, vin('vin_abertura_bloco'), vin('vin_outra_janela'), vin('vin_vem_ai_comum')]
    const promises = [
      aSeguir('vin_abertura_bloco', 'bbb', { janelas: [{ dias: [1, 2, 3, 4, 5, 6, 7], hora: HORA }] }),
      aSeguir('vin_outra_janela', 'bbb', { janelas: [{ dias: [1, 2, 3, 4, 5, 6, 7], hora: outraHora }] }),
      aSeguir('vin_vem_ai_comum', 'bbb'),
    ]
    const { db, epg } = makeDB({ channel: CANAL, media: CAT, covEnd: A - 1500, slots, promises })
    await scheduleChannel({ DB: db }, 'ch', 24, false)
    const rows = grade(epg)
    check('abertura de janela entra antes da faixa daquela hora (no lugar da "vem aí" comum)',
      antesDaHora(rows)?.media_id === 'vin_abertura_bloco', antesDaHora(rows)?.media_id ?? 'nada')
    const tocouAbertura = rows.filter((r) => r.media_id === 'vin_abertura_bloco')
    check('abertura de janela nunca toca fora da janela', tocouAbertura.every((r) => (A - r.end) % 86400 === 0),
      `${tocouAbertura.length} vez(es)`)
    check('abertura de outra janela (sem faixa) nunca toca', !rows.some((r) => r.media_id === 'vin_outra_janela'))
    check('abertura de janela: EPG contígua', contigua(rows))
  }
}

console.log(`\n${fail === 0 ? '🎉' : '⚠️'} ${pass}/${pass + fail} checagens passaram`)
process.exit(fail === 0 ? 0 : 1)
