// Verificação e2e da fase 12 (comerciais como promessa) — com LLM REAL.
// Injeta uma transcrição num comercial do canal, deixa o Gemini/DeepSeek
// classificar, e confere os EFEITOS na grade:
//   pendente com promessa → FORA do rodízio;
//   confirmada "a_seguir" → só toca imediatamente antes da série alvo;
//   genérico → rodízio normal de volta.
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchRetry as fetch } from './_lib.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787'
const TOKEN = process.env.ADMIN_TOKEN ?? 'bieltv-dev-2026'
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const CANAL = 'jetix'
const PROMO = 'com_power_rangers'          // único comercial do jetix local
const ALVO_MEDIA = 'ep_seu_madruga_vai_aos_eua'
const SERIE = 'serie_promo_alvo'

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

// limpeza de rodadas anteriores + série alvo de teste
function cleanup() {
  d1(`DELETE FROM media_promises WHERE media_id = '${PROMO}'`)
}
cleanup()
await post(`/admin/media/${ALVO_MEDIA}/series`, { series_id: SERIE })

// ── 1. transcrição entra → LLM real classifica ────────────────────────────
const r1 = await post(`/admin/promessas/${PROMO}/transcript`, {
  transcript: 'Já vem! A seguir, Seu Madruga e toda a sua turma, aqui no canal! Corra, não perca!',
})
check('transcript aceito e analisado', r1.status === 200)
const lista = await fetch(`${BASE}/admin/promessas`, { headers: auth }).then((r) => r.json())
const p1 = lista.find((p) => p.media_id === PROMO)
const prop = p1?.proposta ? JSON.parse(p1.proposta) : null
console.log(`   🤖 proposta: ${JSON.stringify(prop)}`)
check('LLM detectou promessa "a_seguir" (status pendente)', p1?.status === 'pendente' && prop?.tipo === 'a_seguir')
check('LLM apontou a série alvo certa da lista', prop?.series_id === SERIE, `series_id=${prop?.series_id}`)

// ── 2. pendente com promessa = FORA do rodízio ─────────────────────────────
await post('/admin/schedule/run', { canal: CANAL, rebuild: true })
const now = Math.floor(Date.now() / 1000)
const pend = d1(`SELECT COUNT(*) c FROM epg_virtual WHERE canal='${CANAL}' AND media_id='${PROMO}' AND start_time_virtual > ${now}`)[0].c
check('promo pendente saiu completamente da grade futura', pend === 0, `${pend} blocos`)

// ── 3. confirmada: só no intervalo imediatamente antes da série alvo ───────
const r3 = await post(`/admin/promessas/${PROMO}/decidir`, {
  status: 'confirmada',
  condicao: { tipo: 'a_seguir', series_id: SERIE, descricao: 'a seguir: Seu Madruga' },
})
check('confirmação aceita (e canais replanejados)', r3.status === 200)

const grade = d1(`
  SELECT e.media_id, m.tipo, json_extract(m.metadata,'$.series_id') sid
  FROM epg_virtual e JOIN media_items m ON m.id = e.media_id
  WHERE e.canal='${CANAL}' AND e.start_time_virtual > ${now}
  ORDER BY e.start_time_virtual`)
const usos = []
for (let i = 0; i < grade.length; i++) {
  if (grade[i].media_id !== PROMO) continue
  const prox = grade[i + 1]
  usos.push(prox ? (prox.sid === SERIE ? 'ok' : `errado:${prox.media_id}`) : 'fim-do-horizonte')
}
const maus = usos.filter((u) => u.startsWith('errado'))
check('promo confirmada VOLTOU pra grade', usos.length > 0, `${usos.length} veiculações`)
check('TODA veiculação fica colada no programa prometido', maus.length === 0,
  maus.length ? maus.slice(0, 3).join(' | ') : 'todas ok')

// promo nunca dentro de intervalo no meio do episódio (entre partes do MESMO conteúdo)
let meioEpisodio = 0
for (let i = 1; i < grade.length - 1; i++) {
  if (grade[i].media_id !== PROMO) continue
  const antes = grade[i - 1]
  const depois = grade[i + 1]
  if (antes.media_id === depois.media_id && (antes.tipo === 'episodio' || antes.tipo === 'filme')) meioEpisodio++
}
check('nunca aparece no meio de um episódio', meioEpisodio === 0)

// ── 4. de volta a genérico: rodízio normal ─────────────────────────────────
await post(`/admin/promessas/${PROMO}/decidir`, { status: 'generico' })
const generico = d1(`SELECT COUNT(*) c FROM epg_virtual WHERE canal='${CANAL}' AND media_id='${PROMO}' AND start_time_virtual > ${now}`)[0].c
check('como genérico, volta ao rodízio comum dos intervalos', generico > 0, `${generico} blocos`)

// ── 5. interruptor "comerciais fiéis" ⇄ "livres" ──────────────────────────
await post(`/admin/promessas/${PROMO}/decidir`, { status: 'ignorar' })
const foraFiel = d1(`SELECT COUNT(*) c FROM epg_virtual WHERE canal='${CANAL}' AND media_id='${PROMO}' AND start_time_virtual > ${now}`)[0].c
check('modo FIEL: "não usar" tira do ar', foraFiel === 0)

// o interruptor é POR CANAL (e o servidor já replaneja o canal na troca)
await post(`/admin/channels/${CANAL}`, { comerciais_fieis: 0 })
const livre = d1(`SELECT COUNT(*) c FROM epg_virtual WHERE canal='${CANAL}' AND media_id='${PROMO}' AND start_time_virtual > ${now}`)[0].c
check('modo LIVRE no canal: até o "não usar" volta pro rodízio cego', livre > 0, `${livre} blocos`)
const outroCanal = d1(`SELECT comerciais_fieis f FROM channels WHERE id='cartoon_network'`)[0].f
check('o outro canal continua FIEL (interruptor é por canal)', outroCanal === 1)

await post(`/admin/channels/${CANAL}`, { comerciais_fieis: 1 })
const fielDeNovo = d1(`SELECT COUNT(*) c FROM epg_virtual WHERE canal='${CANAL}' AND media_id='${PROMO}' AND start_time_virtual > ${now}`)[0].c
check('religou o FIEL: promessas voltam a mandar', fielDeNovo === 0)

// ── limpeza ────────────────────────────────────────────────────────────────
cleanup()
await post(`/admin/media/${ALVO_MEDIA}/series`, { series_id: '' })
await post('/admin/schedule/run', { canal: CANAL, rebuild: true })
const limpo = d1(`SELECT COUNT(*) c FROM media_promises WHERE media_id='${PROMO}'`)[0].c === 0
check('estado de teste limpo (promessa removida, grade replanejada)', limpo)

console.log(`\n${fail === 0 ? '🎉' : '💥'} ${pass}/${pass + fail} checagens passaram`)
process.exit(fail === 0 ? 0 : 1)
