-- Ingestão de PLAYLIST do YouTube (episódios em partes de ~4min).
-- Duas peças:
--  (1) playlist_ingests: o ciclo de análise de uma playlist — a fábrica lista
--      os títulos (yt-dlp --flat-playlist), o Worker classifica por TÍTULO
--      (nunca pela posição na playlist!) via LLM+regex e propõe o agrupamento
--      em episódios pro operador revisar antes de baixar.
--  (2) ingest_jobs.source_urls: um job de episódio agora carrega VÁRIAS fontes
--      ordenadas (as partes); a fábrica baixa em ordem, concatena CRU e deixa
--      o pipeline normalizar uma vez só. O source_url único de hoje segue como
--      o caso especial de 1 parte.
-- ATENÇÃO: ALTER ADD COLUMN não é idempotente — aplicar 1x local e 1x remoto.

CREATE TABLE IF NOT EXISTS playlist_ingests (
  id          TEXT PRIMARY KEY,           -- pl_<hex>
  url         TEXT NOT NULL,              -- link da playlist (tem list=)
  tipo        TEXT NOT NULL DEFAULT 'episodio' CHECK (tipo IN ('episodio','filme','comercial','vinheta')),
  canais      TEXT NOT NULL DEFAULT '',   -- csv de canais destino
  series_id   TEXT,                       -- slug da série (dica do operador; o parser confirma)
  temporada   INTEGER,                    -- nº da temporada (opcional → entra no media_id como s{T})
  status      TEXT NOT NULL DEFAULT 'listando'
              CHECK (status IN ('listando','analisando','revisar','confirmado','error')),
  entries     TEXT,                       -- JSON cru da fábrica: [{video_id,url,title,playlist_index}]
  grupos      TEXT,                       -- JSON do agrupamento proposto (episódios × partes ordenadas)
  error       TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_playlist_status ON playlist_ingests (status, created_at);

-- Fontes ordenadas (JSON array) — presente = job de episódio-em-partes.
ALTER TABLE ingest_jobs ADD COLUMN source_urls TEXT;
