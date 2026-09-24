// PAPEL de cada peça de intervalo: o que é DA CASA (chamada, interprograma,
// institucional, promo de horário/maratona) e o que é ANÚNCIO de produto.
//
// Visão do Gabriel (24/09/2026): nos canais de verdade o que mais passava no
// intervalo era a própria programação. Quem assiste descobre pelos intervalos
// o que passa naquele canal; o anúncio de produto só enche o espaço. Medido
// no mesmo dia: no Disney, 56% dos intervalos não tinham NENHUMA peça da casa.
//
// A regra é pelo id (os ids do acervo são descritivos, e é assim que peça nova
// já nasce classificada). `metadata.papel` sobrescreve quando a regra erra, e
// `metadata.anuncia` diz qual série a peça divulga quando o id não diz.
// Função pura, coberta por scripts/verify-papel-comercial.mjs.

export type Papel = 'anuncio' | 'casa' | 'entrada' | 'retorno'

export interface PecaIntervalo {
  id: string
  series_id?: string | null
  papel?: string | null // override do metadata
  anuncia?: string | null // override do metadata
}

export interface PromessaDaPeca {
  tipo?: string | null
  series_id?: string | null
  hora?: string | null
  dias?: number[] | null
}

const PAPEIS: readonly string[] = ['anuncio', 'casa', 'entrada', 'retorno']

// Anúncio de produto, por origem do lote. Vem ANTES das regras da casa: o lote
// "cn_colecao_externo" é anúncio mesmo tendo "cn" no nome.
const ANUNCIO = [
  /^com_disney_2009_/, // brinquedos e produtos dos intervalos do Disney de 2009
  /^com_cn_colecao_externo_/, // anúncios externos da coleção do CN
  /^com_cn_colecao_licenciado_/, // produto licenciado (é anúncio, não chamada)
  /^com_lote_inicial_(?!06_cartoon_network)/, // lote inicial (o 06 é serviço do CN)
]

// Estrutura do intervalo: bumper do CANAL que abre ("já voltamos") e que fecha
// ("voltamos") quando o programa não tem o bumper próprio.
const ENTRADA = [/entrada_intervalo/]
const RETORNO = [/retorno_intervalo/]

// Da casa: chamadas, interprogramas, institucionais e promos do próprio canal.
const CASA = [
  /^com_ev_/, // promo de maratona (janela de promoção)
  /^com_cn_invasao_referencia_cn_/,
  /^com_cn_colecao_referencia_cn_/,
  /^com_cartoon_network_/,
  /^com_lote_inicial_06_cartoon_network/,
  /^com_jetix_/,
  /disney_channel/, // institucional do Disney ("com_comercial_disney_channel_200x")
  /^com_conheca_/, // "Conheça o Ranger..." da Jetix
  /^com_promo_/,
  /^com_cn_biografia_toon_/,
  /^com_cn_promo_/,
  /_chamada(_|$)/,
  /^ep_momento_/,
]

/**
 * Papel da peça: override do metadata > regra do id > promessa de horário >
 * série. `anuncia` é o resultado de anunciaDe: comercial que leva o nome de
 * uma série do canal é peça do programa (ex.: Capitão Lento no CN).
 */
export function papelDe(p: PecaIntervalo, promessa?: PromessaDaPeca | null, anuncia?: string | null): Papel {
  if (p.papel && PAPEIS.includes(p.papel)) return p.papel as Papel
  const id = p.id
  if (ANUNCIO.some((r) => r.test(id))) return 'anuncio'
  if (ENTRADA.some((r) => r.test(id))) return 'entrada'
  if (RETORNO.some((r) => r.test(id))) return 'retorno'
  if (CASA.some((r) => r.test(id))) return 'casa'
  // promo de horário/maratona gerada pela fábrica: sempre da casa
  if (promessa?.tipo === 'bloco_horario' || promessa?.tipo === 'evento') return 'casa'
  // comercial com série (no metadata ou no id) é peça de programa do canal
  if (p.series_id || anuncia) return 'casa'
  return 'anuncio'
}

/**
 * Série que a peça divulga (pra preferir a chamada de programa que passa MAIS
 * TARDE e nunca anunciar o que está no ar). Override > promessa > série do
 * metadata > série do canal que aparece no id (a mais longa, pra
 * "looney_tunes_show" não virar "looney_tunes").
 */
export function anunciaDe(p: PecaIntervalo, promessa: PromessaDaPeca | null | undefined, seriesDoCanal: Iterable<string>): string | null {
  if (p.anuncia) return p.anuncia
  if (promessa?.series_id) return promessa.series_id
  if (p.series_id) return p.series_id
  let melhor: string | null = null
  for (const s of seriesDoCanal) {
    if (s.length >= 3 && p.id.includes(s) && (!melhor || s.length > melhor.length)) melhor = s
  }
  return melhor
}
