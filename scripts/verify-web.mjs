// Verificação e2e da fase 3 (frontend Vue): builda, sobe o vite dev (proxy →
// worker), abre num Chromium headless de verdade e confere que a TV liga:
// player tocando (currentTime avançando sem travar), AGORA/A SEGUIR, grade.
// Pré-requisito: wrangler dev rodando (pnpm dev) com EPG semeado.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WEB = 'http://127.0.0.1:5173'
const WORKER = process.env.BASE ?? 'http://127.0.0.1:8787'

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`✅ ${name}${extra ? `  (${extra})` : ''}`) }
  else { fail++; console.log(`❌ ${name}${extra ? `  (${extra})` : ''}`) }
}

// ── 1. build de produção compila? ──────────────────────────────────────────
const b = spawnSync('pnpm', ['--filter', '@bieltv/web', 'build'], { cwd: ROOT, encoding: 'utf8' })
check('vite build (produção)', b.status === 0 && existsSync(join(ROOT, 'apps/web/dist/index.html')))
if (b.status !== 0) {
  console.error(b.stdout?.slice(-2000), b.stderr?.slice(-2000))
  process.exit(1)
}

// ── 2. worker no ar? ───────────────────────────────────────────────────────
const health = await fetch(`${WORKER}/health`).then((r) => r.json()).catch(() => null)
if (health?.status !== 'ok') {
  console.error('✖ wrangler dev fora do ar — rode `pnpm dev` antes de `pnpm verify:web`')
  process.exit(1)
}

// ── 3. sobe o vite dev (proxy pro worker) ──────────────────────────────────
const vite = spawn('npx', ['vite', '--port', '5173', '--strictPort'], {
  cwd: join(ROOT, 'apps/web'),
  stdio: 'ignore',
  detached: true,
})
vite.unref()
const kill = () => { try { process.kill(-vite.pid, 'SIGTERM') } catch { /* já morreu */ } }
process.on('exit', kill)

let up = false
for (let i = 0; i < 60 && !up; i++) {
  up = await fetch(WEB).then((r) => r.ok).catch(() => false)
  if (!up) await new Promise((r) => setTimeout(r, 500))
}
check('vite dev server no ar (5173, proxy → 8787)', up)
if (!up) process.exit(1)

// ── 4. Chromium headless assiste TV ────────────────────────────────────────
const { chromium } = await import('playwright')
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 920 } })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))

await page.goto(WEB, { waitUntil: 'domcontentloaded' })

const brand = await page.waitForSelector('.brand', { timeout: 10_000 }).catch(() => null)
check('app monta (marca BIEL TV visível)', Boolean(brand))

const hasGuide = await page
  .waitForFunction(() => document.querySelectorAll('.guide-item').length >= 3, { timeout: 15_000 })
  .then(() => true).catch(() => false)
const guideCount = await page.evaluate(() => document.querySelectorAll('.guide-item').length)
check('grade de programação renderizada', hasGuide, `${guideCount} programas listados`)

// o painel de contexto tem dois estados legítimos: programa no ar (AGORA)
// ou intervalo comercial (INTERVALO — a seguir: …)
const nowTitle = await page
  .waitForSelector('.now-panel .now-title', { timeout: 15_000 })
  .then((el) => el.textContent())
  .catch(() => null)
check('painel de contexto (AGORA ou INTERVALO) com título', Boolean(nowTitle?.trim()), nowTitle?.trim() ?? '')

const hasNextInfo = await page.evaluate(
  () => Boolean(document.querySelector('.next-line') || document.querySelector('.tag-break')),
)
check('próximo programa informado (A SEGUIR)', hasNextInfo)

// o player de fato toca?
const playing = await page
  .waitForFunction(() => {
    const v = document.querySelector('video')
    return v && v.readyState >= 3 && !v.paused && v.currentTime > 0.5
  }, { timeout: 30_000 })
  .then(() => true).catch(() => false)
check('hls.js iniciou reprodução (autoplay mudo)', playing)

if (playing) {
  const dims = await page.evaluate(() => {
    const v = document.querySelector('video')
    return { w: v.videoWidth, h: v.videoHeight }
  })
  check('decodificando no perfil do canal (1280x720)', dims.w === 1280 && dims.h === 720, `${dims.w}x${dims.h}`)

  // 30s de reprodução contínua, amostrando a cada 5s — pega travadas em
  // trocas de segmento/descontinuidades (a grade tem troca a cada 60–80s)
  const samples = [await page.evaluate(() => document.querySelector('video').currentTime)]
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(5_000)
    samples.push(await page.evaluate(() => document.querySelector('video').currentTime))
  }
  const deltas = samples.slice(1).map((t, i) => t - samples[i])
  const smooth = deltas.every((d) => d > 3.5)
  check('30s de reprodução sem travar', smooth, `avanços: ${deltas.map((d) => d.toFixed(1)).join(', ')}s`)

  const vErr = await page.evaluate(() => document.querySelector('video').error?.message ?? null)
  check('sem erro no elemento de vídeo', vErr === null, vErr ?? '')
}

check('sem exceções JS na página', pageErrors.length === 0, pageErrors[0] ?? '')

mkdirSync(join(ROOT, '.ingest-work'), { recursive: true })
const shot = join(ROOT, '.ingest-work', 'web-screenshot.png')
await page.screenshot({ path: shot })
console.log(`📸 screenshot: ${shot}`)

await browser.close()
kill()

console.log(`\n${fail === 0 ? '🎉' : '💥'} ${pass}/${pass + fail} checagens passaram`)
process.exit(fail === 0 ? 0 : 1)
