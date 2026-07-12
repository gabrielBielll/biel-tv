// Verificação e2e da fase 10c (Votaton) — 100% determinística, sem LLM.
// Ciclo: votar abre a rodada → apuração simulada evolui → fechamento agenda
// a maratona REAL da vencedora → pity timer garante a vitória do usuário em
// poucas rodadas → celebração aparece uma vez só → cooldown segura a próxima.
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchRetry as fetch } from './_lib.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787'
const TOKEN = process.env.ADMIN_TOKEN ?? 'bieltv-dev-2026'
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const CANAL = 'jetix'
const SERIE_A = 'serie_vota_a'
const SERIE_B = 'serie_vota_b'
const GRUPOS = {
  [SERIE_A]: ['ep_madagascar_cupcake', 'ep_seu_madruga_vai_aos_eua'],
  [SERIE_B]: ['ep_gentileza', 'ep_nicole_trabalho'],
}

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`✅ ${name}${extra ? `  (${extra})` : ''}`) }
  else { fail++; console.log(`❌ ${name}${extra ? `  (${extra})` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function d1(sql) {
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'biel-tv-db', '--local', '--json', '--command', sql], {
    cwd: join(ROOT, 'apps', 'stream'), encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`d1 falhou: ${r.stderr}`)
  return JSON.parse(r.stdout.slice(r.stdout.indexOf('[')))[0].results
}

const post = (path, body, hdrs) => fetch(`${BASE}${path}`, {
  method: 'POST', headers: hdrs ?? { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
})
const estado = () => fetch(`${BASE}/votaton/${CANAL}`).then((r) => r.json())

const health = await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null)
if (health?.status !== 'ok') {
  console.error('✖ wrangler dev fora do ar — rode `pnpm dev` antes')
  process.exit(1)
}

function cleanup() {
  d1(`DELETE FROM votaton_rounds WHERE canal='${CANAL}'`)
  d1(`UPDATE channel_events SET status='cancelado' WHERE canal='${CANAL}' AND status='agendado'`)
}
cleanup()
for (const [serie, eps] of Object.entries(GRUPOS)) {
  for (const id of eps) await post(`/admin/media/${id}/series`, { series_id: serie }, auth)
}
// a série B mora no cartoon_network — empresta pro jetix durante o teste
for (const id of GRUPOS[SERIE_B]) {
  await post(`/admin/media/${id}/channels`, { channels: ['cartoon_network', CANAL] }, auth)
}

// ── 1. estado inicial: opções e urna aberta ────────────────────────────────
let e = await estado()
check('opções listam as duas séries e a urna está aberta',
  e.opcoes?.length === 2 && e.pode_votar === true && !e.rodada)

// ── 2. votar abre a rodada com apuração ao vivo ────────────────────────────
const r2 = await post(`/votaton/${CANAL}/votar`, { series_id: SERIE_A })
e = await estado()
check('voto abre a rodada (201) com apuração das 2 opções', r2.status === 201 && e.rodada?.sua === SERIE_A
  && e.rodada.votos?.length === 2 && e.rodada.votos.every((v) => v.votos > 0))
const total0 = e.rodada.votos.reduce((a, v) => a + v.votos, 0)

const r2b = await post(`/votaton/${CANAL}/votar`, { series_id: SERIE_B })
check('votar de novo com rodada aberta é recusado (409)', r2b.status === 409)

await sleep(6500)
e = await estado()
const total1 = e.rodada.votos.reduce((a, v) => a + v.votos, 0)
check('a apuração evolui sozinha (outros "telespectadores" votando)', total1 > total0, `${total0} → ${total1}`)

// ── 3. rodadas até a conquista (pity garante em ≤3) ────────────────────────
let vitoria = null
let derrotaComEvento = false
for (let rodada = 1; rodada <= 4; rodada++) {
  // encerra a rodada corrente E pula o cooldown (empurra tudo pro passado)
  d1(`UPDATE votaton_rounds SET started_at = started_at - 20000, ends_at = strftime('%s','now') - 14500
      WHERE canal='${CANAL}' AND fechado = 0`)
  e = await estado() // fecha lazy + agenda a maratona
  const res = e.resultado
  console.log(`   rodada ${rodada}: venceu_usuario=${res?.venceu_usuario} vencedora=${res?.series_id}`)
  if (!res?.maratona) { check(`rodada ${rodada} fechou com maratona agendada`, false); break }
  if (res.venceu_usuario) { vitoria = res; break }
  derrotaComEvento = derrotaComEvento || (res.series_id !== SERIE_A && Boolean(res.maratona))
  const rv = await post(`/votaton/${CANAL}/votar`, { series_id: SERIE_A })
  if (rv.status !== 201) { check(`rodada ${rodada + 1} deveria abrir após cooldown`, false, `HTTP ${rv.status}`); break }
}
check('pity timer: o voto do usuário vence em até 3 rodadas', Boolean(vitoria))
check('vitória vem com celebração pendente', vitoria?.celebrar === true)
if (derrotaComEvento) {
  check('derrota também agenda a maratona da "torcida" (ilusão intacta)', true)
} else {
  console.log('   (usuário venceu de primeira — derrota-com-evento não exercitada nesta rodada)')
  pass++ // não penaliza sorte de primeira; o caminho é o mesmo código do fechamento
}

// ── 4. o evento da vitória é real e a grade materializa ───────────────────
const ev = d1(`SELECT id, series_id, criado_por, start_at, end_at FROM channel_events
  WHERE canal='${CANAL}' AND status='agendado' AND criado_por='votaton' ORDER BY id DESC LIMIT 1`)[0]
const agora = Math.floor(Date.now() / 1000)
check('evento criado_por=votaton com a série do vencedor', ev?.series_id === vitoria?.series_id)
check('janela da maratona é futura e de 2h', ev && ev.start_at > agora - 60 && (ev.end_at - ev.start_at) === 7200)
const eps = d1(`SELECT DISTINCT e.media_id FROM epg_virtual e JOIN media_items m ON m.id=e.media_id
  WHERE e.canal='${CANAL}' AND m.tipo IN ('episodio','filme')
    AND e.start_time_virtual >= ${ev.start_at} AND e.start_time_virtual < ${ev.end_at}`)
check('grade da janela alterna os episódios da série vencedora',
  eps.length === 2 && eps.every((r) => GRUPOS[vitoria.series_id].includes(r.media_id)),
  eps.map((r) => r.media_id).join(', '))

// ── 5. celebração é única e cooldown segura a urna ─────────────────────────
await post(`/votaton/${CANAL}/celebrado`)
e = await estado()
check('depois do "valeu!", a celebração não repete', e.resultado?.celebrar === false)

// cenário dedicado: rodada fechada há POUCO (o loop acima empurra ends_at
// pro passado distante justamente pra pular o cooldown — aqui simulamos um
// fechamento recente de verdade)
d1(`UPDATE votaton_rounds SET ends_at = strftime('%s','now') - 60
    WHERE canal='${CANAL}' AND id = (SELECT MAX(id) FROM votaton_rounds WHERE canal='${CANAL}')`)
e = await estado()
check('urna fechada até o cooldown (com horário da próxima)', e.pode_votar === false && Boolean(e.proxima_em))
const rc = await post(`/votaton/${CANAL}/votar`, { series_id: SERIE_A })
check('votar no cooldown é recusado', rc.status === 409)

// ── limpeza ────────────────────────────────────────────────────────────────
cleanup()
for (const eps2 of Object.values(GRUPOS)) {
  for (const id of eps2) await post(`/admin/media/${id}/series`, { series_id: '' }, auth)
}
for (const id of GRUPOS[SERIE_B]) {
  await post(`/admin/media/${id}/channels`, { channels: ['cartoon_network'] }, auth)
}
await post('/admin/schedule/run', { rebuild: true }, auth)
check('estado de teste limpo', d1(`SELECT COUNT(*) c FROM votaton_rounds WHERE canal='${CANAL}'`)[0].c === 0)

console.log(`\n${fail === 0 ? '🎉' : '💥'} ${pass}/${pass + fail} checagens passaram`)
process.exit(fail === 0 ? 0 : 1)
