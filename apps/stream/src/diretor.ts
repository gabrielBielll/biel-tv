// O Diretor IA (fase 10b): chat do Modo God.
// Princípio de sempre: o LLM DECIDE (emite ações tipadas em JSON garantido),
// o CÓDIGO CALCULA (valida contra o catálogo e executa no banco).
// Cadeia de provedores: Gemini 3.5 Flash → DeepSeek (cota/erro) → só resposta.
import { scheduleChannel } from './scheduler'

type Env = {
  DB: D1Database
  MEDIA: R2Bucket
  GEMINI_API_KEY?: string
  DEEPSEEK_API_KEY?: string
}

export interface ChatMsg {
  role: 'user' | 'diretor'
  text: string
}

interface Acao {
  tipo: 'excluir_media' | 'excluir_serie' | 'cancelar_exclusao' | 'maratona' | 'replan' | 'nenhuma'
  media_id?: string
  series_id?: string
  ate?: string // 'YYYY-MM-DD HH:MM' em America/Sao_Paulo
  inicio?: string
  fim?: string
}

interface PlanoChat {
  resposta: string
  acoes: Acao[]
}

// Brasil não tem horário de verão desde 2019 — offset fixo de -03:00.
// Tolerante com o LLM: aceita "YYYY-MM-DD HH:MM", com "T", com segundos.
const spToEpoch = (s: string): number | null => {
  const m = s.trim().match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2})?$/)
  if (!m) return null
  const t = Date.parse(`${m[1]}T${m[2]}:00-03:00`)
  return Number.isFinite(t) ? Math.floor(t / 1000) : null
}
const epochToSp = (e: number) =>
  new Date((e - 3 * 3600) * 1000).toISOString().slice(0, 16).replace('T', ' ')

// ── provedores ─────────────────────────────────────────────────────────────

const GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    resposta: { type: 'STRING' },
    acoes: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          tipo: { type: 'STRING', enum: ['excluir_media', 'excluir_serie', 'cancelar_exclusao', 'maratona', 'replan', 'nenhuma'] },
          media_id: { type: 'STRING' },
          series_id: { type: 'STRING' },
          ate: { type: 'STRING' },
          inicio: { type: 'STRING' },
          fim: { type: 'STRING' },
        },
        required: ['tipo'],
      },
    },
  },
  required: ['resposta', 'acoes'],
}

async function chamaGemini(env: Env, system: string, msgs: ChatMsg[]): Promise<PlanoChat> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: msgs.map((m) => ({
          role: m.role === 'user' ? 'user' : 'model',
          parts: [{ text: m.text }],
        })),
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: GEMINI_SCHEMA,
          temperature: 0.3, // disciplina > criatividade: os campos precisam sair limpos
        },
      }),
    },
  )
  if (!res.ok) {
    const body = await res.text()
    const e = new Error(`gemini HTTP ${res.status}: ${body.slice(0, 200)}`) as Error & { quota?: boolean }
    e.quota = res.status === 429 || body.includes('RESOURCE_EXHAUSTED')
    throw e
  }
  const data = await res.json<any>()
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('gemini sem texto na resposta')
  return JSON.parse(text)
}

async function chamaDeepSeek(env: Env, system: string, msgs: ChatMsg[]): Promise<PlanoChat> {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        ...msgs.map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text })),
      ],
    }),
  })
  if (!res.ok) throw new Error(`deepseek HTTP ${res.status}`)
  const data = await res.json<any>()
  return JSON.parse(data.choices[0].message.content)
}

// ── séries/temporadas ────────────────────────────────────────────────────
// series_id vem de metadata.series_id — preenchido automaticamente no upload
// em lote/pasta (fase 11a), ou manualmente pelo admin pra agrupar uploads
// avulsos numa "temporada" que pode ser excluída/reposta de uma vez.

interface SerieInfo { ids: string[]; titulo: string }

async function getSeries(env: Env, canal: string): Promise<Map<string, SerieInfo>> {
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.metadata, json_extract(m.metadata, '$.series_id') sid
     FROM media_items m JOIN media_channels mc ON mc.media_id = m.id
     WHERE mc.channel_id = ?1 AND m.status = 'ready'
       AND json_extract(m.metadata, '$.series_id') IS NOT NULL`,
  ).bind(canal).all<{ id: string; metadata: string; sid: string }>()
  const map = new Map<string, SerieInfo>()
  for (const r of results) {
    if (!r.sid) continue
    let titulo = r.sid
    try { titulo = String(JSON.parse(r.metadata).title ?? r.sid).split(/\s[—-]\s/)[0] } catch { /* usa o sid */ }
    const info = map.get(r.sid) ?? { ids: [], titulo }
    info.ids.push(r.id)
    map.set(r.sid, info)
  }
  return map
}

// ── contexto do canal ──────────────────────────────────────────────────────

async function montaSystemPrompt(env: Env, canal: string): Promise<string> {
  const ch = await env.DB.prepare('SELECT * FROM channels WHERE id = ?1').bind(canal).first<any>()
  const { results: catalogo } = await env.DB.prepare(
    `SELECT m.id, m.tipo, m.duracao_seg, m.metadata FROM media_items m
     JOIN media_channels mc ON mc.media_id = m.id
     WHERE mc.channel_id = ?1 AND m.status = 'ready' ORDER BY m.tipo, m.id`,
  ).bind(canal).all<any>()
  const series = await getSeries(env, canal)
  const now = Math.floor(Date.now() / 1000)
  const { results: dirs } = await env.DB.prepare(
    `SELECT id, payload, vigente_ate FROM directives
     WHERE canal = ?1 AND status = 'ativa' AND (vigente_ate IS NULL OR vigente_ate > ?2)`,
  ).bind(canal, now).all<any>()
  const { results: evs } = await env.DB.prepare(
    `SELECT media_id, start_at, end_at FROM channel_events
     WHERE canal = ?1 AND status = 'agendado' AND end_at > ?2 ORDER BY start_at LIMIT 10`,
  ).bind(canal, now).all<any>()

  const linhaCat = catalogo.map((m: any) => {
    let titulo = m.id
    try { titulo = JSON.parse(m.metadata).title ?? m.id } catch { /* segue o id */ }
    return `- ${m.id} | ${m.tipo} | ${Math.round(m.duracao_seg / 60)}min | ${titulo}`
  }).join('\n')
  const linhaSeries = [...series.entries()]
    .map(([sid, info]) => `- ${sid} ("${info.titulo}"): ${info.ids.length} episódio(s) — ${info.ids.join(', ')}`)
    .join('\n') || '(nenhuma série agrupada — se o pedido mencionar "temporada" ou "série" e você não achar aqui, avise que precisa agrupar primeiro no catálogo)'
  const linhaDir = dirs.map((d: any) => {
    const p = JSON.parse(d.payload)
    const alvo = p.series_id ? `série ${p.series_id}` : p.media_id
    return `- exclusão: ${alvo}${d.vigente_ate ? ` até ${epochToSp(d.vigente_ate)}` : ' (sem prazo)'}`
  }).join('\n') || '(nenhuma)'
  const linhaEv = evs.map((e: any) => `- maratona de ${e.media_id}: ${epochToSp(e.start_at)} → ${epochToSp(e.end_at)}`).join('\n') || '(nenhum)'

  return `Você é o Diretor de Programação do canal "${ch?.nome ?? canal}" da Biel TV, falando com o dono do canal no modo administrador.

IDENTIDADE EDITORIAL DO CANAL:
${ch?.identidade ?? '(sem identidade definida)'}

AGORA: ${epochToSp(now)} (horário de São Paulo).
DATAS DE REFERÊNCIA (copie daqui ao converter prazos): amanhã = ${epochToSp(now + 86400)} · +1 semana = ${epochToSp(now + 7 * 86400)} · +1 mês = ${epochToSp(now + 30 * 86400)} · +2 meses = ${epochToSp(now + 60 * 86400)} · +3 meses = ${epochToSp(now + 90 * 86400)}

CATÁLOGO DO CANAL (só estas mídias existem — use os ids EXATOS):
${linhaCat}

SÉRIES/TEMPORADAS AGRUPADAS (pra excluir/repor TODOS os episódios de uma vez, use o series_id — não liste media_id por media_id):
${linhaSeries}

EXCLUSÕES ATIVAS:
${linhaDir}

EVENTOS AGENDADOS:
${linhaEv}

VOCÊ RESPONDE SEMPRE em JSON com "resposta" (texto curto, no tom do canal, em português) e "acoes" (lista, pode ser vazia). Ações possíveis:
- {"tipo":"excluir_media","media_id":"...","ate":"YYYY-MM-DD HH:MM"} — tira UMA mídia da programação até a data (omita "ate" se for sem prazo). Use pra um episódio/comercial/vinheta específico.
- {"tipo":"excluir_serie","series_id":"...","ate":"YYYY-MM-DD HH:MM"} — tira TODOS os episódios de uma série/temporada de uma vez (omita "ate" se for sem prazo). Use quando pedirem pra tirar uma temporada, série, ou "todos os episódios de X" inteira.
- {"tipo":"cancelar_exclusao","media_id":"..."} OU {"tipo":"cancelar_exclusao","series_id":"..."} — cancela uma exclusão ativa (de mídia individual ou de série inteira; use o mesmo campo que foi usado pra excluir).
- {"tipo":"maratona","media_id":"...","inicio":"YYYY-MM-DD HH:MM","fim":"YYYY-MM-DD HH:MM"} — agenda maratona daquela mídia no período (máx 24h).
- {"tipo":"replan"} — replaneja a grade futura (use quando pedirem pra "mudar/embaralhar a programação").
- {"tipo":"nenhuma"} — quando for só conversa/pergunta.

REGRAS DURAS:
- media_id precisa existir no catálogo acima; series_id precisa existir na lista de séries agrupadas. Se não existir, explique na resposta e NÃO emita a ação.
- Pedido de "temporada inteira" ou "todos os episódios de X" → SEMPRE use excluir_serie (uma ação só), NUNCA emita excluir_media repetido pra cada episódio.
- Se o pedido menciona uma série que NÃO está na lista de séries agrupadas (está só como itens soltos no catálogo), explique isso na resposta e não invente um series_id.
- Datas sempre no formato exato YYYY-MM-DD HH:MM, horário de São Paulo, no futuro.
- Prazos relativos ("2 meses", "semana que vem") você SEMPRE converte em data absoluta somando à data de AGORA e coloca no campo "ate"/"inicio"/"fim".
- TUDO que você prometer na "resposta" PRECISA ter a ação correspondente em "acoes" — resposta sem ação é só conversa e nada acontece de verdade.
- Nunca invente mídias, séries, datas impossíveis ou ações fora da lista.
- Os valores dos campos em "acoes" devem ser EXATOS e limpos: só o id ou a data, sem comentários, sem raciocínio, sem texto extra dentro das strings.
- Confirme na "resposta" o que você fez, com as datas concretas.

EXEMPLOS (suponha AGORA = 2026-07-12 14:00):
Pedido: "tira o desenho X (id ep_x) por 2 meses"
→ {"resposta":"Feito! ep_x fora da grade até 2026-09-12 14:00.","acoes":[{"tipo":"excluir_media","media_id":"ep_x","ate":"2026-09-12 14:00"}]}
Pedido: "tira a temporada inteira de Power Rangers (series_id pwr_rangers) por 1 mês"
→ {"resposta":"Feito! Toda a temporada de pwr_rangers fora do ar até 2026-08-12 14:00.","acoes":[{"tipo":"excluir_serie","series_id":"pwr_rangers","ate":"2026-08-12 14:00"}]}
Pedido: "tira TODOS os comerciais da série pwr_rangers por 3 dias" (mesmo dizendo "todos os X da série Y" — ainda é UMA excluir_serie, não uma excluir_media por item)
→ {"resposta":"Feito! Todos os itens de pwr_rangers fora do ar até 2026-07-15 14:00.","acoes":[{"tipo":"excluir_serie","series_id":"pwr_rangers","ate":"2026-07-15 14:00"}]}
Pedido: "maratona do Y (id ep_y) hoje das 20h às 23h"
→ {"resposta":"Maratona de ep_y confirmada: hoje, 20:00 às 23:00!","acoes":[{"tipo":"maratona","media_id":"ep_y","inicio":"2026-07-12 20:00","fim":"2026-07-12 23:00"}]}
Pedido: "o que passa hoje?"
→ {"resposta":"(fala da grade)","acoes":[]}`
}

// ── executor de ações (o "código calcula") ─────────────────────────────────

// ── backstops determinísticos: o LLM decide O QUE, o código resolve QUANDO ──
// (modelos flash falam a data certa na resposta e esquecem de preencher o
// campo; interpretar o prazo direto do pedido é infalível e auditável)

const DIA = 86400
/** "por 2 meses", "por 3 semanas", "até amanhã" → epoch futuro (mês ≈ 30 dias) */
export function interpretaPrazo(texto: string, now: number): number | null {
  const t = texto.toLowerCase()
  const m = t.match(/(\d+)\s*(dia|semana|m[eê]s|meses|ano)s?/)
  if (m) {
    const n = Number(m[1])
    const mult = { dia: 1, semana: 7, 'mês': 30, mes: 30, meses: 30, ano: 365 }[m[2]] ?? 1
    return now + n * mult * DIA
  }
  if (/amanh[ãa]/.test(t)) return now + DIA
  if (/semana que vem/.test(t)) return now + 7 * DIA
  if (/m[eê]s que vem/.test(t)) return now + 30 * DIA
  return null
}

/** período explícito no pedido: par de datas completas, ou "das 20h às 23h" (hoje/amanhã) */
export function extraiPeriodo(texto: string, now: number): { ini: number; fim: number } | null {
  const datas = [...texto.matchAll(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/g)]
  if (datas.length >= 2) {
    const ini = spToEpoch(`${datas[0][1]} ${datas[0][2]}`)
    const fim = spToEpoch(`${datas[1][1]} ${datas[1][2]}`)
    if (ini && fim && fim > ini) return { ini, fim }
  }
  const horas = texto.toLowerCase().match(/das?\s+(\d{1,2})(?::(\d{2}))?\s*h?(?:\d{2})?\s*(?:às|as|ate|até)\s+(\d{1,2})(?::(\d{2}))?\s*h/)
  if (horas) {
    const hojeSp = new Date((now - 3 * 3600) * 1000).toISOString().slice(0, 10)
    const dia = /amanh[ãa]/.test(texto.toLowerCase())
      ? new Date((now + DIA - 3 * 3600) * 1000).toISOString().slice(0, 10)
      : hojeSp
    const ini = spToEpoch(`${dia} ${horas[1].padStart(2, '0')}:${horas[2] ?? '00'}`)
    let fim = spToEpoch(`${dia} ${horas[3].padStart(2, '0')}:${horas[4] ?? '00'}`)
    if (ini && fim && fim <= ini) fim += DIA // "das 22h às 2h" vira madrugada seguinte
    if (ini && fim && fim > ini) return { ini, fim }
  }
  return null
}

// LLMs rápidos às vezes sujam o campo com raciocínio ("ep_x_ops_wait...").
// Se o valor começa com um id válido (de mídia OU de série) e o match é
// único, recorta. Mesma função serve pros dois id-spaces, chamados à parte.
function snapId(bruto: string | undefined, validos: string[]): string | undefined {
  if (!bruto) return undefined
  if (validos.includes(bruto)) return bruto
  const candidatos = validos.filter((v) => bruto.startsWith(v))
  if (candidatos.length === 1) return candidatos[0]
  const contem = validos.filter((v) => bruto.includes(v))
  return contem.length === 1 ? contem[0] : bruto
}

async function executa(
  env: Env,
  canal: string,
  acoes: Acao[],
  ultimoPedido: string,
): Promise<{ feitas: string[]; recusadas: string[] }> {
  const feitas: string[] = []
  const recusadas: string[] = []
  const now = Math.floor(Date.now() / 1000)
  let mexeuNaGrade = false

  const { results } = await env.DB.prepare(
    `SELECT m.id, m.tipo FROM media_items m JOIN media_channels mc ON mc.media_id = m.id
     WHERE mc.channel_id = ?1 AND m.status = 'ready'`,
  ).bind(canal).all<{ id: string; tipo: string }>()
  const doCanal = new Map(results.map((r) => [r.id, r.tipo]))
  const ids = [...doCanal.keys()]
  const series = await getSeries(env, canal)
  const seriesIds = [...series.keys()]

  for (const bruta of acoes) {
    const a: Acao = {
      ...bruta,
      media_id: snapId(bruta.media_id, ids),
      series_id: snapId(bruta.series_id, seriesIds),
    }
    if (a.tipo === 'nenhuma') continue

    if (a.tipo === 'replan') {
      mexeuNaGrade = true
      feitas.push('replanejamento da grade')
      continue
    }

    if (a.tipo === 'excluir_media') {
      if (!a.media_id || !doCanal.has(a.media_id)) {
        recusadas.push(`excluir ${a.media_id ?? '?'}: mídia não é deste canal`)
        continue
      }
      // data do LLM > prazo interpretado do pedido > sem prazo
      let ate = a.ate ? spToEpoch(a.ate) : null
      if (ate && ate <= now) ate = null
      if (!ate) ate = interpretaPrazo(ultimoPedido, now)
      await env.DB.prepare(
        `INSERT INTO directives (canal, tipo, payload, vigente_de, vigente_ate)
         VALUES (?1, 'excluir_media', ?2, ?3, ?4)`,
      ).bind(canal, JSON.stringify({ media_id: a.media_id }), now, ate).run()
      await env.DB.prepare(
        'DELETE FROM epg_virtual WHERE canal = ?1 AND media_id = ?2 AND start_time_virtual > ?3',
      ).bind(canal, a.media_id, now).run()
      mexeuNaGrade = true
      feitas.push(`exclusão de ${a.media_id}${ate ? ` até ${epochToSp(ate)}` : ' (sem prazo)'}`)
      continue
    }

    if (a.tipo === 'excluir_serie') {
      const info = a.series_id ? series.get(a.series_id) : undefined
      if (!a.series_id || !info) {
        recusadas.push(`excluir série ${a.series_id ?? '?'}: série não encontrada neste canal (agrupe os episódios primeiro no catálogo)`)
        continue
      }
      let ate = a.ate ? spToEpoch(a.ate) : null
      if (ate && ate <= now) ate = null
      if (!ate) ate = interpretaPrazo(ultimoPedido, now)
      await env.DB.prepare(
        `INSERT INTO directives (canal, tipo, payload, vigente_de, vigente_ate)
         VALUES (?1, 'excluir_serie', ?2, ?3, ?4)`,
      ).bind(canal, JSON.stringify({ series_id: a.series_id }), now, ate).run()
      const inList = info.ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(',')
      await env.DB.prepare(
        `DELETE FROM epg_virtual WHERE canal = ?1 AND media_id IN (${inList}) AND start_time_virtual > ?2`,
      ).bind(canal, now).run()
      mexeuNaGrade = true
      feitas.push(
        `exclusão da série ${a.series_id} — ${info.ids.length} episódio(s)${ate ? ` até ${epochToSp(ate)}` : ' (sem prazo)'}`,
      )
      continue
    }

    if (a.tipo === 'cancelar_exclusao') {
      if (!a.media_id && !a.series_id) {
        recusadas.push('cancelar exclusão: informe qual mídia ou série cancelar')
        continue
      }
      let changes = 0
      if (a.series_id) {
        // cancela a diretriz de série (se o LLM excluiu com excluir_serie)...
        const r1 = await env.DB.prepare(
          `UPDATE directives SET status = 'cancelada'
           WHERE canal = ?1 AND status = 'ativa' AND tipo = 'excluir_serie' AND payload LIKE ?2`,
        ).bind(canal, `%"${a.series_id}"%`).run()
        changes += r1.meta.changes ?? 0
        // ...E qualquer exclusão individual dos episódios dessa série (caso o
        // LLM tenha excluído um por um em vez de usar excluir_serie — já
        // aconteceu na prática; cancelar por série tem que desfazer os dois).
        const info = series.get(a.series_id)
        if (info) {
          for (const mid of info.ids) {
            const r2 = await env.DB.prepare(
              `UPDATE directives SET status = 'cancelada'
               WHERE canal = ?1 AND status = 'ativa' AND tipo = 'excluir_media' AND payload LIKE ?2`,
            ).bind(canal, `%"${mid}"%`).run()
            changes += r2.meta.changes ?? 0
          }
        }
      } else {
        const r = await env.DB.prepare(
          `UPDATE directives SET status = 'cancelada'
           WHERE canal = ?1 AND status = 'ativa' AND tipo = 'excluir_media' AND payload LIKE ?2`,
        ).bind(canal, `%"${a.media_id}"%`).run()
        changes += r.meta.changes ?? 0
      }
      const alvoId = a.series_id ?? a.media_id
      if (changes > 0) {
        mexeuNaGrade = true
        feitas.push(
          a.series_id
            ? `exclusão da série ${alvoId} cancelada (${changes} diretriz(es)) — episódios voltam pra grade`
            : `exclusão de ${alvoId} cancelada — volta pra grade`,
        )
      } else {
        recusadas.push(`cancelar exclusão de ${alvoId}: não havia exclusão ativa`)
      }
      continue
    }

    if (a.tipo === 'maratona') {
      if (!a.media_id || !doCanal.has(a.media_id)) {
        recusadas.push(`maratona de ${a.media_id ?? '?'}: mídia não é deste canal`)
        continue
      }
      // campos do LLM > período interpretado do pedido
      let ini = a.inicio ? spToEpoch(a.inicio) : null
      let fim = a.fim ? spToEpoch(a.fim) : null
      if (!ini || !fim) {
        const p = extraiPeriodo(ultimoPedido, now)
        if (p) { ini = p.ini; fim = p.fim }
      }
      if (!ini || !fim || fim <= ini || ini < now - 600 || fim - ini > 24 * 3600) {
        recusadas.push(`maratona de ${a.media_id}: período inválido (${a.inicio ?? '?'} → ${a.fim ?? '?'}) — informe inicio e fim como YYYY-MM-DD HH:MM`)
        continue
      }
      await env.DB.prepare(
        `INSERT INTO channel_events (canal, tipo, media_id, start_at, end_at)
         VALUES (?1, 'maratona', ?2, ?3, ?4)`,
      ).bind(canal, a.media_id, ini, fim).run()
      mexeuNaGrade = true
      feitas.push(`maratona de ${a.media_id}: ${epochToSp(ini)} → ${epochToSp(fim)}`)
      continue
    }
  }

  if (mexeuNaGrade) await scheduleChannel(env as any, canal, 48, true)
  return { feitas, recusadas }
}

// ── entrada principal ──────────────────────────────────────────────────────

export async function chatDiretor(env: Env, canal: string, mensagens: ChatMsg[]) {
  const system = await montaSystemPrompt(env, canal)
  const msgs = mensagens.slice(-12)

  let plano: PlanoChat | null = null
  let provedor = ''
  let erroGemini = ''
  if (env.GEMINI_API_KEY) {
    try {
      plano = await chamaGemini(env, system, msgs)
      provedor = 'gemini-3.5-flash'
    } catch (e) {
      erroGemini = (e as Error).message
    }
  }
  if (!plano && env.DEEPSEEK_API_KEY) {
    try {
      plano = await chamaDeepSeek(env, system, msgs)
      provedor = 'deepseek-v4-flash'
    } catch {
      /* cai no erro final */
    }
  }
  if (!plano) {
    return {
      resposta: `Os provedores de IA estão fora do ar agora (${erroGemini || 'sem chave configurada'}). A grade continua rodando no automático.`,
      acoes_executadas: [],
      acoes_recusadas: [],
      provedor: 'nenhum',
    }
  }

  const ultimoPedido = msgs.at(-1)?.text ?? ''
  const acoes = Array.isArray(plano.acoes) ? plano.acoes : []
  let { feitas, recusadas } = await executa(env, canal, acoes, ultimoPedido)

  // Rodada de reparo (1x): devolve as recusas pro modelo corrigir o JSON.
  if (recusadas.length > 0) {
    const reparo: ChatMsg[] = [
      ...msgs,
      { role: 'diretor', text: JSON.stringify(plano) },
      {
        role: 'user',
        text: `SISTEMA: estas ações foram recusadas pelo validador: ${recusadas.join('; ')}. Reemita o JSON com as ações corrigidas para o mesmo pedido (não repita ações que já funcionaram).`,
      },
    ]
    try {
      const plano2 = provedor.startsWith('gemini')
        ? await chamaGemini(env, system, reparo)
        : await chamaDeepSeek(env, system, reparo)
      const r2 = await executa(env, canal, Array.isArray(plano2.acoes) ? plano2.acoes : [], ultimoPedido)
      if (r2.feitas.length > 0) {
        feitas = [...feitas, ...r2.feitas]
        recusadas = r2.recusadas
        plano.resposta = plano2.resposta || plano.resposta
      }
    } catch {
      /* mantém o resultado da primeira rodada */
    }
  }

  return {
    resposta: String(plano.resposta ?? '').slice(0, 2000),
    acoes_executadas: feitas,
    acoes_recusadas: recusadas,
    provedor,
  }
}

/** Estado pro painel: exclusões ativas (mídia ou série), eventos futuros, e as séries agrupadas. */
export async function estadoDiretor(env: Env, canal: string) {
  const now = Math.floor(Date.now() / 1000)
  const { results: diretrizes } = await env.DB.prepare(
    `SELECT id, tipo, payload, vigente_ate, created_at FROM directives
     WHERE canal = ?1 AND status = 'ativa' AND (vigente_ate IS NULL OR vigente_ate > ?2)
     ORDER BY created_at DESC`,
  ).bind(canal, now).all<any>()
  const { results: eventos } = await env.DB.prepare(
    `SELECT id, media_id, start_at, end_at FROM channel_events
     WHERE canal = ?1 AND status = 'agendado' AND end_at > ?2 ORDER BY start_at`,
  ).bind(canal, now).all<any>()
  const series = await getSeries(env, canal)
  return {
    diretrizes: diretrizes.map((d: any) => {
      let p: any = {}
      try { p = JSON.parse(d.payload) } catch { /* payload corrompido */ }
      return {
        id: d.id,
        tipo: d.tipo,
        alvo: p.series_id ?? p.media_id ?? '?',
        ate: d.vigente_ate ? epochToSp(d.vigente_ate) : null,
      }
    }),
    eventos: eventos.map((e: any) => ({
      id: e.id,
      media_id: e.media_id,
      inicio: epochToSp(e.start_at),
      fim: epochToSp(e.end_at),
    })),
    series: [...series.entries()].map(([sid, info]) => ({ series_id: sid, titulo: info.titulo, n: info.ids.length })),
  }
}
