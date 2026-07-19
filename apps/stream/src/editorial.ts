// Fase 10a — o Diretor editorial noturno.
//
// Roda no cron diário (antes do agendador) e sob demanda pelo painel: pra
// cada canal, o LLM olha a identidade editorial, as séries disponíveis e o
// histórico recente e DECIDE se esta noite merece uma maratona — e de quê.
// A materialização é 100% determinística: validações duras (série existe,
// janela noturna sensata, sem sobreposição, sem repetir a de ontem) e um
// channel_events que o agendador cumpre. Se o LLM falhar ou decidir "hoje
// não", a rotação da fase 9 segura a grade — a TV nunca depende do LLM.
//
// É aqui que o sonho da maratona se completa com a fase 12: o evento criado
// destrava a promo tipo "evento" da mesma série, que roda nos intervalos
// DURANTE a janela de promoção — você descobre assistindo que hoje à noite
// tem maratona.
import { pedeJson } from './llm'
import { spToEpoch, epochToSp } from './diretor'
import { scheduleChannel } from './scheduler'
import { dispatchFabrica } from './fabrica'

type Env = {
  DB: D1Database
  MEDIA: R2Bucket
  GEMINI_API_KEY?: string
  DEEPSEEK_API_KEY?: string
  GH_DISPATCH_TOKEN?: string
  GH_REPO?: string
}

export interface DecisaoEditorial {
  canal: string
  fez: boolean
  series_id?: string
  inicio?: string
  fim?: string
  motivo: string
}

const SCHEMA_GEMINI = {
  type: 'OBJECT',
  properties: {
    fazer: { type: 'BOOLEAN' },
    series_id: { type: 'STRING' },
    inicio: { type: 'STRING' },
    fim: { type: 'STRING' },
    motivo: { type: 'STRING' },
  },
  required: ['fazer', 'motivo'],
}

const DIA_PT = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']

interface SerieDisponivel { sid: string; titulo: string; n: number; dur_media: number }

async function seriesDoCanal(env: Env, canal: string): Promise<SerieDisponivel[]> {
  const { results } = await env.DB.prepare(
    `SELECT json_extract(m.metadata,'$.series_id') sid,
            MIN(json_extract(m.metadata,'$.title')) titulo,
            COUNT(*) n, CAST(AVG(m.duracao_seg) AS INTEGER) dur_media
     FROM media_items m JOIN media_channels mc ON mc.media_id = m.id
     WHERE mc.channel_id = ?1 AND m.status = 'ready' AND m.tipo IN ('episodio','filme')
       AND json_extract(m.metadata,'$.series_id') IS NOT NULL
     GROUP BY sid HAVING COUNT(*) >= 2`,
  ).bind(canal).all<SerieDisponivel>()
  return results.filter((r) => r.sid)
}

async function historico(env: Env): Promise<any[]> {
  const row = await env.DB.prepare("SELECT v FROM config WHERE k = 'planos_editoriais'").first<{ v: string }>()
  try { return row ? JSON.parse(row.v) : [] } catch { return [] }
}

export async function planejaEditorial(
  env: Env,
  opts: { canal?: string; forcar?: boolean } = {},
): Promise<DecisaoEditorial[]> {
  const canais = opts.canal
    ? [{ id: opts.canal }]
    : (await env.DB.prepare('SELECT id FROM channels ORDER BY ordem, id').all<{ id: string }>()).results
  const agora = Math.floor(Date.now() / 1000)
  const hist = await historico(env)
  const decisoes: DecisaoEditorial[] = []

  for (const c of canais) {
    const canal = c.id
    const chan = await env.DB.prepare('SELECT nome, identidade FROM channels WHERE id = ?1')
      .bind(canal).first<{ nome: string; identidade: string }>()
    if (!chan) continue

    const series = await seriesDoCanal(env, canal)
    if (series.length === 0) {
      decisoes.push({ canal, fez: false, motivo: 'sem séries agrupadas (≥2 episódios) neste canal' })
      continue
    }

    // idempotência do dia: se o editorial já agendou algo pras próximas 24h
    // neste canal, não decide de novo (cron + botão manual convivem em paz)
    const jaTem = await env.DB.prepare(
      `SELECT id FROM channel_events WHERE canal = ?1 AND status = 'agendado'
         AND criado_por = 'editorial' AND start_at BETWEEN ?2 AND ?3 LIMIT 1`,
    ).bind(canal, agora, agora + 24 * 3600).first()
    if (jaTem) {
      decisoes.push({ canal, fez: false, motivo: 'já existe maratona editorial agendada pras próximas 24h' })
      continue
    }

    const eventosFuturos = await env.DB.prepare(
      `SELECT series_id, media_id, start_at, end_at FROM channel_events
       WHERE canal = ?1 AND status = 'agendado' AND end_at > ?2`,
    ).bind(canal, agora).all<{ series_id: string | null; media_id: string; start_at: number; end_at: number }>()

    const histCanal = hist.filter((h) => h.canal === canal).slice(-7)
    const diaSemana = DIA_PT[new Date((agora - 3 * 3600) * 1000).getUTCDay()]

    const system = `Você é o diretor de programação do canal "${chan.nome}" — um canal de TV nostálgico pessoal. Sua identidade editorial:
"""
${chan.identidade || 'canal infantil nostálgico'}
"""

Decida se HOJE à noite o canal faz uma MARATONA de alguma série (episódios em sequência). Responda APENAS o JSON.

REGRAS:
- fazer=true só quando fizer sentido editorial (fim de semana pede mais; não force maratona todo dia — 2 a 3 por semana é ritmo bom de TV).${opts.forcar ? '\n- HOJE É ESPECIAL: o operador PEDIU maratona — escolha a melhor série e agende (fazer=true obrigatório).' : ''}
- series_id: EXATAMENTE um da lista abaixo.
- NÃO repita a série das maratonas recentes (histórico abaixo).
- inicio/fim: "YYYY-MM-DD HH:MM" em horário de São Paulo, HOJE entre 18:00 e 23:59 (fim pode entrar pela madrugada), duração de 1 a 4 horas.
- motivo: uma frase curta com a voz do canal.

SÉRIES DISPONÍVEIS (series_id — título — episódios — duração média):
${series.map((s) => `${s.sid} — ${s.titulo} — ${s.n} eps — ~${Math.round(s.dur_media / 60)}min`).join('\n')}

MARATONAS RECENTES (não repetir):
${histCanal.map((h) => `${h.data}: ${h.series_id}`).join('\n') || '(nenhuma)'}

EVENTOS JÁ AGENDADOS (não sobrepor):
${eventosFuturos.results.map((e) => `${epochToSp(e.start_at)} → ${epochToSp(e.end_at)}: ${e.series_id ?? e.media_id}`).join('\n') || '(nenhum)'}`

    const user = `AGORA: ${epochToSp(agora)} (${diaSemana}, horário de São Paulo). Decida a noite de hoje do ${chan.nome}.`

    const out = await pedeJson(env, system, user, SCHEMA_GEMINI)
    if (!out) {
      decisoes.push({ canal, fez: false, motivo: 'LLM indisponível — rotação normal segura a grade' })
      continue
    }
    const j = out.json ?? {}
    if (!j.fazer) {
      decisoes.push({ canal, fez: false, motivo: String(j.motivo ?? 'hoje não').slice(0, 200) })
      continue
    }

    // ── validações duras (o LLM decide O QUÊ; o código valida TUDO) ────────
    const sid = String(j.series_id ?? '')
    const serie = series.find((s) => s.sid === sid)
    let ini = j.inicio ? spToEpoch(String(j.inicio)) : null
    let fim = j.fim ? spToEpoch(String(j.fim)) : null
    // backstop de horário: 20:00–22:00 de hoje se o LLM mandou datas tortas
    const hoje20 = spToEpoch(`${epochToSp(agora).slice(0, 10)} 20:00`)!
    if (!ini || ini <= agora || ini > agora + 36 * 3600) ini = Math.max(hoje20, agora + 600)
    if (!fim || fim <= ini) fim = ini + 2 * 3600
    if (fim - ini > 4 * 3600) fim = ini + 4 * 3600
    ini = Math.floor(ini / 10) * 10
    fim = Math.floor(fim / 10) * 10

    if (!serie) {
      decisoes.push({ canal, fez: false, motivo: `LLM sugeriu série fora da lista ("${sid}") — descartado` })
      continue
    }
    const sobrepoe = eventosFuturos.results.some((e) => ini! < e.end_at && fim! > e.start_at)
    if (sobrepoe) {
      decisoes.push({ canal, fez: false, motivo: 'sugestão sobrepunha evento existente — descartado' })
      continue
    }
    const repetida = histCanal.some((h) => h.series_id === sid)
    if (repetida && !opts.forcar) {
      decisoes.push({ canal, fez: false, motivo: `LLM repetiu maratona recente (${sid}) — descartado` })
      continue
    }

    // ── materializa: evento de série + histórico + grade replanejada ──────
    const primeiroEp = await env.DB.prepare(
      `SELECT m.id FROM media_items m JOIN media_channels mc ON mc.media_id = m.id
       WHERE mc.channel_id = ?1 AND m.status='ready' AND m.tipo IN ('episodio','filme')
         AND json_extract(m.metadata,'$.series_id') = ?2 ORDER BY m.id LIMIT 1`,
    ).bind(canal, sid).first<{ id: string }>()
    const ev = await env.DB.prepare(
      `INSERT INTO channel_events (canal, tipo, media_id, series_id, start_at, end_at, criado_por)
       VALUES (?1, 'maratona', ?2, ?3, ?4, ?5, 'editorial')
       RETURNING id`,
    ).bind(canal, primeiroEp!.id, sid, ini, fim).first<{ id: number }>()

    // Fase B: o Diretor enfileira um comercial que PROMETE esta maratona. Nasce
    // como promessa 'evento' (fase 12) amarrada à série do evento — só vai ao ar
    // na janela de promoção (agora → start_at) e some quando a maratona começa.
    // Best-effort: se algo faltar (molde/voz/amostra) o comercial não sai, mas a
    // maratona nunca é afetada — ele é bônus, jamais um bloqueio.
    try { await enfileiraComercialEvento(env, canal, sid, ini, ev!.id) } catch { /* bônus */ }

    hist.push({ data: epochToSp(agora).slice(0, 10), canal, series_id: sid, inicio: epochToSp(ini), fim: epochToSp(fim), motivo: j.motivo })
    await env.DB.prepare("INSERT OR REPLACE INTO config (k, v) VALUES ('planos_editoriais', ?1)")
      .bind(JSON.stringify(hist.slice(-30))).run()

    await scheduleChannel(env, canal, 48, true)
    decisoes.push({
      canal, fez: true, series_id: sid,
      inicio: epochToSp(ini), fim: epochToSp(fim),
      motivo: String(j.motivo ?? '').slice(0, 200),
    })
  }
  return decisoes
}

// dia-da-semana em São Paulo → convenção da fábrica de comerciais (1=seg..6=sáb,7=dom)
function diaFabrica(epochSp: number): number {
  const js = new Date((epochSp - 3 * 3600) * 1000).getUTCDay() // 0=dom..6=sáb
  return js === 0 ? 7 : js
}

// Enfileira o comercial da maratona (Fase B). O slot { [dia do start], hora do
// start } vira a fala "…, [dia], às [hora]"; o /done materializa a promessa como
// 'evento' amarrada à série, e o scheduler a toca só na janela agora→start_at.
async function enfileiraComercialEvento(
  env: Env, canal: string, sid: string, startAt: number, eventId: number,
): Promise<void> {
  // prefere molde SEM música (aí a trilha da amostra — a abertura do desenho — toca)
  const molde = await env.DB.prepare(
    'SELECT id FROM moldes WHERE canal = ?1 ORDER BY (musica_key IS NULL) DESC, created_at DESC LIMIT 1',
  ).bind(canal).first<{ id: string }>()
  if (!molde) return // canal sem molde: sem comercial, maratona segue no ar

  const diaN = diaFabrica(startAt)
  // encaixa a hora no grid de 15 min da biblioteca de voz (00/15/30/45)
  const [h, m] = epochToSp(startAt).slice(11, 16).split(':').map(Number)
  const mm = [0, 15, 30, 45].reduce((a, b) => (Math.abs(b - m) < Math.abs(a - m) ? b : a), 0)
  const hora = `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`

  const rid = () => crypto.randomUUID().replace(/-/g, '')
  const mediaId = `com_ev_${sid.slice(0, 18)}_${rid().slice(0, 8)}`.slice(0, 40)
  await env.DB.prepare(
    `INSERT INTO commercial_build_jobs
       (id, media_id, title, molde_id, series_id, slot_dias, slot_hora, event_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  ).bind(`cb_${rid().slice(0, 10)}`, mediaId, `Maratona ${sid} — ${epochToSp(startAt)}`,
    molde.id, sid, JSON.stringify([diaN]), hora, eventId).run()

  await dispatchFabrica(env) // acorda a fábrica (best-effort; o cron também cobre)
}