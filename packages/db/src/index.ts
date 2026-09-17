// Tipos e SQL compartilhados entre o Worker de streaming, o Diretor e o pipeline.

export const SEGMENT_DURATION = 10 // segundos — todo o sistema assume múltiplos disso

export interface MediaItem {
  id: string
  tipo: 'episodio' | 'filme' | 'comercial' | 'vinheta' | 'placeholder'
  status: 'ingesting' | 'ready' | 'disabled'
  duracao_seg: number
  segment_count: number
  base_url: string
  path_prefix: string
  metadata: string
  last_played_at: number | null
  created_at: number
}

export interface EpgRow {
  id: number
  canal: string
  media_id: string
  start_time_virtual: number
  end_time_virtual: number
  segment_index_start: number
}

export interface EpgRowWithMedia extends EpgRow {
  base_url: string
  path_prefix: string
  segment_count: number
  tipo: MediaItem['tipo']
  metadata: string
}

// Quanto tempo ANTES do início da janela uma linha do EPG ainda pode ter
// começado. Uma linha nunca dura mais que a mídia dela (a mais longa do acervo
// tem ~1h45), então 6h é folga de sobra — e é o que transforma a varredura num
// seek no índice (canal, start_time_virtual).
const EPG_LINHA_MAX = 6 * 3600

// Linhas do EPG que se sobrepõem ao intervalo [?2, ?3) de um canal, com os
// dados da mídia necessários para montar URLs de segmento.
//
// ⚠️ O piso em `start_time_virtual` não é cosmético. Sem ele o índice
// (canal, start) só limitava o LADO DIREITO (`start < ?3`) e cada pedido de
// playlist varria TODO o passado do canal guardado na tabela: **5.180 linhas
// por chamada**. Em 2026-09-15, 1.113 chamadas = 5,7 milhões de linhas lidas,
// o limite diário do D1 free estourou e os três canais caíram (HTTP 500 no
// /live) até a virada UTC. Com o piso, cada /live lê ~200 linhas.
// Janela do AO VIVO: em vez de varrer um intervalo, faz duas buscas diretas —
// a linha que cobre o início da janela (a que está no ar) e as poucas que
// começam dentro dela. O /live é chamado a cada poucos segundos por cada
// espectador, então é ele que decide se a conta de leitura do D1 fecha no mês:
// ~6 linhas por chamada aqui, contra ~200 da consulta de intervalo (e ~5.180
// antes do piso, que foi o que derrubou os canais em 15/09/2026).
// O `LIMIT 1` dentro de subconsulta é exigência do SQLite (ORDER BY/LIMIT só
// valem no último ramo de um compound SELECT).
export const SQL_EPG_AGORA = `
SELECT e.id, e.canal, e.media_id, e.start_time_virtual, e.end_time_virtual,
       e.segment_index_start, m.base_url, m.path_prefix, m.segment_count,
       m.tipo, m.metadata
FROM (
  SELECT * FROM (
    SELECT * FROM epg_virtual
    WHERE canal = ?1 AND start_time_virtual <= ?2
    ORDER BY start_time_virtual DESC LIMIT 1
  )
  UNION ALL
  SELECT * FROM epg_virtual
  WHERE canal = ?1 AND start_time_virtual > ?2 AND start_time_virtual < ?3
) e
JOIN media_items m ON m.id = e.media_id
WHERE e.end_time_virtual > ?2
ORDER BY e.start_time_virtual
`

export const SQL_EPG_OVERLAP = `
SELECT e.id, e.canal, e.media_id, e.start_time_virtual, e.end_time_virtual,
       e.segment_index_start, m.base_url, m.path_prefix, m.segment_count,
       m.tipo, m.metadata
FROM epg_virtual e
JOIN media_items m ON m.id = e.media_id
WHERE e.canal = ?1
  AND e.start_time_virtual < ?3
  AND e.start_time_virtual > ?2 - ${EPG_LINHA_MAX}
  AND e.end_time_virtual > ?2
ORDER BY e.start_time_virtual
`
