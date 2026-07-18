import { Hono } from 'hono'
import { dispatchFabrica } from './fabrica'
import { scheduleChannel } from './scheduler'

type Bindings = {
  DB: D1Database
  MEDIA: R2Bucket
  GH_DISPATCH_TOKEN?: string
  GH_REPO?: string
}

type ClipRow = {
  id: string
  categoria: string
  series_id: string | null
  chave: string | null
  rotulo: string
  audio_key: string
  duracao: number | null
  created_at: number
}

type MoldeRow = {
  id: string
  nome: string
  canal: string
  molde_key: string
  musica_key: string | null
  buraco: string | null
  texto_box: string | null
  created_at: number
}

type SampleRow = {
  id: string
  series_id: string
  rotulo: string
  video_key: string
  created_at: number
}

type BuildJobRow = {
  id: string
  media_id: string
  title: string
  status: string
  error: string | null
  progress: number
  molde_id: string
  series_id: string
  slot_dias: string
  slot_hora: string
  frase_id: string | null
  sample_id: string | null
  payload: string | null
  created_at: number
  updated_at: number
}

export const fabricaComerciais = new Hono<{ Bindings: Bindings }>()

const ID_RE = /^[a-z0-9_]{3,40}$/
const SLUG = /^[a-z0-9_]{2,40}$/
const CATEGORIAS = ['horario', 'frequencia', 'nome', 'frase', 'conector']
const DIAS = [
  { n: 1, key: 'seg', tela: 'SEG' },
  { n: 2, key: 'ter', tela: 'TER' },
  { n: 3, key: 'qua', tela: 'QUA' },
  { n: 4, key: 'qui', tela: 'QUI' },
  { n: 5, key: 'sex', tela: 'SEX' },
  { n: 6, key: 'sab', tela: 'SAB' },
  { n: 7, key: 'dom', tela: 'DOM' },
]

function slugify(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)
}

function hex(n = 10): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, n)
}

function safeName(s: string): string {
  return (s || 'asset.bin').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-90)
}

function limpaHora(s: unknown): string | null {
  const raw = String(s ?? '').trim()
  const m = raw.match(/^([01]\d|2[0-3]):([0-5]\d)$/)
  return m ? `${m[1]}:${m[2]}` : null
}

function diasCanon(raw: unknown): number[] {
  const arr = Array.isArray(raw) ? raw : []
  const dias = [...new Set(arr.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7))]
    .sort((a, b) => a - b)
  return dias
}

function freqKey(dias: number[]): string {
  const s = dias.join(',')
  if (s === '1,2,3,4,5,6,7') return 'todos'
  if (s === '1,2,3,4,5') return 'seg-sex'
  if (s === '6,7') return 'fimsemana'
  if (dias.length === 1) return DIAS.find((d) => d.n === dias[0])!.key
  const keys = dias.map((n) => DIAS.find((d) => d.n === n)!.key)
  const sequencial = dias.every((n, i) => i === 0 || n === dias[i - 1] + 1)
  return sequencial ? `${keys[0]}-${keys.at(-1)}` : keys.join('-')
}

function freqTela(dias: number[]): string {
  const s = dias.join(',')
  if (s === '1,2,3,4,5,6,7') return 'TODOS OS DIAS'
  if (s === '1,2,3,4,5') return 'SEG A SEX'
  if (s === '6,7') return 'SAB E DOM'
  const telas = dias.map((n) => DIAS.find((d) => d.n === n)!.tela)
  const sequencial = dias.every((n, i) => i === 0 || n === dias[i - 1] + 1)
  return sequencial && telas.length > 1 ? `${telas[0]} A ${telas.at(-1)}` : telas.join(' · ')
}

function horaTela(hora: string): string {
  const [h, m] = hora.split(':')
  return m === '00' ? `${Number(h)}H` : `${Number(h)}H${m}`
}

function textoTela(dias: number[], hora: string): string {
  return `${freqTela(dias)} · ${horaTela(hora)}`
}

function assetKey(kind: string, id: string, original: string): string {
  return `fabrica/${kind}/${id}/${safeName(original)}`
}

async function copiaAsset(env: Bindings, stagingKey: unknown, destKey: string): Promise<void> {
  const key = String(stagingKey ?? '').trim()
  if (!key) throw new Error('staging_key é obrigatório')
  const obj = await env.MEDIA.get(key)
  if (!obj) throw new Error(`asset não encontrado no R2: ${key}`)
  await env.MEDIA.put(destKey, obj.body)
  if (key !== destKey) await env.MEDIA.delete(key)
}

async function canalExiste(db: D1Database, id: string): Promise<boolean> {
  return Boolean(await db.prepare('SELECT id FROM channels WHERE id = ?1').bind(id).first())
}

async function serieTitulo(db: D1Database, sid: string): Promise<string> {
  const row = await db.prepare(
    `SELECT MIN(json_extract(metadata, '$.title')) titulo
     FROM media_items
     WHERE json_extract(metadata, '$.series_id') = ?1`,
  ).bind(sid).first<{ titulo: string | null }>()
  return row?.titulo ?? sid
}

async function clip(db: D1Database, where: string, ...binds: unknown[]): Promise<ClipRow | null> {
  return db.prepare(`SELECT * FROM voice_clips WHERE ${where} ORDER BY created_at DESC LIMIT 1`)
    .bind(...binds).first<ClipRow>()
}

async function resolvePayload(env: Bindings, job: BuildJobRow) {
  const dias = diasCanon(JSON.parse(job.slot_dias))
  const hora = limpaHora(job.slot_hora)
  if (dias.length === 0 || !hora) throw new Error('slot inválido no job')
  const fk = freqKey(dias)
  const molde = await env.DB.prepare('SELECT * FROM moldes WHERE id = ?1')
    .bind(job.molde_id).first<MoldeRow>()
  if (!molde) throw new Error(`molde não encontrado: ${job.molde_id}`)

  const sample = job.sample_id
    ? await env.DB.prepare('SELECT * FROM program_samples WHERE id = ?1 AND series_id = ?2')
      .bind(job.sample_id, job.series_id).first<SampleRow>()
    : await env.DB.prepare('SELECT * FROM program_samples WHERE series_id = ?1 ORDER BY created_at DESC LIMIT 1')
      .bind(job.series_id).first<SampleRow>()
  if (!sample) throw new Error(`cadastre uma amostra de vídeo para ${job.series_id}`)

  const frase = job.frase_id
    ? await env.DB.prepare("SELECT * FROM voice_clips WHERE id = ?1 AND categoria = 'frase' AND series_id = ?2")
      .bind(job.frase_id, job.series_id).first<ClipRow>()
    : await env.DB.prepare("SELECT * FROM voice_clips WHERE categoria = 'frase' AND series_id = ?1 ORDER BY RANDOM() LIMIT 1")
      .bind(job.series_id).first<ClipRow>()
  const nome = await clip(env.DB, "categoria = 'nome' AND series_id = ?1", job.series_id)
  const frequencia = await clip(env.DB, "categoria = 'frequencia' AND chave = ?1", fk)
  const horario = await clip(env.DB, "categoria = 'horario' AND chave = ?1", hora)
  const assinatura = await clip(env.DB, "categoria = 'conector' AND chave = 'encerramento'")

  const faltando = [
    !frase && `frase de ${job.series_id}`,
    !nome && `nome de ${job.series_id}`,
    !frequencia && `frequência ${fk}`,
    !horario && `horário ${hora}`,
    !assinatura && 'assinatura final do canal',
  ].filter(Boolean)
  if (faltando.length) throw new Error(`faltam clipes de fala: ${faltando.join(', ')}`)

  const transcript = [frase!.rotulo, nome!.rotulo, frequencia!.rotulo, horario!.rotulo, assinatura!.rotulo]
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return {
    id: job.id,
    media_id: job.media_id,
    title: job.title,
    canal: molde.canal,
    series_id: job.series_id,
    slot: {
      dias,
      hora,
      frequencia_chave: fk,
      titulo_tela: nome!.rotulo.replace(/[.!?]+$/, '').trim(),
      texto_tela: textoTela(dias, hora),
    },
    transcript,
    molde,
    sample,
    clips: [
      { papel: 'frase', ...frase! },
      { papel: 'nome', ...nome! },
      { papel: 'frequencia', ...frequencia! },
      { papel: 'horario', ...horario! },
      { papel: 'assinatura', ...assinatura! },
    ],
  }
}

fabricaComerciais.get('/', async (c) => {
  const [voice, moldes, samples, jobs, series] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM voice_clips ORDER BY categoria, series_id, chave, created_at DESC').all(),
    c.env.DB.prepare('SELECT * FROM moldes ORDER BY created_at DESC').all(),
    c.env.DB.prepare('SELECT * FROM program_samples ORDER BY series_id, created_at DESC').all(),
    c.env.DB.prepare('SELECT * FROM commercial_build_jobs ORDER BY created_at DESC LIMIT 50').all(),
    c.env.DB.prepare(
      `SELECT json_extract(metadata, '$.series_id') sid,
              MIN(json_extract(metadata, '$.title')) titulo,
              COUNT(*) n
       FROM media_items
       WHERE json_extract(metadata, '$.series_id') IS NOT NULL
         AND tipo IN ('episodio','filme')
       GROUP BY sid
       ORDER BY titulo`,
    ).all(),
  ])
  return c.json({
    voice_clips: voice.results,
    moldes: moldes.results,
    samples: samples.results,
    jobs: jobs.results,
    series: series.results.filter((s: any) => s.sid),
  })
})

fabricaComerciais.post('/voice-clips', async (c) => {
  const b = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!b) return c.json({ error: 'JSON inválido' }, 400)
  const categoria = String(b.categoria ?? '')
  if (!CATEGORIAS.includes(categoria)) return c.json({ error: 'categoria inválida' }, 400)
  const seriesId = b.series_id ? slugify(String(b.series_id)) : ''
  if ((categoria === 'nome' || categoria === 'frase') && !SLUG.test(seriesId)) {
    return c.json({ error: 'nome/frase exigem uma série válida' }, 400)
  }
  const chave = String(b.chave ?? '').trim()
  if ((categoria === 'horario' || categoria === 'frequencia' || categoria === 'conector') && !chave) {
    return c.json({ error: 'esta categoria exige chave' }, 400)
  }
  if (categoria === 'horario' && !limpaHora(chave)) return c.json({ error: 'chave de horário deve ser HH:MM' }, 400)
  const rotulo = String(b.rotulo ?? '').trim().slice(0, 300)
  if (!rotulo) return c.json({ error: 'rotulo é obrigatório' }, 400)

  const id = `vc_${hex()}`
  const audioKey = assetKey('voice_clips', id, String(b.original_name ?? 'fala.wav'))
  try {
    await copiaAsset(c.env, b.staging_key, audioKey)
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
  const clipSeries = categoria === 'nome' || categoria === 'frase' ? seriesId : null
  await c.env.DB.prepare(
    `INSERT INTO voice_clips (id, categoria, series_id, chave, rotulo, audio_key)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).bind(id, categoria, clipSeries, chave || null, rotulo, audioKey).run()
  return c.json({ ok: true, id, audio_key: audioKey }, 201)
})

fabricaComerciais.delete('/voice-clips/:id', async (c) => {
  const id = c.req.param('id')
  const row = await c.env.DB.prepare('SELECT audio_key FROM voice_clips WHERE id = ?1')
    .bind(id).first<{ audio_key: string }>()
  if (!row) return c.json({ error: 'clipe não encontrado' }, 404)
  await c.env.MEDIA.delete(row.audio_key)
  await c.env.DB.prepare('DELETE FROM voice_clips WHERE id = ?1').bind(id).run()
  return c.json({ ok: true })
})

fabricaComerciais.post('/samples', async (c) => {
  const b = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!b) return c.json({ error: 'JSON inválido' }, 400)
  const seriesId = slugify(String(b.series_id ?? ''))
  if (!SLUG.test(seriesId)) return c.json({ error: 'série inválida' }, 400)
  const rotulo = String(b.rotulo ?? '').trim().slice(0, 160) || `amostra ${seriesId}`
  const id = `ps_${hex()}`
  const videoKey = assetKey('samples', id, String(b.original_name ?? 'amostra.mp4'))
  try {
    await copiaAsset(c.env, b.staging_key, videoKey)
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
  await c.env.DB.prepare(
    'INSERT INTO program_samples (id, series_id, rotulo, video_key) VALUES (?1, ?2, ?3, ?4)',
  ).bind(id, seriesId, rotulo, videoKey).run()
  return c.json({ ok: true, id, video_key: videoKey }, 201)
})

fabricaComerciais.delete('/samples/:id', async (c) => {
  const id = c.req.param('id')
  const row = await c.env.DB.prepare('SELECT video_key FROM program_samples WHERE id = ?1')
    .bind(id).first<{ video_key: string }>()
  if (!row) return c.json({ error: 'amostra não encontrada' }, 404)
  await c.env.MEDIA.delete(row.video_key)
  await c.env.DB.prepare('DELETE FROM program_samples WHERE id = ?1').bind(id).run()
  return c.json({ ok: true })
})

fabricaComerciais.post('/moldes', async (c) => {
  const b = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!b) return c.json({ error: 'JSON inválido' }, 400)
  const nome = String(b.nome ?? '').trim().slice(0, 120)
  if (!nome) return c.json({ error: 'nome é obrigatório' }, 400)
  const canal = slugify(String(b.canal ?? ''))
  if (!SLUG.test(canal) || !(await canalExiste(c.env.DB, canal))) return c.json({ error: 'canal desconhecido' }, 400)

  const id = `md_${hex()}`
  const moldeKey = assetKey('moldes', id, String(b.molde_original_name ?? 'molde.png'))
  let musicaKey: string | null = null
  try {
    await copiaAsset(c.env, b.molde_staging_key, moldeKey)
    if (b.musica_staging_key) {
      musicaKey = assetKey('moldes', `${id}_music`, String(b.musica_original_name ?? 'musica.mp3'))
      await copiaAsset(c.env, b.musica_staging_key, musicaKey)
    }
  } catch (e) {
    await c.env.MEDIA.delete(moldeKey)
    if (musicaKey) await c.env.MEDIA.delete(musicaKey)
    return c.json({ error: (e as Error).message }, 400)
  }
  await c.env.DB.prepare(
    `INSERT INTO moldes (id, nome, canal, molde_key, musica_key, texto_box)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).bind(id, nome, canal, moldeKey, musicaKey, b.texto_box ? String(b.texto_box) : null).run()
  return c.json({ ok: true, id, molde_key: moldeKey, musica_key: musicaKey }, 201)
})

fabricaComerciais.delete('/moldes/:id', async (c) => {
  const id = c.req.param('id')
  const row = await c.env.DB.prepare('SELECT molde_key, musica_key FROM moldes WHERE id = ?1')
    .bind(id).first<{ molde_key: string; musica_key: string | null }>()
  if (!row) return c.json({ error: 'molde não encontrado' }, 404)
  await c.env.MEDIA.delete(row.molde_key)
  if (row.musica_key) await c.env.MEDIA.delete(row.musica_key)
  await c.env.DB.prepare('DELETE FROM moldes WHERE id = ?1').bind(id).run()
  return c.json({ ok: true })
})

fabricaComerciais.post('/jobs', async (c) => {
  const b = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!b) return c.json({ error: 'JSON inválido' }, 400)
  const moldeId = String(b.molde_id ?? '')
  const molde = await c.env.DB.prepare('SELECT * FROM moldes WHERE id = ?1').bind(moldeId).first<MoldeRow>()
  if (!molde) return c.json({ error: 'molde não encontrado' }, 400)

  const seriesId = slugify(String(b.series_id ?? ''))
  if (!SLUG.test(seriesId)) return c.json({ error: 'série inválida' }, 400)
  const dias = diasCanon(b.dias)
  if (dias.length === 0) return c.json({ error: 'escolha ao menos um dia' }, 400)
  const hora = limpaHora(b.hora)
  if (!hora) return c.json({ error: 'hora deve ser HH:MM' }, 400)

  const sampleId = String(b.sample_id ?? '').trim() || null
  const fraseId = String(b.frase_id ?? '').trim() || null
  const tituloSerie = await serieTitulo(c.env.DB, seriesId)
  const mediaIdRaw = String(b.media_id ?? '').trim()
  const mediaId = mediaIdRaw || `com_${seriesId.slice(0, 20)}_${hora.replace(':', 'h')}_${hex(4)}`
  if (!ID_RE.test(mediaId)) return c.json({ error: 'media_id inválido (minúsculas/dígitos/_, 3–40)' }, 400)
  const dup = await c.env.DB.prepare(
    `SELECT id FROM media_items WHERE id = ?1
     UNION SELECT media_id FROM commercial_build_jobs WHERE media_id = ?1`,
  ).bind(mediaId).first()
  if (dup) return c.json({ error: `id "${mediaId}" já existe no catálogo ou na fábrica` }, 409)

  const id = `cb_${hex()}`
  const title = String(b.title ?? '').trim().slice(0, 140) || `${tituloSerie} — ${textoTela(dias, hora)}`
  await c.env.DB.prepare(
    `INSERT INTO commercial_build_jobs
       (id, media_id, title, molde_id, series_id, slot_dias, slot_hora, frase_id, sample_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  ).bind(id, mediaId, title, moldeId, seriesId, JSON.stringify(dias), hora, fraseId, sampleId).run()
  c.executionCtx.waitUntil(dispatchFabrica(c.env))
  return c.json({ ok: true, id, media_id: mediaId }, 201)
})

fabricaComerciais.post('/claim', async (c) => {
  let job: BuildJobRow | null = null
  try {
    await c.env.DB.prepare(
      `UPDATE commercial_build_jobs SET status='queued', error=NULL, progress=0, updated_at=unixepoch()
       WHERE status='processing' AND updated_at < unixepoch() - 7200`,
    ).run()
    job = await c.env.DB.prepare(
      `UPDATE commercial_build_jobs SET status='processing', progress=0, updated_at=unixepoch()
       WHERE id = (SELECT id FROM commercial_build_jobs WHERE status='queued' ORDER BY created_at LIMIT 1)
       RETURNING *`,
    ).first<BuildJobRow>()
    if (!job) return c.body(null, 204)
    const payload = await resolvePayload(c.env, job)
    await c.env.DB.prepare('UPDATE commercial_build_jobs SET payload = ?2 WHERE id = ?1')
      .bind(job.id, JSON.stringify(payload)).run()
    return c.json(payload)
  } catch (e) {
    if (/no such table/i.test(String((e as Error).message ?? e))) return c.body(null, 204)
    if (!job) throw e
    await c.env.DB.prepare(
      "UPDATE commercial_build_jobs SET status='error', error=?2, progress=0, updated_at=unixepoch() WHERE id = ?1",
    ).bind(job.id, String((e as Error).message ?? e).slice(0, 500)).run()
    return c.body(null, 204)
  }
})

fabricaComerciais.post('/:id/progress', async (c) => {
  const { pct } = await c.req.json<{ pct?: number }>().catch(() => ({ pct: -1 }))
  const n = Math.max(0, Math.min(99, Math.floor(Number(pct ?? -1))))
  if (!Number.isFinite(n)) return c.json({ error: 'pct inválido' }, 400)
  await c.env.DB.prepare(
    "UPDATE commercial_build_jobs SET progress=?2, updated_at=unixepoch() WHERE id=?1 AND status='processing'",
  ).bind(c.req.param('id'), n).run()
  return c.json({ ok: true })
})

fabricaComerciais.post('/:id/retry', async (c) => {
  const r = await c.env.DB.prepare(
    "UPDATE commercial_build_jobs SET status='queued', error=NULL, progress=0, updated_at=unixepoch() WHERE id=?1 AND status='error'",
  ).bind(c.req.param('id')).run()
  if ((r.meta.changes ?? 0) === 0) return c.json({ error: 'job não está em erro' }, 404)
  c.executionCtx.waitUntil(dispatchFabrica(c.env))
  return c.json({ ok: true })
})

fabricaComerciais.post('/:id/done', async (c) => {
  const id = c.req.param('id')
  const b = await c.req.json<{ media_id?: string; transcript?: string; proposta?: unknown; render?: unknown }>()
    .catch(() => ({} as { media_id?: string; transcript?: string; proposta?: unknown; render?: unknown }))
  const job = await c.env.DB.prepare('SELECT * FROM commercial_build_jobs WHERE id = ?1')
    .bind(id).first<BuildJobRow>()
  if (!job) return c.json({ error: 'job não encontrado' }, 404)
  const mediaId = String(b.media_id ?? job.media_id)
  const dias = diasCanon(JSON.parse(job.slot_dias))
  const hora = limpaHora(job.slot_hora) ?? job.slot_hora
  const proposta = b.proposta ?? {
    tipo: 'bloco_horario',
    series_id: job.series_id,
    descricao: `${job.title} (${textoTela(dias, hora)})`,
    confianca: 1,
  }
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE commercial_build_jobs SET status='done', error=NULL, progress=100, updated_at=unixepoch() WHERE id=?1",
    ).bind(id),
    c.env.DB.prepare(
      `INSERT INTO media_promises (media_id, transcript, proposta, status)
       VALUES (?1, ?2, ?3, 'pendente')
       ON CONFLICT(media_id) DO UPDATE SET
         transcript=excluded.transcript,
         proposta=excluded.proposta,
         status=CASE WHEN media_promises.status='confirmada' THEN media_promises.status ELSE 'pendente' END,
         updated_at=unixepoch()`,
    ).bind(mediaId, String(b.transcript ?? '').slice(0, 8000), JSON.stringify(proposta)),
  ])
  const molde = await c.env.DB.prepare('SELECT canal FROM moldes WHERE id = ?1')
    .bind(job.molde_id).first<{ canal: string }>()
  if (molde?.canal) await scheduleChannel(c.env, molde.canal, 48, true)
  return c.json({ ok: true })
})

fabricaComerciais.post('/:id/error', async (c) => {
  const { error } = await c.req.json<{ error?: string }>().catch(() => ({ error: 'falha na montagem' }))
  const r = await c.env.DB.prepare(
    "UPDATE commercial_build_jobs SET status='error', error=?2, progress=0, updated_at=unixepoch() WHERE id=?1",
  ).bind(c.req.param('id'), String(error ?? 'falha na montagem').slice(0, 500)).run()
  if ((r.meta.changes ?? 0) === 0) return c.json({ error: 'job não encontrado' }, 404)
  return c.json({ ok: true })
})
