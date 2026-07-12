import { Hono } from 'hono'

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

admin.use('*', async (c, next) => {
  const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
  if (!c.env.ADMIN_TOKEN || token !== c.env.ADMIN_TOKEN) {
    return c.text('não autorizado\n', 401)
  }
  await next()
})

admin.post('/upload', async (c) => {
  const raw = c.req.query('name') ?? 'upload.bin'
  const name = raw.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-80)
  const buf = await c.req.arrayBuffer()
  if (buf.byteLength === 0) return c.json({ error: 'arquivo vazio' }, 400)
  const key = `staging/${Date.now()}-${crypto.randomUUID().slice(0, 8)}/${name}`
  await c.env.MEDIA.put(key, buf)
  return c.json({ staging_key: key, bytes: buf.byteLength }, 201)
})

// download do staging pela fábrica
admin.get('/staging/*', async (c) => {
  const key = decodeURIComponent(new URL(c.req.url).pathname.replace(/^\/admin\/staging\//, ''))
  const obj = await c.env.MEDIA.get(key)
  if (!obj) return c.text('não encontrado\n', 404)
  return c.body(obj.body as ReadableStream, 200, { 'content-type': 'application/octet-stream' })
})

admin.post('/jobs', async (c) => {
  const b = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!b) return c.json({ error: 'JSON inválido' }, 400)
  const id = String(b.id ?? '')
  if (!/^[a-z0-9_]{3,40}$/.test(id)) return c.json({ error: 'id inválido (minúsculas/dígitos/_, 3–40)' }, 400)
  if (!TIPOS.includes(String(b.tipo))) return c.json({ error: 'tipo inválido' }, 400)
  if (!b.title || !b.staging_key) return c.json({ error: 'title e staging_key são obrigatórios' }, 400)

  const dup = await c.env.DB.prepare(
    'SELECT id FROM media_items WHERE id = ?1 UNION SELECT id FROM ingest_jobs WHERE id = ?1',
  ).bind(id).first()
  if (dup) return c.json({ error: `id "${id}" já existe` }, 409)

  await c.env.DB.prepare(
    `INSERT INTO ingest_jobs (id, staging_key, original_name, tipo, title, series_id, episode, tags)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  ).bind(
    id, String(b.staging_key), String(b.original_name ?? ''), String(b.tipo), String(b.title),
    b.series_id ? String(b.series_id) : null,
    b.episode ? Number(b.episode) : null,
    String(b.tags ?? ''),
  ).run()
  return c.json({ ok: true, id }, 201)
})

admin.get('/jobs', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM ingest_jobs ORDER BY created_at DESC LIMIT 50',
  ).all()
  return c.json(results)
})

// a fábrica pega o job mais antigo da fila (e o marca como processing)
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
  if (ok) await c.env.MEDIA.delete(job.staging_key) // staging é temporário
  return c.json({ ok: true })
})

admin.get('/media', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, tipo, status, duracao_seg, segment_count, metadata, created_at FROM media_items ORDER BY created_at DESC LIMIT 200',
  ).all()
  return c.json(results)
})

admin.post('/media/:id/status', async (c) => {
  const { status } = await c.req.json<{ status: string }>().catch(() => ({ status: '' }))
  if (!['ready', 'disabled'].includes(status)) return c.json({ error: 'status inválido' }, 400)
  await c.env.DB.prepare('UPDATE media_items SET status = ?2 WHERE id = ?1')
    .bind(c.req.param('id'), status).run()
  return c.json({ ok: true })
})
