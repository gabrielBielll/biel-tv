// Fase 12 — comerciais como promessa (docs/features/comerciais-condicionais.md).
//
// A transcrição chega da fábrica (whisper) via register do pipeline ou via
// POST /admin/promessas/:id/transcript (backfill). Aqui o LLM lê o texto
// falado e PROPÕE a condição de veiculação; o operador confirma no painel.
// O agendador (scheduler.ts) aplica: "a_seguir" só toca no intervalo
// imediatamente antes da série prometida; promessa pendente/não-verificável
// fica FORA do rodízio — nunca prometemos o que não vamos cumprir.
import { pedeJson } from './llm'

type Env = {
  DB: D1Database
  GEMINI_API_KEY?: string
  DEEPSEEK_API_KEY?: string
}

export interface Proposta {
  tipo: 'a_seguir' | 'durante' | 'bloco_horario' | 'evento' | 'generico'
  series_id?: string | null
  descricao?: string
  confianca?: number
  // O QUE a promessa de horário afirma. O scheduler já lia `cond.hora`/`cond.dias`
  // pra decidir se a grade cumpre o anunciado, mas nada os gravava — então a
  // promessa valia pela SÉRIE só, e um comercial de "Scooby às três da tarde"
  // destravava com a faixa das 15:30. Foi assim que 7 comerciais viraram mentira
  // sem ninguém editar nada (auditoria de 21/09: `pnpm verify:comerciais-horario`).
  hora?: string | null // 'HH:MM'
  dias?: number[] | null // ISO 1=seg … 7=dom
  // QUANDO a peça 'durante' toca no intervalo: 'saida' ABRE ("voltamos já com
  // X"), 'volta' FECHA colado no retorno ("estamos de volta com X"), 'ambos'
  // entra nos dois pools. O scheduler já separava os três (scheduler.ts, pools
  // `duranteDe` e `voltaDe`), mas `/decidir` não persistia o campo — então TODA
  // peça caía no default 'saida' e o "está de volta" abria o intervalo em vez de
  // fechá-lo. Mesmo furo que hora/dias tinham.
  momento?: 'saida' | 'volta' | 'ambos' | null
}

const SCHEMA_GEMINI = {
  type: 'OBJECT',
  properties: {
    tipo: { type: 'STRING', enum: ['a_seguir', 'durante', 'bloco_horario', 'evento', 'generico'] },
    series_id: { type: 'STRING' },
    descricao: { type: 'STRING' },
    confianca: { type: 'NUMBER' },
  },
  required: ['tipo', 'descricao', 'confianca'],
}

// séries conhecidas em TODOS os canais (a promo pode citar qualquer uma)
async function seriesCandidatas(env: Env): Promise<Array<{ sid: string; titulo: string }>> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT json_extract(metadata, '$.series_id') sid,
            MIN(json_extract(metadata, '$.title')) titulo
     FROM media_items
     WHERE status = 'ready' AND json_extract(metadata, '$.series_id') IS NOT NULL
     GROUP BY sid`,
  ).all<{ sid: string; titulo: string }>()
  return results.filter((r) => r.sid)
}

export async function extraiPromessa(env: Env, mediaId: string): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT p.transcript, m.metadata, m.tipo
     FROM media_promises p JOIN media_items m ON m.id = p.media_id
     WHERE p.media_id = ?1`,
  ).bind(mediaId).first<{ transcript: string | null; metadata: string; tipo: string }>()
  if (!row?.transcript) return

  let titulo = mediaId
  try { titulo = JSON.parse(row.metadata).title ?? mediaId } catch { /* segue com o id */ }
  const series = await seriesCandidatas(env)

  const system = `Você analisa a TRANSCRIÇÃO de um comercial/vinheta de um canal de TV nostálgico e classifica a "promessa" que ele faz ao espectador. Responda APENAS o JSON.

TIPOS:
- "a_seguir": anuncia o PRÓXIMO programa ("a seguir...", "não perca daqui a pouco...", "é o que vem aí"). Se citar um programa, escolha o series_id EXATO da lista de séries conhecidas (campo series_id). Se o programa citado NÃO estiver na lista, deixe series_id vazio.
- "durante": bumper de permanência — afirma o que está NO AR AGORA ("você está vendo X", "estamos de volta com X", "continue com X"). Só vale nos intervalos do próprio programa (ou entre dois episódios seguidos dele). Preencha series_id igual ao caso acima.
- "bloco_horario": promete dia/horário fixo de programação ("de segunda a sexta às 17h", "todo sábado", "nas manhãs do canal").
- "evento": promete um evento único/maratona com data ("nesta sexta, maratona...").
- "generico": não promete programação nenhuma (comercial comum de produto, vinheta institucional sem citação de grade).

REGRAS:
- Só classifique como promessa se o TEXTO FALADO realmente citar programação/horário. Menção casual ao nome do canal = generico.
- "descricao": resuma a promessa em uma frase curta em português (ou "sem promessa").
- "confianca": 0 a 1.
- Nunca invente series_id fora da lista.

SÉRIES CONHECIDAS (series_id — título):
${series.map((s) => `${s.sid} — ${s.titulo}`).join('\n') || '(nenhuma série agrupada ainda)'}`

  const user = `Título do arquivo: ${titulo}
Tipo no catálogo: ${row.tipo}
TRANSCRIÇÃO:
"""
${row.transcript.slice(0, 4000)}
"""`

  const out = await pedeJson(env, system, user, SCHEMA_GEMINI)
  if (!out) return // sem provedor agora — o botão "reanalisar" tenta de novo

  const p: Proposta = {
    tipo: (['a_seguir', 'durante', 'bloco_horario', 'evento', 'generico'] as const).includes(out.json?.tipo)
      ? out.json.tipo
      : 'generico',
    series_id: null,
    descricao: String(out.json?.descricao ?? '').slice(0, 300),
    confianca: Math.max(0, Math.min(1, Number(out.json?.confianca ?? 0))),
  }
  // snap do series_id contra a lista real (LLM não pode inventar)
  const bruto = String(out.json?.series_id ?? '').trim()
  if (bruto && series.some((s) => s.sid === bruto)) p.series_id = bruto

  // Retaguarda determinística: LLM às vezes acerta o tipo mas deixa a série
  // vazia por excesso de cautela. Caso o começo do título de UMA única série
  // apareça literalmente no texto falado, casamos aqui — ambiguidade (duas
  // "Power Rangers…") fica nula de propósito: o operador decide no painel.
  if ((p.tipo === 'a_seguir' || p.tipo === 'durante') && !p.series_id) {
    const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    const falado = norm(`${row.transcript} ${p.descricao ?? ''}`)
    const hits = series.filter((s) => {
      const palavras = norm(s.titulo).split(/[^a-z0-9]+/).filter((w) => w.length >= 3)
      const chave = palavras.slice(0, 2).join(' ')
      return chave.length >= 5 && falado.includes(chave)
    })
    if (hits.length === 1) p.series_id = hits[0].sid
  }

  // sem promessa detectada → libera pro rodízio sem burocracia; com promessa
  // → pendente (fora do ar até o operador decidir)
  const status = p.tipo === 'generico' ? 'generico' : 'pendente'
  await env.DB.prepare(
    `UPDATE media_promises SET proposta = ?2, status = ?3, updated_at = unixepoch()
     WHERE media_id = ?1 AND status IN ('pendente','generico')`,
  ).bind(mediaId, JSON.stringify(p), status).run()
}

// grava/atualiza transcript preservando decisões já tomadas
export async function salvaTranscript(env: Env, mediaId: string, transcript: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO media_promises (media_id, transcript) VALUES (?1, ?2)
     ON CONFLICT(media_id) DO UPDATE SET transcript = excluded.transcript, updated_at = unixepoch()`,
  ).bind(mediaId, transcript.slice(0, 8000)).run()
}
