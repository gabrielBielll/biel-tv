// O GUIA (o que o /epg devolve) é feito de PROGRAMA, não de linha de grade.
//
// A `epg_virtual` guarda EXECUÇÃO: cada comercial é uma linha e todo episódio
// sai picado em uma linha por intervalo. Os dois apps jogavam isso fora no
// cliente (`normalizeEpg` no React, `coalesce` no Vue) — ou seja, baixavam o
// guia inteiro pra desenhar um décimo dele. Medido em 15/09/2026, com o app
// pedindo `past=7d`: 6.560 itens / 1,5 MB por troca de canal no Cartoon, contra
// 728 itens / 155 KB depois desta montagem. Era a causa do travamento ao trocar
// de canal — e o trabalho passa a ser feito uma vez aqui, não em cada aparelho.
//
// Três passos: (1) comercial/vinheta não é programa; (2) as continuações do
// mesmo episódio viram UM item (o intervalo do meio fica dentro dele); (3) o
// programa se estende até o começo do próximo — é como um guia de TV mostra
// ("10:00 Scooby" cobre o intervalo que fecha a meia hora), e é o que garante
// que SEMPRE exista um item "no ar", em vez de o app ficar sem nada pra mostrar
// durante o intervalo entre dois programas.
import type { EpgRowWithMedia } from '@bieltv/db'

export interface ItemGuia {
  media_id: string
  tipo: string
  title: string
  serie: string | null
  start: number
  end: number
  // mantido por compatibilidade com os apps: sempre 0 (as partes já vêm unidas)
  segment_index_start: number
  is_now: boolean
}

// Comparação sem acento/caixa (pra saber se o título já traz o nome da série).
// O "&" vira "e" porque o título do arquivo e o slug da série divergem nisso
// ("Tom & Jerry - Ratoeira" vs `tom_e_jerry`) — sem isso o guia mostrava
// "Tom e Jerry — Tom & Jerry - Ratoeira", com o nome duplicado.
function normaliza(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' e ').replace(/\s+/g, ' ').toLowerCase().trim()
}

// Nome de exibição da série: preferir o clipe de voz 'nome' (grafia bonita,
// com acento — "Power Rangers Fúria da Selva"); sem clipe, capitaliza o slug.
export function slugBonito(sid: string): string {
  const MINUSCULAS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'o', 'a'])
  return sid.split('_')
    .map((p, i) => (i > 0 && MINUSCULAS.has(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(' ')
}

export function montaGuia(
  rows: EpgRowWithMedia[],
  now: number,
  nomeSerie: Map<string, string> = new Map(),
): ItemGuia[] {
  const items: ItemGuia[] = []
  for (const r of rows) {
    if (r.tipo === 'comercial' || r.tipo === 'vinheta') continue
    const ant = items.at(-1)
    if (ant && ant.media_id === r.media_id && r.segment_index_start > 0) {
      ant.end = r.end_time_virtual // continuação: o programa segue depois do break
      continue
    }
    let title = r.media_id
    let serie: string | null = null
    try {
      const meta = JSON.parse(r.metadata)
      title = (meta.title as string) ?? r.media_id
      const sid = meta.series_id as string | undefined
      if (sid) {
        serie = nomeSerie.get(sid) ?? slugBonito(sid)
        // O espectador precisa saber QUE SÉRIE é ("Bem-vindo à Selva" sozinho
        // não diz nada) — prefixa a série quando o título ainda não a traz.
        if (r.tipo === 'episodio' || r.tipo === 'filme') {
          if (!normaliza(title).includes(normaliza(serie))) title = `${serie} — ${title}`
        }
      }
    } catch { /* metadata inválido não derruba o guia */ }
    items.push({
      media_id: r.media_id,
      tipo: r.tipo,
      title,
      serie,
      start: r.start_time_virtual,
      end: r.end_time_virtual,
      segment_index_start: 0,
      is_now: false,
    })
  }
  // o programa ocupa a faixa até o próximo (o intervalo entre eles é dele) e só
  // então o "no ar" é decidido — assim ele nunca cai no vão entre dois blocos
  for (let i = 0; i < items.length; i++) {
    const prox = items[i + 1]
    if (prox && prox.start > items[i].end) items[i].end = prox.start
    items[i].is_now = items[i].start <= now && now < items[i].end
  }
  return items
}
