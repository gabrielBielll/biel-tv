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
    const ord = [...eps].sort((a, b) => a.id.localeCompare(b.id))
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
  const duranteDe = new Map<string, string[]>() // bumper "você está vendo X" → só dentro do universo de X
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
        // seguidos dele — nunca fora do universo da série (pedido do Gabriel)
        if (cond.tipo === 'durante' && cond.series_id) {
          const lista = duranteDe.get(cond.series_id) ?? []
          lista.push(p.media_id)
          duranteDe.set(cond.series_id, lista)
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

  const contents = media.filter((m) => m.tipo === 'episodio' || m.tipo === 'filme')
  const ads = media.filter((m) => m.tipo === 'comercial' && !foraDoRodizio.has(m.id))
  const vins = media.filter((m) => m.tipo === 'vinheta' && !foraDoRodizio.has(m.id))
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
  // rotação em BLOCOS: episódios da mesma série emendados (até N seguidos),
  // séries alternando em rodízio; menos-tocada lidera, empates pela seed do dia
  const blocoMax = Math.max(1, chan.episodios_por_bloco ?? 2)
  const blocos = montaBlocos(contents, blocoMax, rnd)
  const adPool = shuffled(ads, rnd)
  let ai = 0
  let vi = 0
  let bi = 0 // qual bloco
  let ei = 0 // qual episódio dentro do bloco atual
  let lastAd = ''
  const rows: Array<[string, string, number, number, number]> = []
  const playedAt: Record<string, number> = {}

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
  let ultimoPodFim = -Infinity
  let peIdx = 0
  let duIdx = 0
  // serieCtx: série "dona" deste intervalo — no meio de um episódio dela, ou
  // entre dois episódios seguidos dela. O bumper "você está vendo X" ABRE o
  // pod nesse contexto (como na TV real) e não existe em nenhum outro lugar.
  const breakPod = (serieCtx?: string | null) => {
    if (t - ultimoPodFim < MIN_ENTRE_PODS) return
    const alvo = chan.break_target_seg ?? 120
    const bumpers = serieCtx ? duranteDe.get(serieCtx) ?? [] : []
    if (bumpers.length > 0) {
      const bp = porId.get(bumpers[duIdx++ % bumpers.length])
      if (bp) {
        push(bp.id, t, t + bp.duracao_seg, 0)
        t += bp.duracao_seg
      }
    }
    // tolerância de 25%: estourar um pouco o alvo é ritmo normal de TV
    // (2×70s num alvo de 120 ✓); o que não pode é UM comercial de 200s
    // entrar sozinho num intervalo de 120 tendo alternativa que caiba
    const folga = Math.ceil(alvo * 0.25)
    const usados = new Set<string>()
    let sum = 0
    for (;;) {
      const restante = alvo - sum
      const cands = adPool.filter((a) =>
        !usados.has(a.id) && !(usados.size === 0 && a.id === lastAd && adPool.length > 1))
      if (cands.length === 0 || restante <= 0) break
      const cabem = cands.filter((a) => a.duracao_seg <= restante + folga)
      let pick: MediaRow
      if (cabem.length > 0) pick = cabem[ai++ % cabem.length]
      else if (sum === 0) pick = cands.reduce((a, b) => (a.duracao_seg <= b.duracao_seg ? a : b))
      else break
      push(pick.id, t, t + pick.duracao_seg, 0)
      t += pick.duracao_seg
      sum += pick.duracao_seg
      usados.add(pick.id)
      lastAd = pick.id
    }
    // janela de promoção: enquanto a maratona não começou, o intervalo
    // fecha com UMA promo do evento (rodízio entre as elegíveis) — é assim
    // que você fica sabendo durante a semana que sábado tem maratona
    const eleg = promosEvento.filter((p) => t < p.ate)
    if (eleg.length > 0) {
      const pr = porId.get(eleg[peIdx++ % eleg.length].id)
      if (pr && !usados.has(pr.id)) {
        push(pr.id, t, t + pr.duracao_seg, 0)
        t += pr.duracao_seg
        sum += pr.duracao_seg
        lastAd = pr.id
      }
    }
    if (sum > 0 || bumpers.length > 0) ultimoPodFim = t
  }

  // agenda um conteúdo com seus breaks nos cue points (pods do MEIO do
  // programa nunca levam "a seguir" — o próximo bloco é a continuação dele)
  const agendaConteudo = (c: MediaRow) => {
    playedAt[c.id] = t
    const cues = (cuesOf[c.id] ?? []).filter((x) => x > 0 && x < c.duracao_seg)
    let pos = 0
    for (const cue of cues) {
      push(c.id, t, t + (cue - pos), pos / SEGMENT_DURATION)
      t += cue - pos
      pos = cue
      breakPod(c.series_id) // pod no MEIO do programa: o bumper dele pode abrir
    }
    push(c.id, t, t + (c.duracao_seg - pos), pos / SEGMENT_DURATION)
    t += c.duracao_seg - pos
  }

  // O intervalo ENTRE programas é montado já sabendo quem vem a seguir:
  // fecha com a promo "a seguir <série>" confirmada quando existir (colada
  // no programa prometido, como TV de verdade). Quando fecha com a promo,
  // ela faz o papel da vinheta de abertura.
  let asIdx = 0
  let ultimaSerie: string | null = null
  const podEntrePrograma = (proxima: MediaRow, continuacao: boolean): boolean => {
    // continuacao = próximo episódio do MESMO bloco (mesma série, emendado): é
    // permanência dentro do universo dela — o bumper "você está vendo X" pode
    // abrir o pod e NÃO se anuncia "a seguir" (o próximo é a mesma coisa).
    const mesmaSerie = continuacao
      ? proxima.series_id
      : ultimaSerie && proxima.series_id === ultimaSerie ? ultimaSerie : null
    breakPod(mesmaSerie)
    if (continuacao) return false
    const promoIds = proxima.series_id ? aSeguirDe.get(proxima.series_id) ?? [] : []
    const promo = promoIds.length > 0 ? porId.get(promoIds[asIdx++ % promoIds.length]) : undefined
    if (!promo) return false
    push(promo.id, t, t + promo.duracao_seg, 0)
    t += promo.duracao_seg
    return true
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

  while (t < target) {
    // maratona agendada cobrindo este instante? o evento manda na grade
    const ev = eventos.find((e) => t >= e.start_at - 300 && t < e.end_at)
    const evMedia = ev ? proximoDaMaratona(ev) : undefined

    let prox: MediaRow
    let continuacao = false
    if (evMedia) {
      prox = evMedia // a maratona cuida da própria emenda; não mexe no cursor de blocos
    } else {
      const bloco = blocos[bi % blocos.length]
      prox = bloco[ei]
      // continuação = não é o 1º do bloco E emenda a mesma série que saiu agora;
      // se um evento entrou no meio do bloco, ultimaSerie muda e o bloco reabre
      continuacao = ei > 0 && prox.series_id != null && prox.series_id === ultimaSerie
      ei++
      if (ei >= bloco.length) { bi++; ei = 0 }
    }

    let fechouComASeguir = false
    if (!primeiroBloco) fechouComASeguir = podEntrePrograma(prox, continuacao)
    primeiroBloco = false

    // vinheta de abertura só quando começa um bloco NOVO: maratona emenda sem
    // vinheta, episódio-continuação do mesmo bloco também, e "a seguir" já abre
    if (!evMedia && !continuacao && !fechouComASeguir && vins.length > 0) {
      const v = vins[vi++ % vins.length]
      push(v.id, t, t + v.duracao_seg, 0)
      t += v.duracao_seg
    }
    agendaConteudo(prox)
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
