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

// Linhas do EPG que se sobrepõem ao intervalo [?2, ?3) de um canal, com os
// dados da mídia necessários para montar URLs de segmento.
export const SQL_EPG_OVERLAP = `
SELECT e.id, e.canal, e.media_id, e.start_time_virtual, e.end_time_virtual,
       e.segment_index_start, m.base_url, m.path_prefix, m.segment_count,
       m.tipo, m.metadata
FROM epg_virtual e
JOIN media_items m ON m.id = e.media_id
WHERE e.canal = ?1 AND e.end_time_virtual > ?2 AND e.start_time_virtual < ?3
ORDER BY e.start_time_virtual
`
