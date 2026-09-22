import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { runScheduler, scheduleChannel, reconcileAndRepair } from './scheduler'
import { chatDiretor, estadoDiretor, type ChatMsg } from './diretor'
import { uploads } from './uploads'
import { dispatchFabrica } from './fabrica'
import { fabricaComerciais } from './fabrica-comerciais'
import { extraiPromessa, salvaTranscript, type Proposta } from './promessas'
import { planejaEditorial } from './editorial'
import { pedeJson } from './llm'
import { montaGrupos, mediaIdDe, slugSerie, type Entry, type Grupos } from './serie-partes'

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
  GEMINI_API_KEY?: string
  DEEPSEEK_API_KEY?: string
}

export const admin = new Hono<{ Bindings: Bindings }>()

const TIPOS = ['episodio', 'filme', 'comercial', 'vinheta']
const SLUG = /^[a-z0-9_]{2,40}$/

// Aceita série digitada "como gente" ("Power Rangers Galáxia Perdida") e
// converte pro slug do sistema — recusar formato era atrito puro no painel.
export function slugify(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)
}

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
admin.route('/fabrica-comerciais', fabricaComerciais)

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
  // origem: um upload (staging_key) OU um link da web (source_url — YouTube,
  // archive.org etc.; a fábrica baixa com yt-dlp e segue o pipeline normal)
  const sourceUrl = String(b.source_url ?? '').trim()
  if (sourceUrl && !/^https?:\/\/.{4,500}$/.test(sourceUrl)) {
    return c.json({ error: 'link inválido (precisa começar com http/https)' }, 400)
  }
  if (!b.title || (!b.staging_key && !sourceUrl)) {
    return c.json({ error: 'title e (staging_key OU source_url) são obrigatórios' }, 400)
  }

  const canais = String(b.canais ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (canais.length === 0) return c.json({ error: 'escolha pelo menos um canal' }, 400)
  const validos = await channelIds(c.env.DB)
  for (const canal of canais) {
    if (!validos.includes(canal)) return c.json({ error: `canal desconhecido: ${canal}` }, 400)
  }

  // enquadramento 16:9: 'fill' enche a tela (fonte 4:3, sem tarjas); default letterbox
  const videoFit = b.video_fit === 'fill' ? 'fill' : null

  const dup = await c.env.DB.prepare(
    'SELECT id FROM media_items WHERE id = ?1 UNION SELECT id FROM ingest_jobs WHERE id = ?1',
  ).bind(id).first()
  if (dup) return c.json({ error: `id "${id}" já existe` }, 409)

  await c.env.DB.prepare(
    `INSERT INTO ingest_jobs (id, staging_key, original_name, tipo, title, series_id, episode, tags, canais, source_url, video_fit)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  ).bind(
    id, String(b.staging_key ?? ''), String(b.original_name ?? ''), String(b.tipo), String(b.title),
    b.series_id ? String(b.series_id) : null,
    b.episode ? Number(b.episode) : null,
    String(b.tags ?? ''),
    canais.join(','),
    sourceUrl || null,
    videoFit,
  ).run()
  c.executionCtx.waitUntil(dispatchFabrica(c.env))
  return c.json({ ok: true, id }, 201)
})

// Título/autor de um link do YouTube via oEmbed (server-side: o navegador
// não consegue por CORS) — pré-preenche o formulário do painel. Melhor
// esforço: link de outro site só devolve title null e o operador digita.
admin.get('/yt-info', async (c) => {
  const url = c.req.query('url') ?? ''
  if (!/^https?:\/\//.test(url)) return c.json({ error: 'url inválida' }, 400)
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`,
      { headers: { 'user-agent': 'biel-tv-admin' } },
    )
    if (!res.ok) return c.json({ title: null })
    const data = await res.json<{ title?: string; author_name?: string }>()
    return c.json({ title: data.title ?? null, autor: data.author_name ?? null })
  } catch {
    return c.json({ title: null })
  }
})

// ── cookies do YouTube (self-service) ──────────────────────────────────────
// O YouTube não deixa renovar cookies automaticamente (precisaria da senha
// do Google / navegador logado 24/7). O que dá pra fazer é a renovação SEM
// depender de ninguém: o Gabriel cola o cookies.txt aqui → guardamos no D1 →
// a fábrica busca daqui na hora de baixar → os vídeos que falharam voltam
// pra fila sozinhos. Trade-off: cookies dão acesso à conta Google e ficam no
// D1 atrás do token de admin (não no GitHub secret encriptado) — aceitável
// num projeto pessoal só dele. O secret do GitHub segue como fallback.

// Aceita os DOIS formatos de export: o cookies.txt Netscape (extensão "Get
// cookies.txt LOCALLY") E o JSON (Cookie-Editor / EditThisCookie) — converte
// pro Netscape que o yt-dlp exige. Assim tanto faz qual extensão o Gabriel usa.
export function cookiesParaNetscape(raw: string): string | null {
  const t = raw.trim()
  if (t.startsWith('[') || t.startsWith('{')) {
    let arr: unknown
    try {
      const parsed = JSON.parse(t)
      arr = Array.isArray(parsed) ? parsed : (parsed as { cookies?: unknown[] }).cookies ?? []
    } catch { return null }
    if (!Array.isArray(arr)) return null
    const linhas = ['# Netscape HTTP Cookie File']
    for (const raw2 of arr) {
      const ck = raw2 as Record<string, unknown>
      if (!ck?.domain || !ck?.name) continue
      const domain = String(ck.domain)
      const flag = domain.startsWith('.') ? 'TRUE' : 'FALSE'
      const secure = ck.secure ? 'TRUE' : 'FALSE'
      const exp = ck.expirationDate ? Math.floor(Number(ck.expirationDate)) : 0
      linhas.push([domain, flag, String(ck.path ?? '/'), secure, String(exp), String(ck.name), String(ck.value ?? '')].join('\t'))
    }
    return linhas.join('\n') + '\n'
  }
  // já é Netscape: colar no campo/chat troca TABs por espaços — normaliza
  return raw.split('\n')
    .map((l) => (l.startsWith('#') || !l.trim() ? l : l.trim().replace(/[ \t]+/g, '\t')))
    .join('\n') + '\n'
}

admin.post('/yt-cookies', async (c) => {
  const { cookies } = await c.req.json<{ cookies?: string }>().catch(() => ({ cookies: '' }))
  const norm = cookiesParaNetscape(String(cookies ?? ''))
  if (!norm || !/\.youtube\.com/.test(norm) || !/(__Secure-3PSID|\bSID\b)/.test(norm)) {
    return c.json({ error: 'não reconheci os cookies do YouTube — cole o cookies.txt (Netscape) OU o JSON (Cookie-Editor) inteiro' }, 400)
  }
  await c.env.DB.prepare("INSERT OR REPLACE INTO config (k, v) VALUES ('yt_cookies', ?1)").bind(norm).run()
  // cookie novo → reenfileira tudo que falhou por link (não só YouTube, mas
  // é o caso que importa) e acorda a fábrica
  const r = await c.env.DB.prepare(
    `UPDATE ingest_jobs SET status = 'queued', error = NULL, progress = 0, updated_at = unixepoch()
     WHERE source_url IS NOT NULL AND status = 'error'`,
  ).run()
  c.executionCtx.waitUntil(dispatchFabrica(c.env))
  return c.json({ ok: true, reenfileirados: r.meta.changes ?? 0 })
})

// a fábrica busca os cookies aqui (protegido pelo token de admin)
admin.get('/yt-cookies', async (c) => {
  const row = await c.env.DB.prepare("SELECT v FROM config WHERE k = 'yt_cookies'").first<{ v: string }>()
  return c.json({ cookies: row?.v ?? null })
})

// a fábrica devolve os cookies rotacionados pelo yt-dlp após um download OK —
// mantém os do D1 frescos entre lotes. Silencioso: NÃO reenfileira nem dispara.
admin.put('/yt-cookies', async (c) => {
  const { cookies } = await c.req.json<{ cookies?: string }>().catch(() => ({ cookies: '' }))
  const norm = cookiesParaNetscape(String(cookies ?? ''))
  if (!norm || !/\.youtube\.com/.test(norm)) return c.json({ error: 'cookies inválidos' }, 400)
  await c.env.DB.prepare("INSERT OR REPLACE INTO config (k, v) VALUES ('yt_cookies', ?1)").bind(norm).run()
  return c.json({ ok: true })
})

// status pro painel — NÃO devolve os cookies em si
admin.get('/yt-cookies/status', async (c) => {
  const row = await c.env.DB.prepare("SELECT length(v) n FROM config WHERE k = 'yt_cookies'").first<{ n: number }>()
  return c.json({ configurado: Boolean(row), tamanho: row?.n ?? 0 })
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

// Job que falhou volta pra fila com um clique (↻ no painel) — o caso típico
// é link do YouTube após renovar os cookies. Acorda a fábrica na sequência.
admin.post('/jobs/:id/retry', async (c) => {
  const r = await c.env.DB.prepare(
    `UPDATE ingest_jobs SET status = 'queued', error = NULL, progress = 0, updated_at = unixepoch()
     WHERE id = ?1 AND status = 'error'`,
  ).bind(c.req.param('id')).run()
  if ((r.meta.changes ?? 0) === 0) return c.json({ error: 'job não está em erro' }, 404)
  c.executionCtx.waitUntil(dispatchFabrica(c.env))
  return c.json({ ok: true })
})

// Cancela um job (✕ no painel): tira da fila (queued) ou descarta um em erro.
// Num job 'processing' o runner do Actions pode já estar baixando — a linha
// some da fila mesmo assim, e o /done dele passa a responder 404 (inofensivo;
// ver o handler abaixo). Deletar a linha (em vez de um status 'cancelado' novo)
// evita migração do CHECK de status. Job já 'done' virou mídia → recusa e manda
// remover pelo catálogo. Limpa o staging no R2 se o job tinha upload.
admin.post('/jobs/:id/cancel', async (c) => {
  const id = c.req.param('id')
  const job = await c.env.DB.prepare('SELECT status, staging_key FROM ingest_jobs WHERE id = ?1')
    .bind(id).first<{ status: string; staging_key: string | null }>()
  if (!job) return c.json({ error: 'job não existe' }, 404)
  if (job.status === 'done') return c.json({ error: 'job já concluído — remova a mídia pelo catálogo' }, 409)
  await c.env.DB.prepare('DELETE FROM ingest_jobs WHERE id = ?1').bind(id).run()
  if (job.staging_key) await c.env.MEDIA.delete(job.staging_key) // libera o upload no R2
  return c.json({ ok: true, era: job.status })
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
  if (ok) {
    if (job.staging_key) await c.env.MEDIA.delete(job.staging_key) // job de link não tem staging
    // comercial/vinheta recém-ingerido com transcrição → o LLM propõe a
    // promessa em background (fase 12); com promessa detectada, a peça fica
    // fora do rodízio até o operador confirmar no painel
    c.executionCtx.waitUntil(extraiPromessa(c.env, id))
  }
  return c.json({ ok: true })
})

// ── ingestão de playlist (episódios em partes) ──────────────────────────────
// Playlist do YouTube onde cada episódio vem partido em pedaços de ~4min. O
// fluxo: analisar (a fábrica lista os títulos) → o Worker classifica por TÍTULO
// (nunca pela posição!) e propõe o agrupamento → o operador revisa e confirma →
// nasce 1 job por episódio, cada um com as partes ordenadas (source_urls). A
// fábrica baixa em ordem, concatena cru e o pipeline normaliza uma vez só.

// classifica os títulos crus (LLM+regex) e grava o agrupamento — roda em
// waitUntil (o LLM demora), igual à extração de promessas; erro cai em 'error'
async function analisaPlaylist(env: Bindings, id: string): Promise<void> {
  const row = await env.DB.prepare(
    'SELECT entries, series_id, temporada FROM playlist_ingests WHERE id = ?1',
  ).bind(id).first<{ entries: string; series_id: string | null; temporada: number | null }>()
  if (!row) return
  try {
    const entries = JSON.parse(row.entries ?? '[]') as Entry[]
    if (!Array.isArray(entries) || entries.length === 0) {
      await env.DB.prepare("UPDATE playlist_ingests SET status='error', error='playlist vazia ou não listada', updated_at=unixepoch() WHERE id = ?1").bind(id).run()
      return
    }
    const grupos = await montaGrupos(env, entries, {
      series_id: row.series_id ?? undefined,
      temporada: row.temporada,
    })
    await env.DB.prepare(
      "UPDATE playlist_ingests SET status='revisar', grupos=?2, error=NULL, updated_at=unixepoch() WHERE id = ?1",
    ).bind(id, JSON.stringify(grupos)).run()
  } catch (e) {
    await env.DB.prepare("UPDATE playlist_ingests SET status='error', error=?2, updated_at=unixepoch() WHERE id = ?1")
      .bind(id, `classificação falhou: ${String((e as Error)?.message ?? e).slice(0, 300)}`).run()
  }
}

// operador cola o link da playlist → cria a análise (a fábrica lista depois)
admin.post('/playlist', async (c) => {
  const b = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!b) return c.json({ error: 'JSON inválido' }, 400)
  const url = String(b.url ?? '').trim()
  if (!/^https?:\/\//.test(url)) return c.json({ error: 'link inválido (precisa começar com http/https)' }, 400)
  if (!/[?&]list=/.test(url)) return c.json({ error: 'esse link não é de playlist (falta o "list=" na URL)' }, 400)
  const tipo = String(b.tipo ?? 'episodio')
  if (!TIPOS.includes(tipo)) return c.json({ error: 'tipo inválido' }, 400)

  const canais = String(b.canais ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (canais.length === 0) return c.json({ error: 'escolha pelo menos um canal' }, 400)
  const validos = await channelIds(c.env.DB)
  for (const canal of canais) {
    if (!validos.includes(canal)) return c.json({ error: `canal desconhecido: ${canal}` }, 400)
  }

  const serieSlug = b.series_id ? slugSerie(String(b.series_id)) : ''
  if (String(b.series_id ?? '').trim() && !SLUG.test(serieSlug)) {
    return c.json({ error: 'série inválida — use pelo menos 2 letras/números' }, 400)
  }
  const temporada = Number(b.temporada)
  const temp = Number.isFinite(temporada) && temporada > 0 ? Math.floor(temporada) : null

  const id = `pl_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`
  await c.env.DB.prepare(
    `INSERT INTO playlist_ingests (id, url, tipo, canais, series_id, temporada)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).bind(id, url, tipo, canais.join(','), serieSlug || null, temp).run()
  c.executionCtx.waitUntil(dispatchFabrica(c.env))
  return c.json({ ok: true, id }, 201)
})

// a fábrica reivindica uma análise pra listar (self-heal: análise presa em
// 'analisando' por >10min volta pra fila — listagem é rápida)
admin.post('/playlist/claim', async (c) => {
  await c.env.DB.prepare(
    "UPDATE playlist_ingests SET status='listando', updated_at=unixepoch() WHERE status='analisando' AND updated_at < unixepoch() - 600",
  ).run()
  const row = await c.env.DB.prepare(
    `UPDATE playlist_ingests SET status='analisando', updated_at=unixepoch()
     WHERE id = (SELECT id FROM playlist_ingests WHERE status='listando' ORDER BY created_at LIMIT 1)
     RETURNING id, url, tipo, canais, series_id, temporada`,
  ).first()
  return row ? c.json(row) : c.body(null, 204)
})

// a fábrica devolve os títulos crus → responde rápido e classifica em background
admin.post('/playlist/:id/entries', async (c) => {
  const id = c.req.param('id')
  const b = await c.req.json<{ entries?: Entry[] }>().catch(() => ({ entries: [] as Entry[] }))
  const raw = Array.isArray(b.entries) ? b.entries : []
  const entries: Entry[] = raw
    .filter((e) => e && e.video_id && e.url)
    .map((e, i) => ({
      video_id: String(e.video_id).slice(0, 40),
      url: String(e.url).slice(0, 500),
      title: String(e.title ?? '').slice(0, 300),
      playlist_index: Number.isFinite(Number(e.playlist_index)) ? Number(e.playlist_index) : i,
    }))
  const exists = await c.env.DB.prepare('SELECT id FROM playlist_ingests WHERE id = ?1').bind(id).first()
  if (!exists) return c.json({ error: 'análise não encontrada' }, 404)
  await c.env.DB.prepare(
    "UPDATE playlist_ingests SET entries=?2, status='analisando', updated_at=unixepoch() WHERE id = ?1",
  ).bind(id, JSON.stringify(entries)).run()
  // classifica na hora (a fábrica não tem pressa e o waitUntil não é confiável
  // pra trabalho longo no dev/miniflare) — analisaPlaylist trata o próprio erro
  await analisaPlaylist(c.env, id)
  return c.json({ ok: true, recebidos: entries.length })
})

// a fábrica reporta falha de listagem (yt-dlp barrado, playlist privada etc.)
admin.post('/playlist/:id/error', async (c) => {
  const { error } = await c.req.json<{ error?: string }>().catch(() => ({ error: '' }))
  const r = await c.env.DB.prepare(
    "UPDATE playlist_ingests SET status='error', error=?2, updated_at=unixepoch() WHERE id = ?1",
  ).bind(c.req.param('id'), String(error ?? 'falha na listagem').slice(0, 500)).run()
  if ((r.meta.changes ?? 0) === 0) return c.json({ error: 'análise não encontrada' }, 404)
  return c.json({ ok: true })
})

// lista as análises pro painel (sem o `entries` cru, que é grande)
admin.get('/playlist', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, url, tipo, canais, series_id, temporada, status, grupos, error, created_at, updated_at
     FROM playlist_ingests ORDER BY created_at DESC LIMIT 20`,
  ).all()
  return c.json(results)
})

// operador confirma → cria 1 job por episódio ESCOLHIDO, cada um com as partes
// ordenadas. Só episódios OK (partes 1..N completas) viram job — episódio com
// buraco/duplicata é PULADO e reportado (nunca junta errado em silêncio).
admin.post('/playlist/:id/confirmar', async (c) => {
  const id = c.req.param('id')
  const b = await c.req.json<{ episodios?: number[]; series_id?: string; temporada?: number }>()
    .catch(() => ({} as { episodios?: number[]; series_id?: string; temporada?: number }))
  const row = await c.env.DB.prepare(
    "SELECT tipo, canais, series_id, temporada, grupos, status FROM playlist_ingests WHERE id = ?1",
  ).bind(id).first<{ tipo: string; canais: string; series_id: string | null; temporada: number | null; grupos: string | null; status: string }>()
  if (!row) return c.json({ error: 'análise não encontrada' }, 404)
  if (!row.grupos) return c.json({ error: 'análise ainda não terminou — aguarde a revisão' }, 409)

  let grupos: Grupos
  try { grupos = JSON.parse(row.grupos) } catch { return c.json({ error: 'agrupamento corrompido — reanalise' }, 500) }

  // série/temporada podem ter sido ajustadas na revisão → recalculam os ids
  const serieSlug = b.series_id ? slugSerie(String(b.series_id)) : (grupos.series_id ?? '')
  if (!serieSlug || !SLUG.test(serieSlug)) return c.json({ error: 'informe a série (slug válido) antes de confirmar' }, 400)
  const temp = b.temporada != null
    ? (Number(b.temporada) > 0 ? Math.floor(Number(b.temporada)) : null)
    : grupos.temporada

  const canais = row.canais.split(',').map((s) => s.trim()).filter(Boolean)
  const escolhidos = Array.isArray(b.episodios) && b.episodios.length
    ? new Set(b.episodios.map(Number))
    : null // null = todos os OK

  const criados: string[] = []
  const pulados: { episodio: number; motivo: string }[] = []
  for (const ep of grupos.episodios) {
    if (escolhidos && !escolhidos.has(ep.episodio)) continue
    if (!ep.ok) { pulados.push({ episodio: ep.episodio, motivo: ep.aviso ?? 'partes incompletas' }); continue }
    const mediaId = mediaIdDe(serieSlug, temp, ep.episodio)
    const dup = await c.env.DB.prepare(
      'SELECT id FROM media_items WHERE id = ?1 UNION SELECT id FROM ingest_jobs WHERE id = ?1',
    ).bind(mediaId).first()
    if (dup) { pulados.push({ episodio: ep.episodio, motivo: `id "${mediaId}" já existe` }); continue }
    const urls = ep.partes.map((p) => p.url)
    await c.env.DB.prepare(
      `INSERT INTO ingest_jobs (id, staging_key, original_name, tipo, title, series_id, episode, tags, canais, source_url, source_urls)
       VALUES (?1, '', ?2, ?3, ?4, ?5, ?6, '', ?7, NULL, ?8)`,
    ).bind(
      mediaId, `${mediaId}.mp4`, row.tipo, ep.titulo, serieSlug, ep.episodio,
      canais.join(','), JSON.stringify(urls),
    ).run()
    criados.push(mediaId)
  }

  await c.env.DB.prepare("UPDATE playlist_ingests SET status='confirmado', updated_at=unixepoch() WHERE id = ?1").bind(id).run()
  if (criados.length) c.executionCtx.waitUntil(dispatchFabrica(c.env))
  return c.json({ ok: true, criados, pulados })
})

// ── promessas de comerciais (fase 12) ──────────────────────────────────────

admin.get('/promessas', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.media_id, p.transcript, p.proposta, p.condicao, p.status, p.updated_at,
            m.tipo, m.metadata, m.status media_status
     FROM media_promises p JOIN media_items m ON m.id = p.media_id
     ORDER BY CASE p.status WHEN 'pendente' THEN 0 ELSE 1 END, p.updated_at DESC`,
  ).all()
  return c.json(results)
})

// backfill / fábrica: grava a transcrição e já dispara a análise
admin.post('/promessas/:id/transcript', async (c) => {
  const { transcript } = await c.req.json<{ transcript?: string }>().catch(() => ({ transcript: '' }))
  const id = c.req.param('id')
  if (!transcript?.trim()) return c.json({ error: 'transcript vazio' }, 400)
  const m = await c.env.DB.prepare('SELECT id FROM media_items WHERE id = ?1').bind(id).first()
  if (!m) return c.json({ error: 'mídia não encontrada' }, 404)
  await salvaTranscript(c.env, id, transcript)
  await extraiPromessa(c.env, id)
  return c.json({ ok: true })
})

admin.post('/promessas/:id/extrair', async (c) => {
  await extraiPromessa(c.env, c.req.param('id'))
  return c.json({ ok: true })
})

admin.post('/promessas/:id/decidir', async (c) => {
  const b = await c.req.json<{ status?: string; condicao?: Proposta }>().catch(() => ({} as { status?: string; condicao?: Proposta }))
  const id = c.req.param('id')
  const status = String(b.status ?? '')
  if (!['confirmada', 'generico', 'ignorar', 'pendente'].includes(status)) {
    return c.json({ error: 'status inválido' }, 400)
  }
  let condicao: string | null = null
  if (status === 'confirmada') {
    const cd = b.condicao
    if (!cd || !['a_seguir', 'durante', 'bloco_horario', 'evento'].includes(cd.tipo)) {
      return c.json({ error: 'confirmar exige a condição (tipo da promessa)' }, 400)
    }
    if (cd.tipo === 'a_seguir' || cd.tipo === 'durante') {
      // sem série alvo não há como cumprir — melhor "ignorar" que prometer no escuro
      if (!cd.series_id || !SLUG.test(cd.series_id)) {
        return c.json({ error: `promessa "${cd.tipo === 'durante' ? 'você está vendo' : 'a seguir'}" precisa de uma série alvo válida` }, 400)
      }
      // o alvo precisa ser série de CONTEÚDO — "a seguir" toca colado num
      // episódio/filme; série de comerciais nunca aparece como programa
      const existe = await c.env.DB.prepare(
        `SELECT 1 FROM media_items
         WHERE json_extract(metadata,'$.series_id') = ?1 AND status = 'ready'
           AND tipo IN ('episodio','filme') LIMIT 1`,
      ).bind(cd.series_id).first()
      if (!existe) {
        return c.json({ error: `"${cd.series_id}" não tem episódio/filme pronto — agrupe os episódios da série alvo no catálogo primeiro` }, 400)
      }
    }
    // hora/dias são o CORPO da promessa de horário — sem eles a condição vale
    // pela série só, e a peça destrava numa faixa que não é a anunciada.
    let hora: string | null = null
    if (cd.hora != null && String(cd.hora).trim() !== '') {
      const h = String(cd.hora).trim()
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(h)) return c.json({ error: 'hora deve ser HH:MM' }, 400)
      hora = h
    }
    let dias: number[] | null = null
    if (cd.dias != null) {
      if (!Array.isArray(cd.dias) || !cd.dias.every((n) => Number.isInteger(n) && n >= 1 && n <= 7)) {
        return c.json({ error: 'dias deve ser lista ISO 1..7 (1=seg, 7=dom)' }, 400)
      }
      dias = [...new Set(cd.dias as number[])].sort()
    }
    condicao = JSON.stringify({
      tipo: cd.tipo, series_id: cd.series_id ?? null, descricao: cd.descricao ?? '', hora, dias,
    })
  }
  const r = await c.env.DB.prepare(
    `UPDATE media_promises SET status = ?2, condicao = ?3, updated_at = unixepoch() WHERE media_id = ?1`,
  ).bind(id, status, condicao).run()
  if ((r.meta.changes ?? 0) === 0) return c.json({ error: 'promessa não encontrada' }, 404)

  // o pool de comerciais mudou — replaneja os canais da mídia
  const { results: chs } = await c.env.DB.prepare(
    'SELECT DISTINCT channel_id ch FROM media_channels WHERE media_id = ?1',
  ).bind(id).all<{ ch: string }>()
  for (const r2 of chs) await scheduleChannel(c.env, r2.ch, 48, true)
  return c.json({ ok: true, canais_replanejados: chs.map((x) => x.ch) })
})

// ── catálogo ───────────────────────────────────────────────────────────────

// Nome ruim = candidato à área "A nomear" do painel: título só numérico,
// curto demais, ou aquele amasso de consoantes sem espaço dos rips antigos
// ("AVDAEASAVNTSDJNPRLET03EP14"). metadata.nome_ok=true dispensa (falso
// positivo confirmado pelo operador); renomear de verdade sai da fila sozinho.
export function nomeRuim(title: string): boolean {
  const t = (title ?? '').trim()
  if (t.length < 4) return true
  if (/^[\d\s._-]+$/.test(t)) return true                 // "34", "12-1"
  const letras = t.replace(/[^a-zA-ZÀ-ÿ]/g, '')
  if (letras.length === 0) return true
  const vogais = (letras.match(/[aeiouáéíóúâêôãõAEIOUÁÉÍÓÚÂÊÔÃÕ]/g) ?? []).length
  if (letras.length >= 10 && vogais / letras.length < 0.28) return true // consoantes emendadas
  if (t.length >= 14 && !t.includes(' ')) return true      // palavrão colado sem espaços
  return false
}

admin.get('/media', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.tipo, m.status, m.duracao_seg, m.segment_count, m.metadata, m.created_at,
            (SELECT GROUP_CONCAT(channel_id) FROM media_channels mc WHERE mc.media_id = m.id) AS canais
     FROM media_items m ORDER BY m.created_at DESC LIMIT 200`,
  ).all<{ metadata: string } & Record<string, unknown>>()
  return c.json(results.map((m) => {
    let meta: Record<string, unknown> = {}
    try { meta = JSON.parse(m.metadata) } catch { /* segue */ }
    const title = String(meta.title ?? m.id)
    return { ...m, nome_ruim: !meta.nome_ok && nomeRuim(title) }
  }))
})

// renomear manual (área "A nomear"): título/série/episódio de uma vez —
// título muda na grade na hora (o EPG lê por join), nada a replanejar
admin.post('/media/:id/renomear', async (c) => {
  const b = await c.req.json<{ title?: string; series_id?: string; episode?: number | string }>().catch(() => null)
  if (!b?.title?.trim()) return c.json({ error: 'title é obrigatório' }, 400)
  const id = c.req.param('id')
  const row = await c.env.DB.prepare('SELECT metadata FROM media_items WHERE id = ?1').bind(id).first<{ metadata: string }>()
  if (!row) return c.json({ error: 'mídia não encontrada' }, 404)
  let meta: Record<string, unknown> = {}
  try { meta = JSON.parse(row.metadata) } catch { /* recomeça limpo */ }
  meta.title = b.title.trim().slice(0, 140)
  const slug = slugify(String(b.series_id ?? ''))
  if (String(b.series_id ?? '').trim() && !SLUG.test(slug)) {
    return c.json({ error: 'série inválida — use pelo menos 2 letras/números' }, 400)
  }
  if (slug) meta.series_id = slug
  else delete meta.series_id
  const ep = Number(b.episode)
  if (Number.isFinite(ep) && ep > 0) meta.episode = ep
  else delete meta.episode
  delete meta.nome_ok // nome novo se defende sozinho na heurística
  await c.env.DB.prepare('UPDATE media_items SET metadata = ?2 WHERE id = ?1').bind(id, JSON.stringify(meta)).run()
  return c.json({ ok: true })
})

// 11c: o Gemini propõe nomes pro LOTE inteiro numa chamada só, guiado pelo
// contexto livre do operador ("são episódios de Padrinhos Mágicos T3, da
// Record"). Devolve propostas — quem grava é o operador, campo a campo.
admin.post('/media/nomear-sugestoes', async (c) => {
  const b = await c.req.json<{ ids?: string[]; contexto?: string }>().catch(() => null)
  const ids = (b?.ids ?? []).filter((i) => /^[a-z0-9_]{3,40}$/.test(String(i))).slice(0, 40)
  if (ids.length === 0) return c.json({ error: 'informe os ids' }, 400)

  const inList = ids.map((i) => `'${i}'`).join(',')
  const { results: itens } = await c.env.DB.prepare(
    `SELECT id, tipo, duracao_seg, metadata FROM media_items WHERE id IN (${inList})`,
  ).all<{ id: string; tipo: string; duracao_seg: number; metadata: string }>()
  const { results: series } = await c.env.DB.prepare(
    `SELECT DISTINCT json_extract(metadata,'$.series_id') sid, MIN(json_extract(metadata,'$.title')) t
     FROM media_items WHERE json_extract(metadata,'$.series_id') IS NOT NULL GROUP BY sid`,
  ).all<{ sid: string; t: string }>()

  const linhas = itens.map((m) => {
    let t = m.id
    try { t = JSON.parse(m.metadata).title ?? m.id } catch { /* segue */ }
    return `${m.id} | título atual: "${t}" | ${m.tipo} | ${Math.round(m.duracao_seg / 60)}min`
  })
  const system = `Você organiza o catálogo de uma TV nostálgica pessoal. Para CADA item da lista, proponha:
- "title": título limpo e bonito em português, como apareceria num guia de TV (ex.: "Padrinhos Mágicos — T3 Ep 14"). Deduza do id/título atual + contexto do operador. Números no fim do id geralmente são temporada/episódio.
- "series_id": slug minúsculo/underscore da série (use um da lista de séries EXISTENTES se for a mesma série; senão crie um slug novo coerente, ex.: "padrinhos_magicos").
- "episode": número do episódio (ou null).
- "confianca": 0 a 1.
Responda APENAS o JSON {"itens":[{"id","title","series_id","episode","confianca"}]}.

CONTEXTO DO OPERADOR (a fonte da verdade sobre o que é este lote):
"""${(b?.contexto ?? '').slice(0, 1000) || '(nenhum — deduza dos nomes)'}"""

SÉRIES EXISTENTES: ${series.filter((s) => s.sid).map((s) => `${s.sid} (${s.t})`).join(', ') || '(nenhuma)'}`

  const schema = {
    type: 'OBJECT',
    properties: {
      itens: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            id: { type: 'STRING' }, title: { type: 'STRING' },
            series_id: { type: 'STRING' }, episode: { type: 'NUMBER' }, confianca: { type: 'NUMBER' },
          },
          required: ['id', 'title'],
        },
      },
    },
    required: ['itens'],
  }
  const out = await pedeJson(c.env, system, `ITENS:\n${linhas.join('\n')}`, schema)
  if (!out) return c.json({ error: 'IA indisponível agora — renomeie na mão ou tente de novo' }, 503)
  const validos = new Set(itens.map((m) => m.id))
  const sugestoes = (out.json?.itens ?? [])
    .filter((s: any) => validos.has(s?.id) && s?.title)
    .map((s: any) => {
      let episode = Number.isFinite(Number(s.episode)) && Number(s.episode) > 0 ? Number(s.episode) : null
      // retaguarda: o LLM às vezes escreve "Ep 34" no título e deixa o campo
      // vazio — o número está ali, é só pescar (título primeiro, depois o id)
      if (!episode) {
        const m = String(s.title).match(/ep\.?\s*0*(\d{1,4})\b/i) ?? String(s.id).match(/ep0*(\d{1,4})$/i)
        if (m) episode = Number(m[1])
      }
      return {
        id: s.id,
        title: String(s.title).slice(0, 140),
        series_id: SLUG.test(String(s.series_id ?? '')) ? s.series_id : null,
        episode,
        confianca: Math.max(0, Math.min(1, Number(s.confianca ?? 0))),
      }
    })
  return c.json({ sugestoes, provedor: out.provedor })
})

// "esse nome está bom sim" — dispensa o falso positivo da fila
admin.post('/media/:id/nome-ok', async (c) => {
  const id = c.req.param('id')
  const row = await c.env.DB.prepare('SELECT metadata FROM media_items WHERE id = ?1').bind(id).first<{ metadata: string }>()
  if (!row) return c.json({ error: 'mídia não encontrada' }, 404)
  let meta: Record<string, unknown> = {}
  try { meta = JSON.parse(row.metadata) } catch { /* recomeça limpo */ }
  meta.nome_ok = true
  await c.env.DB.prepare('UPDATE media_items SET metadata = ?2 WHERE id = ?1').bind(id, JSON.stringify(meta)).run()
  return c.json({ ok: true })
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
  const slug = slugify(series_id ?? '')
  if ((series_id ?? '').trim() && !SLUG.test(slug)) {
    return c.json({ error: 'série inválida — use pelo menos 2 letras/números' }, 400)
  }
  if (slug) meta.series_id = slug
  else delete meta.series_id
  await c.env.DB.prepare('UPDATE media_items SET metadata = ?2 WHERE id = ?1').bind(id, JSON.stringify(meta)).run()
  return c.json({ ok: true })
})

// Reclassificação: "compilado de comerciais" que entrou como episódio vira
// comercial (sai da rotação de programas e entra no pool de intervalos) —
// e vice-versa. A grade se corrige na hora: blocos futuros somem e os
// canais são replanejados.
admin.post('/media/:id/tipo', async (c) => {
  const { tipo } = await c.req.json<{ tipo?: string }>().catch(() => ({ tipo: '' }))
  if (!TIPOS.includes(String(tipo))) return c.json({ error: 'tipo inválido' }, 400)
  const id = c.req.param('id')
  const r = await c.env.DB.prepare('UPDATE media_items SET tipo = ?2 WHERE id = ?1').bind(id, tipo).run()
  if ((r.meta.changes ?? 0) === 0) return c.json({ error: 'mídia não encontrada' }, 404)
  const agora = Math.floor(Date.now() / 1000)
  await c.env.DB.prepare('DELETE FROM epg_virtual WHERE media_id = ?1 AND start_time_virtual > ?2')
    .bind(id, agora).run()
  const { results: chs } = await c.env.DB.prepare(
    'SELECT DISTINCT channel_id ch FROM media_channels WHERE media_id = ?1',
  ).bind(id).all<{ ch: string }>()
  for (const r2 of chs) await scheduleChannel(c.env, r2.ch, 48, true)
  return c.json({ ok: true, canais_replanejados: chs.map((x) => x.ch) })
})

// Muda o status de N mídias e replaneja cada canal afetado UMA vez — mesmo
// padrão do `aplicaCanais` logo acima, e pelo mesmo motivo.
//
// ⚠️ REPLAN É CARO. `epg_virtual` tem 5 índices, então cada linha custa 6
// escritas (tabela + índices); com ~1.100 linhas futuras por canal, um replan
// (delete + insert) sai por ~13 mil linhas. O teto diário do D1 free tier é
// 100 mil.
//
// Medido em 22/09/2026: um laço de 19 peças do MESMO canal pelo endpoint
// antigo (que replanejava por chamada) escreveu 397 mil linhas numa hora —
// quatro dias de orçamento, pra fazer o que um replan faria. A fábrica ficou
// parada o dia inteiro e 33 episódios não ingeriram. Daí o lote.
async function aplicaStatus(
  env: { DB: D1Database; MEDIA: R2Bucket },
  mediaIds: string[],
  status: 'ready' | 'disabled',
): Promise<string[]> {
  if (mediaIds.length === 0) return []
  const afetados = new Set<string>()
  const now = Math.floor(Date.now() / 1000)
  for (const id of mediaIds) {
    await env.DB.prepare('UPDATE media_items SET status = ?2 WHERE id = ?1').bind(id, status).run()
    if (status !== 'disabled') continue
    // sai da grade futura já agendada; o replan vem depois, uma vez por canal
    await env.DB.prepare('DELETE FROM epg_virtual WHERE media_id = ?1 AND start_time_virtual > ?2')
      .bind(id, now).run()
    const { results } = await env.DB.prepare(
      'SELECT DISTINCT channel_id ch FROM media_channels WHERE media_id = ?1',
    ).bind(id).all<{ ch: string }>()
    for (const r of results) afetados.add(r.ch)
  }
  for (const ch of afetados) await scheduleChannel(env, ch, 48, true)
  return [...afetados]
}

admin.post('/media/:id/status', async (c) => {
  const { status } = await c.req.json<{ status: string }>().catch(() => ({ status: '' }))
  if (!['ready', 'disabled'].includes(status)) return c.json({ error: 'status inválido' }, 400)
  const canais = await aplicaStatus(c.env, [c.req.param('id')], status as 'ready' | 'disabled')
  return c.json({ ok: true, canais_replanejados: canais })
})

// Versão em LOTE: desativar N peças custa o mesmo replan que desativar uma.
// Use esta em qualquer limpeza — ver o aviso de custo no `aplicaStatus`.
admin.post('/media/status', async (c) => {
  type Corpo = { ids?: string[]; status?: string }
  const b = await c.req.json<Corpo>().catch(() => ({} as Corpo))
  const status = String(b.status ?? '')
  if (!['ready', 'disabled'].includes(status)) return c.json({ error: 'status inválido' }, 400)
  const ids = Array.isArray(b.ids) ? b.ids.filter((x: unknown): x is string => typeof x === 'string' && !!x) : null
  if (!ids || ids.length === 0) return c.json({ error: 'ids deve ser uma lista não vazia' }, 400)
  if (ids.length > 200) return c.json({ error: 'no máximo 200 por chamada' }, 400)
  const canais = await aplicaStatus(c.env, ids, status as 'ready' | 'disabled')
  return c.json({ ok: true, mudados: ids.length, canais_replanejados: canais })
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
  // O teto é 120 porque id de peça recortada é descritivo e passa fácil de 40
  // ("com_cn_invasao_referencia_cn_programacao_andy_esquilo_…" tem 83): com o
  // limite antigo a exclusão morria com 500 em 115 mídias do acervo — bug
  // encontrado em 16/09/2026 na limpeza dos rebaixados. O que a trava tem que
  // barrar é prefixo VAZIO ou fora de `media/`, não id comprido.
  if (!/^media\/[a-z0-9_]{3,120}$/.test(m.path_prefix)) {
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
    // `instr` em vez de LIKE: o D1 recusa padrão LIKE com mais de 50 caracteres
    // ("LIKE or GLOB pattern too complex"), e `%"<id>"%` passa disso com id de
    // 47+ chars — que é o caso das peças recortadas (nome descritivo). Custou
    // 500 silencioso na exclusão de 3 mídias em 16/09/2026; `instr` não tem
    // limite de tamanho e faz a mesma busca literal.
    c.env.DB.prepare("UPDATE directives SET status = 'cancelada' WHERE status = 'ativa' AND instr(payload, '\"' || ?1 || '\"') > 0").bind(id),
    c.env.DB.prepare('DELETE FROM ingest_jobs WHERE id = ?1').bind(id),
    c.env.DB.prepare('DELETE FROM upload_parts WHERE session_id IN (SELECT id FROM upload_sessions WHERE media_id = ?1)').bind(id),
    c.env.DB.prepare('DELETE FROM upload_sessions WHERE media_id = ?1').bind(id),
    c.env.DB.prepare('DELETE FROM media_promises WHERE media_id = ?1').bind(id), // FK: fase 12
    c.env.DB.prepare('DELETE FROM media_items WHERE id = ?1').bind(id),
  ])

  // o pool desses canais mudou — replaneja (append-only, bloco no ar intacto)
  for (const r of canais) await scheduleChannel(c.env, r.ch, 48, true)

  return c.json({ ok: true, segmentos_apagados: segmentosApagados, canais_replanejados: canais.map((r) => r.ch) })
})

// Troca os canais de UMA mídia — e conserta a grade na hora: canal REMOVIDO
// tem os blocos futuros da mídia apagados e é replanejado (antes, a mídia
// "removida" continuava passando até o próximo replanejo — errado).
async function aplicaCanais(env: { DB: D1Database; MEDIA: R2Bucket }, mediaIds: string[], channels: string[]) {
  const agora = Math.floor(Date.now() / 1000)
  const afetados = new Set<string>()
  for (const id of mediaIds) {
    const { results: antes } = await env.DB.prepare(
      'SELECT channel_id ch FROM media_channels WHERE media_id = ?1',
    ).bind(id).all<{ ch: string }>()
    const velhos = antes.map((r) => r.ch)
    const removidos = velhos.filter((ch) => !channels.includes(ch))

    await env.DB.prepare('DELETE FROM media_channels WHERE media_id = ?1').bind(id).run()
    for (const canal of channels) {
      await env.DB.prepare('INSERT OR IGNORE INTO media_channels (media_id, channel_id) VALUES (?1, ?2)')
        .bind(id, canal).run()
    }
    for (const ch of removidos) {
      await env.DB.prepare(
        'DELETE FROM epg_virtual WHERE canal = ?1 AND media_id = ?2 AND start_time_virtual > ?3',
      ).bind(ch, id, agora).run()
      afetados.add(ch)
    }
    for (const ch of channels.filter((x) => !velhos.includes(x))) afetados.add(ch)
  }
  for (const ch of afetados) await scheduleChannel(env, ch, 48, true)
  return [...afetados]
}

admin.post('/media/:id/channels', async (c) => {
  const { channels } = await c.req.json<{ channels: string[] }>().catch(() => ({ channels: null as unknown as string[] }))
  if (!Array.isArray(channels)) return c.json({ error: 'channels deve ser uma lista' }, 400)
  const validos = await channelIds(c.env.DB)
  for (const canal of channels) {
    if (!validos.includes(canal)) return c.json({ error: `canal desconhecido: ${canal}` }, 400)
  }
  const replanejados = await aplicaCanais(c.env, [c.req.param('id')], channels)
  return c.json({ ok: true, canais_replanejados: replanejados })
})

// Correção em LOTE: aplica os canais a TODOS os episódios de uma série de
// uma vez ("adicionei a temporada no canal errado" → um clique conserta).
admin.post('/series/:sid/channels', async (c) => {
  const sid = c.req.param('sid')
  if (!SLUG.test(sid)) return c.json({ error: 'série inválida' }, 400)
  const { channels } = await c.req.json<{ channels: string[] }>().catch(() => ({ channels: null as unknown as string[] }))
  if (!Array.isArray(channels)) return c.json({ error: 'channels deve ser uma lista' }, 400)
  const validos = await channelIds(c.env.DB)
  for (const canal of channels) {
    if (!validos.includes(canal)) return c.json({ error: `canal desconhecido: ${canal}` }, 400)
  }
  const { results } = await c.env.DB.prepare(
    `SELECT id FROM media_items WHERE json_extract(metadata,'$.series_id') = ?1`,
  ).bind(sid).all<{ id: string }>()
  if (results.length === 0) return c.json({ error: 'nenhuma mídia com essa série' }, 404)
  const replanejados = await aplicaCanais(c.env, results.map((r) => r.id), channels)
  return c.json({ ok: true, midias: results.length, canais_replanejados: replanejados })
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
  if (typeof b.comerciais_fieis === 'number') campos.push(['comerciais_fieis', b.comerciais_fieis ? 1 : 0])
  // episódios por bloco: 1 (sem agrupar) a 8 (blocão); fora disso, fixa no limite
  if (typeof b.episodios_por_bloco === 'number')
    campos.push(['episodios_por_bloco', Math.max(1, Math.min(8, Math.round(b.episodios_por_bloco)))])
  if (campos.length === 0) return c.json({ error: 'nada pra atualizar' }, 400)
  const sets = campos.map(([k], i) => `${k} = ?${i + 2}`).join(', ')
  await c.env.DB.prepare(`UPDATE channels SET ${sets} WHERE id = ?1`)
    .bind(id, ...campos.map(([, v]) => v)).run()
  // trocar o modo fiel/livre ou o tamanho do bloco muda a grade — replaneja já
  if (campos.some(([k]) => k === 'comerciais_fieis' || k === 'episodios_por_bloco'))
    await scheduleChannel(c.env, id, 48, true)
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

// `lote` = quantas mídias conferir nesta passada (default no scheduler);
// `seco: true` = ensaio, diz o que cairia sem desabilitar nada.
admin.post('/reconcile', async (c) => {
  const b = await c.req.json<{ lote?: number; seco?: boolean }>().catch(() => ({}))
  const lote = Number.isFinite(Number(b?.lote)) ? Number(b?.lote) : undefined
  return c.json(await reconcileAndRepair(c.env, { lote, seco: Boolean(b?.seco) }))
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

// Fase 10a: o diretor decide a noite AGORA (mesmo cérebro do cron diário).
// forcar=true = "quero maratona hoje, escolha a melhor" (pula o "hoje não").
admin.post('/diretor/planejar', async (c) => {
  const b = await c.req.json<{ canal?: string; forcar?: boolean }>().catch(() => ({} as { canal?: string; forcar?: boolean }))
  if (b.canal && !SLUG.test(b.canal)) return c.json({ error: 'canal inválido' }, 400)
  const decisoes = await planejaEditorial(c.env, { canal: b.canal, forcar: Boolean(b.forcar) })
  return c.json({ decisoes })
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
  // yt_cookies fica de fora: é grande e sensível — o painel usa /yt-cookies/status
  const { results } = await c.env.DB.prepare("SELECT k, v FROM config WHERE k != 'yt_cookies'").all<{ k: string; v: string }>()
  return c.json(Object.fromEntries(results.map((r) => [r.k, r.v])))
})

admin.post('/config', async (c) => {
  const { k, v } = await c.req.json<{ k: string; v: string }>().catch(() => ({ k: '', v: '' }))
  if (!CONFIG_KEYS.includes(k)) return c.json({ error: 'chave desconhecida' }, 400)
  await c.env.DB.prepare('INSERT OR REPLACE INTO config (k, v) VALUES (?1, ?2)').bind(k, String(v)).run()
  return c.json({ ok: true })
})
