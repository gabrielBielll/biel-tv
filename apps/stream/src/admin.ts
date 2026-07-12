import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { runScheduler, scheduleChannel, reconcileAndRepair } from './scheduler'
import { chatDiretor, estadoDiretor, type ChatMsg } from './diretor'
import { uploads } from './uploads'
import { dispatchFabrica } from './fabrica'

// API do painel admin. Tudo aqui exige `Authorization: Bearer <ADMIN_TOKEN>`.
// Upload oficial: sessões multipart retomáveis em ./uploads.ts (/admin/uploads).
// O POST /upload monolítico abaixo fica só como compatibilidade temporária.

type Bindings = {
  DB: D1Database
  MEDIA: R2Bucket
  ADMIN_TOKEN: string
  ALLOW_TIME_TRAVEL: string
  GH_DISPATCH_TOKEN?: string
  GH_REPO?: string
}

export const admin = new Hono<{ Bindings: Bindings }>()

const TIPOS = ['episodio', 'filme', 'comercial', 'vinheta']
const SLUG = /^[a-z0-9_]{2,40}$/

// Em produção o painel (Pages) chama esta API cross-origin — o cors() também
// responde os preflights OPTIONS antes da checagem de token.
admin.use('*', cors())

admin.use('*', async (c, next) => {
  const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
  if (!c.env.ADMIN_TOKEN || token !== c.env.ADMIN_TOKEN) {
    return c.text('não autorizado\n', 401)
  }
  await next()
})

async function channelIds(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare('SELECT id FROM channels').all<{ id: string }>()
  return results.map((r) => r.id)
}

// ── upload / staging ───────────────────────────────────────────────────────

// sessões multipart retomáveis (o cors+token acima cobrem o sub-app)
admin.route('/uploads', uploads)

admin.post('/upload', async (c) => {
  const raw = c.req.query('name') ?? 'upload.bin'
  const name = raw.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-80)
  const buf = await c.req.arrayBuffer()
  if (buf.byteLength === 0) return c.json({ error: 'arquivo vazio' }, 400)
  const key = `staging/${Date.now()}-${crypto.randomUUID().slice(0, 8)}/${name}`
  await c.env.MEDIA.put(key, buf)
  return c.json({ staging_key: key, bytes: buf.byteLength }, 201)
})

admin.get('/staging/*', async (c) => {
  const key = decodeURIComponent(new URL(c.req.url).pathname.replace(/^\/admin\/staging\//, ''))
  const obj = await c.env.MEDIA.get(key)
  if (!obj) return c.text('não encontrado\n', 404)
  return c.body(obj.body as ReadableStream, 200, { 'content-type': 'application/octet-stream' })
})

// ── fila de ingestão ───────────────────────────────────────────────────────

admin.post('/jobs', async (c) => {
  const b = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!b) return c.json({ error: 'JSON inválido' }, 400)
  const id = String(b.id ?? '')
  if (!/^[a-z0-9_]{3,40}$/.test(id)) return c.json({ error: 'id inválido (minúsculas/dígitos/_, 3–40)' }, 400)
  if (!TIPOS.includes(String(b.tipo))) return c.json({ error: 'tipo inválido' }, 400)
  if (!b.title || !b.staging_key) return c.json({ error: 'title e staging_key são obrigatórios' }, 400)

  const canais = String(b.canais ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (canais.length === 0) return c.json({ error: 'escolha pelo menos um canal' }, 400)
  const validos = await channelIds(c.env.DB)
  for (const canal of canais) {
    if (!validos.includes(canal)) return c.json({ error: `canal desconhecido: ${canal}` }, 400)
  }

  const dup = await c.env.DB.prepare(
    'SELECT id FROM media_items WHERE id = ?1 UNION SELECT id FROM ingest_jobs WHERE id = ?1',
  ).bind(id).first()
  if (dup) return c.json({ error: `id "${id}" já existe` }, 409)

  await c.env.DB.prepare(
    `INSERT INTO ingest_jobs (id, staging_key, original_name, tipo, title, series_id, episode, tags, canais)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  ).bind(
    id, String(b.staging_key), String(b.original_name ?? ''), String(b.tipo), String(b.title),
    b.series_id ? String(b.series_id) : null,
    b.episode ? Number(b.episode) : null,
    String(b.tags ?? ''),
    canais.join(','),
  ).run()
  c.executionCtx.waitUntil(dispatchFabrica(c.env))
  return c.json({ ok: true, id }, 201)
})

admin.get('/jobs', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM ingest_jobs ORDER BY created_at DESC LIMIT 50',
  ).all()
  return c.json(results)
})

admin.post('/jobs/claim', async (c) => {
  // Self-heal: um runner do Actions pode morrer no timeout com o job em
  // 'processing' — depois de 2h sem update, o job volta pra fila sozinho.
  await c.env.DB.prepare(
    `UPDATE ingest_jobs SET status = 'queued', error = NULL, progress = 0, updated_at = unixepoch()
     WHERE status = 'processing' AND updated_at < unixepoch() - 7200`,
  ).run()
  const row = await c.env.DB.prepare(
    `UPDATE ingest_jobs SET status = 'processing', progress = 0, updated_at = unixepoch()
     WHERE id = (SELECT id FROM ingest_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1)
     RETURNING *`,
  ).first()
  return row ? c.json(row) : c.body(null, 204)
})

// A fábrica reporta o avanço da transcodificação (0–99) — o painel mostra
// "processando 37%" no chip da fila. 100 é reservado pro done.
admin.post('/jobs/:id/progress', async (c) => {
  const { pct } = await c.req.json<{ pct?: number }>().catch(() => ({ pct: -1 }))
  const n = Math.max(0, Math.min(99, Math.floor(Number(pct ?? -1))))
  if (!Number.isFinite(n)) return c.json({ error: 'pct inválido' }, 400)
  await c.env.DB.prepare(
    `UPDATE ingest_jobs SET progress = ?2, updated_at = unixepoch() WHERE id = ?1 AND status = 'processing'`,
  ).bind(c.req.param('id'), n).run()
  return c.json({ ok: true })
})

admin.post('/jobs/:id/done', async (c) => {
  const { ok, error } = await c.req.json<{ ok: boolean; error?: string }>().catch(() => ({ ok: false, error: 'JSON inválido' }))
  const id = c.req.param('id')
  const job = await c.env.DB.prepare('SELECT staging_key FROM ingest_jobs WHERE id = ?1')
    .bind(id).first<{ staging_key: string }>()
  if (!job) return c.json({ error: 'job não existe' }, 404)
  await c.env.DB.prepare('UPDATE ingest_jobs SET status = ?2, error = ?3, progress = ?4, updated_at = unixepoch() WHERE id = ?1')
    .bind(id, ok ? 'done' : 'error', error ?? null, ok ? 100 : 0).run()
  if (ok) await c.env.MEDIA.delete(job.staging_key)
  return c.json({ ok: true })
})

// ── catálogo ───────────────────────────────────────────────────────────────

admin.get('/media', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.tipo, m.status, m.duracao_seg, m.segment_count, m.metadata, m.created_at,
            (SELECT GROUP_CONCAT(channel_id) FROM media_channels mc WHERE mc.media_id = m.id) AS canais
     FROM media_items m ORDER BY m.created_at DESC LIMIT 200`,
  ).all()
  return c.json(results)
})

// Agrupa (ou desagrupa) retroativamente uma mídia numa série/temporada —
// necessário pro Diretor poder excluir "a temporada inteira" de uma vez
// (media_channels não tem esse conceito; series_id vive dentro do metadata).
admin.post('/media/:id/series', async (c) => {
  const { series_id } = await c.req.json<{ series_id?: string }>().catch(() => ({ series_id: '' }))
  const id = c.req.param('id')
  const row = await c.env.DB.prepare('SELECT metadata FROM media_items WHERE id = ?1').bind(id).first<{ metadata: string }>()
  if (!row) return c.json({ error: 'mídia não encontrada' }, 404)
  let meta: Record<string, unknown> = {}
  try { meta = JSON.parse(row.metadata) } catch { /* metadata inválido — recomeça limpo */ }
  const slug = (series_id ?? '').trim()
  if (slug) {
    if (!SLUG.test(slug)) return c.json({ error: 'series_id inválido (minúsculas/dígitos/_, 2–40)' }, 400)
    meta.series_id = slug
  } else {
    delete meta.series_id
  }
  await c.env.DB.prepare('UPDATE media_items SET metadata = ?2 WHERE id = ?1').bind(id, JSON.stringify(meta)).run()
  return c.json({ ok: true })
})

admin.post('/media/:id/status', async (c) => {
  const { status } = await c.req.json<{ status: string }>().catch(() => ({ status: '' }))
  if (!['ready', 'disabled'].includes(status)) return c.json({ error: 'status inválido' }, 400)
  const id = c.req.param('id')
  await c.env.DB.prepare('UPDATE media_items SET status = ?2 WHERE id = ?1').bind(id, status).run()

  // desativou → sai da grade futura e os canais dela são replanejados
  if (status === 'disabled') {
    const now = Math.floor(Date.now() / 1000)
    await c.env.DB.prepare('DELETE FROM epg_virtual WHERE media_id = ?1 AND start_time_virtual > ?2')
      .bind(id, now).run()
    const { results } = await c.env.DB.prepare(
      'SELECT DISTINCT channel_id ch FROM media_channels WHERE media_id = ?1',
    ).bind(id).all<{ ch: string }>()
    for (const r of results) await scheduleChannel(c.env, r.ch, 48, true)
  }
  return c.json({ ok: true })
})

// Zona de perigo: deleção FÍSICA e irreversível de uma mídia (segmentos no
// R2 + todos os registros). Desativar continua sendo a ação normal; isto
// aqui só passa com TODAS as travas (docs/features/uploads-resumiveis.md):
// mídia já disabled, confirmação digitada exata, e fora da janela do player.
admin.delete('/media/:id', async (c) => {
  const id = c.req.param('id')
  const b = await c.req.json<{ confirmacao?: string }>().catch(() => ({ confirmacao: '' }))

  const m = await c.env.DB.prepare('SELECT status, path_prefix FROM media_items WHERE id = ?1')
    .bind(id).first<{ status: string; path_prefix: string }>()
  if (!m) return c.json({ error: 'mídia não encontrada' }, 404)
  if (m.status !== 'disabled') {
    return c.json({ error: 'só mídia desativada pode ser excluída de vez — desative primeiro' }, 409)
  }
  if ((b.confirmacao ?? '') !== `EXCLUIR ${id}`) {
    return c.json({ error: `confirmação incorreta — digite exatamente "EXCLUIR ${id}"` }, 400)
  }

  // trava temporal: nada que esteja no ar, na janela recente do player
  // (4 slots atrás + buffers) ou ainda na grade futura pode ser apagado.
  const now = Math.floor(Date.now() / 1000)
  const grade = await c.env.DB.prepare(
    `SELECT SUM(CASE WHEN start_time_virtual > ?2 THEN 1 ELSE 0 END) futuras,
            SUM(CASE WHEN start_time_virtual <= ?2 AND end_time_virtual > ?3 THEN 1 ELSE 0 END) recentes
     FROM epg_virtual WHERE media_id = ?1`,
  ).bind(id, now, now - 300).first<{ futuras: number | null; recentes: number | null }>()
  if ((grade?.futuras ?? 0) > 0) {
    return c.json({ error: 'a mídia ainda tem blocos na grade futura — replaneje o canal e tente de novo' }, 409)
  }
  if ((grade?.recentes ?? 0) > 0) {
    return c.json({ error: 'a mídia esteve no ar há instantes (janela do player) — aguarde uns 5 minutos' }, 409)
  }

  // trava de prefixo: só apagamos chaves media/<id>/... — nunca um prefixo
  // vazio/estranho, e a barra final garante que media/ep_x2 não cai junto.
  if (!/^media\/[a-z0-9_]{3,40}$/.test(m.path_prefix)) {
    return c.json({ error: `path_prefix inesperado ("${m.path_prefix}") — deleção recusada por segurança` }, 500)
  }
  const prefixo = `${m.path_prefix}/`

  // canais afetados (antes de apagar os vínculos) e staging de job antigo
  const { results: canais } = await c.env.DB.prepare(
    'SELECT DISTINCT channel_id ch FROM media_channels WHERE media_id = ?1',
  ).bind(id).all<{ ch: string }>()
  const job = await c.env.DB.prepare('SELECT staging_key FROM ingest_jobs WHERE id = ?1')
    .bind(id).first<{ staging_key: string }>()
  const { results: sessoes } = await c.env.DB.prepare(
    'SELECT id, staging_key, r2_upload_id, status FROM upload_sessions WHERE media_id = ?1',
  ).bind(id).all<{ id: string; staging_key: string; r2_upload_id: string; status: string }>()

  // R2 primeiro (idempotente): repetir a limpeza depois de falha parcial é
  // seguro — a mídia continua disabled e os registros só somem no fim.
  let segmentosApagados = 0
  let cursor: string | undefined
  do {
    const lote = await c.env.MEDIA.list({ prefix: prefixo, cursor })
    if (lote.objects.length > 0) {
      await c.env.MEDIA.delete(lote.objects.map((o) => o.key))
      segmentosApagados += lote.objects.length
    }
    cursor = lote.truncated ? lote.cursor : undefined
  } while (cursor)
  if (job?.staging_key) await c.env.MEDIA.delete(job.staging_key)
  for (const s of sessoes) {
    if (s.status === 'ativa') {
      try { await c.env.MEDIA.resumeMultipartUpload(s.staging_key, s.r2_upload_id).abort() } catch { /* já não existia */ }
    }
    await c.env.MEDIA.delete(s.staging_key)
  }

  // D1 numa transação só; media_items por ÚLTIMO — falha parcial deixa a
  // mídia visível (disabled) e a operação pode ser repetida inteira.
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM media_cue_points WHERE media_id = ?1').bind(id),
    c.env.DB.prepare('DELETE FROM media_channels WHERE media_id = ?1').bind(id),
    c.env.DB.prepare('DELETE FROM epg_virtual WHERE media_id = ?1').bind(id),
    c.env.DB.prepare('DELETE FROM channel_events WHERE media_id = ?1').bind(id),
    c.env.DB.prepare(`UPDATE directives SET status = 'cancelada' WHERE status = 'ativa' AND payload LIKE ?1`).bind(`%"${id}"%`),
    c.env.DB.prepare('DELETE FROM ingest_jobs WHERE id = ?1').bind(id),
    c.env.DB.prepare('DELETE FROM upload_parts WHERE session_id IN (SELECT id FROM upload_sessions WHERE media_id = ?1)').bind(id),
    c.env.DB.prepare('DELETE FROM upload_sessions WHERE media_id = ?1').bind(id),
    c.env.DB.prepare('DELETE FROM media_items WHERE id = ?1').bind(id),
  ])

  // o pool desses canais mudou — replaneja (append-only, bloco no ar intacto)
  for (const r of canais) await scheduleChannel(c.env, r.ch, 48, true)

  return c.json({ ok: true, segmentos_apagados: segmentosApagados, canais_replanejados: canais.map((r) => r.ch) })
})

admin.post('/media/:id/channels', async (c) => {
  const { channels } = await c.req.json<{ channels: string[] }>().catch(() => ({ channels: null as unknown as string[] }))
  if (!Array.isArray(channels)) return c.json({ error: 'channels deve ser uma lista' }, 400)
  const validos = await channelIds(c.env.DB)
  for (const canal of channels) {
    if (!validos.includes(canal)) return c.json({ error: `canal desconhecido: ${canal}` }, 400)
  }
  const id = c.req.param('id')
  await c.env.DB.prepare('DELETE FROM media_channels WHERE media_id = ?1').bind(id).run()
  for (const canal of channels) {
    await c.env.DB.prepare('INSERT OR IGNORE INTO media_channels (media_id, channel_id) VALUES (?1, ?2)')
      .bind(id, canal).run()
  }
  return c.json({ ok: true })
})

// ── canais ─────────────────────────────────────────────────────────────────

admin.get('/channels', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM channels ORDER BY ordem, id').all()
  return c.json(results)
})

admin.post('/channels/:id', async (c) => {
  const b = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!b) return c.json({ error: 'JSON inválido' }, 400)
  const id = c.req.param('id')
  if (!SLUG.test(id)) return c.json({ error: 'id inválido' }, 400)
  const campos: Array<[string, unknown]> = []
  if (typeof b.nome === 'string') campos.push(['nome', b.nome])
  if (typeof b.cor === 'string') campos.push(['cor', b.cor])
  if (typeof b.identidade === 'string') campos.push(['identidade', b.identidade])
  if (typeof b.break_target_seg === 'number') campos.push(['break_target_seg', b.break_target_seg])
  if (campos.length === 0) return c.json({ error: 'nada pra atualizar' }, 400)
  const sets = campos.map(([k], i) => `${k} = ?${i + 2}`).join(', ')
  await c.env.DB.prepare(`UPDATE channels SET ${sets} WHERE id = ?1`)
    .bind(id, ...campos.map(([, v]) => v)).run()
  return c.json({ ok: true })
})

// ── agendador / reconciliação ──────────────────────────────────────────────

admin.post('/schedule/run', async (c) => {
  const b = await c.req.json<{ canal?: string; hours?: number; rebuild?: boolean }>().catch(() => ({} as { canal?: string; hours?: number; rebuild?: boolean }))
  const reports = await runScheduler(c.env, {
    canal: b.canal,
    hours: b.hours,
    rebuild: b.rebuild,
  })
  return c.json(reports)
})

admin.post('/reconcile', async (c) => {
  return c.json(await reconcileAndRepair(c.env))
})

// ── Diretor IA (chat do Modo God) ──────────────────────────────────────────

admin.post('/diretor/chat', async (c) => {
  const b = await c.req.json<{ canal?: string; mensagens?: ChatMsg[] }>().catch(() => null)
  if (!b?.canal || !SLUG.test(b.canal)) return c.json({ error: 'canal obrigatório' }, 400)
  const existe = await c.env.DB.prepare('SELECT id FROM channels WHERE id = ?1').bind(b.canal).first()
  if (!existe) return c.json({ error: 'canal desconhecido' }, 400)
  const msgs = (b.mensagens ?? [])
    .filter((m) => m && (m.role === 'user' || m.role === 'diretor') && typeof m.text === 'string')
    .map((m) => ({ role: m.role, text: m.text.slice(0, 2000) }))
  if (msgs.length === 0 || msgs.at(-1)!.role !== 'user') {
    return c.json({ error: 'a última mensagem precisa ser sua' }, 400)
  }
  return c.json(await chatDiretor(c.env, b.canal, msgs))
})

admin.get('/diretor/estado', async (c) => {
  const canal = c.req.query('canal') ?? ''
  if (!SLUG.test(canal)) return c.json({ error: 'canal obrigatório' }, 400)
  return c.json(await estadoDiretor(c.env, canal))
})

admin.post('/diretor/diretriz/:id/cancelar', async (c) => {
  const id = Number(c.req.param('id'))
  const d = await c.env.DB.prepare("UPDATE directives SET status='cancelada' WHERE id = ?1 AND status='ativa' RETURNING canal")
    .bind(id).first<{ canal: string }>()
  if (!d) return c.json({ error: 'diretriz não encontrada' }, 404)
  await scheduleChannel(c.env, d.canal, 48, true)
  return c.json({ ok: true })
})

admin.post('/diretor/evento/:id/cancelar', async (c) => {
  const id = Number(c.req.param('id'))
  const e = await c.env.DB.prepare("UPDATE channel_events SET status='cancelado' WHERE id = ?1 AND status='agendado' RETURNING canal")
    .bind(id).first<{ canal: string }>()
  if (!e) return c.json({ error: 'evento não encontrado' }, 404)
  await scheduleChannel(c.env, e.canal, 48, true)
  return c.json({ ok: true })
})

// ── config (inclui a flag do Modo God) ─────────────────────────────────────

const CONFIG_KEYS = ['god_mode', 'last_reconcile']

admin.get('/config', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT k, v FROM config').all<{ k: string; v: string }>()
  return c.json(Object.fromEntries(results.map((r) => [r.k, r.v])))
})

admin.post('/config', async (c) => {
  const { k, v } = await c.req.json<{ k: string; v: string }>().catch(() => ({ k: '', v: '' }))
  if (!CONFIG_KEYS.includes(k)) return c.json({ error: 'chave desconhecida' }, 400)
  await c.env.DB.prepare('INSERT OR REPLACE INTO config (k, v) VALUES (?1, ?2)').bind(k, String(v)).run()
  return c.json({ ok: true })
})
