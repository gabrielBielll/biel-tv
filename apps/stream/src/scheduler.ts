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
  series_id: string | null
}

export interface ScheduleReport {
  canal: string
  added: number
  skipped?: string
  until?: number
  // âncoras descartadas por atraso além da tolerância (nunca silencioso)
  ancorasPerdidas?: number
  // segundos que viraram INTERVALO pra fechar o vão até a âncora (antes disso
  // era programa cortado no meio) — no report pra ninguém descobrir de surpresa
  enchimentoSeg?: number
}

const DAY = 86400
// Quanto da grade PASSADA guardar (catch-up/playback). O /vod toca por media_id
// independente disto; este teto é a profundidade do HISTÓRICO no guia do /epg.
const EPG_RETENTION = 7 * DAY

// Conversão de fuso num lugar só (Brasil sem horário de verão desde 2019 →
// offset fixo -03:00). Usadas pelas âncoras de grade (slots fixos em hora local).
const spDateStr = (e: number) => new Date((e - 3 * 3600) * 1000).toISOString().slice(0, 10) // 'YYYY-MM-DD' em SP
const spWeekdayIso = (e: number) => { const d = new Date((e - 3 * 3600) * 1000).getUTCDay(); return d === 0 ? 7 : d } // 1=seg..7=dom
const spHoraToEpoch = (date: string, hhmm: string): number | null => {
  const t = Date.parse(`${date}T${hhmm}:00-03:00`)
  return Number.isFinite(t) ? Math.floor(t / 1000) : null
}

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

// Agrupa os conteúdos em BLOCOS pra grade: episódios da mesma série saem
// emendados em pedaços de até `maxLen` (em ordem de episódio), e as séries
// entram em rodízio — um pedaço de cada por rodada. Assim um desenho passa um
// blocão e só volta depois dos outros, em vez de pingar 1 episódio às 10h,
// outro às 12h, outro às 15h (pedido do Gabriel: retém melhor a audiência).
// Fairness no nível da série: a menos-tocada lidera, empates embaralhados pela
// seed do dia. Conteúdo avulso (sem series_id) é um bloco de 1, como sempre.
// maxLen = 1 desliga o agrupamento (volta ao rodízio 1-a-1 de antes) — e, num
// canal onde nenhum episódio tem série, o resultado já é idêntico ao de antes.
// Exportada: coberta por teste unitário (scripts/verify-blocos.mjs).
export function montaBlocos(contents: MediaRow[], maxLen: number, rnd: () => number): MediaRow[][] {
  const porSerie = new Map<string, MediaRow[]>()
  for (const m of contents) {
    const chave = m.series_id ?? ` avulso:${m.id}` // avulso = série de si mesmo
    const arr = porSerie.get(chave)
    if (arr) arr.push(m)
    else porSerie.set(chave, [m])
  }
  // cada série vira uma fila de pedaços (episódios em ordem; pedaços de até
  // maxLen) + "frescor" (menos-tocada = menor last_played, null conta como 0)
  const series = [...porSerie.entries()].map(([chave, eps]) => {
    // Menos-tocado primeiro, id como desempate. É o que faz a progressão
    // PERSISTIR entre montagens: episódios já exibidos (last_played recente)
    // afundam e os inéditos (0) sobem — sem isto, cada rebuild recomeçava a
    // temporada do episódio 1. Série nova (tudo 0) sai em ordem de id, igual antes.
    const ord = [...eps].sort(
      (a, b) => (a.last_played_at ?? 0) - (b.last_played_at ?? 0) || a.id.localeCompare(b.id),
    )
    const chunks: MediaRow[][] = []
    for (let i = 0; i < ord.length; i += maxLen) chunks.push(ord.slice(i, i + maxLen))
    return { chave, chunks, i: 0, frescor: Math.min(...eps.map((m) => m.last_played_at ?? 0)) }
  })
  // prioridade base: menos-tocada primeiro; empates embaralhados pela seed do dia
  const ordem = shuffled(series, rnd).sort((a, b) => a.frescor - b.frescor)
  // intercala guloso: a cada passo emite o próximo pedaço da série com MAIS
  // pedaços restantes que não seja a última emitida — espalha a série longa em
  // vez de empilhá-la no fim; empate mantém a prioridade base (sort estável). Só
  // repete a última série se for a única com pedaços sobrando (aí não dá pra
  // separar). Tudo avulso: cada um é sua própria série, idêntico ao rodízio antigo.
  const rest = (s: (typeof ordem)[number]) => s.chunks.length - s.i
  const blocos: MediaRow[][] = []
  let ultima: string | null = null
  for (;;) {
    const vivas = ordem.filter((s) => rest(s) > 0)
    if (vivas.length === 0) break
    const elegiveis = vivas.filter((s) => s.chave !== ultima)
    const pool = elegiveis.length > 0 ? elegiveis : vivas
    const escolhida = pool.reduce((best, s) => (rest(s) > rest(best) ? s : best), pool[0])
    blocos.push(escolhida.chunks[escolhida.i++])
    ultima = escolhida.chave
  }
  return blocos
}

export async function scheduleChannel(
  env: Env,
  canal: string,
  hours = 48,
  rebuild = false,
): Promise<ScheduleReport> {
  const chan = await env.DB.prepare('SELECT * FROM channels WHERE id = ?1')
    .bind(canal).first<{ break_target_seg: number; comerciais_fieis: number | null; episodios_por_bloco: number | null }>()
  if (!chan) return { canal, added: 0, skipped: 'canal não existe' }

  const { results: mediaTodas } = await env.DB.prepare(
    `SELECT m.id, m.tipo, m.duracao_seg, m.segment_count, m.last_played_at,
            json_extract(m.metadata, '$.series_id') series_id
     FROM media_items m JOIN media_channels mc ON mc.media_id = m.id
     WHERE mc.channel_id = ?1 AND m.status = 'ready'`,
  ).bind(canal).all<MediaRow>()

  // diretrizes do Modo God: mídia (ou série inteira) excluída sai do pool
  // enquanto vigente. Eventos (maratona) ignoram isso de propósito — uma
  // ordem explícita do chat vale mais que uma exclusão geral.
  const agora = Math.floor(Date.now() / 1000)
  const { results: dirs } = await env.DB.prepare(
    `SELECT tipo, payload FROM directives
     WHERE canal = ?1 AND status = 'ativa' AND tipo IN ('excluir_media','excluir_serie')
       AND vigente_de <= ?2 AND (vigente_ate IS NULL OR vigente_ate > ?2)`,
  ).bind(canal, agora).all<{ tipo: string; payload: string }>()
  const mediaExcluida = new Set<string>()
  const serieExcluida = new Set<string>()
  for (const d of dirs) {
    try {
      const p = JSON.parse(d.payload)
      if (d.tipo === 'excluir_media' && p.media_id) mediaExcluida.add(p.media_id)
      if (d.tipo === 'excluir_serie' && p.series_id) serieExcluida.add(p.series_id)
    } catch { /* payload corrompido: ignora essa diretriz */ }
  }
  const media = mediaTodas.filter(
    (m) => !mediaExcluida.has(m.id) && !(m.series_id && serieExcluida.has(m.series_id)),
  )

  // eventos agendados (maratonas) que tocam a janela de planejamento
  const { results: eventos } = await env.DB.prepare(
    `SELECT media_id, series_id, start_at, end_at FROM channel_events
     WHERE canal = ?1 AND status = 'agendado' AND end_at > ?2
     ORDER BY start_at`,
  ).bind(canal, agora).all<{ media_id: string; series_id: string | null; start_at: number; end_at: number }>()

  // Âncoras de grade (slots FIXOS): série X toca no [dia + hora] fixo, todo dia
  // casado. O try/catch mantém a TV no ar mesmo se a migration ainda não rodou
  // (tabela ausente → sem âncoras, grade dinâmica normal — deploy à prova de ordem).
  let slotsAtivos: Array<{ series_id: string; dias: number[]; hora: string; episodios: number; reprise: boolean }> = []
  try {
    type SlotRow = { series_id: string; dias: string; hora: string; episodios: number; reprise?: number }
    const sel = (cols: string) => env.DB.prepare(
      `SELECT ${cols} FROM channel_slots WHERE canal = ?1 AND status = 'ativa'`,
    ).bind(canal).all<SlotRow>()
    // `reprise` é da migration 0029; banco atrasado cai no SELECT sem ela
    const { results: slotRows } = await sel('series_id, dias, hora, episodios, reprise')
      .catch(() => sel('series_id, dias, hora, episodios'))
    slotsAtivos = slotRows.map((r) => {
      let dias: number[] = []
      try { dias = (JSON.parse(r.dias) as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7) } catch { /* slot corrompido: ignora */ }
      return { series_id: r.series_id, dias, hora: r.hora, episodios: Math.max(1, r.episodios || 1), reprise: (r.reprise ?? 0) !== 0 }
    }).filter((s) => s.dias.length > 0 && /^([01]\d|2[0-3]):[0-5]\d$/.test(s.hora))
  } catch { /* tabela ausente: sem âncoras */ }

  // Promessas (fase 12): comercial/vinheta que promete programação só toca
  // quando a grade cumpre. Regras aplicadas ao pool:
  //  - pendente com promessa detectada → FORA do rodízio (aguarda revisão);
  //  - ignorar → fora;
  //  - confirmada a_seguir → pool próprio: só no intervalo imediatamente
  //    antes de um bloco da série alvo (fecha o pod, no lugar da vinheta);
  //  - confirmada bloco_horario/evento → retida até a fase 10a garantir blocos;
  //  - generico / sem registro → rodízio normal de sempre.
  // Interruptor "comerciais fiéis" POR CANAL: no modo LIVRE (0), o sistema
  // de promessas é ignorado por inteiro NESTE canal — rodízio cego, como
  // antes da fase 12 (época de acervo cru). O padrão é fiel (1).
  const modoFiel = (chan.comerciais_fieis ?? 1) !== 0
  const { results: promRows } = modoFiel
    ? await env.DB.prepare(
      `SELECT media_id, status, proposta, condicao FROM media_promises`,
    ).all<{ media_id: string; status: string; proposta: string | null; condicao: string | null }>()
    : { results: [] as Array<{ media_id: string; status: string; proposta: string | null; condicao: string | null }> }
  const foraDoRodizio = new Set<string>()
  const aSeguirDe = new Map<string, string[]>() // series_id alvo → promo ids
  const duranteDe = new Map<string, string[]>() // bumper que ABRE o intervalo ("voltamos já com X") — só no universo de X
  const voltaDe = new Map<string, string[]>() // bumper que FECHA o intervalo ("estamos de volta com X"), colado no retorno
  const promosEvento: Array<{ id: string; ate: number }> = [] // janela: agora → start do evento
  for (const p of promRows) {
    try {
      if (p.status === 'ignorar') { foraDoRodizio.add(p.media_id); continue }
      if (p.status === 'pendente') {
        const prop = p.proposta ? JSON.parse(p.proposta) : null
        // sem proposta ainda (transcrição recém-chegada) ou promessa detectada:
        // segura até alguém decidir; proposta "generico" nunca chega aqui
        // (extração já muda o status), mas o filtro cobre por segurança.
        if (!prop || prop.tipo !== 'generico') foraDoRodizio.add(p.media_id)
        continue
      }
      if (p.status === 'confirmada' && p.condicao) {
        const cond = JSON.parse(p.condicao)
        foraDoRodizio.add(p.media_id) // sai do rodízio cego…
        if (cond.tipo === 'a_seguir' && cond.series_id) {
          const lista = aSeguirDe.get(cond.series_id) ?? []
          lista.push(p.media_id)
          aSeguirDe.set(cond.series_id, lista) // …e entra no pool condicional
        }
        // "durante": vale nos intervalos DO programa e entre dois episódios
        // seguidos dele — nunca fora do universo da série (pedido do Gabriel).
        // `momento` separa a peça de SAÍDA (abre o intervalo, "voltamos já com X")
        // da de VOLTA (fecha, colada no retorno, "estamos de volta com X"). Sem
        // `momento` a peça ABRE, como sempre foi — retrocompatível. 'ambos' entra
        // nos dois pools.
        if (cond.tipo === 'durante' && cond.series_id) {
          const momento = cond.momento === 'volta' || cond.momento === 'saida' || cond.momento === 'ambos'
            ? cond.momento
            : 'saida'
          if (momento === 'volta' || momento === 'ambos') {
            const lista = voltaDe.get(cond.series_id) ?? []
            lista.push(p.media_id)
            voltaDe.set(cond.series_id, lista)
          }
          if (momento === 'saida' || momento === 'ambos') {
            const lista = duranteDe.get(cond.series_id) ?? []
            lista.push(p.media_id)
            duranteDe.set(cond.series_id, lista)
          }
        }
        // promo de HORÁRIO destrava quando a grade GARANTE o bloco (fase 12,
        // etapa 3): existe âncora ativa da série cobrindo a hora e os dias
        // anunciados → a promo é verdade e volta pro rodízio normal (promo de
        // grade rodava o dia inteiro na TV de 2005, não só perto da hora).
        // Sem âncora que cumpra, segue retida — não prometemos no escuro.
        // Checagem por CANAL de propósito: mídia compartilhada destrava só
        // no canal cuja grade cumpre o anunciado.
        if (cond.tipo === 'bloco_horario' && cond.series_id) {
          const cumpre = slotsAtivos.some((s) => s.series_id === cond.series_id
            && (!cond.hora || s.hora === cond.hora)
            && (!Array.isArray(cond.dias) || (cond.dias as unknown[]).every((n) => s.dias.includes(Number(n)))))
          if (cumpre) foraDoRodizio.delete(p.media_id)
        }
        // promo de EVENTO destrava na janela de promoção: só enquanto houver
        // uma maratona AGENDADA da série correspondente ainda por começar —
        // "sábado tem maratona X" toca a semana toda ANTES do sábado, e some
        // sozinha quando o evento começa (ou se for cancelado)
        if (cond.tipo === 'evento' && cond.series_id) {
          const alvo = eventos.find((e) => e.series_id === cond.series_id && e.start_at > agora)
          if (alvo) promosEvento.push({ id: p.media_id, ate: alvo.start_at })
        }
      }
    } catch { /* json corrompido: trata como retida (não promete no escuro) */ }
  }

  // duração 0 fica de fora dos três pools: linha de EPG sem duração não toca
  // nada e faria o enchimento (laço "enche até a hora") girar sem andar.
  const contents = media.filter((m) => (m.tipo === 'episodio' || m.tipo === 'filme') && m.duracao_seg > 0)
  const ads = media.filter((m) => m.tipo === 'comercial' && m.duracao_seg > 0 && !foraDoRodizio.has(m.id))
  const vins = media.filter((m) => m.tipo === 'vinheta' && m.duracao_seg > 0 && !foraDoRodizio.has(m.id))
  const porId = new Map(mediaTodas.map((m) => [m.id, m]))
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
  // DESC de propósito: a grade é contígua e sem sobreposição, então a linha no
  // ar é a de MAIOR start <= agora — achada no primeiro passo do índice. Com
  // ASC o banco varria todo o passado do canal (7 dias, ~4.650 linhas medidas
  // em 18/09/2026) até topar com ela; o resultado é o mesmo.
  const onAir = await env.DB.prepare(
    `SELECT end_time_virtual e FROM epg_virtual
     WHERE canal = ?1 AND start_time_virtual <= ?2 AND end_time_virtual > ?2
     ORDER BY start_time_virtual DESC LIMIT 1`,
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

  // Progressão persistente (pedido do Gabriel, ago/2026): o last_played_at só é
  // GRAVADO pela exibição real (commitAired). Mas o que JÁ está agendado no
  // futuro da grade não pode "parecer inédito" na extensão — senão o append
  // repetiria em ~48h o que acabou de entrar. Conta só pra ORDENAÇÃO desta run
  // (mutação local; nada é gravado). No rebuild o futuro foi deletado acima ⇒
  // o pool volta a ordenar pela exibição real: continua de onde o AR parou.
  // SEM filtro de canal de propósito: mídia compartilhada (ex.: padrinhos no
  // jetix E na disney) continua de onde o OUTRO canal parou, em vez de tocar o
  // mesmo episódio nos dois no mesmo dia — série sindicada, como TV real.
  // INDEXED BY: sem a dica, o planner escolhe agrupar por media_id e varre a
  // tabela INTEIRA (18.506 linhas medidas em 18/09/2026) em vez de percorrer só
  // o futuro pelo índice de start (7.982). `rows_read` do D1 conta entrada de
  // índice também, então o que importa é quantas ele PERCORRE, não se usa índice.
  // O try/catch cobre banco sem a migration 0028: cai na consulta sem dica.
  const sqlFuturo = `SELECT media_id id, MAX(start_time_virtual) t FROM epg_virtual
     %IDX% WHERE start_time_virtual > ?1 GROUP BY media_id`
  let futRows: Array<{ id: string; t: number }>
  try {
    futRows = (await env.DB.prepare(sqlFuturo.replace('%IDX%', 'INDEXED BY idx_epg_start'))
      .bind(now).all<{ id: string; t: number }>()).results
  } catch {
    futRows = (await env.DB.prepare(sqlFuturo.replace('%IDX%', ''))
      .bind(now).all<{ id: string; t: number }>()).results
  }
  const futuroDe = new Map(futRows.map((r) => [r.id, r.t]))
  for (const m of contents) {
    const f = futuroDe.get(m.id)
    if (f && f > (m.last_played_at ?? 0)) m.last_played_at = f
  }

  // Downtime "conta como se tivesse passado": se a grade ficou vazia entre o fim
  // da última linha e agora, as ocorrências de âncora dentro do buraco avançam o
  // cursor da série — igual TV de verdade, que não pausa quando você perde o sinal.
  const ult = await env.DB.prepare(
    'SELECT MAX(end_time_virtual) g FROM epg_virtual WHERE canal = ?1',
  ).bind(canal).first<{ g: number | null }>()
  const gapStart = ult?.g ?? t
  const perdidasNoGap = new Map<string, number>() // series_id → episódios "que passaram"

  // Materializa as âncoras em ocorrências concretas na janela [t, target]: pra
  // cada slot ativo, o unix de cada dia-da-semana casado na hora local. Guardado:
  // só entra série com episódio pronto e cuja hora não caia dentro de uma maratona
  // (o evento manda). Vazio ⇒ laço idêntico ao de hoje (rodízio dinâmico puro).
  const seriesComEp = new Set(contents.map((m) => m.series_id).filter(Boolean) as string[])
  type Ancora = { start: number; series_id: string; episodios: number; reprise: boolean }
  const ancoras: Ancora[] = []
  if (slotsAtivos.length > 0) {
    const vistos = new Set<string>()
    for (let d = Math.min(gapStart, t) - DAY; d <= target + DAY; d += DAY) {
      const dia = spDateStr(d)
      for (const s of slotsAtivos) {
        const A = spHoraToEpoch(dia, s.hora)
        if (A == null) continue
        const As = Math.floor(A / 10) * 10
        if (!s.dias.includes(spWeekdayIso(As))) continue
        if (!seriesComEp.has(s.series_id)) continue
        // ocorrência dentro do buraco (grade vazia até agora): teria passado —
        // avança o cursor sem agendar nada
        if (As >= gapStart && As < Math.min(t, now)) {
          const chave = `gap|${As}|${s.series_id}`
          if (!vistos.has(chave)) {
            vistos.add(chave)
            perdidasNoGap.set(s.series_id, (perdidasNoGap.get(s.series_id) ?? 0) + s.episodios)
          }
          continue
        }
        if (As < t || As >= target) continue
        if (eventos.some((e) => As >= e.start_at - 300 && As < e.end_at)) continue
        const chave = `${As}|${s.series_id}`
        if (vistos.has(chave)) continue
        vistos.add(chave)
        ancoras.push({ start: As, series_id: s.series_id, episodios: s.episodios, reprise: s.reprise })
      }
    }
    ancoras.sort((a, b) => a.start - b.start)
  }
  let ancIdx = 0

  // O que cada série já exibiu em cada DIA (chave `series|YYYY-MM-DD` em SP) —
  // é o que a âncora de reprise repete. Alimentado pelo próprio planejamento e
  // semeado com o dia que já está na grade (o slot da tarde pode reprisar uma
  // exibição da manhã que foi planejada numa run anterior).
  const exibidoNoDia = new Map<string, string[]>()
  const marcaExibido = (sid: string | null, mid: string, quando: number) => {
    if (!sid) return
    const k = `${sid}|${spDateStr(quando)}`
    const lista = exibidoNoDia.get(k) ?? []
    if (lista.at(-1) !== mid) lista.push(mid)
    exibidoNoDia.set(k, lista)
  }
  if (slotsAtivos.some((s) => s.reprise)) {
    // só paga a consulta quando o canal tem slot de reprise
    const { results: hoje } = await env.DB.prepare(
      `SELECT e.media_id id, e.start_time_virtual t, json_extract(m.metadata, '$.series_id') sid
       FROM epg_virtual e JOIN media_items m ON m.id = e.media_id
       WHERE e.canal = ?1 AND e.start_time_virtual > ?2 AND e.start_time_virtual < ?3
         AND m.tipo IN ('episodio','filme')
       ORDER BY e.start_time_virtual`,
    ).bind(canal, t - 2 * DAY, target).all<{ id: string; t: number; sid: string | null }>()
    for (const r of hoje) marcaExibido(r.sid, r.id, r.t)
  }

  const rnd = mulberry32(hashStr(canal + new Date().toISOString().slice(0, 10)))
  // rotação em BLOCOS: episódios da mesma série emendados (até N seguidos),
  // séries alternando em rodízio; menos-tocada lidera, empates pela seed do dia
  const blocoMax = Math.max(1, chan.episodios_por_bloco ?? 2)
  const blocos = montaBlocos(contents, blocoMax, rnd)
  // FILA de comerciais (e outra de vinhetas): a peça que vai ao ar vai pro FIM
  // da fila, então só volta depois que todas as outras passaram. Antes era um
  // índice móvel sobre a lista filtrada por "cabe no alvo" — o que fazia a peça
  // curta ser sorteada toda hora e a longa nunca: medido em 15/09/2026, 40 das
  // 135 peças do jetix não iam ao ar NENHUMA vez em 24h enquanto uma vinheta
  // repetia 27×. Pedido do Gabriel: "faça variar os comerciais, cansa e irrita
  // ficar vendo as mesmas coisas toda hora".
  const filaAds = shuffled(ads, rnd)
  const filaVins = shuffled(vins, rnd)
  // Tira da fila a peça MAIS ANTIGA que satisfaz o filtro e a recoloca no fim.
  // Peça que nunca cabe fica na frente e entra assim que houver espaço — é o que
  // garante que o acervo inteiro rode.
  const daFila = (fila: MediaRow[], cabe: (m: MediaRow) => boolean): MediaRow | undefined => {
    const i = fila.findIndex(cabe)
    if (i < 0) return undefined
    const [m] = fila.splice(i, 1)
    fila.push(m)
    return m
  }

  // Pools CONDICIONAIS (bumper "voltamos já com X", "a seguir X", promo de
  // maratona): ao contrário do acervo grande, aqui costuma existir UMA peça por
  // série — e tocá-la em todo intervalo daquela série faz decorar. Medido em
  // 15/09/2026: a vinheta de pausa dos Padrinhos ia ao ar 30× por dia. Regra:
  // sempre a MENOS tocada da lista e, se até ela passou faz pouco tempo, o
  // intervalo simplesmente não leva a peça (melhor sem do que decorada).
  const DESCANSO_CONDICIONAL = 45 * 60
  const ultimaVezDe = new Map<string, number>()
  const daPoolCondicional = (ids: string[], cabe: (m: MediaRow) => boolean): MediaRow | undefined => {
    const cands = ids.map((id) => porId.get(id)).filter((m): m is MediaRow => Boolean(m) && cabe(m!))
    if (cands.length === 0) return undefined
    const pick = cands.reduce((a, b) =>
      (ultimaVezDe.get(a.id) ?? -Infinity) <= (ultimaVezDe.get(b.id) ?? -Infinity) ? a : b)
    if (t - (ultimaVezDe.get(pick.id) ?? -Infinity) < DESCANSO_CONDICIONAL) return undefined
    ultimaVezDe.set(pick.id, t)
    return pick
  }
  let bi = 0 // qual bloco
  let ei = 0 // qual episódio dentro do bloco atual
  // Conteúdo que JÁ entrou nesta montagem. O encaixe (ver abaixo) pode adiantar
  // um episódio que o rodízio ainda tinha pela frente; sem esta marca ele
  // tocaria duas vezes no mesmo dia. Quando o acervo inteiro já rodou, a marca
  // é zerada e a volta recomeça — igual ao rodízio cíclico de sempre.
  const usadoNaRun = new Set<string>()
  const rows: Array<[string, string, number, number, number]> = []

  const push = (m: string, s: number, e: number, seg: number) => rows.push([canal, m, s, e, seg])

  // Intervalo com duração-alvo: enche até ~alvo segundos, mas NUNCA repete o
  // mesmo comercial dentro do mesmo intervalo. Se os comerciais distintos
  // acabarem antes do alvo, o intervalo fica mais curto (melhor que repetir).
  // Também evita emendar o último comercial do intervalo anterior no primeiro
  // deste, quando há alternativa.
  // Ritmo de TV: intervalo só depois de um MÍNIMO de conteúdo desde o último
  // (episódios cheios de tela preta geram cue points a cada ~2min — sem este
  // respiro, a grade vira mais comercial que programa). E o comercial
  // escolhido precisa CABER no alvo: um de 200s não entra num intervalo de
  // 120s se houver alternativa — sem nenhuma que caiba, o pod fica só com o
  // mais curto disponível (nunca estoura empilhando).
  const MIN_ENTRE_PODS = 300
  const alvoBase = chan.break_target_seg ?? 120
  // Menor programa do canal: é a régua do "ainda cabe alguém antes da âncora?".
  // Vão menor que isso não recebe mais programa nenhum — é intervalo garantido.
  const menorConteudo = Math.min(...contents.map((m) => m.duracao_seg))
  let ultimoPodFim = -Infinity
  // serieCtx: série "dona" deste intervalo — no meio de um episódio dela, ou
  // entre dois episódios seguidos dela. O bumper de saída ("voltamos já com X")
  // ABRE o pod e o de volta ("estamos de volta com X") o FECHA, colado no retorno
  // do programa — como na TV real, e só nesse contexto (nunca fora do universo).
  // `teto` = hora da próxima âncora: o pod NUNCA a ultrapassa (fica mais curto se
  // preciso) pra a grade fixa começar pontual. Infinity quando não há âncora à vista.
  const breakPod = (serieCtx?: string | null, teto = Infinity) => {
    if (t - ultimoPodFim < MIN_ENTRE_PODS) return
    const bumpers = serieCtx ? duranteDe.get(serieCtx) ?? [] : []
    const bp = daPoolCondicional(bumpers, (m) => t + m.duracao_seg <= teto)
    if (bp) {
      push(bp.id, t, t + bp.duracao_seg, 0)
      t += bp.duracao_seg
    }
    // tolerância de 25%: estourar um pouco o alvo é ritmo normal de TV
    // (2×70s num alvo de 120 ✓); o que não pode é UM comercial de 200s
    // entrar sozinho num intervalo de 120 tendo alternativa que caiba
    const folga = Math.ceil(alvoBase * 0.25)
    let sum = 0
    for (;;) {
      const restante = Math.min(alvoBase - sum, teto - t) // nunca cruza a âncora
      if (restante <= 0 || filaAds.length === 0) break
      // a mais antiga que cabe no alvo (com a tolerância); se NENHUMA cabe e o
      // pod ainda está vazio, entra a mais curta disponível (nunca empilha
      // estourando) — o resto espera o próximo intervalo
      let pick = daFila(filaAds, (a) => a.duracao_seg <= restante + folga && t + a.duracao_seg <= teto)
      if (!pick && sum === 0) {
        const curtos = filaAds.filter((a) => t + a.duracao_seg <= teto)
        if (curtos.length === 0) break
        const menor = curtos.reduce((a, b) => (a.duracao_seg <= b.duracao_seg ? a : b))
        pick = daFila(filaAds, (a) => a.id === menor.id)
      }
      if (!pick) break
      push(pick.id, t, t + pick.duracao_seg, 0)
      t += pick.duracao_seg
      sum += pick.duracao_seg
    }
    // janela de promoção: enquanto a maratona não começou, o intervalo
    // fecha com UMA promo do evento (rodízio entre as elegíveis) — é assim
    // que você fica sabendo durante a semana que sábado tem maratona
    const eleg = promosEvento.filter((p) => t < p.ate).map((p) => p.id)
    const pr = daPoolCondicional(eleg, (m) => t + m.duracao_seg <= teto)
    if (pr) {
      push(pr.id, t, t + pr.duracao_seg, 0)
      t += pr.duracao_seg
      sum += pr.duracao_seg
    }
    // fecha o pod com a vinheta de VOLTA ("estamos de volta com X"), colada no
    // retorno do programa — só quando houve intervalo DE VERDADE (entrou ad) e
    // estamos no universo da série. Sem isso, dois bumpers grudariam sem break
    // no meio ("voltamos já" seguido de "estamos de volta").
    const voltas = serieCtx ? voltaDe.get(serieCtx) ?? [] : []
    const vp = sum > 0 ? daPoolCondicional(voltas, (m) => t + m.duracao_seg <= teto) : undefined
    if (vp) {
      push(vp.id, t, t + vp.duracao_seg, 0)
      t += vp.duracao_seg
    }
    if (sum > 0 || bumpers.length > 0) ultimoPodFim = t
  }

  // Agenda um conteúdo INTEIRO com seus breaks nos cue points (pods do MEIO do
  // programa nunca levam "a seguir" — o próximo bloco é a continuação dele).
  // O `teto` (hora da próxima âncora) NÃO decepa mais o programa: quem chama só
  // manda o que cabe, e aqui quem cede espaço são os INTERVALOS do meio — cada
  // um só pode usar a folga que sobra depois de reservar o resto do episódio.
  // Cortar programa na hora da âncora era o comportamento antigo e o Gabriel
  // vetou (set/2026): "um episódio acaba cortando outro… ficar cortando programa
  // fica bem chato, o ideal é passar comerciais mesmo".
  const agendaConteudo = (c: MediaRow, teto = Infinity) => {
    // marca localmente pro rodízio/âncora desta run não repetir; a GRAVAÇÃO do
    // last_played_at é só na exibição real (commitAired), nunca no planejamento
    c.last_played_at = t
    usadoNaRun.add(c.id)
    marcaExibido(c.series_id, c.id, t)
    const cues = (cuesOf[c.id] ?? []).filter((x) => x > 0 && x < c.duracao_seg)
    // ORÇAMENTO dos intervalos deste episódio quando há âncora à frente: eles
    // podem usar a sobra até a hora MENOS o menor programa do canal. Assim os
    // breaks não comem o espaço do programa seguinte — sem isso, dois minutos de
    // intervalo aqui viram dez minutos de comercial colados na âncora (o vão
    // deixa de caber qualquer desenho). Se nem o menor programa cabe na sobra,
    // não há o que proteger: os intervalos usam o que quiserem.
    const sobra = teto === Infinity ? Infinity : teto - t - c.duracao_seg
    const orcamento = sobra === Infinity || sobra < menorConteudo ? sobra : sobra - menorConteudo
    let gastoPods = 0
    let pos = 0
    for (const cue of cues) {
      push(c.id, t, t + (cue - pos), pos / SEGMENT_DURATION)
      t += cue - pos
      pos = cue
      // pod no MEIO do programa (o bumper dele pode abrir): limitado pela FOLGA
      // (o que falta de episódio tem que caber antes da âncora) e pelo orçamento
      const antes = t
      breakPod(c.series_id, Math.min(
        teto === Infinity ? Infinity : teto - (c.duracao_seg - pos),
        t + orcamento - gastoPods,
      ))
      gastoPods += t - antes
    }
    push(c.id, t, t + (c.duracao_seg - pos), pos / SEGMENT_DURATION)
    t += c.duracao_seg - pos
  }

  // O intervalo ENTRE programas é montado já sabendo quem vem a seguir:
  // fecha com a promo "a seguir <série>" confirmada quando existir (colada
  // no programa prometido, como TV de verdade). Quando fecha com a promo,
  // ela faz o papel da vinheta de abertura.
  let ultimaSerie: string | null = null
  const podEntrePrograma = (proxima: MediaRow, continuacao: boolean, teto = Infinity): boolean => {
    // continuacao = próximo episódio do MESMO bloco (mesma série, emendado): é
    // permanência dentro do universo dela — o bumper "você está vendo X" pode
    // abrir o pod e NÃO se anuncia "a seguir" (o próximo é a mesma coisa).
    const mesmaSerie = continuacao
      ? proxima.series_id
      : ultimaSerie && proxima.series_id === ultimaSerie ? ultimaSerie : null
    breakPod(mesmaSerie, teto)
    if (continuacao) return false
    const promoIds = proxima.series_id ? aSeguirDe.get(proxima.series_id) ?? [] : []
    const promo = daPoolCondicional(promoIds, (m) => t + m.duracao_seg <= teto)
    if (!promo) return false
    push(promo.id, t, t + promo.duracao_seg, 0)
    t += promo.duracao_seg
    return true
  }

  // Avança o cursor do rodízio (bloco/episódio dentro do bloco).
  const avancaCursor = () => {
    ei++
    if (ei >= blocos[bi % blocos.length].length) { bi++; ei = 0 }
  }

  // Espia o próximo do rodízio SEM consumi-lo, pulando o que já entrou nesta
  // montagem (o encaixe pode ter adiantado um episódio que estava mais à frente
  // na fila). Esgotado o acervo, a marca zera e a volta recomeça.
  const espiaRodizio = (): { item: MediaRow; continuacao: boolean } => {
    if (usadoNaRun.size >= contents.length) usadoNaRun.clear()
    for (let guarda = 0; guarda < contents.length; guarda++) {
      const item = blocos[bi % blocos.length][ei]
      // continuação = não é o 1º do bloco E emenda a mesma série que saiu agora;
      // se um evento entrou no meio do bloco, ultimaSerie muda e o bloco reabre
      if (!usadoNaRun.has(item.id)) {
        return { item, continuacao: ei > 0 && item.series_id != null && item.series_id === ultimaSerie }
      }
      avancaCursor()
    }
    return { item: blocos[bi % blocos.length][ei], continuacao: false } // tudo usado: repete
  }

  // VÃO MORTO de uma escolha: o que sobraria até a âncora depois do programa e
  // do intervalo seguinte, quando essa sobra é pequena demais pra caber
  // qualquer outro programa do canal. Esse tempo vira comercial, e é ele que
  // vira o blocão de 10min colado na hora — o objetivo da escolha é zerá-lo.
  const vaoMorto = (dur: number, espaco: number): number => {
    const sobra = espaco - dur - alvoBase
    return sobra > 0 && sobra < menorConteudo ? sobra : 0
  }

  // ENCAIXE: escolhe o que entra numa janela que termina na âncora. Serve pros
  // dois casos: o próximo do rodízio não cabe (antes isto era o corte do
  // episódio, vetado pelo Gabriel) ou cabe mas deixaria um vão morto. Ranking:
  // menor vão morto → maior duração → menos tocado. Assim a janela é preenchida
  // com PROGRAMA em vez de comercial, e o papel de "tapa-buraco" roda entre os
  // desenhos curtos em vez de cair sempre no mesmo. Fora da busca: a série da
  // própria âncora (senão o "bloco das 16h" começaria antes das 16h) e o que já
  // entrou nesta run.
  const encaixe = (espaco: number, serieDaAncora: string | null): MediaRow | null => {
    const cands = contents.filter((m) =>
      m.duracao_seg <= espaco && !usadoNaRun.has(m.id) &&
      !(serieDaAncora && m.series_id === serieDaAncora))
    if (cands.length === 0) return null
    return cands.sort((a, b) =>
      vaoMorto(a.duracao_seg, espaco) - vaoMorto(b.duracao_seg, espaco) ||
      b.duracao_seg - a.duracao_seg ||
      (a.last_played_at ?? 0) - (b.last_played_at ?? 0) ||
      a.id.localeCompare(b.id))[0]
  }

  // ENCHIMENTO: nada mais cabe antes da âncora ⇒ o vão vira INTERVALO, que é o
  // que a TV faz (e o que o Gabriel pediu no lugar do corte). Comerciais até a
  // hora, sem repetir peça enquanto houver distinta, fechando EXATO (toda
  // duração do acervo é múltiplo de 10s, como a hora da âncora) e terminando na
  // promo "a seguir <série da âncora>" quando existe uma confirmada — é assim
  // que a TV entra no programa da hora cheia. Devolve false só quando o canal
  // não tem comercial nenhum (aí quem chama decide o que fazer com o vão).
  let enchimentoSeg = 0
  const enchimento = (teto: number, serieDepois?: string | null): boolean => {
    if (filaAds.length === 0) return false
    const curta = filaAds.reduce((a, b) => (a.duracao_seg <= b.duracao_seg ? a : b))
    // menor peça capaz de tapar sobra (vinheta de 10s conta: é ela que fecha o
    // "toco" quando o comercial mais curto do canal é grande demais)
    const menorPeca = Math.min(curta.duracao_seg, ...filaVins.map((v) => v.duracao_seg))
    // A peça certa pro que falta, sempre pela FILA (mais antiga primeiro):
    // fechar EXATO manda; senão a mais antiga que caiba sem deixar um "toco"
    // que nenhuma peça preenche; senão qualquer uma que caiba; por último a
    // vinheta do canal, que é curta e cai bem colada no programa da hora.
    const proxima = (restante: number): MediaRow | undefined =>
      daFila(filaAds, (a) => a.duracao_seg === restante)
      ?? daFila(filaAds, (a) => a.duracao_seg <= restante && restante - a.duracao_seg >= menorPeca)
      ?? daFila(filaAds, (a) => a.duracao_seg <= restante)
      ?? daFila(filaVins, (v) => v.duracao_seg <= restante)
    // `estoura`: quando NADA mais cabe, passa alguns segundos da hora em vez de
    // deixar buraco na EPG (buraco tira o canal do ar; 10s de atraso ninguém vê,
    // e a grace da âncora cobre). Só vale no fechamento contra a âncora.
    const encheAte = (limite: number, estoura: boolean) => {
      while (t < limite) {
        const pick = proxima(limite - t)
          ?? (estoura ? daFila(filaAds, (a) => a.duracao_seg === curta.duracao_seg) : undefined)
        if (!pick) return
        push(pick.id, t, t + pick.duracao_seg, 0)
        t += pick.duracao_seg
      }
    }
    const t0 = t
    // reserva o fim do intervalo pra promo "a seguir" do bloco que vem (só a
    // confirmada; sem promo, o intervalo é só comercial, como antes)
    const promoIds = serieDepois ? aSeguirDe.get(serieDepois) ?? [] : []
    const promo = daPoolCondicional(promoIds, (m) => teto - t > m.duracao_seg)
    const reserva = promo ? promo.duracao_seg : 0
    encheAte(teto - reserva, reserva === 0)
    if (promo && t + promo.duracao_seg <= teto) {
      push(promo.id, t, t + promo.duracao_seg, 0)
      t += promo.duracao_seg
    }
    encheAte(teto, true) // o que ainda faltar (a promo pode não ter cabido)
    ultimoPodFim = t
    enchimentoSeg += t - t0
    return t > t0
  }

  // canal recém-nascido não abre com intervalo; grade em extensão (append)
  // abre com o pod entre-programas — o bloco anterior terminou num conteúdo
  let primeiroBloco = (cov?.m ?? onAir?.e) == null

  // maratona de série: rotaciona episódios DIFERENTES dentro da janela
  const evCursor = new Map<number, number>()
  const proximoDaMaratona = (ev: { media_id: string; series_id: string | null; start_at: number }): MediaRow | undefined => {
    if (ev.series_id) {
      const eps = mediaTodas
        .filter((x) => (x.tipo === 'episodio' || x.tipo === 'filme') && x.series_id === ev.series_id)
        .sort((a, b) => a.id.localeCompare(b.id))
      if (eps.length > 0) {
        const i = evCursor.get(ev.start_at) ?? 0
        evCursor.set(ev.start_at, i + 1)
        return eps[i % eps.length]
      }
    }
    return mediaTodas.find((x) => x.id === ev.media_id && (x.tipo === 'episodio' || x.tipo === 'filme'))
  }

  // Bloco da âncora: N episódios emendados da série (rotaciona entre ocorrências),
  // com breaks entre eles no universo da série. Respeita exclusões (usa `contents`).
  const episodiosDaSerie = (sid: string) =>
    contents.filter((m) => m.series_id === sid).sort((a, b) => a.id.localeCompare(b.id))
  // Cursor PERSISTENTE da âncora (antes zerava a cada run → a série ancorada
  // repetia os primeiros episódios pra sempre): continua do seguinte ao último
  // exibido/agendado (maior last_played_at — inclui o futuro da grade via
  // futuroDe) e soma os episódios "que passaram" no downtime (perdidasNoGap).
  const ancCursor = new Map<string, number>()
  const ancCursorInit = (sid: string, eps: MediaRow[]): number => {
    let best = -1
    let bestLp = 0
    for (let i = 0; i < eps.length; i++) {
      const lp = eps[i].last_played_at ?? 0
      if (lp > bestLp) { bestLp = lp; best = i }
    }
    return best + 1 + (perdidasNoGap.get(sid) ?? 0) // nunca exibida → 0 (+ gap)
  }
  // `teto` = hora da PRÓXIMA âncora. O bloco fixo também respeita quem vem
  // depois dele: os intervalos dele não invadem a hora seguinte e cedem espaço
  // pra caber mais um programa no vão (o mesmo orçamento do agendaConteudo). Se
  // o bloco em si passar da hora seguinte, ele vai INTEIRO mesmo assim e a
  // âncora seguinte entra atrasada — a grace cobre. Cortar, nunca.
  const scheduleAncora = (a: Ancora, teto = Infinity): boolean => {
    const eps = episodiosDaSerie(a.series_id)
    if (eps.length === 0) return false // série sumiu do pool: âncora ignorada
    // REPRISE: repete o que a série exibiu HOJE, sem gastar episódio novo — é
    // o trilho das grades de 2005 (mesma atração de manhã, à tarde e à noite).
    // Se ainda não passou nada hoje, cai no comportamento normal: o primeiro
    // slot do dia é sempre o inédito, mesmo marcado como reprise.
    if (a.reprise) {
      const doDia = exibidoNoDia.get(`${a.series_id}|${spDateStr(a.start)}`) ?? []
      const repetir = doDia.slice(-a.episodios).map((id) => porId.get(id)).filter((m): m is MediaRow => Boolean(m))
      if (repetir.length > 0) {
        for (const ep of repetir) {
          if (ep !== repetir[0]) breakPod(ep.series_id, teto)
          agendaConteudo(ep, teto)
          ultimaSerie = ep.series_id
        }
        return true
      }
    }
    for (let k = 0; k < a.episodios; k++) {
      const i = ancCursor.get(a.series_id) ?? ancCursorInit(a.series_id, eps)
      ancCursor.set(a.series_id, i + 1)
      const ep = eps[i % eps.length]
      if (k > 0) breakPod(ep.series_id, teto) // intervalo entre episódios do bloco (universo da série)
      agendaConteudo(ep, teto)
      ultimaSerie = ep.series_id
    }
    return true
  }

  // Tolerância pra âncora ATRASADA (bug corrida maluca, ago/2026): se o bloco
  // anterior estourou o horário — ou duas âncoras caem no MESMO minuto — a
  // seguinte NÃO é descartada: dispara atrasada, como TV de verdade quando o
  // programa anterior passa da hora. Só cai quem atrasar além da GRACE, e cai
  // CONTADO no report (nada de sumiço silencioso).
  const ANCORA_GRACE = 45 * 60
  let ancorasPerdidas = 0

  while (t < target) {
    // âncora atrasada demais (além da grace) ou dentro de maratona → consome
    // sem tocar (a perdida é contada; a de maratona é intencional — evento manda)
    while (
      ancIdx < ancoras.length &&
      (ancoras[ancIdx].start < t - ANCORA_GRACE ||
        eventos.some((e) => ancoras[ancIdx].start >= e.start_at - 300 && ancoras[ancIdx].start < e.end_at))
    ) {
      if (ancoras[ancIdx].start < t - ANCORA_GRACE) ancorasPerdidas++
      ancIdx++
    }
    let anc: Ancora | null = ancIdx < ancoras.length ? ancoras[ancIdx] : null
    // maratona agendada cobrindo este instante? o evento manda na grade
    const ev = eventos.find((e) => t >= e.start_at - 300 && t < e.end_at)

    // chegou (ou passou, dentro da grace) a hora da âncora, sem maratona no ar?
    // toca o bloco fixo — na hora quando pontual, atrasado quando espremido
    if (!ev && anc && t >= anc.start - 5) {
      ancIdx++
      // a âncora seguinte é o teto do bloco fixo (intervalos e orçamento)
      if (scheduleAncora(anc, ancIdx < ancoras.length ? ancoras[ancIdx].start : Infinity)) continue
      anc = null // série sumiu do pool: ignora esta âncora nesta iteração
    }

    const evMedia = ev ? proximoDaMaratona(ev) : undefined
    // teto = hora da próxima âncora: NADA (intervalo, vinheta ou episódio) a
    // ultrapassa, pra a grade fixa começar pontual sem deixar buraco na EPG. O
    // que não couber inteiro não entra (nunca mais é cortado); o vão vira
    // programa curto + intervalo. Sem âncora à vista (ou durante maratona, que
    // manda) = Infinity. Âncora JÁ atrasada (start <= t, esperando a grace) não
    // vira teto — teto no passado faria t andar pra trás e travar o loop.
    let teto = !evMedia && anc && anc.start > t ? anc.start : Infinity

    // espia o próximo do rodízio SEM consumir o cursor — se ele não couber antes
    // da âncora, o cursor fica intacto e ele toca depois dela.
    let doRodizio = false
    let prox: MediaRow
    let continuacao = false
    if (evMedia) {
      prox = evMedia // a maratona cuida da própria emenda; não mexe no cursor de blocos
    } else {
      const espiado = espiaRodizio()
      prox = espiado.item
      continuacao = espiado.continuacao
      doRodizio = true
    }

    // NUNCA cortar programa no meio (veto do Gabriel, set/2026). Antes disto o
    // rodízio começava um episódio de 22min faltando 2min pra âncora e o teto o
    // decepava: 1 em cada 4 exibições ia ao ar pela metade (algumas perdendo
    // 97%). Agora só entra o que couber INTEIRO e o vão é resolvido nesta ordem:
    // (1) um conteúdo mais curto que caiba, (2) intervalo até a hora.
    if (doRodizio && t + prox.duracao_seg > teto) {
      const alt = encaixe(teto - t, anc?.series_id ?? null)
      if (alt) {
        prox = alt
        continuacao = false
        doRodizio = false // encaixe não consome o cursor: o espiado toca depois da âncora
      } else if (enchimento(teto, anc?.series_id ?? null)) {
        continue // encheu até a hora: a âncora dispara no topo da próxima volta
      } else {
        // canal sem comercial nenhum pra tapar o vão: o programa vai INTEIRO e a
        // âncora entra atrasada (a grace cobre). Cortar, nunca mais.
        teto = Infinity
      }
    }

    // Tudo que vem ANTES do programa (intervalo, promo "a seguir", vinheta) cede
    // espaço a ele: o teto dos acessórios é a hora da âncora MENOS a duração do
    // programa. É isso que o faz caber inteiro sem atrasar a grade fixa.
    const tetoAcessorios = teto === Infinity ? Infinity : teto - prox.duracao_seg

    let fechouComASeguir = false
    if (!primeiroBloco) fechouComASeguir = podEntrePrograma(prox, continuacao, tetoAcessorios)
    primeiroBloco = false

    // o intervalo encostou na hora da âncora? cede a vez a ela (prox intacto no
    // cursor); a âncora dispara no topo da próxima iteração e prox toca depois.
    // `!ev` (não `!evMedia`): durante um evento sem mídia tocável, ceder aqui
    // giraria sem avançar t — o rodízio preenche e a âncora espera o evento.
    if (!ev && anc && t >= anc.start - 5) continue

    // Vinheta de abertura: só quando começa um bloco NOVO, se couber antes da
    // âncora, pela fila (não é sempre a mesma) e respeitando o DESCANSO — num
    // canal com uma vinheta só no rodízio, abrir todo bloco com ela era o que
    // fazia a mesma peça tocar 30× por dia. Sem vinheta disponível, o bloco
    // começa direto: melhor sem vinheta do que com a vinheta decorada.
    if (!evMedia && !continuacao && !fechouComASeguir) {
      const v = daFila(filaVins, (x) => t + x.duracao_seg <= tetoAcessorios
        && t - (ultimaVezDe.get(x.id) ?? -Infinity) >= DESCANSO_CONDICIONAL)
      if (v) {
        ultimaVezDe.set(v.id, t)
        push(v.id, t, t + v.duracao_seg, 0)
        t += v.duracao_seg
      }
    }

    // consome o cursor e agenda o programa INTEIRO (que cabe: checado acima)
    if (doRodizio) avancaCursor()
    agendaConteudo(prox, teto)
    ultimaSerie = prox.series_id
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
  // (o carimbo de last_played_at saiu daqui de propósito: planejar ≠ exibir.
  //  Quem grava é o commitAired, quando o relógio de fato passa pela linha.)
  return {
    canal,
    added: rows.length,
    until: t,
    ...(ancorasPerdidas > 0 ? { ancorasPerdidas } : {}),
    ...(enchimentoSeg > 0 ? { enchimentoSeg } : {}),
  }
}

export async function runScheduler(
  env: Env,
  opts: { canal?: string; hours?: number; rebuild?: boolean } = {},
): Promise<ScheduleReport[]> {
  const canais = opts.canal
    ? [{ id: opts.canal }]
    : (await env.DB.prepare('SELECT id FROM channels ORDER BY ordem, id').all<{ id: string }>()).results
  // exibição real primeiro: carimba o que o relógio já cobriu ANTES de planejar
  // (best-effort — manter a TV no ar vem antes do carimbo)
  try { await commitAired(env) } catch { /* próximo run recupera */ }
  const reports: ScheduleReport[] = []
  for (const c of canais) {
    // Isola cada canal: um lento/quebrado não pode abortar o loop e deixar os
    // seguintes sem extensão (era assim que jetix/disney passavam fome quando o
    // orçamento do cron estourava no meio e a grade deles zerava).
    try {
      reports.push(await scheduleChannel(env, c.id, opts.hours ?? 48, opts.rebuild ?? false))
    } catch (e) {
      reports.push({ canal: c.id, added: 0, skipped: String(e) })
    }
  }
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare('DELETE FROM epg_virtual WHERE end_time_virtual < ?1')
    .bind(now - EPG_RETENTION)
    .run()
  return reports
}

/**
 * Carimbo da EXIBIÇÃO REAL: last_played_at = start da linha mais recente do
 * EPG que o relógio já cobriu (start <= agora), por episódio/filme. É a ÚNICA
 * fonte de progressão — o planejamento não grava nada. Assim a posição de cada
 * série sobrevive a rebuild/queda: o que foi ao ar conta, o que só estava
 * planejado não. Idempotente e monotônico (nunca anda pra trás).
 */
export async function commitAired(env: Env): Promise<number> {
  const now = Math.floor(Date.now() / 1000)
  // Janela de 3 dias em vez do passado inteiro (7 dias de retenção): o carimbo é
  // idempotente e monotônico, então o que passou antes disso JÁ foi carimbado
  // numa run anterior — reler tudo custava 33.021 linhas por chamada contra
  // 4.347 de um dia (medido em 18/09/2026). Três dias dão dois de folga sobre o
  // cron diário; se a TV ficar mais que isso sem planejar, o que escapar do
  // carimbo apenas volta ao rodízio mais cedo.
  const { results } = await env.DB.prepare(
    `SELECT e.media_id id, MAX(e.start_time_virtual) t, m.last_played_at lp
     FROM epg_virtual e JOIN media_items m ON m.id = e.media_id
     WHERE e.start_time_virtual <= ?1 AND e.start_time_virtual > ?2
       AND m.tipo IN ('episodio','filme')
     GROUP BY e.media_id`,
  ).bind(now, now - 3 * DAY).all<{ id: string; t: number; lp: number | null }>()
  const mudou = results.filter((r) => r.lp == null || r.lp < r.t)
  for (let i = 0; i < mudou.length; i += 50) {
    await env.DB.batch(
      mudou.slice(i, i + 50).map((r) =>
        env.DB.prepare(
          'UPDATE media_items SET last_played_at = ?2 WHERE id = ?1 AND (last_played_at IS NULL OR last_played_at < ?2)',
        ).bind(r.id, r.t),
      ),
    )
  }
  return mudou.length
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
