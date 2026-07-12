// Verificação e2e da fase 9: canais nostálgicos + agendador no Worker.
// Testa pureza de canal (mídia só toca no canal dela), pods de intervalo,
// idempotência/append-only e o ciclo completo de reconciliação com o R2
// (apaga um segmento de verdade e confere que o sistema se cura).
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchRetry as fetch } from './_lib.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787'
const TOKEN = process.env.ADMIN_TOKEN ?? 'bieltv-dev-2026'
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }

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

const post = (path, body = {}) =>
  fetch(`${BASE}${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body) })

const health = await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null)
if (health?.status !== 'ok') {
  console.error('✖ wrangler dev fora do ar — rode `pnpm dev` antes')
  process.exit(1)
}

// ── 1. canais expostos ─────────────────────────────────────────────────────
const canais = await fetch(`${BASE}/channels`).then((r) => r.json())
check('GET /channels lista os 3 canais', canais.length >= 3, canais.map((c) => c.id).join(', '))
const disney = canais.find((c) => c.id === 'disney_channel')
check('Disney Channel sem conteúdo = "em breve"', disney && !disney.has_content)

// ── 2. agendador: replaneja tudo ───────────────────────────────────────────
const reports = await (await post('/admin/schedule/run', { rebuild: true })).json()
const rj = reports.find((r) => r.canal === 'jetix')
const rc = reports.find((r) => r.canal === 'cartoon_network')
const rd = reports.find((r) => r.canal === 'disney_channel')
check('grade do Jetix montada (48h)', rj?.added > 0, `+${rj?.added} blocos`)
check('grade da Cartoon montada (48h)', rc?.added > 0, `+${rc?.added} blocos`)
check('Disney pulado (sem conteúdo)', rd?.skipped === 'sem conteúdo')

// ── 3. pureza de canal ─────────────────────────────────────────────────────
const now = Math.floor(Date.now() / 1000)
const violacoes = d1(`
  SELECT COUNT(*) c FROM epg_virtual e
  WHERE e.canal IN ('jetix','cartoon_network') AND e.start_time_virtual > ${now}
    AND NOT EXISTS (SELECT 1 FROM media_channels mc
                    WHERE mc.media_id = e.media_id AND mc.channel_id = e.canal)`)[0].c
check('pureza: nenhuma mídia fora do seu canal na grade', violacoes === 0, `${violacoes} violações`)

// ── 4. pods de intervalo ───────────────────────────────────────────────────
function pods(canal) {
  const rows = d1(`
    SELECT e.media_id m, e.end_time_virtual - e.start_time_virtual d, mi.tipo t
    FROM epg_virtual e JOIN media_items mi ON mi.id = e.media_id
    WHERE e.canal='${canal}' AND e.start_time_virtual > ${now}
    ORDER BY e.start_time_virtual LIMIT 300`)
  const out = []
  let cur = null
  for (const r of rows) {
    if (r.t === 'comercial') {
      cur ??= { total: 0, ads: [] }
      cur.total += r.d
      cur.ads.push(r.m)
    } else if (cur) { out.push(cur); cur = null }
  }
  return out
}
const podsJ = pods('jetix')
const podsC = pods('cartoon_network')
// invariante forte: NENHUM intervalo repete o mesmo comercial (em nenhum canal)
let semDup = true
let ondeDup = ''
for (const [canal, ps] of [['jetix', podsJ], ['cartoon_network', podsC]]) {
  for (const p of ps) {
    if (new Set(p.ads).size !== p.ads.length) { semDup = false; ondeDup = `${canal}: [${p.ads.join(', ')}]`; break }
  }
}
check('nenhum intervalo repete o mesmo comercial (bug do Power Rangers 2x)', semDup, ondeDup || 'limpo')
check('Jetix (1 comercial): intervalos de 1 só, sem back-to-back',
  podsJ.length > 3 && podsJ.every((p) => p.ads.length === 1), `${podsJ.length} pods`)
check('Cartoon (2 comerciais): intervalos usam os 2 sem repetir',
  podsC.length > 3 && podsC.some((p) => p.ads.length === 2), `${podsC.length} pods`)

// ── 5. idempotência (rodar de novo não duplica) ────────────────────────────
const again = await (await post('/admin/schedule/run')).json()
check('rodar o agendador de novo adiciona 0 blocos (idempotente)',
  again.every((r) => r.added === 0 || r.skipped), again.map((r) => `${r.canal}:+${r.added}`).join(' '))

// ── 6. canais no ar, sem buraco ────────────────────────────────────────────
for (const canal of ['jetix', 'cartoon_network']) {
  const epg = await fetch(`${BASE}/epg/${canal}`).then((r) => r.json())
  check(`${canal}: exatamente 1 programa no ar`, epg.items.filter((i) => i.is_now).length === 1)
}
const liveOk = (await fetch(`${BASE}/live/jetix`)).status === 200
const liveOff = (await fetch(`${BASE}/live/disney_channel`)).status === 404
check('/live/jetix no ar e /live/disney_channel fora do ar', liveOk && liveOff)

const semPlay = d1(`
  SELECT COUNT(*) c FROM media_items m JOIN media_channels mc ON mc.media_id = m.id
  WHERE m.status='ready' AND m.tipo IN ('episodio','filme') AND m.last_played_at IS NULL`)[0].c
check('rotação registra last_played_at nos conteúdos', semPlay === 0)

// ── 7. reconciliação: apaga um segmento do R2 e o sistema se cura ─────────
const alvo = 'ep_gentileza'
const segKey = `media/${alvo}/seg00000.ts`
const backup = Buffer.from(await (await fetch(`${BASE}/media/${segKey}`)).arrayBuffer())
mkdirSync(join(ROOT, '.ingest-work'), { recursive: true })
const bkPath = join(ROOT, '.ingest-work', '_seg_backup.ts')
writeFileSync(bkPath, backup)

spawnSync('npx', ['wrangler', 'r2', 'object', 'delete', `biel-tv-media/${segKey}`, '--local'], {
  cwd: join(ROOT, 'apps', 'stream'), stdio: 'ignore',
})
const rec = await (await post('/admin/reconcile')).json()
check('reconciliação detecta o segmento sumido e desativa a mídia',
  rec.disabled.includes(alvo), `disabled: ${rec.disabled.join(',') || '—'}`)
check('canal afetado foi replanejado', rec.repaired.includes('cartoon_network'))
const orfaos = d1(`SELECT COUNT(*) c FROM epg_virtual WHERE media_id='${alvo}' AND start_time_virtual > ${now}`)[0].c
check('grade futura sem a mídia morta', orfaos === 0)

// restaura o segmento e reativa
spawnSync('npx', ['wrangler', 'r2', 'object', 'put', `biel-tv-media/${segKey}`, '--file', bkPath, '--local'], {
  cwd: join(ROOT, 'apps', 'stream'), stdio: 'ignore',
})
await post(`/admin/media/${alvo}/status`, { status: 'ready' })
await post('/admin/schedule/run', { canal: 'cartoon_network', rebuild: true })
let voltou = false
for (let i = 0; i < 5 && !voltou; i++) {
  const epg = await fetch(`${BASE}/epg/cartoon_network`).then((r) => r.json())
  voltou = epg.items.some((it) => it.media_id === alvo)
  if (!voltou) await new Promise((r) => setTimeout(r, 2000))
}
check('mídia restaurada volta pra grade', voltou)

console.log(`\n${fail === 0 ? '🎉' : '💥'} ${pass}/${pass + fail} checagens passaram`)
process.exit(fail === 0 ? 0 : 1)
