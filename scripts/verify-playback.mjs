// Verificação end-to-end do PLAYBACK / catch-up contra o wrangler dev local.
// Valida as duas peças novas: (1) /epg honra past/future (histórico da grade);
// (2) /vod/:mediaId serve um playlist VOD FINITO (#EXT-X-ENDLIST) — o que liga a
// barra de progresso e o seek no player. Também confere que o /live segue AO VIVO.
//
// Uso: pnpm --filter @bieltv/stream dev  (noutro terminal), depois pnpm verify:playback
// Contra produção: BASE=https://biel-tv-stream.<...>.workers.dev pnpm verify:playback
import { Buffer } from 'node:buffer'

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787'
const TOKEN = process.env.ADMIN_TOKEN ?? 'bieltv-dev-2026'
let CANAL = process.env.CANAL ?? ''

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`✅ ${name}${extra ? `  (${extra})` : ''}`) }
  else { fail++; console.log(`❌ ${name}${extra ? `  (${extra})` : ''}`) }
}

const json = (u) => fetch(u).then((r) => r.json()).catch(() => null)

function parseM3u8(text) {
  const lines = text.trim().split('\n')
  return {
    isVod: lines.includes('#EXT-X-PLAYLIST-TYPE:VOD'),
    hasEndlist: lines.at(-1) === '#EXT-X-ENDLIST',
    mediaSeq: lines.find((l) => l.startsWith('#EXT-X-MEDIA-SEQUENCE:'))?.split(':')[1] ?? '',
    extinf: lines.filter((l) => l.startsWith('#EXTINF:')).length,
    segs: lines.filter((l) => l && !l.startsWith('#')),
  }
}

// 1) health
const health = await json(`${BASE}/health`)
check('GET /health', health?.status === 'ok')

// canal alvo (primeiro com conteúdo) + garante que a grade está populada
if (!CANAL) {
  const chs = await json(`${BASE}/channels`)
  CANAL = (Array.isArray(chs) ? chs.find((c) => c.has_content)?.id : null) ?? 'jetix'
}
await fetch(`${BASE}/admin/schedule/run`, {
  method: 'POST',
  headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  body: '{}',
}).catch(() => {})

// 2) EPG base (sem params) — comportamento antigo intacto + pega um programa
const epg = await json(`${BASE}/epg/${CANAL}`)
check('GET /epg — grade populada', (epg?.items?.length ?? 0) > 0, `${epg?.items?.length ?? 0} itens`)
const now = epg?.now ?? Math.floor(Date.now() / 1000)
const prog = epg?.items?.find((i) => i.tipo === 'episodio' || i.tipo === 'filme')
check('GET /epg — há um programa (ep/filme) para tocar', Boolean(prog), prog?.media_id ?? '—')

// 3) /epg honra `future` (janela maior nunca traz menos itens)
const epgFut = await json(`${BASE}/epg/${CANAL}?future=172800`)
check('GET /epg?future — janela ampliada é superset',
  (epgFut?.items?.length ?? 0) >= (epg?.items?.length ?? 0),
  `${epg?.items?.length ?? 0} → ${epgFut?.items?.length ?? 0}`)

// 4) histórico via viagem no tempo: em at=now+6h, a 1ª parte da grade já foi "exibida"
const AT = now + 6 * 3600
const hist = await json(`${BASE}/epg/${CANAL}?at=${AT}&past=604800&future=3600`)
if (hist && hist.now === AT) {
  const jaExibidos = (hist.items ?? []).filter((i) => i.end <= AT)
  check('GET /epg?past — histórico traz programas já exibidos (end ≤ now)',
    jaExibidos.length > 0, `${jaExibidos.length} itens`)
  const semPast = await json(`${BASE}/epg/${CANAL}?at=${AT}`)
  check('GET /epg sem past — NÃO traz já-exibidos (retrocompatível)',
    (semPast?.items ?? []).every((i) => i.end > AT))
} else {
  console.log('⚠️  ALLOW_TIME_TRAVEL≠1 — pulei o teste determinístico de histórico')
}

// 5) /vod do programa: playlist VOD seekable
const vodRes = await fetch(`${BASE}/vod/${encodeURIComponent(prog?.media_id ?? 'x')}`)
const vodTxt = await vodRes.text()
const v = parseM3u8(vodTxt)
check('GET /vod — 200 + content-type HLS',
  vodRes.status === 200 && (vodRes.headers.get('content-type') ?? '').includes('mpegurl'))
check('GET /vod — é VOD (#EXT-X-PLAYLIST-TYPE:VOD)', v.isVod)
check('GET /vod — fecha com #EXT-X-ENDLIST (habilita barra/seek)', v.hasEndlist)
check('GET /vod — começa em MEDIA-SEQUENCE:0 (do início)', v.mediaSeq === '0')
check('GET /vod — 1 #EXTINF por segmento', v.extinf === v.segs.length && v.segs.length > 0, `${v.segs.length} segs`)
check('GET /vod — 1º segmento é seg00000.ts', Boolean(v.segs[0]?.includes('seg00000.ts')), v.segs[0] ?? '—')

// 6) segmentos referenciados baixam (amostra: primeiro e último)
const amostra = [...new Set([v.segs[0], v.segs.at(-1)].filter(Boolean))]
for (const uri of amostra) {
  const r = await fetch(new URL(uri, BASE))
  const buf = r.ok ? Buffer.from(await r.arrayBuffer()) : null
  check(`segmento ${uri.split('/').pop()} baixável (200, >10KB)`,
    Boolean(buf) && buf.byteLength > 10_000, `${buf?.byteLength ?? 0}B`)
}

// 7) VOD é determinístico/estático (mesma mídia → mesma resposta)
const vod2 = await fetch(`${BASE}/vod/${encodeURIComponent(prog?.media_id ?? 'x')}`).then((r) => r.text())
check('GET /vod — determinístico (imutável por mídia)', vod2 === vodTxt)

// 8) mídia inexistente → 404 (não vira URL de arquivo fantasma)
const nf = await fetch(`${BASE}/vod/nao_existe_zzz_${Date.now()}`)
check('GET /vod — mídia inexistente → 404', nf.status === 404)

// 9) regressão: o /live continua AO VIVO (sem ENDLIST → sem seek)
const liveRes = await fetch(`${BASE}/live/${CANAL}`)
const liveTxt = await liveRes.text()
check('GET /live — segue ao vivo (sem #EXT-X-ENDLIST)',
  liveRes.status === 200 && !liveTxt.includes('#EXT-X-ENDLIST'))

console.log(`\n${fail === 0 ? '🎉' : '💥'} ${pass}/${pass + fail} checagens passaram`)
process.exit(fail === 0 ? 0 : 1)
