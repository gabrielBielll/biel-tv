export interface EpgItem {
  media_id: string
  tipo: string
  title: string
  start: number
  end: number
  segment_index_start: number
  is_now: boolean
}

export interface EpgResponse {
  canal: string
  now: number
  items: EpgItem[]
}

/** Um "programa" como aparece no guia: partes do mesmo episódio já unidas. */
export interface Program {
  media_id: string
  tipo: string
  title: string
  start: number
  end: number
}

export async function fetchEpg(api: string, canal: string): Promise<EpgResponse> {
  const res = await fetch(`${api}/epg/${canal}`)
  if (!res.ok) throw new Error(`EPG HTTP ${res.status}`)
  return res.json()
}

/**
 * Transforma as linhas cruas do EPG (que incluem comerciais e episódios
 * fatiados pelos intervalos) num guia de TV: comerciais/vinhetas somem, e uma
 * continuação (segment_index_start > 0) estende o programa anterior em vez de
 * virar uma entrada nova.
 */
export function coalesce(items: EpgItem[]): Program[] {
  const programs: Program[] = []
  for (const it of items) {
    if (it.tipo === 'comercial' || it.tipo === 'vinheta') continue
    const prev = programs.at(-1)
    if (prev && prev.media_id === it.media_id && it.segment_index_start > 0) {
      prev.end = it.end
      continue
    }
    programs.push({
      media_id: it.media_id,
      tipo: it.tipo,
      title: it.title,
      start: it.start,
      end: it.end,
    })
  }
  return programs
}

export function nowAndNext(programs: Program[], now: number) {
  const idx = programs.findIndex((p) => p.start <= now && now < p.end)
  return {
    current: idx >= 0 ? programs[idx] : undefined,
    next: idx >= 0 ? programs[idx + 1] : programs.find((p) => p.start > now),
  }
}

const fmtHM = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  hour: '2-digit',
  minute: '2-digit',
})

export const hm = (unix: number) => fmtHM.format(new Date(unix * 1000))
