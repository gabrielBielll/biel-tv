-- Uploads persistentes e retomáveis (docs/features/uploads-resumiveis.md).
-- A sessão nasce no D1 ANTES do primeiro byte; cada parte confirmada no R2
-- (multipart) fica registrada aqui. Depois de um reload o painel lista as
-- sessões ativas e retoma enviando só as partes que faltam.

CREATE TABLE IF NOT EXISTS upload_sessions (
  id           TEXT PRIMARY KEY,             -- uuid
  media_id     TEXT NOT NULL,                -- id de mídia desejado (ex.: ep_pr_s1e01)
  staging_key  TEXT NOT NULL,                -- staging/<sessao>/<arquivo>
  r2_upload_id TEXT NOT NULL,                -- uploadId do multipart no R2
  -- fingerprint do arquivo local (o navegador não guarda o File após reload;
  -- no reanexo a UI casa por caminho relativo + nome + tamanho + lastModified)
  file_name    TEXT NOT NULL,
  file_rel     TEXT NOT NULL DEFAULT '',     -- webkitRelativePath (lote/pasta)
  file_size    INTEGER NOT NULL,
  file_mtime   INTEGER NOT NULL,             -- File.lastModified (ms)
  part_size    INTEGER NOT NULL,
  parts_total  INTEGER NOT NULL,
  -- metadados editoriais que virariam o ingest_job no complete
  tipo         TEXT NOT NULL CHECK (tipo IN ('episodio','filme','comercial','vinheta')),
  title        TEXT NOT NULL,
  series_id    TEXT,
  episode      INTEGER,
  tags         TEXT NOT NULL DEFAULT '',
  canais       TEXT NOT NULL DEFAULT '',     -- CSV, igual ingest_jobs
  status       TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa','concluida')),
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_upload_sessions_status ON upload_sessions (status, updated_at);

CREATE TABLE IF NOT EXISTS upload_parts (
  session_id  TEXT NOT NULL REFERENCES upload_sessions(id),
  part_number INTEGER NOT NULL,
  etag        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  PRIMARY KEY (session_id, part_number)
);
