// Verificação e2e da ingestão por LINK (fase 11d): job nasce de uma URL,
// a fábrica baixa com yt-dlp (aqui: um mp4 servido pelo próprio Worker
// local — testa o caminho inteiro sem depender do YouTube) e o pipeline
// segue normal até a mídia ficar pronta.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchRetry as fetch } from './_lib.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787'
const TOKEN = process.env.ADMIN_TOKEN ?? 'bieltv-dev-2026'
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const ID = 'com_dl_teste'

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

function bin(name) {
  for (const c of [process.env[name.toUpperCase()], name, join(homedir(), '.local/bin', name)].filter(Boolean)) {
    try { execFileSync(c, ['-version'], { stdio: 'ignore' }); return c } catch { /* próximo */ }
  }
  throw new Error(`${name} não encontrado`)
}

const post = (path, body) => fetch(`${BASE}${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body ?? {}) })

const health = await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null)
if (health?.status !== 'ok') {
  console.error('✖ wrangler dev fora do ar — rode `pnpm dev` antes')
  process.exit(1)
}

// limpeza + fixture: um mp4 real de 15s servido pelo Worker em /media/*
function cleanup() {
  d1(`DELETE FROM ingest_jobs WHERE id='${ID}'`)
  d1(`DELETE FROM media_promises WHERE media_id='${ID}'`)
  d1(`DELETE FROM epg_virtual WHERE media_id='${ID}'`)
  d1(`DELETE FROM media_channels WHERE media_id='${ID}'`)
  d1(`DELETE FROM media_cue_points WHERE media_id='${ID}'`)
  d1(`DELETE FROM media_items WHERE id='${ID}'`)
}
cleanup()
const srcDir = join(ROOT, '.ingest-work', '_src')
mkdirSync(srcDir, { recursive: true })
const fx = join(srcDir, 'dl-teste.mp4')
execFileSync(bin('ffmpeg'), ['-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=500',
  '-t', '15', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', fx])
spawnSync('npx', ['wrangler', 'r2', 'object', 'put', 'biel-tv-media/media/_testdl/video.mp4', '--file', fx, '--local'],
  { cwd: join(ROOT, 'apps', 'stream'), stdio: 'ignore' })

// ── 1. validações do endpoint ──────────────────────────────────────────────
let r = await post('/admin/jobs', { id: ID, tipo: 'comercial', title: 'DL Teste', canais: 'jetix', source_url: 'ftp://nao' })
check('link não-http é recusado', r.status === 400)
r = await post('/admin/jobs', { id: ID, tipo: 'comercial', title: 'DL Teste', canais: 'jetix' })
check('sem staging E sem link é recusado', r.status === 400)

r = await post('/admin/jobs', {
  id: ID, tipo: 'comercial', title: 'DL Teste', canais: 'jetix',
  source_url: `${BASE}/media/_testdl/video.mp4`,
})
check('job de link aceito', r.status === 201)

// ── 2. a fábrica baixa e processa (drain local) ────────────────────────────
const fac = spawnSync('node', [join(ROOT, 'scripts/factory-local.mjs')], {
  encoding: 'utf8', timeout: 240_000,
  env: { ...process.env, FACTORY_DRAIN: '1', ADMIN_TOKEN: TOKEN, BASE },
})
const saida = (fac.stdout ?? '') + (fac.stderr ?? '')
check('fábrica baixou pelo link e concluiu o job', /concluído e no ar/.test(saida) && saida.includes(ID),
  saida.split('\n').filter((l) => l.includes('✖')).at(-1) ?? 'ok')

const job = d1(`SELECT status, error FROM ingest_jobs WHERE id='${ID}'`)[0]
check('job done sem erro', job?.status === 'done', job?.error ?? '')
const m = d1(`SELECT status, segment_count, duracao_seg FROM media_items WHERE id='${ID}'`)[0]
check('mídia pronta no catálogo (15s → 2 segmentos de 10s)', m?.status === 'ready' && m.segment_count === 2)

// ── limpeza ────────────────────────────────────────────────────────────────
await post(`/admin/media/${ID}/status`, { status: 'disabled' })
cleanup()
spawnSync('npx', ['wrangler', 'r2', 'object', 'delete', 'biel-tv-media/media/_testdl/video.mp4', '--local'],
  { cwd: join(ROOT, 'apps', 'stream'), stdio: 'ignore' })
await post('/admin/schedule/run', { canal: 'jetix', rebuild: true })
check('estado de teste limpo', d1(`SELECT COUNT(*) c FROM media_items WHERE id='${ID}'`)[0].c === 0)

console.log(`\n${fail === 0 ? '🎉' : '💥'} ${pass}/${pass + fail} checagens passaram`)
process.exit(fail === 0 ? 0 : 1)
