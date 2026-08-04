import { Hono } from 'hono'
import type { Context } from 'hono'
import { SEGMENT_DURATION, SQL_EPG_OVERLAP, type EpgRowWithMedia } from '@bieltv/db'
import { buildLivePlaylist, buildVodPlaylist } from './playlist'
import { revisao } from './revisao'
import { admin } from './admin'
import { votaton } from './votaton'
import { reconcileAndRepair, runScheduler } from './scheduler'
import { dispatchSeTemFila } from './fabrica'
import { planejaEditorial } from './editorial'

type Bindings = {
  DB: D1Database
  MEDIA: R2Bucket
  ADMIN_TOKEN: string
  ALLOW_TIME_TRAVEL: string
  ELEVENLABS_API_KEY?: string
  GH_DISPATCH_TOKEN?: string
  GH_REPO?: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.route('/admin', admin)
// bancada de revisão das peças recortadas (ideia do Gabriel, 2026-07-15):
// pública e read-only — o /media/* que ela consome já é aberto. As AÇÕES
// (tirar do ar) batem em /admin/media/:id/status, que exige o token.
app.route('/revisao', revisao)
// /r é o mesmo sub-app: o Gabriel digita a URL na mão no celular/TV e o
// domínio workers.dev já é longo demais — cada caractere do path conta.
// (o m3u8 usa caminho ABSOLUTO /media/*, então funciona igual pelos dois)
app.route('/r', revisao)
// Votaton (fase 10c): público de propósito — é a experiência do telespectador
app.route('/votaton', votaton)

// Lista pública de canais (pro front montar o seletor)
app.get('/channels', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT ch.id, ch.nome, ch.cor, EXISTS(
       SELECT 1 FROM media_channels mc JOIN media_items m ON m.id = mc.media_id
       WHERE mc.channel_id = ch.id AND m.status = 'ready' AND m.tipo IN ('episodio','filme')
     ) AS has_content
     FROM channels ch ORDER BY ch.ordem, ch.id`,
  ).all<{ id: string; nome: string; cor: string; has_content: number }>()
  return c.json(results.map((r) => ({ ...r, has_content: Boolean(r.has_content) })), 200, CORS)
})

const CORS = { 'access-control-allow-origin': '*' } as const
const WINDOW_BEHIND = 4 // slots passados na janela…
const WINDOW_AHEAD = 1 // …+ 1 futuro (já pré-cortado): encurta o delay percebido

const DAY = 86400
// Teto do histórico no /epg: espelha EPG_RETENTION do scheduler (a grade passada
// só existe até esse limite — pedir mais que isso só devolveria janela vazia).
const EPG_HISTORY_MAX = 7 * DAY
// Teto do futuro: o agendador estende a grade ~48h à frente.
const EPG_FUTURE_MAX = 2 * DAY

function nowFrom(c: Context<{ Bindings: Bindings }>): number {
  const at = c.req.query('at')
  if (at && c.env.ALLOW_TIME_TRAVEL === '1') {
    const n = Number(at)
    if (Number.isFinite(n) && n > 0) return Math.floor(n)
  }
  return Math.floor(Date.now() / 1000)
}

// Lê um param de janela (segundos) do query, com default e teto. Valor inválido
// ou negativo cai no default — mantém o /epg sem params 100% retrocompatível.
function clampWindow(raw: string | undefined, def: number, max: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return def
  return Math.min(Math.floor(n), max)
}

app.get('/health', (c) =>
  c.json({ status: 'ok', timestamp: Math.floor(Date.now() / 1000) }, 200, CORS),
)

app.get('/live/:canal', async (c) => {
  const canal = c.req.param('canal')
  const now = nowFrom(c)
  const nowSlot = Math.floor(now / SEGMENT_DURATION)
  const windowStart = (nowSlot - WINDOW_BEHIND) * SEGMENT_DURATION
  const windowEnd = (nowSlot + WINDOW_AHEAD + 1) * SEGMENT_DURATION

  const { results } = await c.env.DB.prepare(SQL_EPG_OVERLAP)
    .bind(canal, windowStart, windowEnd)
    .all<EpgRowWithMedia>()

  const m3u8 = buildLivePlaylist(results, now, WINDOW_BEHIND, WINDOW_AHEAD)
  if (!m3u8) return c.text(`canal "${canal}" fora do ar (EPG vazio neste horário)\n`, 404, CORS)

  return c.body(m3u8, 200, {
    ...CORS,
    'content-type': 'application/vnd.apple.mpegurl',
    'cache-control': 'public, max-age=2',
  })
})

app.get('/epg/:canal', async (c) => {
  const canal = c.req.param('canal')
  const now = nowFrom(c)

  // Janela do guia: `past`/`future` (segundos) permitem incluir o histórico
  // (catch-up). Sem params → now..now+24h (comportamento antigo intacto).
  const past = clampWindow(c.req.query('past'), 0, EPG_HISTORY_MAX)
  const future = clampWindow(c.req.query('future'), 24 * 3600, EPG_FUTURE_MAX)

  const { results } = await c.env.DB.prepare(SQL_EPG_OVERLAP)
    .bind(canal, now - past, now + future)
    .all<EpgRowWithMedia>()

  const items = results.map((r) => {
    let title = r.media_id
    try {
      title = (JSON.parse(r.metadata).title as string) ?? r.media_id
    } catch {
      // metadata inválido não derruba o EPG
    }
    return {
      media_id: r.media_id,
      tipo: r.tipo,
      title,
      start: r.start_time_virtual,
      end: r.end_time_virtual,
      // permite ao front juntar partes de um mesmo programa (continuação > 0)
      segment_index_start: r.segment_index_start,
      is_now: r.start_time_virtual <= now && now < r.end_time_virtual,
    }
  })

  return c.json({ canal, now, items }, 200, CORS)
})

// Playback / catch-up: playlist VOD (finita, com barra de progresso) de uma
// mídia inteira, começando do zero. O front usa isto quando o espectador clica
// num programa do histórico. Independe da grade — só precisa da mídia existir.
app.get('/vod/:mediaId', async (c) => {
  const mediaId = c.req.param('mediaId')

  const media = await c.env.DB.prepare(
    `SELECT base_url, path_prefix, segment_count, status
     FROM media_items WHERE id = ?1`,
  )
    .bind(mediaId)
    .first<{ base_url: string; path_prefix: string; segment_count: number; status: string }>()

  // 'ingesting' ainda não tem todos os segmentos no bucket → não é reprodutível.
  if (!media || media.status === 'ingesting') {
    return c.text(`mídia "${mediaId}" indisponível para playback\n`, 404, CORS)
  }

  const m3u8 = buildVodPlaylist(media)
  if (!m3u8) return c.text(`mídia "${mediaId}" sem segmentos\n`, 404, CORS)

  return c.body(m3u8, 200, {
    ...CORS,
    'content-type': 'application/vnd.apple.mpegurl',
    // Estático por mídia; cache curto p/ refletir um eventual re-polimento noturno.
    'cache-control': 'public, max-age=300',
  })
})

// Serve segmentos pelo binding R2 — caminho do dev local e fallback.
// Em produção o caminho principal é o domínio público do bucket
// (não consome invocações do Worker e aproveita o cache da CDN).
app.get('/media/*', async (c) => {
  const key = new URL(c.req.url).pathname.slice(1) // 'media/ep_x/seg00000.ts'
  const obj = await c.env.MEDIA.get(key)
  if (!obj) return c.text('segmento não encontrado\n', 404, CORS)
  return c.body(obj.body as ReadableStream, 200, {
    ...CORS,
    'content-type': 'video/mp2t',
    'cache-control': 'public, max-age=31536000, immutable',
  })
})

export default {
  fetch: app.fetch,
  // Cron diário: reconcilia catálogo↔storage e estende a grade de cada canal
  // pra 48h. A camada editorial (Gemini) entra por cima disso na fase 10.
  async scheduled(_event: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      // Blindagem: falha no reconcile (ex.: R2 fora) não pode impedir o
      // agendamento das grades — senão um erro aqui deixa os canais sem extensão
      // e a grade acaba zerando (404 "fora do ar").
      let rec: unknown = null
      try { rec = await reconcileAndRepair(env) } catch (e) { rec = String(e) }
      // 10a: o diretor editorial decide a noite ANTES do agendador estender
      // a grade — falha do LLM nunca derruba o cron (rotação segura tudo)
      let plano: unknown = null
      try { plano = await planejaEditorial(env) } catch (e) { plano = String(e) }
      const reports = await runScheduler(env, { hours: 48 })
      // rede de segurança da fábrica: dispatch perdido ou run morta no
      // timeout → o cron re-acorda o GitHub Actions enquanto houver fila
      await dispatchSeTemFila(env)
      console.log('[diretor]', JSON.stringify({ rec, plano, reports }))
    })())
  },
}
