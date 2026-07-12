import { Hono } from 'hono'
import { dispatchFabrica } from './fabrica'

// Uploads persistentes e retomáveis (docs/features/uploads-resumiveis.md).
//
// A regra de ouro: a sessão existe no D1 ANTES do primeiro byte trafegar.
// O arquivo sobe em partes fixas pro R2 (multipart), cada parte confirmada
// fica registrada em upload_parts, e o `complete` é idempotente — repetir
// nunca cria dois jobs. Depois de um reload o painel lista as sessões ativas
// (GET) e retoma só as partes ausentes; o navegador não consegue restaurar
// um <input type="file">, então o operador reanexa o arquivo e a UI casa o
// fingerprint (caminho relativo, nome, tamanho, lastModified).
//
// Montado sob /admin/uploads — o cors() e a checagem de token do admin.ts
// (use('*') do app pai) cobrem estas rotas também.

type Bindings = {
  DB: D1Database
  MEDIA: R2Bucket
  ADMIN_TOKEN: string
  ALLOW_TIME_TRAVEL: string
  GH_DISPATCH_TOKEN?: string
  GH_REPO?: string
}

export const uploads = new Hono<{ Bindings: Bindings }>()

const TIPOS = ['episodio', 'filme', 'comercial', 'vinheta']
const ID_RE = /^[a-z0-9_]{3,40}$/

// Partes fixas: mínimo do R2 é 5 MiB (exceto a última); teto de 32 MiB pra
// nunca chegar perto do limite de request/memória do Worker. Todas as partes
// menos a última DEVEM ter exatamente part_size (o R2 exige tamanho uniforme
// — o PUT valida byte a byte, então um cliente bugado falha cedo e claro).
const PART_MIN = 5 * 1024 * 1024
const PART_MAX = 32 * 1024 * 1024
const PART_DEFAULT = 10 * 1024 * 1024
const MAX_PARTS = 10_000

interface SessionRow {
  id: string
  media_id: string
  staging_key: string
  r2_upload_id: string
  file_name: string
  file_rel: string
  file_size: number
  file_mtime: number
  part_size: number
  parts_total: number
  tipo: string
  title: string
  series_id: string | null
  episode: number | null
  tags: string
  canais: string
  status: string
}

async function partesConfirmadas(db: D1Database, sid: string): Promise<Array<{ part_number: number; etag: string; size: number }>> {
  const { results } = await db.prepare(
    'SELECT part_number, etag, size FROM upload_parts WHERE session_id = ?1 ORDER BY part_number',
  ).bind(sid).all<{ part_number: number; etag: string; size: number }>()
  return results
}

function sessaoPublica(s: SessionRow, partes: number[]) {
  return {
    id: s.id,
    media_id: s.media_id,
    staging_key: s.staging_key,
    file_name: s.file_name,
    file_rel: s.file_rel,
    file_size: s.file_size,
    file_mtime: s.file_mtime,
    part_size: s.part_size,
    parts_total: s.parts_total,
    tipo: s.tipo,
    title: s.title,
    series_id: s.series_id,
    episode: s.episode,
    tags: s.tags,
    canais: s.canais,
    partes,
  }
}

// ── criar (ou retomar) uma sessão ──────────────────────────────────────────
uploads.post('/', async (c) => {
  const b = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!b) return c.json({ error: 'JSON inválido' }, 400)

  const file = (b.file ?? {}) as Record<string, unknown>
  const fname = String(file.name ?? '').slice(0, 200)
  const frel = String(file.rel ?? '').slice(0, 400)
  const fsize = Number(file.size ?? 0)
  const fmtime = Number(file.last_modified ?? 0)
  if (!fname || !Number.isFinite(fsize) || fsize <= 0) {
    return c.json({ error: 'file.name e file.size são obrigatórios' }, 400)
  }

  // mesmo arquivo físico já tem sessão ativa? → retoma (dedupe por fingerprint)
  const existente = await c.env.DB.prepare(
    `SELECT * FROM upload_sessions
     WHERE status = 'ativa' AND file_name = ?1 AND file_rel = ?2 AND file_size = ?3 AND file_mtime = ?4`,
  ).bind(fname, frel, fsize, fmtime).first<SessionRow>()
  if (existente) {
    const partes = await partesConfirmadas(c.env.DB, existente.id)
    return c.json({ ...sessaoPublica(existente, partes.map((p) => p.part_number)), retomada: true }, 200)
  }

  // sessão nova: validações iguais às do POST /jobs
  const id = String(b.media_id ?? '')
  if (!ID_RE.test(id)) return c.json({ error: 'media_id inválido (minúsculas/dígitos/_, 3–40)' }, 400)
  if (!TIPOS.includes(String(b.tipo))) return c.json({ error: 'tipo inválido' }, 400)
  if (!b.title) return c.json({ error: 'title é obrigatório' }, 400)
  const canais = String(b.canais ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (canais.length === 0) return c.json({ error: 'escolha pelo menos um canal' }, 400)
  const { results: chs } = await c.env.DB.prepare('SELECT id FROM channels').all<{ id: string }>()
  for (const canal of canais) {
    if (!chs.some((r) => r.id === canal)) return c.json({ error: `canal desconhecido: ${canal}` }, 400)
  }

  const dup = await c.env.DB.prepare(
    `SELECT id FROM media_items WHERE id = ?1
     UNION SELECT id FROM ingest_jobs WHERE id = ?1
     UNION SELECT media_id FROM upload_sessions WHERE media_id = ?1 AND status = 'ativa'`,
  ).bind(id).first()
  if (dup) return c.json({ error: `id "${id}" já existe (mídia, fila ou upload em andamento)` }, 409)

  let partSize = Number(b.part_size ?? PART_DEFAULT)
  if (!Number.isFinite(partSize)) partSize = PART_DEFAULT
  partSize = Math.min(PART_MAX, Math.max(PART_MIN, Math.floor(partSize)))
  const partsTotal = Math.max(1, Math.ceil(fsize / partSize))
  if (partsTotal > MAX_PARTS) return c.json({ error: 'arquivo grande demais pro part_size' }, 400)

  const sid = crypto.randomUUID()
  const safeName = fname.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-80) || 'upload.bin'
  const stagingKey = `staging/${sid}/${safeName}`
  const mp = await c.env.MEDIA.createMultipartUpload(stagingKey)

  await c.env.DB.prepare(
    `INSERT INTO upload_sessions
       (id, media_id, staging_key, r2_upload_id, file_name, file_rel, file_size, file_mtime,
        part_size, parts_total, tipo, title, series_id, episode, tags, canais)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
  ).bind(
    sid, id, stagingKey, mp.uploadId, fname, frel, fsize, fmtime,
    partSize, partsTotal, String(b.tipo), String(b.title),
    b.series_id ? String(b.series_id) : null,
    b.episode ? Number(b.episode) : null,
    String(b.tags ?? ''), canais.join(','),
  ).run()

  const s = { id: sid, media_id: id, staging_key: stagingKey, file_name: fname, file_rel: frel, file_size: fsize, file_mtime: fmtime, part_size: partSize, parts_total: partsTotal, tipo: String(b.tipo), title: String(b.title), series_id: b.series_id ? String(b.series_id) : null, episode: b.episode ? Number(b.episode) : null, tags: String(b.tags ?? ''), canais: canais.join(',') } as SessionRow
  return c.json({ ...sessaoPublica(s, []), retomada: false }, 201)
})

// ── listar sessões incompletas (tela de retomada) ──────────────────────────
uploads.get('/', async (c) => {
  const { results: sess } = await c.env.DB.prepare(
    "SELECT * FROM upload_sessions WHERE status = 'ativa' ORDER BY created_at",
  ).all<SessionRow>()
  const out = []
  for (const s of sess) {
    const partes = await partesConfirmadas(c.env.DB, s.id)
    out.push({
      ...sessaoPublica(s, partes.map((p) => p.part_number)),
      bytes_ok: partes.reduce((a, p) => a + p.size, 0),
    })
  }
  return c.json(out)
})

// ── receber uma parte ──────────────────────────────────────────────────────
uploads.put('/:sid/parts/:n', async (c) => {
  const sid = c.req.param('sid')
  const n = Number(c.req.param('n'))
  const s = await c.env.DB.prepare('SELECT * FROM upload_sessions WHERE id = ?1').bind(sid).first<SessionRow>()
  if (!s) return c.json({ error: 'sessão não existe' }, 404)
  if (s.status !== 'ativa') return c.json({ error: 'sessão já concluída' }, 409)
  if (!Number.isInteger(n) || n < 1 || n > s.parts_total) {
    return c.json({ error: `parte fora do intervalo (1–${s.parts_total})` }, 400)
  }

  // tamanho EXATO por posição: uniforme em todas, resto na última — além de
  // pegar cliente bugado cedo, é o que o R2 exige de um multipart.
  const esperado = n < s.parts_total
    ? s.part_size
    : s.file_size - (s.parts_total - 1) * s.part_size
  const buf = await c.req.arrayBuffer()
  if (buf.byteLength !== esperado) {
    return c.json({ error: `parte ${n} com ${buf.byteLength} bytes; esperava ${esperado}` }, 400)
  }

  const mp = c.env.MEDIA.resumeMultipartUpload(s.staging_key, s.r2_upload_id)
  let up: R2UploadedPart
  try {
    up = await mp.uploadPart(n, buf)
  } catch (e) {
    // multipart sumiu no R2 (abortado/expirado por fora) — sessão irrecuperável
    return c.json({ error: `R2 recusou a parte: ${(e as Error).message} — descarte a sessão e recomece` }, 409)
  }

  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT OR REPLACE INTO upload_parts (session_id, part_number, etag, size) VALUES (?1, ?2, ?3, ?4)',
    ).bind(sid, n, up.etag, buf.byteLength),
    c.env.DB.prepare('UPDATE upload_sessions SET updated_at = unixepoch() WHERE id = ?1').bind(sid),
  ])
  const feitas = await c.env.DB.prepare('SELECT COUNT(*) c FROM upload_parts WHERE session_id = ?1')
    .bind(sid).first<{ c: number }>()
  return c.json({ ok: true, parte: n, confirmadas: feitas?.c ?? 0, total: s.parts_total })
})

// ── completar: fecha o objeto no staging e cria o job (idempotente) ────────
uploads.post('/:sid/complete', async (c) => {
  const sid = c.req.param('sid')
  const s = await c.env.DB.prepare('SELECT * FROM upload_sessions WHERE id = ?1').bind(sid).first<SessionRow>()
  if (!s) return c.json({ error: 'sessão não existe' }, 404)
  if (s.status === 'concluida') return c.json({ ok: true, id: s.media_id, ja_concluida: true })

  const partes = await partesConfirmadas(c.env.DB, sid)
  if (partes.length !== s.parts_total) {
    const tem = new Set(partes.map((p) => p.part_number))
    const faltam = []
    for (let i = 1; i <= s.parts_total; i++) if (!tem.has(i)) faltam.push(i)
    return c.json({ error: `faltam partes: ${faltam.slice(0, 20).join(', ')}`, faltam }, 409)
  }
  const soma = partes.reduce((a, p) => a + p.size, 0)
  if (soma !== s.file_size) {
    return c.json({ error: `soma das partes (${soma}) difere do arquivo (${s.file_size})` }, 409)
  }

  const mp = c.env.MEDIA.resumeMultipartUpload(s.staging_key, s.r2_upload_id)
  try {
    await mp.complete(partes.map((p) => ({ partNumber: p.part_number, etag: p.etag })))
  } catch (e) {
    // um complete anterior pode ter fechado o objeto e a resposta se perdido
    // no caminho — se o staging existe com o tamanho certo, seguimos em frente.
    const head = await c.env.MEDIA.head(s.staging_key)
    if (!head || head.size !== s.file_size) {
      return c.json({ error: `R2 não completou: ${(e as Error).message}` }, 500)
    }
  }

  // corrida rara: alguém tomou o id entre a criação da sessão e o complete
  const dup = await c.env.DB.prepare(
    'SELECT id FROM media_items WHERE id = ?1 UNION SELECT id FROM ingest_jobs WHERE id = ?1',
  ).bind(s.media_id).first()
  if (dup) {
    return c.json({ error: `id "${s.media_id}" já existe no catálogo/fila — descarte esta sessão` }, 409)
  }

  // job + conclusão da sessão numa transação: ou tudo, ou nada — é isso que
  // torna o complete repetível sem nunca duplicar job.
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO ingest_jobs (id, staging_key, original_name, tipo, title, series_id, episode, tags, canais)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).bind(s.media_id, s.staging_key, s.file_name, s.tipo, s.title, s.series_id, s.episode, s.tags, s.canais),
    c.env.DB.prepare("UPDATE upload_sessions SET status = 'concluida', updated_at = unixepoch() WHERE id = ?1").bind(sid),
    c.env.DB.prepare('DELETE FROM upload_parts WHERE session_id = ?1').bind(sid),
  ])
  c.executionCtx.waitUntil(dispatchFabrica(c.env))
  return c.json({ ok: true, id: s.media_id, ja_concluida: false }, 201)
})

// ── abortar e limpar uma sessão incompleta ─────────────────────────────────
uploads.delete('/:sid', async (c) => {
  const sid = c.req.param('sid')
  const s = await c.env.DB.prepare('SELECT * FROM upload_sessions WHERE id = ?1').bind(sid).first<SessionRow>()
  if (!s) return c.json({ error: 'sessão não existe' }, 404)
  if (s.status === 'ativa') {
    try {
      await c.env.MEDIA.resumeMultipartUpload(s.staging_key, s.r2_upload_id).abort()
    } catch {
      /* multipart já não existia no R2 — nada a limpar lá */
    }
  }
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM upload_parts WHERE session_id = ?1').bind(sid),
    c.env.DB.prepare('DELETE FROM upload_sessions WHERE id = ?1').bind(sid),
  ])
  return c.json({ ok: true })
})
