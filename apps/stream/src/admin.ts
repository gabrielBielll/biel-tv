import { Hono } from 'hono'
import { runScheduler, scheduleChannel, reconcileAndRepair } from './scheduler'

// API do painel admin. Tudo aqui exige `Authorization: Bearer <ADMIN_TOKEN>`.
// O upload do MVP bufferiza o corpo no Worker — suficiente pro dev local;
// em produção o caminho certo é multipart direto no R2 via URL pré-assinada.

type Bindings = {
  DB: D1Database
  MEDIA: R2Bucket
  ADMIN_TOKEN: string
  ALLOW_TIME_TRAVEL: string
}

export const admin = new Hono<{ Bindings: Bindings }>()

const TIPOS = ['episodio', 'filme', 'comercial', 'vinheta']
const SLUG = /^[a-z0-9_]{2,40}$/

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
  return c.json({ ok: true, id }, 201)
})

admin.get('/jobs', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM ingest_jobs ORDER BY created_at DESC LIMIT 50',
  ).all()
  return c.json(results)
})

admin.post('/jobs/claim', async (c) => {
  const row = await c.env.DB.prepare(
    `UPDATE ingest_jobs SET status = 'processing', updated_at = unixepoch()
     WHERE id = (SELECT id FROM ingest_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1)
     RETURNING *`,
  ).first()
  return row ? c.json(row) : c.body(null, 204)
})

admin.post('/jobs/:id/done', async (c) => {
  const { ok, error } = await c.req.json<{ ok: boolean; error?: string }>().catch(() => ({ ok: false, error: 'JSON inválido' }))
  const id = c.req.param('id')
  const job = await c.env.DB.prepare('SELECT staging_key FROM ingest_jobs WHERE id = ?1')
    .bind(id).first<{ staging_key: string }>()
  if (!job) return c.json({ error: 'job não existe' }, 404)
  await c.env.DB.prepare('UPDATE ingest_jobs SET status = ?2, error = ?3, updated_at = unixepoch() WHERE id = ?1')
    .bind(id, ok ? 'done' : 'error', error ?? null).run()
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
  const b = await c.req.json<{ canal?: string; hours?: number; rebuild?: boolean }>().catch(() => ({}))
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
