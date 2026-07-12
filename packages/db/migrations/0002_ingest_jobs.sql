-- Fila de ingestão do admin: o navegador sobe o arquivo pro staging (R2) e
-- cria um job; a "fábrica" (local hoje, GitHub Actions depois) processa.
CREATE TABLE IF NOT EXISTS ingest_jobs (
  id            TEXT PRIMARY KEY,          -- id de mídia desejado (ex.: ep_pr_s1e01)
  staging_key   TEXT NOT NULL,             -- chave no R2 (staging/...)
  original_name TEXT NOT NULL DEFAULT '',
  tipo          TEXT NOT NULL CHECK (tipo IN ('episodio','filme','comercial','vinheta')),
  title         TEXT NOT NULL,
  series_id     TEXT,
  episode       INTEGER,
  tags          TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','done','error')),
  error         TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON ingest_jobs (status, created_at);
