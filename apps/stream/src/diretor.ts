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
  tipo: 'excluir_media' | 'cancelar_exclusao' | 'maratona' | 'replan' | 'nenhuma'
  media_id?: string
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
          tipo: { type: 'STRING', enum: ['excluir_media', 'cancelar_exclusao', 'maratona', 'replan', 'nenhuma'] },
          media_id: { type: 'STRING' },
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

// ── contexto do canal ──────────────────────────────────────────────────────

async function montaSystemPrompt(env: Env, canal: string): Promise<string> {
  const ch = await env.DB.prepare('SELECT * FROM channels WHERE id = ?1').bind(canal).first<any>()
  const { results: catalogo } = await env.DB.prepare(
    `SELECT m.id, m.tipo, m.duracao_seg, m.metadata FROM media_items m
     JOIN media_channels mc ON mc.media_id = m.id
     WHERE mc.channel_id = ?1 AND m.status = 'ready' ORDER BY m.tipo, m.id`,
  ).bind(canal).all<any>()
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
  const linhaDir = dirs.map((d: any) => {
    const p = JSON.parse(d.payload)
    return `- exclusão: ${p.media_id}${d.vigente_ate ? ` até ${epochToSp(d.vigente_ate)}` : ' (sem prazo)'}`
  }).join('\n') || '(nenhuma)'
  const linhaEv = evs.map((e: any) => `- maratona de ${e.media_id}: ${epochToSp(e.start_at)} → ${epochToSp(e.end_at)}`).join('\n') || '(nenhum)'

  return `Você é o Diretor de Programação do canal "${ch?.nome ?? canal}" da Biel TV, falando com o dono do canal no modo administrador.

IDENTIDADE EDITORIAL DO CANAL:
${ch?.identidade ?? '(sem identidade definida)'}

AGORA: ${epochToSp(now)} (horário de São Paulo).
DATAS DE REFERÊNCIA (copie daqui ao converter prazos): amanhã = ${epochToSp(now + 86400)} · +1 semana = ${epochToSp(now + 7 * 86400)} · +1 mês = ${epochToSp(now + 30 * 86400)} · +2 meses = ${epochToSp(now + 60 * 86400)} · +3 meses = ${epochToSp(now + 90 * 86400)}

CATÁLOGO DO CANAL (só estas mídias existem — use os ids EXATOS):
${linhaCat}

EXCLUSÕES ATIVAS:
${linhaDir}

EVENTOS AGENDADOS:
${linhaEv}

VOCÊ RESPONDE SEMPRE em JSON com "resposta" (texto curto, no tom do canal, em português) e "acoes" (lista, pode ser vazia). Ações possíveis:
- {"tipo":"excluir_media","media_id":"...","ate":"YYYY-MM-DD HH:MM"} — tira a mídia da programação até a data (omita "ate" se for sem prazo). Use quando pedirem para tirar/remover/pausar um conteúdo.
- {"tipo":"cancelar_exclusao","media_id":"..."} — cancela uma exclusão ativa (o conteúdo volta).
- {"tipo":"maratona","media_id":"...","inicio":"YYYY-MM-DD HH:MM","fim":"YYYY-MM-DD HH:MM"} — agenda maratona daquela mídia no período (máx 24h).
- {"tipo":"replan"} — replaneja a grade futura (use quando pedirem pra "mudar/embaralhar a programação").
- {"tipo":"nenhuma"} — quando for só conversa/pergunta.

REGRAS DURAS:
- media_id precisa existir no catálogo acima; se não existir, explique na resposta e NÃO emita a ação.
- Datas sempre no formato exato YYYY-MM-DD HH:MM, horário de São Paulo, no futuro.
- Prazos relativos ("2 meses", "semana que vem") você SEMPRE converte em data absoluta somando à data de AGORA e coloca no campo "ate"/"inicio"/"fim".
- TUDO que você prometer na "resposta" PRECISA ter a ação correspondente em "acoes" — resposta sem ação é só conversa e nada acontece de verdade.
- Nunca invente mídias, datas impossíveis ou ações fora da lista.
- Os valores dos campos em "acoes" devem ser EXATOS e limpos: só o id ou a data, sem comentários, sem raciocínio, sem texto extra dentro das strings.
- Confirme na "resposta" o que você fez, com as datas concretas.

EXEMPLOS (suponha AGORA = 2026-07-12 14:00):
Pedido: "tira o desenho X (id ep_x) por 2 meses"
→ {"resposta":"Feito! ep_x fora da grade até 2026-09-12 14:00.","acoes":[{"tipo":"excluir_media","media_id":"ep_x","ate":"2026-09-12 14:00"}]}
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
// Se o valor começa com um id válido do canal e o match é único, recorta.
function snapMediaId(bruto: string | undefined, validos: string[]): string | undefined {
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

  for (const bruta of acoes) {
    const a: Acao = { ...bruta, media_id: snapMediaId(bruta.media_id, ids) }
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

    if (a.tipo === 'cancelar_exclusao') {
      const r = await env.DB.prepare(
        `UPDATE directives SET status = 'cancelada'
         WHERE canal = ?1 AND status = 'ativa' AND tipo = 'excluir_media' AND payload LIKE ?2`,
      ).bind(canal, `%"${a.media_id}"%`).run()
      if ((r.meta.changes ?? 0) > 0) {
        mexeuNaGrade = true
        feitas.push(`exclusão de ${a.media_id} cancelada — volta pra grade`)
      } else {
        recusadas.push(`cancelar exclusão de ${a.media_id}: não havia exclusão ativa`)
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

/** Estado pro painel: exclusões ativas e eventos futuros do canal. */
export async function estadoDiretor(env: Env, canal: string) {
  const now = Math.floor(Date.now() / 1000)
  const { results: diretrizes } = await env.DB.prepare(
    `SELECT id, payload, vigente_ate, created_at FROM directives
     WHERE canal = ?1 AND status = 'ativa' AND (vigente_ate IS NULL OR vigente_ate > ?2)
     ORDER BY created_at DESC`,
  ).bind(canal, now).all<any>()
  const { results: eventos } = await env.DB.prepare(
    `SELECT id, media_id, start_at, end_at FROM channel_events
     WHERE canal = ?1 AND status = 'agendado' AND end_at > ?2 ORDER BY start_at`,
  ).bind(canal, now).all<any>()
  return {
    diretrizes: diretrizes.map((d: any) => ({
      id: d.id,
      media_id: JSON.parse(d.payload).media_id,
      ate: d.vigente_ate ? epochToSp(d.vigente_ate) : null,
    })),
    eventos: eventos.map((e: any) => ({
      id: e.id,
      media_id: e.media_id,
      inicio: epochToSp(e.start_at),
      fim: epochToSp(e.end_at),
    })),
  }
}
