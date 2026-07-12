// Verificação end-to-end da fase 1 contra o wrangler dev local.
// Não precisa de tela: valida o m3u8 como um player validaria — janela
// deslizante, MEDIA-SEQUENCE, descontinuidades, segmentos baixáveis.
import { execFileSync } from 'node:child_process'
import { writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787'
const TOKEN = process.env.ADMIN_TOKEN ?? 'bieltv-dev-2026'
let CANAL = process.env.CANAL ?? ''

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`✅ ${name}${extra ? `  (${extra})` : ''}`) }
  else { fail++; console.log(`❌ ${name}${extra ? `  (${extra})` : ''}`) }
}

function parse(m3u8) {
  const lines = m3u8.trim().split('\n')
  const num = (tag) => {
    const l = lines.find((x) => x.startsWith(tag + ':'))
    return l ? Number(l.slice(tag.length + 1)) : NaN
  }
  return {
    mediaSeq: num('#EXT-X-MEDIA-SEQUENCE'),
    discSeq: num('#EXT-X-DISCONTINUITY-SEQUENCE'),
    pdt: lines.find((x) => x.startsWith('#EXT-X-PROGRAM-DATE-TIME:'))?.slice(26) ?? '',
    discCount: lines.filter((x) => x === '#EXT-X-DISCONTINUITY').length,
    segs: lines.filter((x) => x && !x.startsWith('#')),
  }
}

const live = async (q = '') => {
  const r = await fetch(`${BASE}/live/${CANAL}${q}`)
  return { status: r.status, ctype: r.headers.get('content-type') ?? '', text: await r.text() }
}

// 1) health
const health = await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null)
check('GET /health', health?.status === 'ok')

// canal alvo (primeiro com conteúdo) + garante cobertura da grade
if (!CANAL) {
  const chs = await fetch(`${BASE}/channels`).then((r) => r.json()).catch(() => [])
  CANAL = chs.find((c) => c.has_content)?.id ?? 'jetix'
}
await fetch(`${BASE}/admin/schedule/run`, {
  method: 'POST',
  headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  body: '{}',
}).catch(() => {})

// 2) EPG
const epg = await fetch(`${BASE}/epg/${CANAL}`).then((r) => r.json()).catch(() => null)
check('GET /epg — grade populada', (epg?.items?.length ?? 0) > 0, `${epg?.items?.length ?? 0} itens`)
check('GET /epg — exatamente 1 item "no ar"', epg?.items?.filter((i) => i.is_now).length === 1)

// 3) playlist agora
const p1 = await live()
const a = parse(p1.text)
check('GET /live — 200 + content-type HLS', p1.status === 200 && p1.ctype.includes('mpegurl'))
check('GET /live — janela com 6 segmentos', a.segs.length === 6, `${a.segs.length} segs, seq=${a.mediaSeq}`)

// 4) todos os segmentos referenciados existem e têm conteúdo
let okSegs = 0
let firstSeg = null
for (const uri of a.segs) {
  const r = await fetch(new URL(uri, BASE))
  const buf = r.ok ? Buffer.from(await r.arrayBuffer()) : null
  if (buf && buf.byteLength > 10_000) {
    okSegs++
    if (!firstSeg) firstSeg = buf
  }
}
check('segmentos .ts baixáveis (200, >10KB)', okSegs === a.segs.length, `${okSegs}/${a.segs.length}`)

// 5) o .ts é um MPEG-TS válido de ~10s (se houver ffprobe)
const ffprobe = [process.env.FFPROBE, 'ffprobe', join(process.env.HOME ?? '', '.local/bin/ffprobe')]
  .filter(Boolean)
  .find((p) => { try { execFileSync(p, ['-version'], { stdio: 'ignore' }); return true } catch { return false } })
if (ffprobe && firstSeg) {
  const tmp = join(tmpdir(), 'bieltv-seg-check.ts')
  writeFileSync(tmp, firstSeg)
  const dur = Number(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', tmp]).toString().trim())
  check('segmento decodifica com duração ~10s', dur > 9.5 && dur < 10.6, `${dur.toFixed(3)}s`)
} else {
  console.log('⚠️  ffprobe indisponível — pulei a validação de decodificação')
}

// 6) determinismo com viagem no tempo (?at=) em volta de um comercial
const com = epg?.items?.find((i) => i.tipo === 'comercial' && i.start > (epg?.now ?? 0) + 60)
if (com) {
  const C = com.start
  const before = parse((await live(`?at=${C - 20}`)).text)
  const boundary = parse((await live(`?at=${C + 5}`)).text)
  const after = parse((await live(`?at=${C + 60}`)).text)
  check('troca de programa gera EXT-X-DISCONTINUITY', boundary.discCount >= 1)
  check('comercial aparece na janela na hora certa', boundary.segs.some((s) => s.includes(com.media_id)))
  check('MEDIA-SEQUENCE avança 1 por slot de 10s', boundary.mediaSeq - before.mediaSeq === 2,
    `${before.mediaSeq} → ${boundary.mediaSeq}`)
  check('DISCONTINUITY-SEQUENCE incrementa quando o bloco sai da janela', after.discSeq > before.discSeq,
    `${before.discSeq} → ${after.discSeq}`)
  const w1 = parse((await live(`?at=${C}`)).text)
  const w2 = parse((await live(`?at=${C + 10}`)).text)
  check('janela desliza 1 segmento a cada 10s (overlap de 5)',
    w2.mediaSeq === w1.mediaSeq + 1 && JSON.stringify(w2.segs.slice(0, 5)) === JSON.stringify(w1.segs.slice(1)))
} else {
  check('há comercial futuro no EPG para testar descontinuidade', false)
}

// 7) ao vivo de verdade: espera 11s e confere que a janela andou
console.log('… aguardando 11s para medir o deslize ao vivo')
await new Promise((r) => setTimeout(r, 11_000))
const p2 = parse((await live()).text)
const delta = p2.mediaSeq - a.mediaSeq
check('janela ao vivo avançou após 11s', delta === 1 || delta === 2, `Δseq=${delta}`)

console.log(`\n${fail === 0 ? '🎉' : '💥'} ${pass}/${pass + fail} checagens passaram`)
process.exit(fail === 0 ? 0 : 1)
