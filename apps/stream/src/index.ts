import { Hono } from 'hono'
import type { Context } from 'hono'
import { SEGMENT_DURATION, SQL_EPG_OVERLAP, type EpgRowWithMedia } from '@bieltv/db'
import { buildLivePlaylist } from './playlist'
import { admin } from './admin'
import { reconcileAndRepair, runScheduler } from './scheduler'

type Bindings = {
  DB: D1Database
  MEDIA: R2Bucket
  ADMIN_TOKEN: string
  ALLOW_TIME_TRAVEL: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.route('/admin', admin)

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

function nowFrom(c: Context<{ Bindings: Bindings }>): number {
  const at = c.req.query('at')
  if (at && c.env.ALLOW_TIME_TRAVEL === '1') {
    const n = Number(at)
    if (Number.isFinite(n) && n > 0) return Math.floor(n)
  }
  return Math.floor(Date.now() / 1000)
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

  const { results } = await c.env.DB.prepare(SQL_EPG_OVERLAP)
    .bind(canal, now, now + 24 * 3600)
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
      const rec = await reconcileAndRepair(env)
      const reports = await runScheduler(env, { hours: 48 })
      console.log('[diretor]', JSON.stringify({ rec, reports }))
    })())
  },
}
