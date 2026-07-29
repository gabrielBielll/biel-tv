import { SEGMENT_DURATION, type EpgRowWithMedia, type MediaItem } from '@bieltv/db'

const pad5 = (n: number) => String(n).padStart(5, '0')

/**
 * URL de um segmento `.ts` a partir dos dados de armazenamento da mídia.
 * base_url vazia = mesma origem do Worker (rota /media/* lendo o binding R2);
 * em prod = domínio público do bucket. Compartilhada pelo live e pelo VOD.
 */
export function mediaSegmentUri(baseUrl: string, pathPrefix: string, segIdx: number): string {
  const file = `seg${pad5(segIdx)}.ts`
  const base = baseUrl.replace(/\/+$/, '')
  return base ? `${base}/${pathPrefix}/${file}` : `/${pathPrefix}/${file}`
}

function segmentUri(row: EpgRowWithMedia, segIdx: number): string {
  return mediaSegmentUri(row.base_url, row.path_prefix, segIdx)
}

interface WindowEntry {
  slot: number // número global do slot de 10s: floor(unix/10)
  row: EpgRowWithMedia
  segIdx: number
  uri: string
}

/**
 * Playlist ao vivo como função pura de (relógio, EPG) — sem estado.
 *
 * A linha do tempo é dividida em slots globais de 10s. A janela cobre
 * `windowBehind` slots atrás e `windowAhead` à frente do slot "no ar" — os
 * segmentos futuros já existem (tudo é pré-cortado), e servi-los encurta o
 * atraso entre o relógio da grade e o que aparece na tela.
 * Todos os espectadores de um canal recebem exatamente a mesma resposta, o
 * que os mantém sincronizados e torna a resposta cacheável por alguns segundos.
 */
export function buildLivePlaylist(
  rows: EpgRowWithMedia[],
  nowSec: number,
  windowBehind = 4,
  windowAhead = 1,
): string | null {
  const nowSlot = Math.floor(nowSec / SEGMENT_DURATION)

  const entries: WindowEntry[] = []
  for (let slot = nowSlot - windowBehind; slot <= nowSlot + windowAhead; slot++) {
    const t = slot * SEGMENT_DURATION
    const row = rows.find((r) => r.start_time_virtual <= t && t < r.end_time_virtual)
    if (!row) continue // buraco no EPG — mídia 'placeholder' entra aqui na fase 4
    const offset = Math.floor((t - row.start_time_virtual) / SEGMENT_DURATION)
    // Clamp defensivo: se o EPG alocar mais tempo do que a mídia tem,
    // repete o último segmento em vez de gerar URL de arquivo inexistente.
    const segIdx = Math.min(row.segment_index_start + offset, row.segment_count - 1)
    entries.push({ slot, row, segIdx, uri: segmentUri(row, segIdx) })
  }
  if (entries.length === 0) return null

  const first = entries[0]
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    `#EXT-X-TARGETDURATION:${SEGMENT_DURATION}`,
    // Slot global do relógio: monotônico e idêntico entre reloads/espectadores.
    `#EXT-X-MEDIA-SEQUENCE:${first.slot}`,
    // Id da linha do EPG que contém o 1º segmento: incrementa exatamente quando
    // um bloco inteiro (e a descontinuidade que o precedia) sai da janela.
    // Válido enquanto o EPG for inserido em ordem cronológica (RFC 8216 §4.3.3.3).
    `#EXT-X-DISCONTINUITY-SEQUENCE:${first.row.id}`,
    `#EXT-X-PROGRAM-DATE-TIME:${new Date(first.slot * SEGMENT_DURATION * 1000).toISOString()}`,
  ]

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (i > 0) {
      const prev = entries[i - 1]
      const contiguous =
        prev.row.media_id === e.row.media_id &&
        e.segIdx === prev.segIdx + 1 &&
        e.slot === prev.slot + 1
      if (!contiguous) lines.push('#EXT-X-DISCONTINUITY')
    }
    lines.push(`#EXTINF:${SEGMENT_DURATION.toFixed(1)},`, e.uri)
  }

  // Sem #EXT-X-ENDLIST: o player trata como transmissão ao vivo.
  return lines.join('\n') + '\n'
}

/**
 * Playlist VOD (catch-up) de uma mídia inteira — do 1º ao último segmento.
 *
 * Diferente do live: é FINITA (`#EXT-X-ENDLIST`) e marcada como VOD, então o
 * player mostra a barra de progresso e permite buscar livremente. Toca o
 * episódio/filme "limpo" (comerciais são mídias separadas na grade) começando
 * do zero. Depende só da mídia (não da grade), então vale mesmo pra programa
 * que já saiu do EPG — é estático e cacheável por conteúdo.
 */
export function buildVodPlaylist(
  media: Pick<MediaItem, 'base_url' | 'path_prefix' | 'segment_count'>,
): string | null {
  if (!media.segment_count || media.segment_count < 1) return null

  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    `#EXT-X-TARGETDURATION:${SEGMENT_DURATION}`,
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-MEDIA-SEQUENCE:0',
  ]
  for (let i = 0; i < media.segment_count; i++) {
    lines.push(
      `#EXTINF:${SEGMENT_DURATION.toFixed(1)},`,
      mediaSegmentUri(media.base_url, media.path_prefix, i),
    )
  }
  lines.push('#EXT-X-ENDLIST')
  return lines.join('\n') + '\n'
}
