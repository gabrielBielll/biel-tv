// Teste do LINEUP NA GRADE (apps/stream/src/lineup-grade.ts + scheduler.ts).
// Sem servidor: as funções puras direto, e o `scheduleChannel` REAL com um D1
// mockado (mesmo molde do verify-ancoras). Node ≥ 22 lê o .ts direto.
//
// O que NÃO pode quebrar:
//   1) lineup só toca onde a grade cumpre X→Y→Z (promessa verdadeira);
//   2) nenhum horário se move: a EPG continua contígua e todo programa fica
//      exatamente onde estava;
//   3) lineup NUNCA entra no rodízio cego (nem no modo livre, nem sem promessa);
//   4) rebuild parcial não deixa lineup gravado prometendo o que mudou.
import {
  blocosDeConteudo, encaixaLineups, escolheSoma, posicaoDoConfig, recuaCorte, sequenciaDaCondicao,
} from '../apps/stream/src/lineup-grade.ts'

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`✅ ${name}${extra ? `  (${extra})` : ''}`) }
  else { fail++; console.log(`❌ ${name}${extra ? `  (${extra})` : ''}`) }
}

// ── montador de grade sintética ──────────────────────────────────────────────
// Cada item: ['ep', id, serie, dur] | ['ad', id, dur] | ['vin', id, dur]
function monta(itens, t0 = 100_000) {
  const info = new Map()
  const linhas = []
  let t = t0
  for (const it of itens) {
    const [k, id] = it
    const dur = k === 'ep' ? it[3] : it[2]
    info.set(id, { tipo: k === 'ep' ? 'episodio' : k === 'ad' ? 'comercial' : 'vinheta', series_id: k === 'ep' ? it[2] : null })
    linhas.push(['ch', id, t, t + dur, 0])
    t += dur
  }
  return { info, linhas }
}
const contigua = (ls) => ls.every((l, i) => i === 0 || l[2] === ls[i - 1][3])
const programas = (ls, info) => ls.filter((l) => ['episodio', 'filme'].includes(info.get(l[1])?.tipo)).map((l) => `${l[1]}@${l[2]}-${l[3]}`).join('|')
const PECA = { id: 'com_lineup_aaa_bbb_ccc', duracao_seg: 20, seq: ['aaa', 'bbb', 'ccc'] }
const OP = (info, extra = {}) => ({
  pecas: [PECA], info, removivel: new Set(['ad20', 'ad20c', 'ad30', 'ad10a', 'ad10b', 'ad40']),
  posicao: 'ultimo', editavelDesde: 0, ...extra,
})
const entrada = (linhas, preservada = false) => linhas.map((linha) => ({ linha, preservada }))

// Bloco de aaa com TRÊS intervalos dentro (0 s = início):
//   pod1 600–650    meio do aaa_1   (ad30 + ad20)
//   pod2 1250–1280  entre episódios (ad10a + ad10b + vinheta de volta de aaa)
//   pod3 1880–1900  meio do aaa_2   (ad20c)
// Bloco vai de 0 a 2500 (meio = 1250). Depois vêm bbb e ccc.
const GRADE_BASE = [
  ['ep', 'aaa_1', 'aaa', 600], ['ad', 'ad30', 30], ['ad', 'ad20', 20], ['ep', 'aaa_1', 'aaa', 600],
  ['ad', 'ad10a', 10], ['ad', 'ad10b', 10], ['vin', 'vin_volta_aaa', 10], ['ep', 'aaa_2', 'aaa', 600],
  ['ad', 'ad20c', 20], ['ep', 'aaa_2', 'aaa', 600],
  ['ad', 'ad40', 40], ['ep', 'bbb_1', 'bbb', 1200], ['ad', 'ad30', 30], ['ep', 'ccc_1', 'ccc', 1200],
]
const T0 = 100_000

// ── 1. blocos ────────────────────────────────────────────────────────────────
{
  const { info, linhas } = monta(GRADE_BASE)
  const b = blocosDeConteudo(linhas, info)
  check('blocos: aaa (partes + 2 eps) vira UM bloco, depois bbb e ccc',
    b.length === 3 && b[0].serie === 'aaa' && b[1].serie === 'bbb' && b[2].serie === 'ccc',
    b.map((x) => x.serie).join('→'))
}

// ── 2. encaixe básico: último intervalo do bloco de X ────────────────────────
{
  const { info, linhas } = monta(GRADE_BASE)
  const r = encaixaLineups(entrada(linhas), OP(info))
  const nova = r.linhas.map((x) => x.linha)
  const lin = nova.find((l) => l[1] === PECA.id)
  check('encaixou 1 lineup', r.encaixes.length === 1 && Boolean(lin))
  check('EPG continua contígua', contigua(nova))
  check('nenhum programa mudou de horário', programas(nova, info) === programas(linhas, info))
  check('início e fim da grade iguais', nova[0][2] === linhas[0][2] && nova.at(-1)[3] === linhas.at(-1)[3])
  check('posição "ultimo": entrou no pod3 (1880), trocando o ad20c inteiro',
    lin && lin[2] === T0 + 1880 && lin[3] === T0 + 1900 && !nova.some((l) => l[1] === 'ad20c'),
    lin ? `${lin[2] - T0}s` : '')
  check('pods 1 e 2 intactos', nova.filter((l) => ['ad20', 'ad10a', 'ad10b'].includes(l[1])).length === 3)
}

// ── 3. posição "meio" ────────────────────────────────────────────────────────
{
  const { info, linhas } = monta(GRADE_BASE)
  const r = encaixaLineups(entrada(linhas), OP(info, { posicao: 'meio' }))
  const nova = r.linhas.map((x) => x.linha)
  const lin = nova.find((l) => l[1] === PECA.id)
  check('posição "meio": pod2, o mais perto do meio do bloco (1250)',
    lin && lin[2] >= T0 + 1250 && lin[3] <= T0 + 1280, lin ? `${lin[2] - T0}s` : '')
  check('meio: tirou os dois de 10 s (somam 20) e a vinheta de volta ficou DEPOIS da peça',
    !nova.some((l) => l[1] === 'ad10a' || l[1] === 'ad10b')
    && nova.findIndex((l) => l[1] === PECA.id) < nova.findIndex((l) => l[1] === 'vin_volta_aaa'))
  check('meio: EPG contígua e programas no lugar', contigua(nova) && programas(nova, info) === programas(linhas, info))
}

// ── 4. sequência diferente: não encaixa, e entra no inventário ───────────────
{
  const g = GRADE_BASE.map((it) => (it[2] === 'ccc' ? ['ep', 'ddd_1', 'ddd', 1200] : it))
  const { info, linhas } = monta(g)
  const r = encaixaLineups(entrada(linhas), OP(info))
  check('aaa→bbb→ddd: peça de aaa→bbb→ccc NÃO entra', r.encaixes.length === 0 && !r.linhas.some((x) => x.linha[1] === PECA.id))
  check('inventário registra a sequência sem peça', r.semPeca.some((s) => s.seq.join('>') === 'aaa>bbb>ddd'))
}

// ── 5. sem combinação que feche 20 s → não encaixa, grade intacta ────────────
{
  const g = GRADE_BASE.map((it) => (['ad20', 'ad10b', 'ad20c'].includes(it[1]) ? ['ad', 'ad30', 30] : it))
  const { info, linhas } = monta(g)
  const r = encaixaLineups(entrada(linhas), OP(info))
  check('sem soma exata: nada encaixado e fica em semEspaco', r.encaixes.length === 0 && r.semEspaco.length === 1)
  check('sem soma exata: linhas idênticas', JSON.stringify(r.linhas.map((x) => x.linha)) === JSON.stringify(linhas))
}

// ── 6. nunca tira peça que não é do rodízio (vinheta de contexto) ────────────
{
  const g = [
    ['ep', 'aaa_1', 'aaa', 600], ['vin', 'vin_saida_aaa', 20], ['ad', 'ad30', 30], ['ep', 'aaa_1', 'aaa', 600],
    ['ad', 'ad40', 40], ['ep', 'bbb_1', 'bbb', 1200], ['ad', 'ad30', 30], ['ep', 'ccc_1', 'ccc', 1200],
  ]
  const { info, linhas } = monta(g)
  const r = encaixaLineups(entrada(linhas), OP(info))
  check('vinheta de contexto de 20 s NÃO é trocada pelo lineup', r.encaixes.length === 0
    && r.linhas.some((x) => x.linha[1] === 'vin_saida_aaa'))
}

// ── 7. intervalo que já pode estar no buffer do player não é mexido ──────────
{
  const { info, linhas } = monta(GRADE_BASE)
  const r = encaixaLineups(entrada(linhas), OP(info, { editavelDesde: 100_000 + 5000 }))
  check('editavelDesde: intervalo antes do limite fica intacto', r.encaixes.length === 0)
}

// ── 8. idempotência: bloco que já tem lineup não ganha outro ─────────────────
{
  const { info, linhas } = monta(GRADE_BASE)
  const r1 = encaixaLineups(entrada(linhas), OP(info))
  const r2 = encaixaLineups(r1.linhas, OP(info))
  check('rodar duas vezes: continua 1 lineup só', r2.encaixes.length === 0
    && r2.linhas.filter((x) => x.linha[1] === PECA.id).length === 1)
}

// ── 9. intervalo GRAVADO recebe a peça → reportado como preservado ───────────
{
  const { info, linhas } = monta(GRADE_BASE)
  const corte = 10 // as 10 primeiras linhas (até o fim do bloco de aaa) "já estão no banco"
  const e = [...entrada(linhas.slice(0, corte), true), ...entrada(linhas.slice(corte), false)]
  const r = encaixaLineups(e, OP(info))
  check('pod gravado: encaixe reportado como preservado (vira DELETE+INSERT)',
    r.pods.length === 1 && r.pods[0].preservado === true)
  const pod = r.pods[0]
  check('pod gravado: reescrita ocupa exatamente a mesma faixa de tempo',
    pod.linhas[0][2] === pod.inicio && pod.linhas.at(-1)[3] === pod.fim && contigua(pod.linhas))
}

// ── 10. rodízio entre variações da mesma sequência ───────────────────────────
{
  const dobro = [...GRADE_BASE, ['ad', 'ad40', 40], ...GRADE_BASE]
  const { info, linhas } = monta(dobro)
  const v2 = { ...PECA, id: 'com_lineup_aaa_bbb_ccc_v2' }
  const r = encaixaLineups(entrada(linhas), OP(info, { pecas: [PECA, v2] }))
  const ids = r.encaixes.map((x) => x.id)
  check('duas ocorrências, duas variações: alterna em vez de repetir', ids.length === 2 && ids[0] !== ids[1], ids.join(', '))
}

// ── 11. escolheSoma ──────────────────────────────────────────────────────────
{
  const d = (arr) => arr.map((x, k) => ({ k, d: x }))
  check('escolheSoma: prefere 1 item exato', JSON.stringify(escolheSoma(d([10, 20, 10]), 20)) === '[1]')
  check('escolheSoma: par quando não há exato', JSON.stringify(escolheSoma(d([10, 30, 10]), 20)) === '[0,2]')
  check('escolheSoma: trio', JSON.stringify(escolheSoma(d([10, 10, 10, 40]), 30)) === '[0,1,2]')
  check('escolheSoma: impossível → null', escolheSoma(d([30, 40]), 20) === null)
}

// ── 12. recuaCorte (rebuild parcial) ─────────────────────────────────────────
{
  const { info, linhas } = monta(GRADE_BASE)
  const r = encaixaLineups(entrada(linhas), OP(info))
  const nova = r.linhas.map((x) => x.linha)
  const ehL = (id) => id.startsWith('com_lineup_')
  const inicioCcc = nova.find((l) => l[1] === 'ccc_1')[2]
  const inicioBbb = nova.find((l) => l[1] === 'bbb_1')[2]
  // corte DEPOIS do início de ccc: a promessa inteira está gravada → não recua
  const c1 = recuaCorte(nova.filter((l) => l[2] < inicioCcc + 10), info, ehL, inicioCcc + 10, 0)
  check('corte depois de Z começar: não recua', c1 === inicioCcc + 10)
  // corte no início de bbb (Y muda) → recua até antes do bloco de X. Sem bloco
  // anterior na janela, cai no piso (fim do bloco no ar)
  const c2 = recuaCorte(nova.filter((l) => l[2] < inicioBbb), info, ehL, inicioBbb, 100_000)
  check('corte antes de Y: recua (sem bloco anterior → piso)', c2 === 100_000, `${c2 - 100_000}`)
  // com um programa ANTES de aaa, a fronteira é o fim dele
  const { info: i2, linhas: l2 } = monta([['ep', 'zzz_1', 'zzz', 600], ['ad', 'ad40', 40], ...GRADE_BASE])
  const n2 = encaixaLineups(entrada(l2), OP(i2)).linhas.map((x) => x.linha)
  const bbb2 = n2.find((l) => l[1] === 'bbb_1')[2]
  const c3 = recuaCorte(n2.filter((l) => l[2] < bbb2), i2, ehL, bbb2, 0)
  check('corte antes de Y: recua até o FIM do programa anterior a X', c3 === 100_000 + 600, `${c3 - 100_000}`)
  // lineup já no ar (antes do piso) é ignorado
  const c4 = recuaCorte(n2.filter((l) => l[2] < bbb2), i2, ehL, bbb2, bbb2 - 5)
  check('lineup antes do piso (já passou/no ar): não recua', c4 === bbb2)
}

// ── 13. condição e config ────────────────────────────────────────────────────
{
  check('condição do /lineup-jobs (current+next) → sequência por série',
    JSON.stringify(sequenciaDaCondicao({ tipo: 'lineup_grade', current: { series_id: 'aaa', media_id: 'x', start: 1 }, next: [{ series_id: 'bbb' }, { series_id: 'ccc' }] })) === '["aaa","bbb","ccc"]')
  check('condição enxuta seq[3]', JSON.stringify(sequenciaDaCondicao({ tipo: 'lineup_grade', seq: ['a1', 'b2', 'c3'] })) === '["a1","b2","c3"]')
  check('condição incompleta → null', sequenciaDaCondicao({ tipo: 'lineup_grade', current: { series_id: 'aaa' }, next: [] }) === null)
  check('config: {"posicao":"meio"} / "ultimo" / lixo',
    posicaoDoConfig('{"posicao":"meio"}') === 'meio' && posicaoDoConfig('ultimo') === 'ultimo'
    && posicaoDoConfig('"ultimo"') === 'ultimo' && posicaoDoConfig('outra') === null && posicaoDoConfig(null) === null)
}

// ── 14. INTEGRAÇÃO: scheduleChannel real com D1 mockado ──────────────────────
// Relógio congelado ANTES do import: a grade depende da hora.
const spHoraToEpoch = (date, hhmm) => Math.floor(Date.parse(`${date}T${hhmm}:00-03:00`) / 1000)
const AGORA = spHoraToEpoch('2026-09-24', '09:50')
Date.now = () => AGORA * 1000
const { scheduleChannel } = await import('../apps/stream/src/scheduler.ts')

function makeDB({ channel, media, slots = [], cues = {}, promessas = [], config = {}, gravadas = [] }) {
  const epg = []
  const deletes = []
  const cueRows = Object.entries(cues).flatMap(([media_id, ts]) => ts.map((time_seg) => ({ media_id, time_seg })))
  const prepare = (sql) => {
    let args = []
    const api = {
      bind: (...a) => { args = a; return api },
      all: async () => {
        if (/FROM media_items m JOIN media_channels/.test(sql)) return { results: media }
        if (/FROM channel_slots/.test(sql)) return { results: slots }
        if (/FROM media_cue_points/.test(sql)) return { results: cueRows }
        if (/FROM media_promises/.test(sql)) return { results: promessas }
        if (/LEFT JOIN media_items/.test(sql)) return { results: gravadas.filter((r) => r.s >= args[1] && r.s < args[2]) }
        return { results: [] }
      },
      first: async () => {
        if (/FROM channels WHERE id/.test(sql)) return channel
        if (/FROM config WHERE k/.test(sql)) return config[args[0]] != null ? { v: config[args[0]] } : null
        if (/MAX\(end_time_virtual\) g/.test(sql)) return { g: null }
        if (/SELECT MAX\(end_time_virtual\)/.test(sql)) return { m: null }
        return null
      },
      run: async () => {
        if (/INSERT INTO epg_virtual/.test(sql)) {
          const re = /\('([^']*)','([^']*)',(\d+),(\d+),(\d+)\)/g
          let m
          while ((m = re.exec(sql))) epg.push({ media_id: m[2], start: +m[3], end: +m[4], seg: +m[5] })
        }
        if (/^DELETE FROM epg_virtual/.test(sql.trim())) deletes.push(args)
        return { meta: { changes: 0 } }
      },
    }
    return api
  }
  return { db: { prepare, batch: async (stmts) => { for (const s of stmts) await s.run() } }, epg, deletes }
}

const ep = (id, s, dur = 1200) => ({ id, tipo: 'episodio', duracao_seg: dur, segment_count: dur / 10, last_played_at: 0, series_id: s })
const ad = (id, dur) => ({ id, tipo: 'comercial', duracao_seg: dur, segment_count: dur / 10, last_played_at: 0, series_id: null })
const LINEUP = { id: 'com_lineup_teste_abc', tipo: 'comercial', duracao_seg: 20, segment_count: 2, last_played_at: 0, series_id: 'aaa' }
const MEDIA = [
  ep('aaa_01', 'aaa'), ep('aaa_02', 'aaa'), ep('bbb_01', 'bbb'), ep('bbb_02', 'bbb'),
  ep('ccc_01', 'ccc'), ep('ccc_02', 'ccc'), ep('ddd_01', 'ddd'), ep('ddd_02', 'ddd'),
  ad('ad_10a', 10), ad('ad_10b', 10), ad('ad_20', 20), ad('ad_30', 30), ad('ad_20b', 20),
  LINEUP,
]
const CUES = Object.fromEntries(MEDIA.filter((m) => m.tipo === 'episodio').map((m) => [m.id, [600]]))
const SLOTS = [
  { series_id: 'aaa', dias: '[1,2,3,4,5,6,7]', hora: '10:00', episodios: 1 },
  { series_id: 'bbb', dias: '[1,2,3,4,5,6,7]', hora: '10:30', episodios: 1 },
  { series_id: 'ccc', dias: '[1,2,3,4,5,6,7]', hora: '11:00', episodios: 1 },
]
const PROMESSA = { media_id: LINEUP.id, status: 'confirmada', proposta: null,
  condicao: JSON.stringify({ tipo: 'lineup_grade', canal: 'ch', current: { series_id: 'aaa' }, next: [{ series_id: 'bbb' }, { series_id: 'ccc' }] }) }
const CANAL = { break_target_seg: 60, comerciais_fieis: 1, episodios_por_bloco: 1 }
const ordena = (epg) => [...epg].sort((a, b) => a.start - b.start)
const contiguaR = (rows) => rows.every((r, i) => i === 0 || r.start === rows[i - 1].end)
const serieDe = (id) => MEDIA.find((m) => m.id === id)?.series_id
const ehEp = (id) => MEDIA.find((m) => m.id === id)?.tipo === 'episodio'

// para cada ocorrência do lineup: o bloco em volta é X e os dois seguintes Y, Z
function confereOcorrencias(rows) {
  const erros = []
  rows.forEach((r, i) => {
    if (r.media_id !== LINEUP.id) return
    const antes = rows.slice(0, i).reverse().find((x) => ehEp(x.media_id))
    const depois = rows.slice(i + 1).find((x) => ehEp(x.media_id))
    if (serieDe(antes?.media_id) !== 'aaa' || serieDe(depois?.media_id) !== 'aaa') { erros.push(`fora do bloco de aaa @${r.start}`); return }
    const seqSeg = []
    for (const x of rows.slice(i + 1)) {
      if (!ehEp(x.media_id)) continue
      const s = serieDe(x.media_id)
      if (seqSeg.at(-1) !== s) seqSeg.push(s)
      if (seqSeg.length === 3) break
    }
    if (seqSeg.join('>') !== 'aaa>bbb>ccc') erros.push(`promessa falsa @${r.start}: ${seqSeg.join('>')}`)
  })
  return erros
}

{
  const { db, epg } = makeDB({ channel: CANAL, media: MEDIA, slots: SLOTS, cues: CUES, promessas: [PROMESSA],
    config: { 'lineup_grade:ch': '{"posicao":"ultimo"}' } })
  const rep = await scheduleChannel({ DB: db }, 'ch', 48, true)
  const rows = ordena(epg)
  const n = rows.filter((r) => r.media_id === LINEUP.id).length
  check('integração: EPG contígua com lineup ligado', contiguaR(rows))
  check('integração: lineup entrou (2 dias → 2 ocorrências de aaa 10:00)', n === 2 && rep.lineups === 2, `${n} na grade, report ${rep.lineups}`)
  const erros = confereOcorrencias(rows)
  check('integração: TODA ocorrência está no bloco de aaa e a sequência seguinte é aaa→bbb→ccc',
    erros.length === 0, erros.join('; '))
  const ancoras = ['10:00', '10:30', '11:00'].map((h) => spHoraToEpoch('2026-09-24', h))
  check('integração: âncoras continuam pontuais', ancoras.every((A) => rows.some((r) => r.start === A && ehEp(r.media_id))))
}

{
  // mesma grade SEM a chave de config → o lineup não entra nem no rodízio
  const { db, epg } = makeDB({ channel: CANAL, media: MEDIA, slots: SLOTS, cues: CUES, promessas: [PROMESSA] })
  await scheduleChannel({ DB: db }, 'ch', 48, true)
  check('sem config: lineup NÃO aparece em lugar nenhum', !epg.some((r) => r.media_id === LINEUP.id))
}

{
  // modo LIVRE: promessas ignoradas, mas lineup nunca vira anúncio comum
  const { db, epg } = makeDB({ channel: { ...CANAL, comerciais_fieis: 0 }, media: MEDIA, slots: SLOTS, cues: CUES, promessas: [PROMESSA] })
  await scheduleChannel({ DB: db }, 'ch', 48, true)
  check('modo livre: lineup fora do rodízio cego', !epg.some((r) => r.media_id === LINEUP.id))
}

{
  // peça com o prefixo e SEM promessa (runner registrou, /done ainda não gravou)
  const { db, epg } = makeDB({ channel: CANAL, media: MEDIA, slots: SLOTS, cues: CUES, promessas: [],
    config: { 'lineup_grade:ch': 'ultimo' } })
  await scheduleChannel({ DB: db }, 'ch', 48, true)
  check('prefixo com_lineup_ sem promessa: nunca vai ao ar', !epg.some((r) => r.media_id === LINEUP.id))
}

{
  // EXTENSÃO (append): o bloco de aaa e o intervalo já estão GRAVADOS; o lote
  // novo traz bbb e ccc. O lineup tem de entrar no intervalo gravado
  // (DELETE+INSERT da mesma faixa), sem nenhuma linha nova sobrepor as antigas.
  const A = spHoraToEpoch('2026-09-24', '10:00')
  const g = []
  let t = A
  const add = (media_id, dur, seg = 0, tipo = 'comercial', sid = null) => { g.push({ media_id, s: t, f: t + dur, g: seg, tipo, sid }); t += dur }
  add('aaa_01', 600, 0, 'episodio', 'aaa'); add('ad_30', 30); add('ad_10a', 10); add('ad_10b', 10)
  add('aaa_01', 600, 60, 'episodio', 'aaa'); add('ad_20', 20)
  // o mock responde cobertura = fim do gravado
  const { db, epg, deletes } = makeDB({ channel: CANAL, media: MEDIA, slots: SLOTS, cues: CUES, promessas: [PROMESSA],
    config: { 'lineup_grade:ch': 'ultimo' }, gravadas: g })
  const firstOrig = db.prepare
  db.prepare = (sql) => {
    const st = firstOrig(sql)
    if (/SELECT MAX\(end_time_virtual\) m/.test(sql)) st.first = async () => ({ m: t })
    return st
  }
  const rep = await scheduleChannel({ DB: db }, 'ch', 3, false)
  const novas = ordena(epg)
  const podReescrito = novas.filter((r) => r.start < t)
  check('extensão: lineup entrou no intervalo JÁ GRAVADO', podReescrito.some((r) => r.media_id === LINEUP.id) && rep.lineups === 1)
  check('extensão: o intervalo gravado foi apagado na MESMA faixa antes de regravar',
    deletes.some((d) => d[0] === 'ch' && d[1] === A + 600 && d[2] === A + 650))
  check('extensão: reescrita cabe exatamente no buraco (600–650)',
    podReescrito[0]?.start === A + 600 && podReescrito.at(-1)?.end === A + 650 && contiguaR(podReescrito))
}

console.log(`\n${pass} ok, ${fail} falha(s)`)
process.exit(fail ? 1 : 0)
