// Lineup de três janelas NA GRADE: "você está assistindo X, depois Y, mais
// tarde Z". A peça é uma PROMESSA sobre a programação, então só pode tocar onde
// a grade planejada cumpre a sequência inteira. A regra foi combinada com o
// modelo que montou os lineups (card d5HGORZp, 23/09/2026):
//   - identidade da peça: a sequência de séries X→Y→Z (+ versões de template,
//     voz e trilha). A mesma peça volta em qualquer dia em que a sequência se
//     repetir, sem ficar presa a um horário;
//   - elegibilidade: conferida AQUI, nas linhas da grade. No intervalo de X,
//     os dois blocos seguintes têm de ser exatamente Y e Z.
//
// Como entra: num intervalo DENTRO do bloco de X, a peça troca anúncios do
// rodízio cego cuja duração soma exatamente a dela. O intervalo mantém a mesma
// duração, então nenhum horário da grade se move: programa, âncora e o resto
// do intervalo ficam onde estavam. Sem combinação que feche a conta, o bloco
// fica sem lineup (melhor sem do que empurrar a grade).
//
// Funções puras, sem banco: cobertas por scripts/verify-lineup-grade.mjs.

/** canal, media_id, início, fim, segment_index_start — o formato das linhas do scheduler */
export type LinhaGrade = [string, string, number, number, number]

export interface LinhaLineup {
  linha: LinhaGrade
  /** true = já está gravada no banco; false = do lote que está sendo planejado */
  preservada: boolean
}

export interface InfoMidia { tipo: string | null; series_id: string | null }

export type Sequencia = [string, string, string]

export interface PecaLineup { id: string; duracao_seg: number; seq: Sequencia }

/**
 * Em qual intervalo do bloco de X a peça entra. A decisão ainda é do Gabriel,
 * por isso é parâmetro e não constante:
 *  - 'ultimo': o intervalo mais perto do fim do bloco ("depois" já está chegando);
 *  - 'meio':   o intervalo mais perto do meio do bloco.
 */
export type PosicaoLineup = 'ultimo' | 'meio'

export interface OpcoesEncaixe {
  pecas: PecaLineup[]
  info: Map<string, InfoMidia>
  /** anúncios do rodízio cego: os únicos que a peça pode tirar do intervalo */
  removivel: Set<string>
  posicao: PosicaoLineup
  /** intervalo que começa antes disso pode já estar no buffer do player: não mexe */
  editavelDesde: number
}

export interface PodAlterado { inicio: number; fim: number; preservado: boolean; linhas: LinhaGrade[] }

export interface ResultadoEncaixe {
  linhas: LinhaLineup[]
  /** intervalos reescritos. Os preservados viram DELETE+INSERT da mesma faixa de tempo */
  pods: PodAlterado[]
  encaixes: Array<{ id: string; seq: Sequencia; inicio: number }>
  /** havia peça pra sequência, mas nenhum intervalo do bloco fechava a conta */
  semEspaco: Array<{ seq: Sequencia; blocoInicio: number }>
  /** sequência que aconteceu na grade sem peça gravada (inventário do que falta) */
  semPeca: Array<{ seq: Sequencia; blocoInicio: number }>
}

const CONTEUDO = new Set(['episodio', 'filme'])

/** Prefixo do media_id que o /lineup-jobs dá às peças (fabrica-comerciais.ts). */
export const PREFIXO_LINEUP = 'com_lineup_'

export interface Bloco { serie: string | null; primeiro: number; ultimo: number }

/**
 * Programa = linha de episódio/filme. Mídia desconhecida (apagada do catálogo
 * depois de agendada) conta como programa SEM série: vira barreira, porque não
 * dá pra afirmar nada sobre ela.
 */
function ehConteudo(info: Map<string, InfoMidia>, id: string, ehLineup: (id: string) => boolean): boolean {
  if (ehLineup(id)) return false // peça de lineup é intervalo, mesmo sem estar no mapa
  const m = info.get(id)
  return !m || m.tipo == null || CONTEUDO.has(m.tipo)
}

/**
 * Blocos de programa: linhas de conteúdo seguidas da mesma série, ignorando os
 * intervalos entre elas. Conteúdo sem série só emenda consigo mesmo (as partes
 * do mesmo episódio cortadas pelos cue points).
 */
export function blocosDeConteudo(
  linhas: LinhaGrade[],
  info: Map<string, InfoMidia>,
  ehLineup: (id: string) => boolean = (id) => id.startsWith(PREFIXO_LINEUP),
): Bloco[] {
  const blocos: Bloco[] = []
  for (let i = 0; i < linhas.length; i++) {
    if (!ehConteudo(info, linhas[i][1], ehLineup)) continue
    const serie = info.get(linhas[i][1])?.series_id ?? null
    const b = blocos.at(-1)
    const emenda = b && b.serie === serie && (serie !== null || linhas[b.ultimo][1] === linhas[i][1])
    if (b && emenda) b.ultimo = i
    else blocos.push({ serie, primeiro: i, ultimo: i })
  }
  return blocos
}

/**
 * Escolhe itens cuja duração soma EXATAMENTE `alvo`. Prefere menos itens e,
 * no empate, os mais perto do fim do intervalo. Devolve índices ou null.
 */
export function escolheSoma(duracoes: Array<{ k: number; d: number }>, alvo: number): number[] | null {
  const n = duracoes.length
  for (let a = n - 1; a >= 0; a--) if (duracoes[a].d === alvo) return [duracoes[a].k]
  for (let a = n - 1; a >= 0; a--) {
    for (let b = a - 1; b >= 0; b--) {
      if (duracoes[a].d + duracoes[b].d === alvo) return [duracoes[b].k, duracoes[a].k]
    }
  }
  for (let a = n - 1; a >= 0; a--) {
    for (let b = a - 1; b >= 0; b--) {
      for (let c = b - 1; c >= 0; c--) {
        if (duracoes[a].d + duracoes[b].d + duracoes[c].d === alvo) return [duracoes[c].k, duracoes[b].k, duracoes[a].k]
      }
    }
  }
  return null
}

export function encaixaLineups(entrada: LinhaLineup[], op: OpcoesEncaixe): ResultadoEncaixe {
  const linhas = entrada.map((x) => x.linha)
  const res: ResultadoEncaixe = { linhas: entrada, pods: [], encaixes: [], semEspaco: [], semPeca: [] }
  if (linhas.length === 0) return res

  const idsLineup = new Set(op.pecas.map((p) => p.id))
  const ehLineup = (id: string) => idsLineup.has(id) || id.startsWith(PREFIXO_LINEUP)
  const porSeq = new Map<string, PecaLineup[]>()
  for (const p of op.pecas) {
    const k = p.seq.join('>')
    const lista = porSeq.get(k) ?? []
    lista.push(p)
    porSeq.set(k, lista)
  }
  for (const l of porSeq.values()) l.sort((a, b) => a.id.localeCompare(b.id))
  // rodízio entre peças da MESMA sequência (variações): a menos usada nesta passada
  const uso = new Map<string, number>()

  const blocos = blocosDeConteudo(linhas, op.info, ehLineup)
  const trocas = new Map<number, { fim: number; novas: LinhaGrade[] }>()

  for (let b = 0; b + 2 < blocos.length; b++) {
    const X = blocos[b].serie
    const Y = blocos[b + 1].serie
    const Z = blocos[b + 2].serie
    if (!X || !Y || !Z) continue
    const seq: Sequencia = [X, Y, Z]
    const blocoInicio = linhas[blocos[b].primeiro][2]

    // intervalos DENTRO do bloco de X: corrida de não-conteúdo entre duas linhas
    // de conteúdo dele. Não atravessa a fronteira banco/lote novo — os dois
    // lados são gravados de jeitos diferentes.
    const pods: Array<{ i0: number; i1: number }> = []
    for (let i = blocos[b].primeiro + 1; i < blocos[b].ultimo; i++) {
      if (ehConteudo(op.info, linhas[i][1], ehLineup)) continue
      let j = i
      while (j + 1 < blocos[b].ultimo && !ehConteudo(op.info, linhas[j + 1][1], ehLineup)
        && entrada[j + 1].preservada === entrada[i].preservada) j++
      pods.push({ i0: i, i1: j })
      i = j
    }
    // bloco que já tem lineup (run anterior) não ganha outro
    if (pods.some((p) => linhas.slice(p.i0, p.i1 + 1).some((l) => ehLineup(l[1])))) continue

    const cands = porSeq.get(seq.join('>'))
    if (!cands) { res.semPeca.push({ seq, blocoInicio }); continue }
    const peca = cands.reduce((a, c) => ((uso.get(c.id) ?? 0) < (uso.get(a.id) ?? 0) ? c : a), cands[0])

    const meio = (linhas[blocos[b].primeiro][2] + linhas[blocos[b].ultimo][3]) / 2
    const ordem = pods
      .filter((p) => linhas[p.i0][2] >= op.editavelDesde)
      .sort((p, q) => op.posicao === 'ultimo'
        ? linhas[q.i0][2] - linhas[p.i0][2]
        : Math.abs((linhas[p.i0][2] + linhas[p.i1][3]) / 2 - meio) - Math.abs((linhas[q.i0][2] + linhas[q.i1][3]) / 2 - meio))

    let entrou = false
    for (const p of ordem) {
      const pod = linhas.slice(p.i0, p.i1 + 1)
      const removiveis = pod
        .map((l, k) => ({ k, d: l[3] - l[2], id: l[1] }))
        .filter((x) => op.removivel.has(x.id))
      const sel = escolheSoma(removiveis, peca.duracao_seg)
      if (!sel) continue
      const tira = new Set(sel)
      // a peça entra onde estava o ÚLTIMO anúncio do rodízio: o que vem depois
      // dele (vinheta de volta "estamos de volta com X", promo de evento) segue
      // fechando o intervalo, colado no retorno do programa
      const ultimoRemovivel = removiveis[removiveis.length - 1].k
      let t = pod[0][2]
      const novas: LinhaGrade[] = []
      for (let k = 0; k < pod.length; k++) {
        if (!tira.has(k)) {
          const d = pod[k][3] - pod[k][2]
          novas.push([pod[k][0], pod[k][1], t, t + d, pod[k][4]])
          t += d
        }
        if (k === ultimoRemovivel) {
          novas.push([pod[0][0], peca.id, t, t + peca.duracao_seg, 0])
          t += peca.duracao_seg
        }
      }
      // invariante: o intervalo termina onde terminava. Se não, não mexe.
      if (t !== pod[pod.length - 1][3]) continue
      trocas.set(p.i0, { fim: p.i1, novas })
      res.pods.push({ inicio: pod[0][2], fim: t, preservado: entrada[p.i0].preservada, linhas: novas })
      res.encaixes.push({ id: peca.id, seq, inicio: novas.find((l) => l[1] === peca.id)![2] })
      uso.set(peca.id, (uso.get(peca.id) ?? 0) + 1)
      entrou = true
      break
    }
    if (!entrou) res.semEspaco.push({ seq, blocoInicio })
  }

  if (trocas.size === 0) return res
  const saida: LinhaLineup[] = []
  for (let i = 0; i < entrada.length; i++) {
    const tr = trocas.get(i)
    if (!tr) { saida.push(entrada[i]); continue }
    for (const l of tr.novas) saida.push({ linha: l, preservada: entrada[i].preservada })
    i = tr.fim
  }
  res.linhas = saida
  return res
}

/**
 * REBUILD PARCIAL × lineup já gravado. O rebuild a partir de `corte` reescreve
 * o futuro, e um lineup que ficou ANTES do corte pode estar prometendo Y ou Z
 * que vêm DEPOIS dele — e que agora podem mudar. Nesse caso o corte recua até
 * a fronteira antes do bloco de X (fim do programa anterior), e o bloco inteiro
 * é replanejado junto: o lineup some ou volta conferido.
 *
 * `linhas`: as linhas gravadas que começam antes do corte (em ordem). `piso`:
 * fim do bloco no ar, que nunca é tocado.
 */
export function recuaCorte(
  linhas: LinhaGrade[],
  info: Map<string, InfoMidia>,
  ehLineup: (id: string) => boolean,
  corte: number,
  piso: number,
): number {
  const blocos = blocosDeConteudo(linhas, info, ehLineup)
  let novo = corte
  for (let L = 0; L < linhas.length; L++) {
    if (linhas[L][2] < piso || ehConteudo(info, linhas[L][1], ehLineup) || !ehLineup(linhas[L][1])) continue
    // bloco de X = o último bloco que começa antes do lineup
    let b = -1
    for (let k = 0; k < blocos.length; k++) if (blocos[k].primeiro < L) b = k
    // Y e Z começam antes do corte ⇒ a promessa inteira está preservada
    if (b >= 0 && b + 2 < blocos.length) continue
    const fronteira = b >= 1 ? linhas[blocos[b - 1].ultimo][3] : piso
    novo = Math.min(novo, Math.max(fronteira, piso))
  }
  return novo
}

/**
 * Lê a sequência X→Y→Z de uma condição `lineup_grade`. Aceita o formato do
 * /lineup-jobs (current + next[2], com media_id e horário, que aqui são
 * ignorados de propósito: vale a SÉRIE) e o enxuto `seq: [X, Y, Z]`.
 */
export function sequenciaDaCondicao(cond: Record<string, unknown>): Sequencia | null {
  const ok = (s: unknown): s is string => typeof s === 'string' && /^[a-z0-9_]{2,80}$/.test(s)
  if (Array.isArray(cond.seq) && cond.seq.length === 3 && cond.seq.every(ok)) return cond.seq as Sequencia
  const cur = (cond.current as { series_id?: unknown } | undefined)?.series_id
  const nx = Array.isArray(cond.next) ? (cond.next as Array<{ series_id?: unknown }>).map((n) => n?.series_id) : []
  if (ok(cur) && nx.length >= 2 && ok(nx[0]) && ok(nx[1])) return [cur, nx[0], nx[1]]
  return null
}

/** config `lineup_grade:<canal>` → posição, ou null (desligado). */
export function posicaoDoConfig(v: string | null | undefined): PosicaoLineup | null {
  if (!v) return null
  let p: unknown = v
  try { p = (JSON.parse(v) as { posicao?: unknown }).posicao ?? JSON.parse(v) } catch { /* texto puro */ }
  return p === 'ultimo' || p === 'meio' ? p : null
}
