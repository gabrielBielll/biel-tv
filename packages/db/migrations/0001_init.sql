-- Biel TV — schema inicial (D1/SQLite)
-- Regra de ouro do sistema: TODO tempo é múltiplo de 10s (SEGMENT_DURATION).
-- Segmentos .ts têm exatamente 10.000s (force_key_frames no pipeline) e
-- start/end do EPG caem sempre em fronteira de segmento.

CREATE TABLE IF NOT EXISTS media_items (
  id            TEXT PRIMARY KEY,             -- ex.: 'ep_pr_s1e01'
  tipo          TEXT NOT NULL CHECK (tipo IN ('episodio','filme','comercial','vinheta','placeholder')),
  status        TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ingesting','ready','disabled')),
  duracao_seg   INTEGER NOT NULL,             -- duração total em segundos (múltiplo de 10)
  segment_count INTEGER NOT NULL,             -- quantos .ts existem no bucket
  base_url      TEXT NOT NULL DEFAULT '',     -- '' = mesma origem do Worker (rota /media/*);
                                              -- em prod: 'https://media1.seudominio.com'
  path_prefix   TEXT NOT NULL,                -- ex.: 'media/ep_pr_s1e01' (chave no bucket)
  metadata      TEXT NOT NULL DEFAULT '{}',   -- JSON: title, series_id, episode, tags...
  last_played_at INTEGER,                     -- unix; usado pelo Diretor p/ rotação
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Pontos de corte p/ comerciais (black frames detectados pelo pipeline),
-- já arredondados para múltiplos de 10s.
CREATE TABLE IF NOT EXISTS media_cue_points (
  media_id TEXT NOT NULL REFERENCES media_items(id),
  time_seg INTEGER NOT NULL,                  -- segundos desde o início da mídia
  kind     TEXT NOT NULL DEFAULT 'black',
  PRIMARY KEY (media_id, time_seg)
);

-- Regras estáticas de programação por canal/horário — insumo do Diretor (fase 4).
CREATE TABLE IF NOT EXISTS channel_master_grid (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  canal       TEXT NOT NULL,
  dia_semana  INTEGER,                        -- 0=dom..6=sáb; NULL = todos os dias
  hora_inicio TEXT NOT NULL,                  -- 'HH:MM' (America/Sao_Paulo)
  hora_fim    TEXT NOT NULL,
  regra       TEXT NOT NULL DEFAULT '{}'      -- JSON: tags, séries, política de comerciais...
);

-- A grade gerada. O Worker de streaming só LÊ esta tabela.
-- Contrato: linhas inseridas em ordem cronológica (id AUTOINCREMENT crescente
-- no tempo) — o gerador de m3u8 usa o id como EXT-X-DISCONTINUITY-SEQUENCE.
CREATE TABLE IF NOT EXISTS epg_virtual (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  canal               TEXT NOT NULL,
  media_id            TEXT NOT NULL REFERENCES media_items(id),
  start_time_virtual  INTEGER NOT NULL,       -- unix, múltiplo de 10
  end_time_virtual    INTEGER NOT NULL,       -- unix, múltiplo de 10
  segment_index_start INTEGER NOT NULL DEFAULT 0
);

-- Índice crítico: consultado a cada poll de player (~10s por espectador).
CREATE INDEX IF NOT EXISTS idx_epg_lookup
  ON epg_virtual (canal, start_time_virtual, end_time_virtual);

CREATE TABLE IF NOT EXISTS config (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
