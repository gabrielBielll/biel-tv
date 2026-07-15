// Ingestão de playlist "episódios em partes": o coração é transformar os
// TÍTULOS de uma playlist do YouTube em (série, episódio, parte) e agrupar as
// partes de cada episódio NA ORDEM CERTA.
//
// A REGRA DE OURO: o número do episódio e da parte vêm do TÍTULO, NUNCA da
// posição na playlist (as partes vêm embaralhadas — ep 03 pode ser 1,2,6,3,4,5).
//
// Dois níveis, mesmo padrão do resto do projeto (barato + robusto):
//  - Primário: LLM (Gemini→DeepSeek via pedeJson, fase 11c) — aguenta qualquer
//    nomenclatura ("Episódio 05 - Ato 4 (Parte 2)").
//  - Fallback/validação determinística: regex episódio/parte — funciona sozinho
//    se o LLM cair, e confere o LLM quando ele responde.
import { pedeJson } from './llm'

type Env = { GEMINI_API_KEY?: string; DEEPSEEK_API_KEY?: string }

// Entrada crua que a fábrica devolve da listagem (yt-dlp --flat-playlist).
export interface Entry {
  video_id: string
  url: string
  title: string
  playlist_index: number
}

export interface Parte {
  parte: number | null
  video_id: string
  url: string
  title: string
}

export interface Episodio {
  episodio: number
  media_id: string
  titulo: string
  partes: Parte[] // já ordenadas por parte
  ok: boolean
  aviso: string | null
}

export interface Grupos {
  series_id: string | null
  temporada: number | null
  episodios: Episodio[]
  sem_classificacao: { video_id: string; title: string }[]
}

// slug mínimo (duplicado de propósito do admin.ts pra não criar ciclo de import)
export function slugSerie(s: string): string {
  return (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)
}

// id da mídia final de um episódio: ep_<série>[_s{T}]_e{NN}
export function mediaIdDe(seriesSlug: string, temporada: number | null, episodio: number): string {
  const ep = String(episodio).padStart(2, '0')
  return `ep_${seriesSlug}${temporada ? `_s${temporada}` : ''}_e${ep}`
}

// ── nível 2: regex determinístico (fallback e conferência) ──────────────────
function episodioRegex(title: string): number | null {
  const t = title ?? ''
  const m =
    t.match(/epis[óo]dio\s*0*(\d{1,3})/i) ??
    t.match(/cap[íi]tulo\s*0*(\d{1,3})/i) ??
    t.match(/\bep\.?\s*0*(\d{1,3})\b/i) ??
    // "S02E01" (Season) e "T02E01" (Temporada — acervo dublado em PT usa T).
    t.match(/\b[st]\d{1,2}\s*[.\-x]?\s*e\s*0*(\d{1,3})\b/i) ??
    // "2x01" — o que importa é o número DEPOIS do x (o antes é a temporada).
    t.match(/\b\d{1,2}\s*x\s*0*(\d{1,3})\b/i)
  return m ? Number(m[1]) : null
}
function parteRegex(title: string): number | null {
  const t = title ?? ''
  const m =
    t.match(/parte\s*0*(\d{1,3})/i) ??
    t.match(/\bpt\.?\s*0*(\d{1,3})\b/i) ??
    t.match(/\bpart\s*0*(\d{1,3})\b/i) ??
    t.match(/\((\d{1,3})\s*\/\s*\d{1,3}\)/) // "(2/6)"
  return m ? Number(m[1]) : null
}

// ── nível 1: LLM (opcional — cai pro regex se indisponível) ─────────────────
interface Classificado {
  video_id: string
  serie: string | null
  episodio: number | null
  parte: number | null
  titulo_limpo: string
}

async function classificaLLM(env: Env, entries: Entry[], serieDica?: string): Promise<Map<string, Classificado>> {
  const out = new Map<string, Classificado>()
  if (entries.length === 0) return out
  const system = `Você organiza o acervo de uma TV nostálgica. Recebe os TÍTULOS de uma playlist do YouTube onde cada episódio foi PARTIDO em vários pedaços de ~4min. Para CADA vídeo, extraia do TÍTULO (nunca da ordem da lista):
- "serie": nome da série (ex.: "Jake Long O Dragão Ocidental").
- "episodio": número do episódio (inteiro). Se o título não disser, null.
- "parte": número da parte/pedaço dentro do episódio (inteiro). Se não disser, null.
- "titulo_limpo": título curto e limpo do episódio, SEM o "(Parte N)".

Cada acervo do YouTube numera do seu jeito. Formatos que aparecem na prática — use-os para DEDUZIR o padrão da playlist, não como lista fechada:
| Título                                        | episodio | parte |
| "Série - T02E01 | Fora de Controle (1/5)"     | 1        | 1     |
| "Série - S02E05 - O Teste (Parte 2)"          | 5        | 2     |
| "Série 2x01 - Título"                         | 1        | null  |
| "Série - Episódio 05 - Ato 4, Cena 15 (Pt 3)" | 5        | 3     |
| "Série - Ep. 12 [parte 3 de 6]"               | 12       | 3     |
| "Série - Capítulo 7 - segunda parte"          | 7        | 2     |
| "Série - Abertura | 2ª Temporada"             | null     | null  |

ATENÇÃO às duas confusões clássicas:
- Em "T02E01"/"S02E01"/"2x01", o número depois de T/S (ou antes do "x") é a TEMPORADA — o episódio é o número depois do E/x. Nunca devolva a temporada como episódio.
- "(1/5)" é parte 1 DE 5 pedaços — o 5 é o total, não o episódio.
Quem não for episódio da série (abertura, encerramento, trailer, compilado), devolva episodio e parte null em vez de chutar.
Responda APENAS o JSON {"itens":[{"video_id","serie","episodio","parte","titulo_limpo"}]}.
${serieDica ? `\nDICA DO OPERADOR — a série desta playlist é: "${serieDica}".` : ''}`

  const schema = {
    type: 'OBJECT',
    properties: {
      itens: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            video_id: { type: 'STRING' },
            serie: { type: 'STRING' },
            episodio: { type: 'NUMBER' },
            parte: { type: 'NUMBER' },
            titulo_limpo: { type: 'STRING' },
          },
          required: ['video_id'],
        },
      },
    },
    required: ['itens'],
  }
  const user = 'VÍDEOS:\n' + entries.map((e) => `${e.video_id} | "${e.title}"`).join('\n')
  const res = await pedeJson(env, system, user, schema)
  for (const it of res?.json?.itens ?? []) {
    if (!it?.video_id) continue
    out.set(String(it.video_id), {
      video_id: String(it.video_id),
      serie: it.serie ? String(it.serie) : null,
      episodio: Number.isFinite(Number(it.episodio)) && Number(it.episodio) > 0 ? Math.floor(Number(it.episodio)) : null,
      parte: Number.isFinite(Number(it.parte)) && Number(it.parte) > 0 ? Math.floor(Number(it.parte)) : null,
      titulo_limpo: it.titulo_limpo ? String(it.titulo_limpo).slice(0, 140) : '',
    })
  }
  return out
}

// ── montagem final: classifica + agrupa + valida ────────────────────────────
export async function montaGrupos(
  env: Env,
  entries: Entry[],
  opts: { series_id?: string; temporada?: number | null } = {},
): Promise<Grupos> {
  const llm = await classificaLLM(env, entries, opts.series_id)

  // funde LLM (primário) + regex (fallback/conferência) por vídeo
  interface Item extends Classificado { url: string; title: string; playlist_index: number }
  const itens: Item[] = entries.map((e) => {
    const l = llm.get(e.video_id)
    const epR = episodioRegex(e.title)
    const ptR = parteRegex(e.title)
    return {
      video_id: e.video_id,
      url: e.url,
      title: e.title,
      playlist_index: e.playlist_index,
      serie: l?.serie ?? null,
      episodio: l?.episodio ?? epR,
      parte: l?.parte ?? ptR,
      titulo_limpo: l?.titulo_limpo || e.title,
    }
  })

  // série final: dica do operador → maioria do que o LLM inferiu → null
  let seriesSlug = opts.series_id ? slugSerie(opts.series_id) : ''
  if (!seriesSlug) {
    const contagem = new Map<string, number>()
    for (const it of itens) {
      const s = it.serie ? slugSerie(it.serie) : ''
      if (s) contagem.set(s, (contagem.get(s) ?? 0) + 1)
    }
    seriesSlug = [...contagem.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
  }
  const temporada = opts.temporada && opts.temporada > 0 ? Math.floor(opts.temporada) : null

  // agrupa por episódio; quem não tem episódio vai pra "sem classificação"
  const porEp = new Map<number, Item[]>()
  const semClass: { video_id: string; title: string }[] = []
  for (const it of itens) {
    if (it.episodio == null) { semClass.push({ video_id: it.video_id, title: it.title }); continue }
    if (!porEp.has(it.episodio)) porEp.set(it.episodio, [])
    porEp.get(it.episodio)!.push(it)
  }

  const episodios: Episodio[] = [...porEp.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([episodio, lista]) => {
      const comParte = lista.filter((x) => x.parte != null).sort((a, b) => (a.parte ?? 0) - (b.parte ?? 0))
      const semParte = lista.filter((x) => x.parte == null)
      const partes: Parte[] = [...comParte, ...semParte].map((x) => ({
        parte: x.parte, video_id: x.video_id, url: x.url, title: x.title,
      }))

      // validação: as partes têm que formar 1..N sem buraco nem repetição
      const avisos: string[] = []
      const nums = comParte.map((x) => x.parte as number)
      const set = new Set(nums)
      const dups = [...set].filter((n) => nums.filter((m) => m === n).length > 1)
      if (dups.length) avisos.push(`parte(s) ${dups.join(', ')} duplicada(s)`)
      const maxP = nums.length ? Math.max(...nums) : 0
      const faltando = []
      for (let n = 1; n <= maxP; n++) if (!set.has(n)) faltando.push(n)
      if (faltando.length) avisos.push(`parte(s) ${faltando.join(', ')} faltando`)
      if (semParte.length) avisos.push(`${semParte.length} vídeo(s) sem nº de parte`)
      if (!nums.length) avisos.push('nenhuma parte numerada')

      const titulo = comParte[0]?.titulo_limpo || lista[0]?.titulo_limpo ||
        `Ep ${String(episodio).padStart(2, '0')}`
      return {
        episodio,
        media_id: seriesSlug ? mediaIdDe(seriesSlug, temporada, episodio) : '',
        titulo,
        partes,
        ok: avisos.length === 0,
        aviso: avisos.length ? avisos.join('; ') : null,
      }
    })

  return { series_id: seriesSlug || null, temporada, episodios, sem_classificacao: semClass }
}
