// Verificação e2e do chat do Diretor (fase 10b) — com chamadas REAIS ao LLM.
// Testa o ciclo: excluir mídia por período → maratona agendada → cancelar
// exclusão, conferindo os EFEITOS no banco/grade (a resposta em texto do LLM
// é não-determinística; o que validamos é o que o código executou).
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchRetry } from './_lib.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787'
const TOKEN = process.env.ADMIN_TOKEN ?? 'bieltv-dev-2026'
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const CANAL = 'jetix'
const ALVO = 'ep_madagascar_cupcake'
const MARATONA = 'ep_seu_madruga_vai_aos_eua'

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

async function chat(text) {
  const res = await fetchRetry(`${BASE}/admin/diretor/chat`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ canal: CANAL, mensagens: [{ role: 'user', text }] }),
  })
  const body = await res.json()
  if (body.acoes_recusadas?.length) console.log(`   ⚠️ recusadas: ${body.acoes_recusadas.join(' | ')}`)
  return body
}

const health = await fetchRetry(`${BASE}/health`).then((r) => r.json()).catch(() => null)
if (health?.status !== 'ok') {
  console.error('✖ wrangler dev fora do ar — rode `pnpm dev` antes')
  process.exit(1)
}

// limpeza de rodadas anteriores
d1(`UPDATE directives SET status='cancelada' WHERE canal='${CANAL}' AND status='ativa'`)
d1(`UPDATE channel_events SET status='cancelado' WHERE canal='${CANAL}' AND status='agendado'`)
await fetchRetry(`${BASE}/admin/schedule/run`, { method: 'POST', headers: auth, body: JSON.stringify({ canal: CANAL, rebuild: true }) })

const now = Math.floor(Date.now() / 1000)

// As chamadas de LLM (chat()) levam vários segundos — o servidor calcula seu
// próprio `now` no MOMENTO em que processa o pedido, sempre um pouco depois
// do `now` capturado aqui no início do script. Uma linha cujo início cai
// nesse intervalo sobrevive corretamente à exclusão (o servidor nem sabia
// dela ainda) mas pareceria "não excluída" se comparada contra o `now`
// antigo. Por isso os checks de "sumiu da grade" usam um `now` recapturado
// DEPOIS do chat() retornar — nesse ponto o servidor já processou tudo.
const freshNow = () => Math.floor(Date.now() / 1000)

// ── 1. excluir mídia por 2 meses ───────────────────────────────────────────
const r1 = await chat(`Retire o desenho Madagascar (id ${ALVO}) da programação pelos próximos 2 meses, por favor.`)
const t1 = freshNow()
console.log(`   diretor [${r1.provedor}]: ${String(r1.resposta).slice(0, 120)}…`)
check('exclusão: LLM respondeu e o código executou', r1.acoes_executadas?.some((a) => a.includes(ALVO)),
  r1.acoes_executadas?.join(' | ') ?? '')
const dir = d1(`SELECT vigente_ate FROM directives WHERE canal='${CANAL}' AND status='ativa' AND payload LIKE '%${ALVO}%'`)[0]
const dias = dir?.vigente_ate ? Math.round((dir.vigente_ate - t1) / 86400) : null
check('diretriz gravada com prazo ~60 dias', dias !== null && dias >= 50 && dias <= 70, `${dias} dias`)
const aindaTem = d1(`SELECT COUNT(*) c FROM epg_virtual WHERE canal='${CANAL}' AND media_id='${ALVO}' AND start_time_virtual > ${t1}`)[0].c
check('Madagascar saiu da grade futura do Jetix', aindaTem === 0, `${aindaTem} blocos restantes`)

// ── 2. maratona hoje à noite ───────────────────────────────────────────────
const ini = new Date((now + 2 * 3600 - 3 * 3600) * 1000).toISOString().slice(0, 16).replace('T', ' ')
const fim = new Date((now + 3 * 3600 - 3 * 3600) * 1000).toISOString().slice(0, 16).replace('T', ' ')
const r2 = await chat(`Agende uma maratona do Seu Madruga (id ${MARATONA}) de ${ini} até ${fim} (horário de São Paulo).`)
console.log(`   diretor [${r2.provedor}]: ${String(r2.resposta).slice(0, 120)}…`)
check('maratona: ação executada', r2.acoes_executadas?.some((a) => a.includes(MARATONA)),
  r2.acoes_executadas?.join(' | ') ?? '')
const ev = d1(`SELECT start_at, end_at FROM channel_events WHERE canal='${CANAL}' AND status='agendado' AND media_id='${MARATONA}'`)[0]
check('evento gravado no período pedido', Boolean(ev) && Math.abs(ev.start_at - (now + 7200)) < 900)
if (ev) {
  const janela = d1(`
    SELECT e.media_id, m.tipo FROM epg_virtual e JOIN media_items m ON m.id=e.media_id
    WHERE e.canal='${CANAL}' AND e.start_time_virtual >= ${ev.start_at} AND e.start_time_virtual < ${ev.end_at}`)
  const conteudos = janela.filter((r) => r.tipo === 'episodio' || r.tipo === 'filme')
  const soMadruga = conteudos.length > 0 && conteudos.every((r) => r.media_id === MARATONA)
  check('grade da janela é só Seu Madruga (maratona materializada)', soMadruga,
    `${conteudos.length} blocos de conteúdo na janela`)
}

const estado1 = await fetchRetry(`${BASE}/admin/diretor/estado?canal=${CANAL}`, { headers: auth }).then((r) => r.json())
check('GET /diretor/estado lista o evento da maratona', estado1.eventos?.some((e) => e.media_id === MARATONA))

// Cancela pelo endpoint real do painel (exercita esse caminho E isola o
// teste de exclusão de série a seguir — evento > exclusão por design, então
// deixá-lo ativo faria o Madruga "sobreviver" corretamente à exclusão de
// série, dando falso-negativo num teste que não é sobre maratona).
const evId = estado1.eventos?.find((e) => e.media_id === MARATONA)?.id
if (evId) {
  const rc = await fetchRetry(`${BASE}/admin/diretor/evento/${evId}/cancelar`, { method: 'POST', headers: auth }).then((r) => r.json())
  check('cancelar evento pelo painel funciona', rc.ok === true)
}

// ── 3. cancelar a exclusão ─────────────────────────────────────────────────
const r3 = await chat(`Pode cancelar a exclusão do Madagascar (id ${ALVO})? Quero ele de volta na programação.`)
const t3 = freshNow()
console.log(`   diretor [${r3.provedor}]: ${String(r3.resposta).slice(0, 120)}…`)
check('cancelamento: ação executada', r3.acoes_executadas?.some((a) => a.includes(ALVO)),
  r3.acoes_executadas?.join(' | ') ?? '')
const voltou = d1(`SELECT COUNT(*) c FROM epg_virtual WHERE canal='${CANAL}' AND media_id='${ALVO}' AND start_time_virtual > ${t3}`)[0].c
check('Madagascar voltou pra grade', voltou > 0, `${voltou} blocos`)

// ── 4. excluir uma "temporada" (série) inteira ─────────────────────────────
// agrupa 2 mídias reais numa série temporária via o endpoint retroativo
const SERIE = 'serie_teste_verify'
const S1 = 'ep_madagascar_cupcake'
const S2 = 'ep_seu_madruga_vai_aos_eua'
for (const id of [S1, S2]) {
  await fetchRetry(`${BASE}/admin/media/${id}/series`, { method: 'POST', headers: auth, body: JSON.stringify({ series_id: SERIE }) })
}

const r4 = await chat(`Retire a temporada inteira ${SERIE} da programação por 1 mês.`)
const t4 = freshNow()
console.log(`   diretor [${r4.provedor}]: ${String(r4.resposta).slice(0, 120)}…`)
check('excluir série: ação executada (uma ação só, não uma por episódio)',
  r4.acoes_executadas?.some((a) => a.includes(SERIE)) && r4.acoes_executadas.length <= 2,
  r4.acoes_executadas?.join(' | ') ?? '')
const f1 = d1(`SELECT COUNT(*) c FROM epg_virtual WHERE canal='${CANAL}' AND media_id='${S1}' AND start_time_virtual > ${t4}`)[0].c
const f2 = d1(`SELECT COUNT(*) c FROM epg_virtual WHERE canal='${CANAL}' AND media_id='${S2}' AND start_time_virtual > ${t4}`)[0].c
check('AMBOS os episódios da série saíram da grade', f1 === 0 && f2 === 0, `${S1}:${f1} ${S2}:${f2}`)

const r5 = await chat(`Pode cancelar a exclusão da temporada ${SERIE}? Quero ela de volta.`)
const t5 = freshNow()
console.log(`   diretor [${r5.provedor}]: ${String(r5.resposta).slice(0, 120)}…`)
check('cancelar exclusão de série: ação executada', r5.acoes_executadas?.some((a) => a.includes(SERIE)))
const v1 = d1(`SELECT COUNT(*) c FROM epg_virtual WHERE canal='${CANAL}' AND media_id='${S1}' AND start_time_virtual > ${t5}`)[0].c
const v2 = d1(`SELECT COUNT(*) c FROM epg_virtual WHERE canal='${CANAL}' AND media_id='${S2}' AND start_time_virtual > ${t5}`)[0].c
check('AMBOS voltaram pra grade', v1 > 0 && v2 > 0)

// desagrupa (limpa o metadata de teste)
for (const id of [S1, S2]) {
  await fetchRetry(`${BASE}/admin/media/${id}/series`, { method: 'POST', headers: auth, body: JSON.stringify({ series_id: '' }) })
}
const semSerie = d1(`SELECT COUNT(*) c FROM media_items WHERE json_extract(metadata,'$.series_id')='${SERIE}'`)[0].c
check('agrupamento de teste desfeito', semSerie === 0)

// ── 5. limpeza final ────────────────────────────────────────────────────────
const limpo = d1(`SELECT COUNT(*) c FROM channel_events WHERE canal='${CANAL}' AND status='agendado'`)[0].c
check('nenhum evento de teste sobrou', limpo === 0)

console.log(`\n${fail === 0 ? '🎉' : '💥'} ${pass}/${pass + fail} checagens passaram`)
process.exit(fail === 0 ? 0 : 1)
