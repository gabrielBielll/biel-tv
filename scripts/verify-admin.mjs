// Verificação e2e da tela de admin: sobe fábrica + vite próprios, abre o
// /admin.html num Chromium headless, faz upload de um vídeo de verdade pelo
// NAVEGADOR, confere as sugestões automáticas, acompanha a fila até
// "concluído" e confirma que a mídia entrou no catálogo e na grade.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKER = process.env.BASE ?? 'http://127.0.0.1:8787'
const WEB = 'http://127.0.0.1:5174'
const TOKEN = process.env.ADMIN_TOKEN ?? 'bieltv-dev-2026'
const MEDIA_ID = 'com_refrigerante_retro'

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`✅ ${name}${extra ? `  (${extra})` : ''}`) }
  else { fail++; console.log(`❌ ${name}${extra ? `  (${extra})` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function bin(name) {
  for (const c of [process.env[name.toUpperCase()], name, join(homedir(), '.local/bin', name)].filter(Boolean)) {
    try { execFileSync(c, ['-version'], { stdio: 'ignore' }); return c } catch { /* next */ }
  }
  throw new Error(`${name} não encontrado`)
}

// ── pré-requisitos ─────────────────────────────────────────────────────────
const health = await fetch(`${WORKER}/health`).then((r) => r.json()).catch(() => null)
if (health?.status !== 'ok') {
  console.error('✖ wrangler dev fora do ar — rode `pnpm dev` antes')
  process.exit(1)
}
const unauth = await fetch(`${WORKER}/admin/jobs`)
check('API /admin exige token (401 sem Bearer)', unauth.status === 401)

// limpeza idempotente: remove o job/mídia/grade do teste anterior e re-gera
// a grade pra não deixar buraco nem poluir o canal do usuário
const auth = { authorization: `Bearer ${TOKEN}` }
const { spawnSync } = await import('node:child_process')
function cleanTestMedia() {
  spawnSync('npx', ['wrangler', 'd1', 'execute', 'biel-tv-db', '--local', '--command',
    `DELETE FROM ingest_jobs WHERE id='${MEDIA_ID}'; DELETE FROM media_cue_points WHERE media_id='${MEDIA_ID}'; DELETE FROM epg_virtual WHERE media_id='${MEDIA_ID}'; DELETE FROM media_items WHERE id='${MEDIA_ID}';`],
    { cwd: join(ROOT, 'apps', 'stream'), stdio: 'ignore' })
  spawnSync('node', [join(ROOT, 'scripts/seed-epg.mjs')], { stdio: 'ignore' })
}
cleanTestMedia()

// ── vídeo de teste: 25s, "cara" de comercial pelo nome ─────────────────────
const srcDir = join(ROOT, '.ingest-work', '_src')
mkdirSync(srcDir, { recursive: true })
const testFile = join(srcDir, 'Comercial-Refrigerante-Retro.mp4')
execFileSync(bin('ffmpeg'), [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25',
  '-f', 'lavfi', '-i', 'sine=frequency=700:sample_rate=44100',
  '-t', '25', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
  testFile,
])

// ── fábrica e vite próprios ────────────────────────────────────────────────
const factory = spawn('node', [join(ROOT, 'scripts/factory-local.mjs')], {
  env: { ...process.env, ADMIN_TOKEN: TOKEN }, stdio: 'ignore', detached: true,
})
factory.unref()
const vite = spawn('npx', ['vite', '--port', '5174', '--strictPort'], {
  cwd: join(ROOT, 'apps/web'), stdio: 'ignore', detached: true,
})
vite.unref()
const cleanup = () => {
  for (const p of [vite, factory]) { try { process.kill(-p.pid, 'SIGTERM') } catch { /* ok */ } }
}
process.on('exit', cleanup)

let up = false
for (let i = 0; i < 60 && !up; i++) {
  up = await fetch(`${WEB}/admin.html`).then((r) => r.ok).catch(() => false)
  if (!up) await sleep(500)
}
if (!up) { console.error('✖ vite (5174) não subiu'); process.exit(1) }

// ── navegador ──────────────────────────────────────────────────────────────
const { chromium } = await import('playwright')
const browser = await chromium.launch({ headless: true })

// sem token → tela de entrada
const gatePage = await browser.newPage()
await gatePage.goto(`${WEB}/admin.html`, { waitUntil: 'domcontentloaded' })
const gateVisible = await gatePage
  .waitForSelector('input[type=password]', { timeout: 10_000 }).then(() => true).catch(() => false)
check('tela pede token quando não autenticado', gateVisible)
await gatePage.close()

// com token → painel
const page = await browser.newPage({ viewport: { width: 1280, height: 950 } })
await page.addInitScript(`localStorage.setItem('bieltv_admin_token', '${TOKEN}')`)
await page.goto(`${WEB}/admin.html`, { waitUntil: 'domcontentloaded' })
const fileInput = await page.waitForSelector('input[type=file]', { timeout: 10_000 }).catch(() => null)
check('painel abre autenticado (upload disponível)', Boolean(fileInput))

// escolhe o arquivo e confere as sugestões automáticas
await page.setInputFiles('input[type=file]', testFile)
const suggested = await page
  .waitForFunction(() => {
    const sel = document.querySelector('.form select')
    return sel ? sel.value : null
  }, { timeout: 15_000 })
  .then(() => page.evaluate(() => ({
    tipo: document.querySelector('.form select').value,
    inputs: [...document.querySelectorAll('.form input')].map((i) => i.value),
  })))
  .catch(() => null)
check('sugestão automática: tipo "comercial" pela duração/nome', suggested?.tipo === 'comercial')
check('sugestão automática: título e id pré-preenchidos',
  Boolean(suggested?.inputs?.[0]) && (suggested?.inputs?.[1] ?? '').startsWith('com_'),
  `título="${suggested?.inputs?.[0]}" id="${suggested?.inputs?.[1]}"`)

// id determinístico pro teste + envia
await page.evaluate((id) => {
  const el = document.querySelectorAll('.form input')[1]
  el.value = id
  el.dispatchEvent(new Event('input'))
}, MEDIA_ID)
await page.click('.form button.primary')

const queued = await page
  .waitForFunction(() => document.body.innerText.includes('entrou na fila'), { timeout: 60_000 })
  .then(() => true).catch(() => false)
check('upload pelo navegador + job criado', queued)

// fábrica processa até "concluído" (aparece na própria UI, que faz polling)
const done = await page
  .waitForFunction(
    (id) => {
      const rows = [...document.querySelectorAll('.job-row')]
      return rows.some((r) => r.textContent.includes(id) && r.textContent.includes('concluído'))
    },
    MEDIA_ID,
    { timeout: 180_000 },
  )
  .then(() => true).catch(() => false)
check('fábrica processou o job até "concluído"', done)

// ── conferências de estado final ───────────────────────────────────────────
const mediaList = await fetch(`${WORKER}/admin/media`, { headers: auth }).then((r) => r.json())
const item = mediaList.find((m) => m.id === MEDIA_ID)
check('mídia no catálogo com status ready', item?.status === 'ready' && item?.segment_count === 3,
  item ? `${item.duracao_seg}s, ${item.segment_count} segs` : 'não encontrada')

const jobsList = await fetch(`${WORKER}/admin/jobs`, { headers: auth }).then((r) => r.json())
const job = jobsList.find((j) => j.id === MEDIA_ID)
const stagingGone = job
  ? (await fetch(`${WORKER}/admin/staging/${encodeURIComponent(job.staging_key)}`, { headers: auth })).status === 404
  : false
check('staging limpo após o processamento', stagingGone)

let inEpg = false
for (let i = 0; i < 12 && !inEpg; i++) {
  const epg = await fetch(`${WORKER}/epg/bieltv_1`).then((r) => r.json())
  inEpg = epg.items.some((it) => it.media_id === MEDIA_ID)
  if (!inEpg) await sleep(5000)
}
check('grade re-gerada já escala o novo comercial', inEpg)

const epgNow = await fetch(`${WORKER}/epg/bieltv_1`).then((r) => r.json())
check('canal continua no ar sem buraco (1 item is_now)', epgNow.items.filter((i) => i.is_now).length === 1)

await browser.close()
cleanup()
// devolve o canal do usuário ao estado sem a mídia de teste
cleanTestMedia()

console.log(`\n${fail === 0 ? '🎉' : '💥'} ${pass}/${pass + fail} checagens passaram`)
process.exit(fail === 0 ? 0 : 1)
