import { Hono } from 'hono'
import type { Context } from 'hono'
import { SEGMENT_DURATION, SQL_EPG_AGORA, SQL_EPG_OVERLAP, type EpgRowWithMedia } from '@bieltv/db'
import { buildLivePlaylist, buildVodPlaylist } from './playlist'
import { montaGuia } from './guia'
import { revisao } from './revisao'
import { admin } from './admin'
import { votaton } from './votaton'
import { reconcileAndRepair, runScheduler } from './scheduler'
import { dispatchSeTemFila } from './fabrica'
import { planejaEditorial } from './editorial'
import { reconciliaComerciaisGrade } from './fabrica-comerciais'

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

  // `SQL_EPG_AGORA` (duas buscas diretas) em vez do intervalo: o /live é a rota
  // mais repetida do sistema — ~6 linhas lidas por chamada em vez de ~200.
  const { results } = await c.env.DB.prepare(SQL_EPG_AGORA)
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

  // Nome bonito por série (clipe 'nome' da fábrica). Best-effort: sem a
  // tabela ou sem clipe, o slug capitalizado cobre — o guia nunca quebra.
  const nomeSerie = new Map<string, string>()
  try {
    const { results: nomes } = await c.env.DB.prepare(
      "SELECT series_id, MIN(rotulo) rotulo FROM voice_clips WHERE categoria = 'nome' AND series_id IS NOT NULL GROUP BY series_id",
    ).all<{ series_id: string; rotulo: string }>()
    for (const n of nomes) nomeSerie.set(n.series_id, n.rotulo.replace(/[.!?]+$/, '').trim())
  } catch { /* sem clipes: só o fallback de slug */ }

  const items = montaGuia(results, now, nomeSerie)

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
      // Heartbeat: marca que o cron FIROU (antes de qualquer coisa pesada). Se
      // este timestamp não avançar, o problema é o trigger não disparar; se
      // avançar mas last_reconcile ficar velho, é o reconcile morrendo no limite.
      const cronNow = Math.floor(Date.now() / 1000)
      try {
        await env.DB.prepare("INSERT OR REPLACE INTO config (k, v) VALUES ('last_cron_start', ?1)")
          .bind(String(cronNow)).run()
      } catch { /* diagnóstico best-effort */ }

      // ORDEM CRÍTICA (bug ago/2026: last_reconcile travou em 29/07 e TODAS as
      // grades drenaram → 404): ESTENDER AS GRADES vem PRIMEIRO — é o que mantém
      // os canais no ar. O reconcile (1 R2 HEAD por mídia) e o editorial (LLM)
      // são pesados e vinham estourando o limite do cron ANTES de agendar; um
      // kill por limite NÃO é pego por try/catch. Agora rodam DEPOIS, best-effort.
      const reports = await runScheduler(env, { hours: 48 })

      // 10a: diretor editorial (maratonas). Best-effort; aplica no próximo ciclo.
      let plano: unknown = null
      try { plano = await planejaEditorial(env) } catch (e) { plano = String(e) }

      // fábrica de comerciais de GRADE: âncora sem comercial → job na fila;
      // âncora que saiu → comercial desatualizado recolhido. Best-effort.
      let comerciais: unknown = null
      try { comerciais = await reconciliaComerciaisGrade(env) } catch (e) { comerciais = String(e) }

      // Reconcile catálogo↔R2 por ÚLTIMO: se morrer no limite, as grades já
      // foram estendidas e os canais continuam no ar. Desde 18/09/2026 ele é
      // FATIADO (um lote por run, cursor no `last_reconcile`): varrer o acervo
      // inteiro pedia ~2.700 HEADs no R2 e o teto é de 1.000 SUBREQUISIÇÕES por
      // invocação (medido 18/09: 960 HEADs passam, 1.200 estouram com
      // "Too many API requests by single Worker invocation"). D1 e R2 não
      // aparecem no `subrequests` da analítica, mas gastam do mesmo teto.
      let rec: unknown = null
      try { rec = await reconcileAndRepair(env) } catch (e) { rec = String(e) }

      // rede de segurança da fábrica: dispatch perdido ou run morta no
      // timeout → o cron re-acorda o GitHub Actions enquanto houver fila.
      // EM TRY/CATCH de propósito (18/09/2026): era a única etapa solta, e
      // quando o teto de subrequisições já estava queimado ela levantava a
      // exceção que matava a invocação — `scriptThrewException` todo dia, sem
      // o relatório abaixo sair. Agora o cron sempre CONTA o que deu errado.
      let dispatch: unknown = 'ok'
      try { await dispatchSeTemFila(env) } catch (e) { dispatch = String(e) }
      console.log('[diretor]', JSON.stringify({ rec, plano, comerciais, dispatch, reports }))
    })())
  },
}
