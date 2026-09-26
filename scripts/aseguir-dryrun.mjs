// DRY-RUN da ABERTURA DE FAIXA e dos INTERVALOS com os dados REAIS de
// produção, sem gravar nada.
//
// Pergunta que ele responde: quantas faixas fixas (âncoras) entram com a promo
// "a seguir"/"vem aí" da própria série colada antes, e quantas começam grudadas
// no programa anterior, sem chamada nenhuma. Mede também quantas vezes as
// vinhetas genéricas do canal (bumpers sem promessa) conseguem tocar, se as
// faixas continuam pontuais e se a EPG fica sem buraco. Nos intervalos, mede
// quantos levam peça DA CASA (chamada, bumper, interprograma — ver
// apps/stream/src/papel-comercial.ts), quanto tempo é casa × anúncio e quanto
// a peça da casa mais tocada repete por dia.
//
// Os dados do D1 (só SELECT) ficam guardados num retrato local na primeira
// execução, pra comparar ANTES e DEPOIS de uma mudança no scheduler com a mesma
// entrada. `--novo` tira um retrato novo.
//
//   node --import ./scripts/_ts-registra.mjs scripts/aseguir-dryrun.mjs [--canal X] [--horas 48] [--novo]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { anunciaDe, papelDe } from '../apps/stream/src/papel-comercial.ts'
import { scheduleChannel } from '../apps/stream/src/scheduler.ts'

for (const l of readFileSync(`${process.env.HOME}/bieltv-cred.env`, 'utf8').split('\n')) {
  const m = /^\s*(?:export\s+)?([A-Z_0-9]+)=(.*)$/.exec(l)
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '')
}
const arg = (k, d) => (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1] : d)
const HORAS = Number(arg('horas', 48))
const CANAIS = arg('canal', null) ? [arg('canal')] : ['jetix', 'cartoon_network', 'disney_channel']
const DB_ID = 'c7790950-7ee9-4169-8d0c-40e7ce8672d9'
const DIR = `${process.env.HOME}/.cache/bieltv-aseguir`
mkdirSync(DIR, { recursive: true })

async function d1(sql, params = []) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${DB_ID}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  }).then((x) => x.json())
  if (!r.success) throw new Error(JSON.stringify(r.errors))
  return r.result[0].results
}

async function retrato(canal) {
  const arq = `${DIR}/dados-${canal}.json`
  if (existsSync(arq) && !process.argv.includes('--novo')) return JSON.parse(readFileSync(arq, 'utf8'))
  const agora = Math.floor(Date.now() / 1000)
  const [canalRow] = await d1('SELECT * FROM channels WHERE id = ?', [canal])
  const dados = {
    agora,
    canal: canalRow,
    media: await d1(
      `SELECT m.id, m.tipo, m.duracao_seg, m.segment_count, m.last_played_at, json_extract(m.metadata, '$.series_id') series_id
       FROM media_items m JOIN media_channels mc ON mc.media_id = m.id WHERE mc.channel_id = ? AND m.status = 'ready'`, [canal]),
    slots: await d1("SELECT series_id, dias, hora, episodios, reprise FROM channel_slots WHERE canal = ? AND status = 'ativa'", [canal]),
    cues: await d1('SELECT media_id, time_seg FROM media_cue_points WHERE media_id IN (SELECT media_id FROM media_channels WHERE channel_id = ?) ORDER BY time_seg', [canal]),
    promessas: await d1('SELECT media_id, status, proposta, condicao FROM media_promises'),
    eventos: await d1("SELECT media_id, series_id, start_at, end_at FROM channel_events WHERE canal = ? AND status = 'agendado' AND end_at > ?", [canal, agora]),
    diretrizes: await d1("SELECT tipo, payload FROM directives WHERE canal = ? AND status = 'ativa' AND tipo IN ('excluir_media','excluir_serie')", [canal]).catch(() => []),
  }
  writeFileSync(arq, JSON.stringify(dados))
  return dados
}

// D1 falso (mesmo molde do lineup-dryrun): responde por trecho de SQL e guarda
// os INSERT de epg_virtual. Nada sai daqui.
function falso(dados) {
  const epg = []
  const prepare = (sql) => {
    const api = {
      bind: () => api,
      all: async () => {
        if (/FROM media_items m JOIN media_channels/.test(sql)) return { results: structuredClone(dados.media) }
        if (/FROM channel_slots/.test(sql)) return { results: dados.slots }
        if (/FROM media_cue_points/.test(sql)) return { results: dados.cues }
        if (/FROM media_promises/.test(sql)) return { results: dados.promessas }
        if (/FROM channel_events/.test(sql)) return { results: dados.eventos }
        if (/FROM directives/.test(sql)) return { results: dados.diretrizes }
        return { results: [] }
      },
      first: async () => {
        if (/FROM channels WHERE id/.test(sql)) return dados.canal
        if (/MAX\(end_time_virtual\) g/.test(sql)) return { g: null }
        if (/SELECT MAX\(end_time_virtual\)/.test(sql)) return { m: null }
        return null
      },
      run: async () => {
        if (/INSERT INTO epg_virtual/.test(sql)) {
          const re = /\('([^']*)','([^']*)',(\d+),(\d+),(\d+)\)/g
          let m
          while ((m = re.exec(sql))) epg.push({ id: m[2], s: +m[3], f: +m[4], g: +m[5] })
        }
        return { meta: { changes: 0 } }
      },
    }
    return api
  }
  return { db: { prepare, batch: async (st) => { for (const s of st) await s.run() } }, epg }
}

const sp = (e) => new Date((e - 3 * 3600) * 1000)
const hora = (e) => sp(e).toISOString().slice(5, 16).replace('T', ' ')
const DIA = ['', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom']

for (const canal of CANAIS) {
  const dados = await retrato(canal)
  Date.now = () => dados.agora * 1000 // relógio do retrato: mesma grade a cada execução
  const { db, epg } = falso(dados)
  const rep = await scheduleChannel({ DB: db }, canal, HORAS, true)
  const rows = epg.sort((a, b) => a.s - b.s)
  const info = new Map(dados.media.map((m) => [m.id, m]))
  const confirmadas = dados.promessas.filter((p) => p.status === 'confirmada' && p.condicao).map((p) => ({ ...p, c: JSON.parse(p.condicao) }))
  const promoDe = new Map() // media_id → série prometida ("a seguir")
  for (const p of confirmadas) if (p.c.tipo === 'a_seguir' && p.c.series_id && info.has(p.media_id)) promoDe.set(p.media_id, p.c.series_id)
  const seriesComPromo = new Set(promoDe.values())
  const comPromessa = new Set(dados.promessas.map((p) => p.media_id))
  const conteudo = (r) => r && r.g === 0 && ['episodio', 'filme'].includes(info.get(r.id)?.tipo)

  // cada ocorrência de faixa dentro da janela planejada
  const inicio = rows[0]?.s ?? dados.agora
  const fim = rows.at(-1)?.f ?? dados.agora
  const res = { faixas: 0, sem_promo_no_acervo: 0, com_a_seguir: 0, grudada_em_programa: 0, depois_de_intervalo_sem_promo: 0, atrasadas: 0, sumidas: 0 }
  const exemplos = []
  const atrasos = []
  for (let d = inicio - 86400; d < fim + 86400; d += 86400) {
    for (const sl of dados.slots) {
      const [H, M] = sl.hora.split(':').map(Number)
      const x = sp(d)
      const A = Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate(), H, M) / 1000 + 3 * 3600
      if (!JSON.parse(sl.dias).includes(sp(A).getUTCDay() || 7) || A < inicio + 3600 || A > fim - 3600) continue
      const i = rows.findIndex((r) => conteudo(r) && info.get(r.id).series_id === sl.series_id && r.s >= A - 5 && r.s <= A + 2700)
      if (i < 1) { res.sumidas++; atrasos.push(`${DIA[sp(A).getUTCDay() || 7]} ${sl.hora} ${sl.series_id} SUMIU`); continue }
      // faixa de mesma hora que cedeu a outra (especial provisório × filme) não conta duas vezes
      if (exemplos.some((e) => e.A === A)) continue
      res.faixas++
      if (rows[i].s > A) { res.atrasadas++; atrasos.push(`${DIA[sp(A).getUTCDay() || 7]} ${sl.hora} ${sl.series_id} +${rows[i].s - A}s`) }
      const ant = rows[i - 1]
      const rotulo = `${DIA[sp(A).getUTCDay() || 7]} ${sl.hora} ${sl.series_id}`
      if (!seriesComPromo.has(sl.series_id)) { res.sem_promo_no_acervo++; exemplos.push({ A, rotulo, caso: 'sem promo' }); continue }
      if (promoDe.get(ant.id) === sl.series_id) { res.com_a_seguir++; exemplos.push({ A, rotulo, caso: `a seguir ${ant.id}` }); continue }
      if (['episodio', 'filme'].includes(info.get(ant.id)?.tipo)) {
        res.grudada_em_programa++
        exemplos.push({ A, rotulo, caso: `GRUDADA em ${info.get(ant.id).series_id}` })
      } else {
        res.depois_de_intervalo_sem_promo++
        exemplos.push({ A, rotulo, caso: `intervalo sem promo (${ant.id})` })
      }
    }
  }
  // vinhetas genéricas (sem promessa nenhuma) que conseguiram tocar
  const genericas = rows.filter((r) => info.get(r.id)?.tipo === 'vinheta' && !comPromessa.has(r.id))
  const contigua = rows.every((r, i) => i === 0 || r.s === rows[i - 1].f)
  const segDe = (pred) => rows.filter(pred).reduce((a, r) => a + r.f - r.s, 0)
  const progSeg = segDe((r) => ['episodio', 'filme'].includes(info.get(r.id)?.tipo))
  const total = segDe(() => true)
  console.log(`\n══ ${canal} · ${HORAS}h a partir de ${hora(inicio)} (retrato de ${hora(dados.agora)}) ══`)
  console.log(`  faixas: ${res.faixas} · sem promo no acervo: ${res.sem_promo_no_acervo}`)
  console.log(`  com "a seguir" colado: ${res.com_a_seguir} · GRUDADAS em programa: ${res.grudada_em_programa} · depois de intervalo sem promo: ${res.depois_de_intervalo_sem_promo}`)
  console.log(`  atrasadas: ${res.atrasadas}${atrasos.length ? ` (${atrasos.join(', ')})` : ''} · sumidas: ${res.sumidas} · perdidas (report): ${rep.ancorasPerdidas ?? 0}`)
  console.log(`  vinhetas genéricas tocadas: ${genericas.length} (${new Set(genericas.map((r) => r.id)).size} distintas)`)
  console.log(`  programa: ${(100 * progSeg / total).toFixed(1)}% do tempo · enchimento: ${Math.round((rep.enchimentoSeg ?? 0) / 60)} min`)
  console.log(`  ${contigua ? '✅' : '❌'} EPG contígua`)
  for (const e of exemplos.filter((x) => /GRUDADA|intervalo sem/.test(x.caso)).slice(0, 8)) console.log(`    ${e.rotulo}: ${e.caso}`)
  // ── intervalos: casa × anúncio ──
  const seriesCanal = new Set(dados.media.filter((m) => ['episodio', 'filme'].includes(m.tipo) && m.series_id).map((m) => m.series_id))
  const condDe = new Map(confirmadas.map((p) => [p.media_id, p.c]))
  const papel = (id) => {
    const m = info.get(id)
    if (!m || m.tipo !== 'comercial' || id.startsWith('com_lineup_')) return m?.tipo === 'comercial' ? 'casa' : null
    return papelDe(m, condDe.get(id), anunciaDe(m, condDe.get(id), seriesCanal))
  }
  const pods = []
  let pod = null
  for (const r of rows) {
    if (['episodio', 'filme'].includes(info.get(r.id)?.tipo)) { if (pod) pods.push(pod); pod = null } else (pod ??= []).push(r)
  }
  const reais = pods.filter((p) => p.some((r) => info.get(r.id)?.tipo === 'comercial'))
  const nCasa = (p) => p.filter((r) => papel(r.id) === 'casa').length
  const semCasa = reais.filter((p) => nCasa(p) === 0).length
  const segPapel = (pp) => rows.filter((r) => papel(r.id) === pp).reduce((a, r) => a + r.f - r.s, 0)
  const porDia = {}
  for (const r of rows) if (papel(r.id) === 'casa') { const k = `${r.id}|${hora(r.s).slice(0, 5)}`; porDia[k] = (porDia[k] ?? 0) + 1 }
  const pior = Object.entries(porDia).sort((a, b) => b[1] - a[1]).slice(0, 3)
  const distintas = new Set(rows.filter((r) => papel(r.id) === 'casa').map((r) => r.id)).size
  const estrut = rows.filter((r) => ['entrada', 'retorno'].includes(papel(r.id))).length
  console.log(`  intervalos: ${reais.length} · sem peça da casa: ${semCasa} (${Math.round(100 * semCasa / Math.max(1, reais.length))}%) · média ${(reais.reduce((a, p) => a + nCasa(p), 0) / Math.max(1, reais.length)).toFixed(1)} da casa por intervalo`)
  console.log(`  tempo: casa ${Math.round(segPapel('casa') / 60)} min × anúncio ${Math.round(segPapel('anuncio') / 60)} min · ${distintas} peças da casa distintas · ${estrut} bumpers de entrada/retorno`)
  // ── ritmo da programação: episódios novos por dia × repetição ──
  const starts = rows.filter((r) => r.g === 0 && info.get(r.id)?.tipo === 'episodio')
  const porSerieEp = {}
  for (const r of starts) (porSerieEp[info.get(r.id).series_id ?? '-'] ??= []).push(r.id)
  const distintos = new Set(starts.map((r) => r.id)).size
  const topNovos = Object.entries(porSerieEp).map(([s, ids]) => [s, new Set(ids).size, ids.length]).sort((a, b) => b[1] - a[1]).slice(0, 5)
  // "inédito" = não ia ao ar havia mais de 7 dias (last_played_at do retrato)
  const lp0 = new Map(dados.media.map((m) => [m.id, m.last_played_at ?? 0]))
  const ineditos = new Set(starts.filter((r) => lp0.get(r.id) < dados.agora - 7 * 86400).map((r) => r.id))
  console.log(`  ritmo: ${ineditos.size} episódios inéditos (não passavam havia 7+ dias) em ${HORAS} h ≈ ${Math.round(ineditos.size * 24 / HORAS)}/dia`)
  console.log(`  episódios: ${starts.length} exibições, ${distintos} diferentes (${Math.round(100 * (starts.length - distintos) / Math.max(1, starts.length))}% repetição) em ${HORAS} h · mais novos: ${topNovos.map(([s, n, e]) => `${s} ${n}/${e}`).join(' · ')}`)
  // ── ping-pong: família (Power Rangers conta como uma) que volta em até 2 h
  //    depois de outro desenho, SEM ser faixa fixa (a grade do Gabriel)
  const fam = (sid) => !sid ? null : sid.startsWith('power_rangers') || sid.startsWith('pwr_rangers') ? 'power_rangers' : sid.startsWith('looney_tunes') ? 'looney_tunes' : sid
  const ehFaixa = (r) => dados.slots.some((sl) => {
    if (sl.series_id !== info.get(r.id)?.series_id || !JSON.parse(sl.dias).includes(sp(r.s).getUTCDay() || 7)) return false
    const d = sp(r.s); const A = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), +sl.hora.slice(0, 2), +sl.hora.slice(3)) / 1000 + 3 * 3600
    return r.s >= A - 5 && r.s <= A + 2700
  })
  let pingPongs = 0
  const pp = []
  for (let i = 1; i < starts.length; i++) {
    const r = starts[i], f = fam(info.get(r.id).series_id)
    if (!f || fam(info.get(starts[i - 1].id).series_id) === f || ehFaixa(r)) continue
    if (starts.some((x, j) => j < i - 1 && fam(info.get(x.id).series_id) === f && r.s - x.s < 7200)) { pingPongs++; if (pp.length < 4) pp.push(`${hora(r.s)} ${f}`) }
  }
  console.log(`  ping-pong no tapa-buraco (família volta em <2 h depois de outro desenho): ${pingPongs}${pp.length ? ` (ex.: ${pp.join(', ')})` : ''}`)
  const doMolde = (id) => /_\d{2}h\d{2}_[0-9a-f]{4}$/.test(id) || id.startsWith('com_ev_')
  const nMolde = rows.filter((r) => doMolde(r.id)).length
  console.log(`  comerciais da fábrica (mesmo molde): ${nMolde} em ${HORAS} h (~${Math.round(nMolde * 24 / HORAS)}/dia)`)
  console.log(`  peça da casa que mais repete num dia: ${pior.map(([k, n]) => `${k.split('|')[0].slice(0, 40)}×${n}`).join(' · ')}`)
  writeFileSync(`${DIR}/resultado-${canal}.json`, JSON.stringify({ res, exemplos, genericas: genericas.map((r) => `${hora(r.s)} ${r.id}`) }, null, 2))
}
