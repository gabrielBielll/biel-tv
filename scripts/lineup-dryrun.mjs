// DRY-RUN do lineup na grade, com os dados REAIS de produção e SEM gravar nada.
//
// Lê do D1 (só SELECT) o acervo, as âncoras, os cue points e as promessas de
// cada canal. Roda o `scheduleChannel` de verdade num D1 falso, duas vezes:
//   A) sem lineup nenhum: a grade como ela sairia hoje;
//   B) com uma peça de lineup FALSA (20 s) para cada sequência X→Y→Z que
//      apareceu em A, e o encaixe ligado na posição pedida.
// Depois confere: os programas de B estão nos MESMOS horários de A (lineup
// não empurra a grade)? Toda peça caiu no bloco de X com Y e Z logo depois
// (promessa verdadeira)? Quantas sequências ficaram sem espaço, e por quê?
//
//   node --import ./scripts/_ts-registra.mjs scripts/lineup-dryrun.mjs [--posicao ultimo|meio] [--canal X] [--horas 48]
//
// Credenciais: ~/bieltv-cred.env (CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { blocosDeConteudo } from '../apps/stream/src/lineup-grade.ts'
import { scheduleChannel } from '../apps/stream/src/scheduler.ts'

for (const l of readFileSync(`${process.env.HOME}/bieltv-cred.env`, 'utf8').split('\n')) {
  const m = /^\s*(?:export\s+)?([A-Z_0-9]+)=(.*)$/.exec(l)
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '')
}
const arg = (k, d) => (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1] : d)
const POSICAO = arg('posicao', 'ultimo')
const HORAS = Number(arg('horas', 48))
const CANAIS = arg('canal', null) ? [arg('canal')] : ['jetix', 'cartoon_network', 'disney_channel']
const DB_ID = 'c7790950-7ee9-4169-8d0c-40e7ce8672d9'
const SAIDA = `${process.env.HOME}/.cache/bieltv-lineup/dryrun`
mkdirSync(SAIDA, { recursive: true })

async function d1(sql, params = []) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${DB_ID}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  }).then((x) => x.json())
  if (!r.success) throw new Error(JSON.stringify(r.errors))
  return r.result[0].results
}

const hora = (e) => new Date((e - 3 * 3600) * 1000).toISOString().slice(5, 16).replace('T', ' ')

// D1 falso: responde por trecho de SQL (mesmo molde do verify-ancoras) e
// guarda os INSERT de epg_virtual. Nada sai daqui.
function falso(dados) {
  const epg = []
  const prepare = (sql) => {
    let args = []
    const api = {
      bind: (...a) => { args = a; return api },
      all: async () => {
        // cópia por consulta: o scheduleChannel MUTA last_played_at dos objetos
        // (marca local do rodízio). Reusar os mesmos objetos na rodada B faria
        // ela começar com a "memória" da rodada A e planejar outra grade.
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
        if (/FROM config WHERE k/.test(sql)) return dados.config[args[0]] != null ? { v: dados.config[args[0]] } : null
        if (/MAX\(end_time_virtual\) g/.test(sql)) return { g: null }
        if (/SELECT MAX\(end_time_virtual\)/.test(sql)) return { m: null }
        return null
      },
      run: async () => {
        if (/INSERT INTO epg_virtual/.test(sql)) {
          const re = /\('([^']*)','([^']*)',(\d+),(\d+),(\d+)\)/g
          let m
          while ((m = re.exec(sql))) epg.push([m[1], m[2], +m[3], +m[4], +m[5]])
        }
        return { meta: { changes: 0 } }
      },
    }
    return api
  }
  return { db: { prepare, batch: async (st) => { for (const s of st) await s.run() } }, epg }
}

// Relógio CONGELADO: as duas rodadas precisam partir do mesmo instante. Sem
// isso, a rodada B começa 10 s depois se o relógio virar a casa dos 10 s no
// meio, e a comparação "mesmos horários" acusa uma diferença que não existe.
const agora = Math.floor(Date.now() / 1000)
Date.now = () => agora * 1000
const resumo = {}
for (const canal of CANAIS) {
  const [canalRow] = await d1('SELECT * FROM channels WHERE id = ?', [canal])
  const media = await d1(
    `SELECT m.id, m.tipo, m.duracao_seg, m.segment_count, m.last_played_at, json_extract(m.metadata, '$.series_id') series_id
     FROM media_items m JOIN media_channels mc ON mc.media_id = m.id WHERE mc.channel_id = ? AND m.status = 'ready'`, [canal])
  const slots = await d1("SELECT series_id, dias, hora, episodios, reprise FROM channel_slots WHERE canal = ? AND status = 'ativa'", [canal])
  const cues = await d1('SELECT media_id, time_seg FROM media_cue_points WHERE media_id IN (SELECT media_id FROM media_channels WHERE channel_id = ?) ORDER BY time_seg', [canal])
  const promessas = await d1('SELECT media_id, status, proposta, condicao FROM media_promises')
  const eventos = await d1("SELECT media_id, series_id, start_at, end_at FROM channel_events WHERE canal = ? AND status = 'agendado' AND end_at > ?", [canal, agora])
  const diretrizes = await d1("SELECT tipo, payload FROM directives WHERE canal = ? AND status = 'ativa' AND tipo IN ('excluir_media','excluir_serie')", [canal]).catch(() => [])
  const base = { canal: canalRow, media, slots, cues, promessas, eventos, diretrizes, config: {} }

  // ── A: a grade como ela sai hoje ──
  const A = falso(base)
  await scheduleChannel({ DB: A.db }, canal, HORAS, true)
  const rowsA = A.epg.sort((a, b) => a[2] - b[2])
  const info = new Map(media.map((m) => [m.id, { tipo: m.tipo, series_id: m.series_id }]))
  const blocosA = blocosDeConteudo(rowsA, info)
  const seqs = new Map()
  for (let b = 0; b + 2 < blocosA.length; b++) {
    const s = [blocosA[b].serie, blocosA[b + 1].serie, blocosA[b + 2].serie]
    if (s.some((x) => !x)) continue
    seqs.set(s.join('>'), (seqs.get(s.join('>')) ?? 0) + 1)
  }

  // ── B: uma peça falsa por sequência, encaixe ligado ──
  const falsas = [...seqs.keys()].map((k, i) => ({ id: `com_lineup_dry_${String(i).padStart(3, '0')}`, seq: k.split('>') }))
  const B = falso({
    ...base,
    media: [...media, ...falsas.map((f) => ({ id: f.id, tipo: 'comercial', duracao_seg: 20, segment_count: 2, last_played_at: 0, series_id: f.seq[0] }))],
    promessas: [...promessas, ...falsas.map((f) => ({ media_id: f.id, status: 'confirmada', proposta: null,
      condicao: JSON.stringify({ tipo: 'lineup_grade', canal, seq: f.seq }) }))],
    config: { [`lineup_grade:${canal}`]: POSICAO },
  })
  const rep = await scheduleChannel({ DB: B.db }, canal, HORAS, true)
  const rowsB = B.epg.sort((a, b) => a[2] - b[2])
  const seqDe = new Map(falsas.map((f) => [f.id, f.seq.join('>')]))

  // ── conferências ──
  const progs = (rows) => rows.filter((r) => ['episodio', 'filme'].includes(info.get(r[1])?.tipo)).map((r) => `${r[1]}@${r[2]}`).join('|')
  const mesmosProgramas = progs(rowsA) === progs(rowsB)
  const contigua = rowsB.every((r, i) => i === 0 || r[2] === rowsB[i - 1][3])
  const infoB = new Map([...info, ...falsas.map((f) => [f.id, { tipo: 'comercial', series_id: null }])])
  const blocosB = blocosDeConteudo(rowsB, infoB)
  const encaixes = []
  const falsos = []
  rowsB.forEach((r, i) => {
    if (!seqDe.has(r[1])) return
    const b = blocosB.findIndex((x) => x.primeiro < i && i < x.ultimo)
    const real = b >= 0 && b + 2 < blocosB.length ? [blocosB[b].serie, blocosB[b + 1].serie, blocosB[b + 2].serie].join('>') : '(fora de bloco)'
    const bloco = b >= 0 ? blocosB[b] : null
    const e = { hora: hora(r[2]), seq: seqDe.get(r[1]), real,
      noBloco: bloco ? `${Math.round((r[2] - rowsB[bloco.primeiro][2]) / 60)} de ${Math.round((rowsB[bloco.ultimo][3] - rowsB[bloco.primeiro][2]) / 60)} min` : '-' }
    encaixes.push(e)
    if (e.real !== e.seq) falsos.push(e)
  })
  const ocorrencias = [...seqs.values()].reduce((a, b) => a + b, 0)

  // Por que um bloco ficou SEM lineup: não tinha intervalo dentro dele, ou
  // tinha mas nenhuma combinação de anúncios do rodízio fechava 20 s.
  // "Do rodízio" aqui é aproximado (comercial/vinheta sem promessa de contexto).
  const comContexto = new Set(promessas.filter((p) => p.status !== 'confirmada' || !/bloco_horario/.test(p.condicao ?? '')).map((p) => p.media_id))
  const motivos = { sem_intervalo_no_bloco: 0, sem_soma_de_20s: 0 }
  const duracoesVistas = new Map()
  for (let b = 0; b + 2 < blocosB.length; b++) {
    const bl = blocosB[b]
    const temLineup = rowsB.slice(bl.primeiro, bl.ultimo + 1).some((r) => seqDe.has(r[1]))
    if (temLineup || [blocosB[b].serie, blocosB[b + 1].serie, blocosB[b + 2].serie].some((x) => !x)) continue
    const naoConteudo = rowsB.slice(bl.primeiro + 1, bl.ultimo).filter((r) => !['episodio', 'filme'].includes(infoB.get(r[1])?.tipo))
    if (naoConteudo.length === 0) { motivos.sem_intervalo_no_bloco++; continue }
    motivos.sem_soma_de_20s++
    for (const r of naoConteudo) {
      const k = `${comContexto.has(r[1]) ? 'contexto' : 'rodizio'} ${r[3] - r[2]}s`
      duracoesVistas.set(k, (duracoesVistas.get(k) ?? 0) + 1)
    }
  }
  resumo[canal] = {
    blocos: blocosA.length, sequencias_distintas: seqs.size, ocorrencias, encaixados: encaixes.length,
    sem_espaco: ocorrencias - encaixes.length, mesmos_programas: mesmosProgramas, epg_contigua: contigua,
    promessas_falsas: falsos.length, report_lineups: rep.lineups ?? 0,
  }
  writeFileSync(`${SAIDA}/${canal}-${POSICAO}.json`, JSON.stringify({ resumo: resumo[canal], encaixes, falsos,
    sequencias: [...seqs.entries()].sort((a, b) => b[1] - a[1]) }, null, 2))

  console.log(`\n══ ${canal} · posição "${POSICAO}" · ${HORAS}h a partir de ${hora(rowsA[0]?.[2] ?? agora)} ══`)
  console.log(`  blocos de programa: ${blocosA.length} · sequências X→Y→Z: ${ocorrencias} (${seqs.size} distintas)`)
  console.log(`  encaixadas: ${encaixes.length} · sem espaço: ${ocorrencias - encaixes.length}` +
    ` (sem intervalo dentro do bloco: ${motivos.sem_intervalo_no_bloco}; intervalo sem soma de 20 s: ${motivos.sem_soma_de_20s})`)
  if (motivos.sem_soma_de_20s) console.log(`    peças nesses intervalos: ${[...duracoesVistas.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k}×${n}`).join(' · ')}`)
  console.log(`  ${mesmosProgramas ? '✅' : '❌'} programas nos MESMOS horários com e sem lineup`)
  console.log(`  ${contigua ? '✅' : '❌'} EPG contígua`)
  console.log(`  ${falsos.length === 0 ? '✅' : '❌'} toda peça promete o que vem depois dela${falsos.length ? ` (${falsos.length} FALSAS)` : ''}`)
  console.log('  primeiros encaixes:')
  for (const e of encaixes.slice(0, 8)) console.log(`    ${e.hora}  ${e.seq.replaceAll('>', ' → ')}  (min ${e.noBloco} do bloco)`)
}
console.log(`\nDetalhes em ${SAIDA}/<canal>-${POSICAO}.json`)
