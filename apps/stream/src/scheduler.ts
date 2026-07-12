// O Diretor determinístico (fase 9): mantém a grade de cada canal sozinho.
// Roda no cron diário e sob demanda (admin/fábrica). Sempre append-only:
// nunca toca no bloco que está no ar.
import { SEGMENT_DURATION } from '@bieltv/db'

type Env = { DB: D1Database; MEDIA: R2Bucket }

interface MediaRow {
  id: string
  tipo: string
  duracao_seg: number
  segment_count: number
  last_played_at: number | null
}

export interface ScheduleReport {
  canal: string
  added: number
  skipped?: string
  until?: number
}

const DAY = 86400

// RNG com seed (canal+dia): grade reproduzível dentro do dia, variada entre dias.
function mulberry32(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashStr(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function shuffled<T>(arr: T[], rnd: () => number): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export async function scheduleChannel(
  env: Env,
  canal: string,
  hours = 48,
  rebuild = false,
): Promise<ScheduleReport> {
  const chan = await env.DB.prepare('SELECT * FROM channels WHERE id = ?1')
    .bind(canal).first<{ break_target_seg: number }>()
  if (!chan) return { canal, added: 0, skipped: 'canal não existe' }

  const { results: media } = await env.DB.prepare(
    `SELECT m.id, m.tipo, m.duracao_seg, m.segment_count, m.last_played_at
     FROM media_items m JOIN media_channels mc ON mc.media_id = m.id
     WHERE mc.channel_id = ?1 AND m.status = 'ready'`,
  ).bind(canal).all<MediaRow>()

  const contents = media.filter((m) => m.tipo === 'episodio' || m.tipo === 'filme')
  const ads = media.filter((m) => m.tipo === 'comercial')
  const vins = media.filter((m) => m.tipo === 'vinheta')
  if (contents.length === 0) return { canal, added: 0, skipped: 'sem conteúdo' }

  const { results: cueRows } = await env.DB.prepare(
    `SELECT media_id, time_seg FROM media_cue_points
     WHERE media_id IN (SELECT media_id FROM media_channels WHERE channel_id = ?1)
     ORDER BY time_seg`,
  ).bind(canal).all<{ media_id: string; time_seg: number }>()
  const cuesOf: Record<string, number[]> = {}
  for (const c of cueRows) (cuesOf[c.media_id] ??= []).push(c.time_seg)

  const now = Math.floor(Date.now() / 1000)
  const nowSlot = Math.floor(now / SEGMENT_DURATION) * SEGMENT_DURATION
  const onAir = await env.DB.prepare(
    `SELECT end_time_virtual e FROM epg_virtual
     WHERE canal = ?1 AND start_time_virtual <= ?2 AND end_time_virtual > ?2
     ORDER BY start_time_virtual LIMIT 1`,
  ).bind(canal, now).first<{ e: number }>()

  if (rebuild) {
    // replaneja o futuro preservando o bloco no ar
    const cut = onAir?.e ?? nowSlot
    await env.DB.prepare('DELETE FROM epg_virtual WHERE canal = ?1 AND start_time_virtual >= ?2')
      .bind(canal, cut).run()
  }

  const cov = await env.DB.prepare(
    'SELECT MAX(end_time_virtual) m FROM epg_virtual WHERE canal = ?1 AND end_time_virtual > ?2',
  ).bind(canal, now).first<{ m: number | null }>()

  let t = cov?.m ?? onAir?.e ?? nowSlot - 600 // canal novo entra "no ar" há 10 min
  const target = now + hours * 3600
  if (t >= target) return { canal, added: 0, until: t }

  const rnd = mulberry32(hashStr(canal + new Date().toISOString().slice(0, 10)))
  // rotação: menos-tocado primeiro; empates embaralhados pela seed do dia
  const queue = shuffled(contents, rnd).sort(
    (a, b) => (a.last_played_at ?? 0) - (b.last_played_at ?? 0),
  )
  const adPool = shuffled(ads, rnd)
  let ai = 0
  let vi = 0
  let qi = 0
  let lastAd = ''
  const rows: Array<[string, string, number, number, number]> = []
  const playedAt: Record<string, number> = {}

  const push = (m: string, s: number, e: number, seg: number) => rows.push([canal, m, s, e, seg])

  // intervalo com duração-alvo: 1..N comerciais, sem repetir o anterior
  const breakPod = () => {
    if (adPool.length === 0) return
    const alvo = chan.break_target_seg ?? 120
    let sum = 0
    let guard = 0
    while (sum < alvo && guard++ < 10) {
      let pick = adPool[ai % adPool.length]
      if (pick.id === lastAd && adPool.length > 1) {
        ai++
        pick = adPool[ai % adPool.length]
      }
      ai++
      push(pick.id, t, t + pick.duracao_seg, 0)
      t += pick.duracao_seg
      sum += pick.duracao_seg
      lastAd = pick.id
    }
  }

  while (t < target) {
    if (vins.length > 0) {
      const v = vins[vi++ % vins.length]
      push(v.id, t, t + v.duracao_seg, 0)
      t += v.duracao_seg
    }
    const c = queue[qi++ % queue.length]
    playedAt[c.id] = t
    const cues = (cuesOf[c.id] ?? []).filter((x) => x > 0 && x < c.duracao_seg)
    let pos = 0
    for (const cue of cues) {
      push(c.id, t, t + (cue - pos), pos / SEGMENT_DURATION)
      t += cue - pos
      pos = cue
      breakPod()
    }
    push(c.id, t, t + (c.duracao_seg - pos), pos / SEGMENT_DURATION)
    t += c.duracao_seg - pos
    breakPod()
  }

  // grava em lotes (ids são slugs internos validados — interpolação segura)
  for (let i = 0; i < rows.length; i += 80) {
    const values = rows
      .slice(i, i + 80)
      .map((r) => `('${r[0]}','${r[1]}',${r[2]},${r[3]},${r[4]})`)
      .join(',')
    await env.DB.prepare(
      `INSERT INTO epg_virtual (canal, media_id, start_time_virtual, end_time_virtual, segment_index_start) VALUES ${values}`,
    ).run()
  }
  for (const [id, ts] of Object.entries(playedAt)) {
    await env.DB.prepare('UPDATE media_items SET last_played_at = ?2 WHERE id = ?1')
      .bind(id, ts).run()
  }
  return { canal, added: rows.length, until: t }
}

export async function runScheduler(
  env: Env,
  opts: { canal?: string; hours?: number; rebuild?: boolean } = {},
): Promise<ScheduleReport[]> {
  const canais = opts.canal
    ? [{ id: opts.canal }]
    : (await env.DB.prepare('SELECT id FROM channels ORDER BY ordem, id').all<{ id: string }>()).results
  const reports: ScheduleReport[] = []
  for (const c of canais) {
    reports.push(await scheduleChannel(env, c.id, opts.hours ?? 48, opts.rebuild ?? false))
  }
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare('DELETE FROM epg_virtual WHERE end_time_virtual < ?1').bind(now - DAY).run()
  return reports
}

/**
 * Reconciliação catálogo ↔ R2: mídia "ready" cujos segmentos sumiram do
 * storage vira "disabled", sai da grade futura e os canais afetados são
 * replanejados (append-only). Roda no cron antes do planejamento.
 */
export async function reconcileAndRepair(env: Env) {
  const { results } = await env.DB.prepare(
    "SELECT id, path_prefix, segment_count FROM media_items WHERE status = 'ready'",
  ).all<{ id: string; path_prefix: string; segment_count: number }>()

  const disabled: string[] = []
  for (const m of results) {
    const first = await env.MEDIA.head(`${m.path_prefix}/seg00000.ts`)
    const last = await env.MEDIA.head(
      `${m.path_prefix}/seg${String(m.segment_count - 1).padStart(5, '0')}.ts`,
    )
    if (!first || !last) disabled.push(m.id)
  }

  const repaired: string[] = []
  if (disabled.length > 0) {
    const inList = disabled.map((id) => `'${id}'`).join(',')
    await env.DB.prepare(`UPDATE media_items SET status='disabled' WHERE id IN (${inList})`).run()
    const now = Math.floor(Date.now() / 1000)
    await env.DB.prepare(
      `DELETE FROM epg_virtual WHERE media_id IN (${inList}) AND start_time_virtual > ?1`,
    ).bind(now).run()
    const { results: chans } = await env.DB.prepare(
      `SELECT DISTINCT channel_id c FROM media_channels WHERE media_id IN (${inList})`,
    ).all<{ c: string }>()
    for (const ch of chans) {
      await scheduleChannel(env, ch.c, 48, true)
      repaired.push(ch.c)
    }
  }

  await env.DB.prepare("INSERT OR REPLACE INTO config (k, v) VALUES ('last_reconcile', ?1)")
    .bind(JSON.stringify({ at: Math.floor(Date.now() / 1000), disabled, repaired }))
    .run()
  return { disabled, repaired }
}
