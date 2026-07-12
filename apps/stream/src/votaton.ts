import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { spToEpoch, epochToSp } from './diretor'
import { scheduleChannel } from './scheduler'

// Fase 10c — Votaton: o modo TELESPECTADOR (público, sem token).
//
// O espectador vota na maratona que quer ver. A apuração "ao vivo" simula
// outros telespectadores votando (teatro determinístico — mesma resposta pra
// qualquer observador no mesmo instante), o desfecho é decidido no ABRIR da
// rodada com recompensa variável + pity timer (derrotas seguidas garantem a
// próxima vitória), e o resultado vira uma maratona REAL na grade — vencendo
// o usuário ou "a torcida". A UI nunca quebra a 4ª parede: aqui dentro só
// existem "os telespectadores".
//
// Sem LLM em lugar nenhum: rápido, grátis e à prova de cota.

type Bindings = {
  DB: D1Database
  MEDIA: R2Bucket
}

export const votaton = new Hono<{ Bindings: Bindings }>()
votaton.use('*', cors())

const RODADA_SEG = 10 * 60        // 10 min de "apuração ao vivo"
const COOLDOWN_SEG = 4 * 3600     // próxima votação 4h depois do fim da anterior
const SLUG = /^[a-z0-9_]{2,40}$/

function hashStr(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

interface Opcao { sid: string; titulo: string; n: number }

async function opcoesDoCanal(db: D1Database, canal: string): Promise<Opcao[]> {
  const { results } = await db.prepare(
    `SELECT json_extract(m.metadata,'$.series_id') sid,
            MIN(json_extract(m.metadata,'$.title')) titulo, COUNT(*) n
     FROM media_items m JOIN media_channels mc ON mc.media_id = m.id
     WHERE mc.channel_id = ?1 AND m.status = 'ready' AND m.tipo IN ('episodio','filme')
       AND json_extract(m.metadata,'$.series_id') IS NOT NULL
     GROUP BY sid HAVING COUNT(*) >= 2 ORDER BY sid`,
  ).bind(canal).all<Opcao>()
  return results.filter((r) => r.sid)
}

interface Round {
  id: number
  canal: string
  series_user: string
  series_vencedora: string
  venceu_usuario: number
  started_at: number
  ends_at: number
  fechado: number
  event_id: number | null
  celebrado: number
}

const ultimaRodada = (db: D1Database, canal: string) =>
  db.prepare('SELECT * FROM votaton_rounds WHERE canal = ?1 ORDER BY id DESC LIMIT 1')
    .bind(canal).first<Round>()

// ── fechamento (lazy): materializa a maratona da vencedora ────────────────
async function fechaSePrecisar(env: Bindings, r: Round | null, agora: number): Promise<Round | null> {
  if (!r || r.fechado || agora < r.ends_at) return r
  const sid = r.venceu_usuario ? r.series_user : r.series_vencedora

  // primeiro horário noturno livre: hoje a partir das 20h (ou agora+30min,
  // o que vier depois), pulando conflitos de 2 em 2 horas
  const hoje20 = spToEpoch(`${epochToSp(agora).slice(0, 10)} 20:00`)!
  let ini = Math.max(hoje20, agora + 1800)
  ini = Math.ceil(ini / 10) * 10
  const { results: evs } = await env.DB.prepare(
    `SELECT start_at, end_at FROM channel_events WHERE canal = ?1 AND status='agendado' AND end_at > ?2`,
  ).bind(r.canal, agora).all<{ start_at: number; end_at: number }>()
  for (let tent = 0; tent < 4; tent++) {
    const fim = ini + 2 * 3600
    if (!evs.some((e) => ini < e.end_at && fim > e.start_at)) break
    ini += 2 * 3600
  }
  const fim = ini + 2 * 3600

  const primeiroEp = await env.DB.prepare(
    `SELECT m.id FROM media_items m JOIN media_channels mc ON mc.media_id = m.id
     WHERE mc.channel_id = ?1 AND m.status='ready' AND m.tipo IN ('episodio','filme')
       AND json_extract(m.metadata,'$.series_id') = ?2 ORDER BY m.id LIMIT 1`,
  ).bind(r.canal, sid).first<{ id: string }>()

  let eventId: number | null = null
  if (primeiroEp) {
    const ins = await env.DB.prepare(
      `INSERT INTO channel_events (canal, tipo, media_id, series_id, start_at, end_at, criado_por)
       VALUES (?1, 'maratona', ?2, ?3, ?4, ?5, 'votaton') RETURNING id`,
    ).bind(r.canal, primeiroEp.id, sid, ini, fim).first<{ id: number }>()
    eventId = ins?.id ?? null
    await scheduleChannel(env, r.canal, 48, true)
  }
  await env.DB.prepare('UPDATE votaton_rounds SET fechado = 1, event_id = ?2 WHERE id = ?1')
    .bind(r.id, eventId).run()
  return { ...r, fechado: 1, event_id: eventId }
}

// ── apuração simulada (determinística no tempo) ───────────────────────────
function apura(r: Round, opcoes: Opcao[], agora: number) {
  const f = Math.min(1, Math.max(0, (agora - r.started_at) / (r.ends_at - r.started_at)))
  const seed = hashStr(`${r.canal}:${r.id}`)
  const total = 40 + Math.floor(f * (280 + (seed % 240)))

  // dramaturgia: quem vai vencer termina na frente, mas o meio é tenso —
  // vitória = arrancada no fim; derrota = liderança que escorre nos minutos finais
  const shares = new Map<string, number>()
  const winnerSid = r.venceu_usuario ? r.series_user : r.series_vencedora
  for (const [i, o] of opcoes.entries()) {
    let s = 0.6 + ((seed >> (i * 3)) % 40) / 100 // base 0.6–1.0
    if (o.sid === r.series_user) s += r.venceu_usuario ? -0.25 + 0.65 * f : 0.35 - 0.5 * f
    else if (o.sid === winnerSid) s += -0.1 + 0.55 * f
    // um "puxão" de torcida no meio da rodada pra ninguém dormir
    s += 0.12 * Math.sin(f * Math.PI * 2 + (seed % 7) + i)
    shares.set(o.sid, Math.max(0.05, s))
  }
  const soma = [...shares.values()].reduce((a, b) => a + b, 0)
  return opcoes.map((o) => {
    const pct = (shares.get(o.sid) ?? 0) / soma
    return { series_id: o.sid, titulo: o.titulo, votos: Math.max(1, Math.round(total * pct)), pct: Math.round(pct * 100) }
  }).sort((a, b) => b.votos - a.votos)
}

// ── estado (a tela da TV faz polling aqui) ─────────────────────────────────
votaton.get('/:canal', async (c) => {
  const canal = c.req.param('canal')
  if (!SLUG.test(canal)) return c.json({ error: 'canal inválido' }, 400)
  const agora = Math.floor(Date.now() / 1000)
  const opcoes = await opcoesDoCanal(c.env.DB, canal)
  let r = await ultimaRodada(c.env.DB, canal)
  r = await fechaSePrecisar(c.env, r ?? null, agora)

  const aberta = r && !r.fechado && agora < r.ends_at
  const podeVotar = opcoes.length >= 2 && (!r || (r.fechado === 1 && agora >= r.ends_at + COOLDOWN_SEG))

  let resultado = null
  if (r?.fechado) {
    const sid = r.venceu_usuario ? r.series_user : r.series_vencedora
    const op = opcoes.find((o) => o.sid === sid)
    const ev = r.event_id
      ? await c.env.DB.prepare('SELECT start_at, end_at, status FROM channel_events WHERE id = ?1')
        .bind(r.event_id).first<{ start_at: number; end_at: number; status: string }>()
      : null
    resultado = {
      series_id: sid,
      titulo: op?.titulo ?? sid,
      venceu_usuario: Boolean(r.venceu_usuario),
      celebrar: Boolean(r.venceu_usuario) && !r.celebrado,
      maratona: ev && ev.status === 'agendado'
        ? { inicio: epochToSp(ev.start_at), fim: epochToSp(ev.end_at), inicio_epoch: ev.start_at }
        : null,
    }
  }

  return c.json({
    opcoes: opcoes.map((o) => ({ series_id: o.sid, titulo: o.titulo })),
    rodada: aberta && r
      ? { termina_em: r.ends_at, sua: r.series_user, votos: apura(r, opcoes, agora) }
      : null,
    resultado,
    pode_votar: podeVotar,
    proxima_em: r && !podeVotar && !aberta ? r.ends_at + COOLDOWN_SEG : null,
  })
})

// ── votar (abre a rodada; o desfecho já nasce decidido, mas oculto) ───────
votaton.post('/:canal/votar', async (c) => {
  const canal = c.req.param('canal')
  if (!SLUG.test(canal)) return c.json({ error: 'canal inválido' }, 400)
  const { series_id } = await c.req.json<{ series_id?: string }>().catch(() => ({ series_id: '' }))
  const agora = Math.floor(Date.now() / 1000)

  const opcoes = await opcoesDoCanal(c.env.DB, canal)
  if (opcoes.length < 2) return c.json({ error: 'a votação abre quando houver mais séries no catálogo' }, 409)
  if (!series_id || !opcoes.some((o) => o.sid === series_id)) {
    return c.json({ error: 'escolha uma das opções da votação' }, 400)
  }

  let r = await ultimaRodada(c.env.DB, canal)
  r = await fechaSePrecisar(c.env, r ?? null, agora)
  if (r && !r.fechado) return c.json({ error: 'a votação já está rolando — acompanhe a apuração!' }, 409)
  if (r && agora < r.ends_at + COOLDOWN_SEG) {
    return c.json({ error: 'a próxima votação ainda não abriu', proxima_em: r.ends_at + COOLDOWN_SEG }, 409)
  }

  // recompensa variável + pity: derrotas seguidas garantem a vitória.
  // pity sorteado (1–2 derrotas) por ciclo; fora do pity, ~35% de chance.
  const { results: hist } = await c.env.DB.prepare(
    'SELECT venceu_usuario FROM votaton_rounds WHERE canal = ?1 ORDER BY id DESC LIMIT 5',
  ).bind(canal).all<{ venceu_usuario: number }>()
  let derrotasSeguidas = 0
  for (const h of hist) {
    if (h.venceu_usuario) break
    derrotasSeguidas++
  }
  const nRodadas = hist.length
  const pity = 1 + (hashStr(`${canal}:pity:${nRodadas - derrotasSeguidas}`) % 2) // 1 ou 2
  const sorte = hashStr(`${canal}:sorte:${nRodadas}`) % 100 < 35
  const venceu = derrotasSeguidas >= pity || sorte

  // se "a torcida" vence, a vencedora é outra série (seeded — nunca a do usuário)
  const outras = opcoes.filter((o) => o.sid !== series_id)
  const vencedora = venceu
    ? series_id
    : outras[hashStr(`${canal}:venc:${nRodadas}`) % outras.length].sid

  await c.env.DB.prepare(
    `INSERT INTO votaton_rounds (canal, series_user, series_vencedora, venceu_usuario, started_at, ends_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).bind(canal, series_id, vencedora, venceu ? 1 : 0, agora, agora + RODADA_SEG).run()

  return c.json({ ok: true, termina_em: agora + RODADA_SEG }, 201)
})

// ── conquista celebrada (pra não repetir a festa a cada reload) ────────────
votaton.post('/:canal/celebrado', async (c) => {
  const canal = c.req.param('canal')
  if (!SLUG.test(canal)) return c.json({ error: 'canal inválido' }, 400)
  await c.env.DB.prepare(
    `UPDATE votaton_rounds SET celebrado = 1
     WHERE canal = ?1 AND fechado = 1 AND venceu_usuario = 1 AND celebrado = 0`,
  ).bind(canal).run()
  return c.json({ ok: true })
})
