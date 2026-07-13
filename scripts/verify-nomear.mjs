// Verificação e2e da fase 11c (área "A nomear") + correção por canal.
// LLM real na sugestão de nomes; o resto é determinístico.
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchRetry as fetch } from './_lib.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787'
const TOKEN = process.env.ADMIN_TOKEN ?? 'bieltv-dev-2026'
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const ALVO = 'com_test' // cobaia local do rename
const EP1 = 'ep_madagascar_cupcake'
const EP2 = 'ep_seu_madruga_vai_aos_eua'
const SERIE = 'serie_canais_teste'

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`✅ ${name}${extra ? `  (${extra})` : ''}`) }
  else { fail++; console.log(`❌ ${name}${extra ? `  (${extra})` : ''}`) }
}

function d1(sql) {
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'biel-tv-db', '--local', '--json', '--command', sql], {
    cwd: join(ROOT, 'apps', 'stream'), encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`d1 falhou: ${r.stderr}`)
  return JSON.parse(r.stdout.slice(r.stdout.indexOf('[')))[0].results
}

const post = (path, body) => fetch(`${BASE}${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body ?? {}) })
const getMedia = async () => (await fetch(`${BASE}/admin/media`, { headers: auth })).json()

const health = await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null)
if (health?.status !== 'ok') {
  console.error('✖ wrangler dev fora do ar — rode `pnpm dev` antes')
  process.exit(1)
}

const tituloOriginal = JSON.parse(d1(`SELECT metadata FROM media_items WHERE id='${ALVO}'`)[0].metadata).title ?? ALVO

// ── 1. detecção de nome ruim ───────────────────────────────────────────────
d1(`UPDATE media_items SET metadata = json_set(metadata, '$.title', 'AVDTSTNMRT01EP07') WHERE id='${ALVO}'`)
let lista = await getMedia()
check('amasso de consoantes cai na fila "A nomear"', lista.find((m) => m.id === ALVO)?.nome_ruim === true)

d1(`UPDATE media_items SET metadata = json_set(metadata, '$.title', '34') WHERE id='${ALVO}'`)
lista = await getMedia()
check('título só numérico também cai', lista.find((m) => m.id === ALVO)?.nome_ruim === true)

// ── 2. sugestão da IA com contexto do lote (LLM real) ─────────────────────
d1(`UPDATE media_items SET metadata = json_set(metadata, '$.title', 'PDRMGCST03EP34') WHERE id='${ALVO}'`)
const r2 = await post('/admin/media/nomear-sugestoes', {
  ids: [ALVO],
  contexto: 'esse lote são episódios da série Padrinhos Mágicos, terceira temporada',
})
const b2 = await r2.json()
const sug = (b2.sugestoes ?? [])[0]
console.log(`   ✨ sugestão [${b2.provedor}]: ${JSON.stringify(sug)}`)
check('IA propôs título limpo citando a série do contexto',
  r2.status === 200 && sug?.id === ALVO && /padrinhos/i.test(sug?.title ?? ''), sug?.title)
check('IA propôs slug de série e episódio coerentes',
  /padrinhos/.test(sug?.series_id ?? '') && sug?.episode === 34, `${sug?.series_id} ep${sug?.episode}`)

// ── 3. renomear tira da fila; nome-ok dispensa falso positivo ─────────────
await post(`/admin/media/${ALVO}/renomear`, { title: 'Padrinhos Mágicos — T3 Ep 34', series_id: null, episode: 34 })
lista = await getMedia()
check('renomeado sai da fila sozinho', lista.find((m) => m.id === ALVO)?.nome_ruim === false)

d1(`UPDATE media_items SET metadata = json_set(metadata, '$.title', 'XPTO') WHERE id='${ALVO}'`)
await post(`/admin/media/${ALVO}/nome-ok`, {})
lista = await getMedia()
check('"está bom" dispensa o falso positivo', lista.find((m) => m.id === ALVO)?.nome_ruim === false)

// ── 4. correção por canal: remover canal LIMPA a grade futura na hora ─────
const now = Math.floor(Date.now() / 1000)
const antes = d1(`SELECT COUNT(*) c FROM epg_virtual WHERE canal='jetix' AND media_id='${EP1}' AND start_time_virtual > ${now}`)[0].c
check('cobaia tinha blocos futuros no jetix', antes > 0, `${antes} blocos`)
await post(`/admin/media/${EP1}/channels`, { channels: ['cartoon_network'] })
const depois = d1(`SELECT COUNT(*) c FROM epg_virtual WHERE canal='jetix' AND media_id='${EP1}' AND start_time_virtual > ${now}`)[0].c
check('removeu do canal → blocos futuros SOMEM na hora (grade reajustada)', depois === 0, `${depois} blocos`)
await post(`/admin/media/${EP1}/channels`, { channels: ['jetix'] })

// ── 5. série inteira de uma vez ────────────────────────────────────────────
for (const id of [EP1, EP2]) await post(`/admin/media/${id}/series`, { series_id: SERIE })
const r5 = await post(`/admin/series/${SERIE}/channels`, { channels: ['cartoon_network'] })
const b5 = await r5.json()
const j1 = d1(`SELECT COUNT(*) c FROM epg_virtual WHERE canal='jetix' AND media_id IN ('${EP1}','${EP2}') AND start_time_virtual > ${now}`)[0].c
const cc = d1(`SELECT COUNT(*) c FROM media_channels WHERE media_id IN ('${EP1}','${EP2}') AND channel_id='cartoon_network'`)[0].c
check('série inteira movida de canal num comando', r5.status === 200 && b5.midias === 2 && cc === 2)
check('grade do canal de origem limpa pros DOIS episódios', j1 === 0, `${j1} blocos`)

// ── limpeza ────────────────────────────────────────────────────────────────
for (const id of [EP1, EP2]) {
  await post(`/admin/media/${id}/series`, { series_id: '' })
  await post(`/admin/media/${id}/channels`, { channels: ['jetix'] })
}
d1(`UPDATE media_items SET metadata = json_remove(json_set(metadata, '$.title', '${tituloOriginal.replaceAll("'", "''")}'), '$.nome_ok', '$.episode') WHERE id='${ALVO}'`)
await post('/admin/schedule/run', { rebuild: true })
const volta = d1(`SELECT COUNT(*) c FROM epg_virtual WHERE canal='jetix' AND media_id='${EP1}' AND start_time_virtual > ${now}`)[0].c
check('estado restaurado (cobaias de volta ao jetix e à grade)', volta > 0)

console.log(`\n${fail === 0 ? '🎉' : '💥'} ${pass}/${pass + fail} checagens passaram`)
process.exit(fail === 0 ? 0 : 1)
