// Verificação e2e dos uploads persistentes/retomáveis + deleção definitiva
// (docs/features/uploads-resumiveis.md).
//
// A: sessões multipart pela API — dedupe por fingerprint, re-PUT idempotente,
//    parte com tamanho errado rejeitada, complete 2x = exatamente 1 job.
// B: abort limpa tudo.
// C: retomada REAL pós-reload no navegador (sessão órfã → reanexa → conclui).
// D: zona de perigo — todas as recusas + deleção que só atinge o prefixo certo.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchRetry as fetch } from './_lib.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787'
const WEB = 'http://127.0.0.1:5175'
const TOKEN = process.env.ADMIN_TOKEN ?? 'bieltv-dev-2026'
const auth = { authorization: `Bearer ${TOKEN}` }
const authJson = { ...auth, 'content-type': 'application/json' }

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

function r2PutLocal(key, file) {
  const r = spawnSync('npx', ['wrangler', 'r2', 'object', 'put', `biel-tv-media/${key}`, '--file', file, '--local'], {
    cwd: join(ROOT, 'apps', 'stream'), encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`r2 put falhou: ${r.stderr}`)
}

const health = await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null)
if (health?.status !== 'ok') {
  console.error('✖ wrangler dev fora do ar — rode `pnpm dev` antes')
  process.exit(1)
}

// limpeza de rodadas anteriores (idempotente)
const LIMPA_IDS = ['upl_teste_api', 'upl_teste_web', 'ep_del_teste', 'ep_del_teste2']
function cleanAll() {
  for (const id of LIMPA_IDS) {
    d1(`DELETE FROM upload_parts WHERE session_id IN (SELECT id FROM upload_sessions WHERE media_id='${id}')`)
    d1(`DELETE FROM upload_sessions WHERE media_id='${id}'`)
    d1(`DELETE FROM ingest_jobs WHERE id='${id}'`)
    d1(`DELETE FROM epg_virtual WHERE media_id='${id}'`)
    d1(`DELETE FROM media_channels WHERE media_id='${id}'`)
    d1(`DELETE FROM media_cue_points WHERE media_id='${id}'`)
    d1(`DELETE FROM media_items WHERE id='${id}'`)
  }
}
cleanAll()

// ── A. sessões multipart pela API ──────────────────────────────────────────
console.log('— A: sessão multipart, idempotência, complete 2x —')
const MB = 1024 * 1024
const PART = 5 * MB
const bufA = randomBytes(12 * MB) // 3 partes: 5 + 5 + 2 MiB
const fpA = { name: 'upl-teste-api.bin', rel: '', size: bufA.length, last_modified: 1783800000000 }

const criaBody = (media_id) => JSON.stringify({
  media_id, tipo: 'comercial', title: 'Upload Teste API', tags: '',
  canais: 'jetix', part_size: PART, file: fpA,
})
let res = await fetch(`${BASE}/admin/uploads`, { method: 'POST', headers: authJson, body: criaBody('upl_teste_api') })
const sess = await res.json()
check('sessão criada antes do primeiro byte (201, 3 partes previstas)',
  res.status === 201 && sess.parts_total === 3 && sess.partes.length === 0, `id=${sess.id}`)

res = await fetch(`${BASE}/admin/uploads`, { method: 'POST', headers: authJson, body: criaBody('upl_teste_api_outro') })
const sess2 = await res.json()
check('mesmo arquivo de novo → retoma a MESMA sessão (dedupe por fingerprint)',
  res.status === 200 && sess2.id === sess.id && sess2.retomada === true)

const putPart = (n, corpo) => fetch(`${BASE}/admin/uploads/${sess.id}/parts/${n}`, { method: 'PUT', headers: auth, body: corpo })
res = await putPart(1, bufA.subarray(0, PART))
check('parte 1 aceita', res.status === 200)
res = await putPart(1, bufA.subarray(0, PART))
const linhas1 = d1(`SELECT COUNT(*) c FROM upload_parts WHERE session_id='${sess.id}'`)[0].c
check('re-PUT da parte 1 é idempotente (1 linha só)', res.status === 200 && linhas1 === 1)

res = await putPart(2, bufA.subarray(PART, PART + 1234))
check('parte com tamanho errado é rejeitada (400)', res.status === 400)

const lista = await fetch(`${BASE}/admin/uploads`, { headers: auth }).then((r) => r.json())
const naLista = lista.find((s) => s.id === sess.id)
check('GET /uploads lista a sessão incompleta com progresso', naLista?.partes?.length === 1 && naLista.partes[0] === 1)

res = await fetch(`${BASE}/admin/uploads/${sess.id}/complete`, { method: 'POST', headers: authJson, body: '{}' })
const inc = await res.json()
check('complete incompleto recusa e diz o que falta', res.status === 409 && inc.faltam?.join(',') === '2,3')

await putPart(2, bufA.subarray(PART, 2 * PART))
await putPart(3, bufA.subarray(2 * PART))
res = await fetch(`${BASE}/admin/uploads/${sess.id}/complete`, { method: 'POST', headers: authJson, body: '{}' })
const done1 = await res.json()
check('complete com tudo → job criado', res.status === 201 && done1.ok === true && done1.ja_concluida === false)

res = await fetch(`${BASE}/admin/uploads/${sess.id}/complete`, { method: 'POST', headers: authJson, body: '{}' })
const done2 = await res.json()
const nJobs = d1(`SELECT COUNT(*) c FROM ingest_jobs WHERE id='upl_teste_api'`)[0].c
check('complete REPETIDO não duplica (idempotente)', res.status === 200 && done2.ja_concluida === true && nJobs === 1)

const job = d1(`SELECT staging_key, canais, title, status FROM ingest_jobs WHERE id='upl_teste_api'`)[0]
check('job na fila com os metadados da sessão', job?.status === 'queued' && job.canais === 'jetix' && job.title === 'Upload Teste API')

const staged = await fetch(`${BASE}/admin/staging/${encodeURIComponent(job.staging_key)}`, { headers: auth })
const stagedBytes = staged.ok ? (await staged.arrayBuffer()).byteLength : -1
check('staging montado com o arquivo inteiro (12 MiB)', stagedBytes === bufA.length)

// limpeza A: done apaga o staging; aí removemos o job de teste
await fetch(`${BASE}/admin/jobs/upl_teste_api/done`, { method: 'POST', headers: authJson, body: '{"ok":true}' })
const stagedGone = (await fetch(`${BASE}/admin/staging/${encodeURIComponent(job.staging_key)}`, { headers: auth })).status === 404
check('staging limpo após "done"', stagedGone)
d1(`DELETE FROM ingest_jobs WHERE id='upl_teste_api'`)
d1(`DELETE FROM upload_sessions WHERE media_id='upl_teste_api'`)

// ── B. abortar limpa tudo ──────────────────────────────────────────────────
console.log('— B: abort —')
const bufB = randomBytes(1 * MB)
res = await fetch(`${BASE}/admin/uploads`, {
  method: 'POST', headers: authJson,
  body: JSON.stringify({
    media_id: 'upl_teste_abort', tipo: 'comercial', title: 'Abort', canais: 'jetix',
    part_size: PART, file: { name: 'upl-abort.bin', rel: '', size: bufB.length, last_modified: 1783800001000 },
  }),
})
const sb = await res.json()
await fetch(`${BASE}/admin/uploads/${sb.id}/parts/1`, { method: 'PUT', headers: auth, body: bufB })
res = await fetch(`${BASE}/admin/uploads/${sb.id}`, { method: 'DELETE', headers: auth })
const listaB = await fetch(`${BASE}/admin/uploads`, { headers: auth }).then((r) => r.json())
const partesB = d1(`SELECT COUNT(*) c FROM upload_parts WHERE session_id='${sb.id}'`)[0].c
check('DELETE aborta a sessão e some da lista', res.status === 200 && !listaB.some((s) => s.id === sb.id) && partesB === 0)
res = await fetch(`${BASE}/admin/uploads/${sb.id}/complete`, { method: 'POST', headers: authJson, body: '{}' })
check('complete depois do abort → 404', res.status === 404)

// ── C. retomada pós-reload no NAVEGADOR ────────────────────────────────────
console.log('— C: retomada no navegador (sessão órfã + reanexo) —')
const srcDir = join(ROOT, '.ingest-work', '_src')
mkdirSync(srcDir, { recursive: true })
const webFile = join(srcDir, 'upl-teste-web.bin')
const bufC = randomBytes(6 * MB) // 2 partes: 5 + 1 MiB
writeFileSync(webFile, bufC)
const MTIME = 1783800300 // mtime inteiro (s) → File.lastModified exato em ms
utimesSync(webFile, MTIME, MTIME)

// sessão órfã: existe no servidor, com a parte 1 já subida "antes do reload"
res = await fetch(`${BASE}/admin/uploads`, {
  method: 'POST', headers: authJson,
  body: JSON.stringify({
    media_id: 'upl_teste_web', tipo: 'comercial', title: 'Upload Teste Web', canais: 'jetix',
    part_size: PART, file: { name: 'upl-teste-web.bin', rel: '', size: bufC.length, last_modified: MTIME * 1000 },
  }),
})
const sc = await res.json()
await fetch(`${BASE}/admin/uploads/${sc.id}/parts/1`, { method: 'PUT', headers: auth, body: bufC.subarray(0, PART) })

const vite = spawn('npx', ['vite', '--port', '5175', '--strictPort'], {
  cwd: join(ROOT, 'apps/web'), stdio: 'ignore', detached: true,
})
vite.unref()
const mataVite = () => { try { process.kill(-vite.pid, 'SIGTERM') } catch { /* já morreu */ } }
process.on('exit', mataVite)
let up = false
for (let i = 0; i < 60 && !up; i++) {
  up = await fetch(`${WEB}/admin.html`).then((r) => r.ok).catch(() => false)
  if (!up) await sleep(500)
}
if (!up) { console.error('✖ vite (5175) não subiu'); process.exit(1) }

const { chromium } = await import('playwright')
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 950 } })
await page.addInitScript(`localStorage.setItem('bieltv_admin_token', '${TOKEN}')`)
await page.goto(`${WEB}/admin.html`, { waitUntil: 'domcontentloaded' })

// textContent, não innerText: o CSS põe os h2 em uppercase e o innerText
// devolve o texto RENDERIZADO ("UPLOADS INTERROMPIDOS")
const veInterrompido = await page
  .waitForFunction(() => (document.body.textContent ?? '').includes('Uploads interrompidos')
    && (document.body.textContent ?? '').includes('upl_teste_web'), { timeout: 15_000 })
  .then(() => true).catch(() => false)
check('painel mostra o upload interrompido (1/2 partes)', veInterrompido)

await page.setInputFiles('input.reanexa-arquivos', webFile)
const retomou = await page
  .waitForFunction(() => {
    const rows = [...document.querySelectorAll('.job-row')]
    return rows.some((r) => r.textContent.includes('upl_teste_web') && r.textContent.includes('na fila'))
  }, { timeout: 60_000 })
  .then(() => true).catch(() => false)
check('reanexar o arquivo retoma e conclui (só a parte que faltava)', retomou)

const jobsC = d1(`SELECT COUNT(*) c FROM ingest_jobs WHERE id='upl_teste_web'`)[0].c
const sessC = d1(`SELECT status FROM upload_sessions WHERE id='${sc.id}'`)[0]
check('retomada criou exatamente 1 job e concluiu a sessão', jobsC === 1 && sessC?.status === 'concluida')

await browser.close()
mataVite()

// limpeza C
const jobC = d1(`SELECT staging_key FROM ingest_jobs WHERE id='upl_teste_web'`)[0]
if (jobC) await fetch(`${BASE}/admin/jobs/upl_teste_web/done`, { method: 'POST', headers: authJson, body: '{"ok":true}' })
d1(`DELETE FROM ingest_jobs WHERE id='upl_teste_web'`)
d1(`DELETE FROM upload_sessions WHERE media_id='upl_teste_web'`)

// ── D. zona de perigo (deleção definitiva) ─────────────────────────────────
console.log('— D: deleção definitiva —')
const segFile = join(srcDir, 'seg-fake.ts')
writeFileSync(segFile, randomBytes(64 * 1024))
for (const id of ['ep_del_teste', 'ep_del_teste2']) {
  d1(`INSERT INTO media_items (id, tipo, status, duracao_seg, segment_count, base_url, path_prefix, metadata)
      VALUES ('${id}', 'comercial', 'ready', 20, 2, '', 'media/${id}', '{"title":"Del ${id}"}')`)
  r2PutLocal(`media/${id}/seg_00000.ts`, segFile)
  r2PutLocal(`media/${id}/seg_00001.ts`, segFile)
}

const delReq = (id, confirmacao) => fetch(`${BASE}/admin/media/${id}`, {
  method: 'DELETE', headers: authJson, body: JSON.stringify({ confirmacao }),
})

res = await delReq('ep_del_teste', 'EXCLUIR ep_del_teste')
check('recusa mídia ainda ativa (ready)', res.status === 409)

await fetch(`${BASE}/admin/media/ep_del_teste/status`, { method: 'POST', headers: authJson, body: '{"status":"disabled"}' })
res = await delReq('ep_del_teste', 'EXCLUIR ep_del_errado')
check('recusa confirmação errada', res.status === 400)

const now = Math.floor(Date.now() / 1000)
d1(`INSERT INTO epg_virtual (canal, media_id, start_time_virtual, end_time_virtual) VALUES ('jetix', 'ep_del_teste', ${now + 600}, ${now + 620})`)
res = await delReq('ep_del_teste', 'EXCLUIR ep_del_teste')
check('recusa mídia com blocos na grade futura', res.status === 409)
d1(`DELETE FROM epg_virtual WHERE media_id='ep_del_teste'`)

d1(`INSERT INTO epg_virtual (canal, media_id, start_time_virtual, end_time_virtual) VALUES ('jetix', 'ep_del_teste', ${now - 60}, ${now - 20})`)
res = await delReq('ep_del_teste', 'EXCLUIR ep_del_teste')
check('recusa mídia que esteve no ar há instantes (janela do player)', res.status === 409)
d1(`DELETE FROM epg_virtual WHERE media_id='ep_del_teste'`)

res = await delReq('ep_del_teste', 'EXCLUIR ep_del_teste')
const delBody = await res.json()
check('deleção correta passa e apaga os segmentos', res.status === 200 && delBody.segmentos_apagados === 2)

// path_prefix já começa com media/ — a rota pública é /<path_prefix>/<seg>
const sumiuD1 = d1(`SELECT COUNT(*) c FROM media_items WHERE id='ep_del_teste'`)[0].c === 0
const sumiuR2 = (await fetch(`${BASE}/media/ep_del_teste/seg_00000.ts`)).status === 404
check('registro e segmentos da mídia sumiram', sumiuD1 && sumiuR2)

const irmaViva = (await fetch(`${BASE}/media/ep_del_teste2/seg_00000.ts`)).status === 200
const irmaD1 = d1(`SELECT COUNT(*) c FROM media_items WHERE id='ep_del_teste2'`)[0].c === 1
check('prefixo parecido (ep_del_teste2) ficou INTACTO', irmaViva && irmaD1)

// a irmã sai pelo mesmo caminho oficial (cobre o fluxo completo de novo)
await fetch(`${BASE}/admin/media/ep_del_teste2/status`, { method: 'POST', headers: authJson, body: '{"status":"disabled"}' })
res = await delReq('ep_del_teste2', 'EXCLUIR ep_del_teste2')
check('limpeza da irmã pelo próprio endpoint', res.status === 200)

cleanAll()
console.log(`\n${fail === 0 ? '🎉' : '💥'} ${pass}/${pass + fail} checagens passaram`)
process.exit(fail === 0 ? 0 : 1)
