// Verificação e2e da fase 10a (diretor editorial noturno) — com LLM REAL.
// Ciclo completo do "sonho da maratona": o diretor decide a noite → evento de
// SÉRIE entra na grade (episódios diferentes em sequência) → a promo tipo
// "evento" da série destrava nos intervalos DURANTE a janela de promoção →
// cancelou o evento, a promo some (nunca prometemos o que não vamos cumprir).
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchRetry as fetch } from './_lib.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787'
const TOKEN = process.env.ADMIN_TOKEN ?? 'bieltv-dev-2026'
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const CANAL = 'jetix'
const SERIE = 'serie_noite_teste'
const EPS = ['ep_madagascar_cupcake', 'ep_seu_madruga_vai_aos_eua']
const PROMO = 'com_power_rangers'

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

const post = (path, body) => fetch(`${BASE}${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body) })

const health = await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null)
if (health?.status !== 'ok') {
  console.error('✖ wrangler dev fora do ar — rode `pnpm dev` antes')
  process.exit(1)
}

// limpeza de rodadas anteriores + série de teste com 2 episódios
function cleanup() {
  d1(`UPDATE channel_events SET status='cancelado' WHERE canal='${CANAL}' AND status='agendado'`)
  d1(`DELETE FROM media_promises WHERE media_id='${PROMO}'`)
}
cleanup()
for (const id of EPS) await post(`/admin/media/${id}/series`, { series_id: SERIE })

// ── 1. o diretor decide a noite (LLM real, forçado a agir) ─────────────────
const r1 = await post('/admin/diretor/planejar', { canal: CANAL, forcar: true })
const b1 = await r1.json()
const d = (b1.decisoes ?? [])[0]
console.log(`   🌙 decisão: ${JSON.stringify(d)}`)
check('diretor decidiu e agendou maratona', r1.status === 200 && d?.fez === true && d.series_id === SERIE,
  d?.motivo ?? '')

const ev = d1(`SELECT id, series_id, media_id, criado_por, start_at, end_at FROM channel_events
  WHERE canal='${CANAL}' AND status='agendado' AND criado_por='editorial'`)[0]
check('evento de SÉRIE gravado (criado_por=editorial)', Boolean(ev) && ev.series_id === SERIE)
const durH = ev ? (ev.end_at - ev.start_at) / 3600 : 0
const agora = Math.floor(Date.now() / 1000)
check('janela sensata (começa no futuro, dura 1–4h)', ev && ev.start_at > agora && durH >= 1 && durH <= 4,
  `${durH.toFixed(1)}h`)

// ── 2. a grade materializa a maratona com episódios DIFERENTES ─────────────
const naJanela = d1(`
  SELECT DISTINCT e.media_id FROM epg_virtual e JOIN media_items m ON m.id=e.media_id
  WHERE e.canal='${CANAL}' AND m.tipo IN ('episodio','filme')
    AND e.start_time_virtual >= ${ev.start_at} AND e.start_time_virtual < ${ev.end_at}`)
const ids = naJanela.map((r) => r.media_id).sort()
check('maratona alterna os episódios da série (não é loop de um só)',
  ids.length === 2 && ids.every((id) => EPS.includes(id)), ids.join(', '))

// ── 3. idempotência do dia ─────────────────────────────────────────────────
const r3 = await post('/admin/diretor/planejar', { canal: CANAL })
const d3 = ((await r3.json()).decisoes ?? [])[0]
check('planejar de novo no mesmo dia não duplica', d3?.fez === false && /já existe/i.test(d3?.motivo ?? ''))

// ── 4. promo do evento destrava na janela de promoção ─────────────────────
await post(`/admin/promessas/${PROMO}/transcript`, {
  transcript: 'Hoje à noite! Maratona do Seu Madruga, episódios sem parar! Só aqui no canal!',
})
await post(`/admin/promessas/${PROMO}/decidir`, {
  status: 'confirmada',
  condicao: { tipo: 'evento', series_id: SERIE, descricao: 'maratona do Seu Madruga' },
})
const antes = d1(`SELECT COUNT(*) c FROM epg_virtual WHERE canal='${CANAL}' AND media_id='${PROMO}'
  AND start_time_virtual > ${agora} AND start_time_virtual < ${ev.start_at}`)[0].c
const depois = d1(`SELECT COUNT(*) c FROM epg_virtual WHERE canal='${CANAL}' AND media_id='${PROMO}'
  AND start_time_virtual >= ${ev.start_at}`)[0].c
check('promo roda nos intervalos ANTES da maratona (janela de promoção)', antes > 0, `${antes} veiculações`)
check('promo NUNCA depois que a maratona começa', depois === 0, `${depois} depois do início`)

// ── 5. cancelou o evento → promo some junto ────────────────────────────────
await post(`/admin/diretor/evento/${ev.id}/cancelar`, {})
// timestamp FRESCO: as chamadas de LLM acima levam dezenas de segundos e a
// promo pode já ter tocado nesse meio-tempo (ver GOTCHAS.md — now envelhecido)
const agora5 = Math.floor(Date.now() / 1000)
const promoAposCancel = d1(`SELECT COUNT(*) c FROM epg_virtual WHERE canal='${CANAL}' AND media_id='${PROMO}'
  AND start_time_virtual > ${agora5} + 120`)[0].c
const maratonaAposCancel = d1(`
  SELECT COUNT(DISTINCT e.media_id) c FROM epg_virtual e JOIN media_items m ON m.id=e.media_id
  WHERE e.canal='${CANAL}' AND m.tipo IN ('episodio','filme')
    AND e.start_time_virtual >= ${ev.start_at} AND e.start_time_virtual < ${ev.end_at}`)[0].c
check('cancelar o evento tira a promo do ar junto (promessa morta não toca)', promoAposCancel === 0)
check('janela volta pra programação normal (variedade, não só a série)', maratonaAposCancel !== 1)

// ── limpeza ────────────────────────────────────────────────────────────────
cleanup()
for (const id of EPS) await post(`/admin/media/${id}/series`, { series_id: '' })
await post('/admin/schedule/run', { canal: CANAL, rebuild: true })
check('estado de teste limpo', d1(`SELECT COUNT(*) c FROM channel_events WHERE canal='${CANAL}' AND status='agendado'`)[0].c === 0)

console.log(`\n${fail === 0 ? '🎉' : '💥'} ${pass}/${pass + fail} checagens passaram`)
process.exit(fail === 0 ? 0 : 1)
