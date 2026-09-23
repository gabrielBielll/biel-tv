-- (Renumerada de 0026 para 0035 em 23/09/2026: o 0026 já era do
-- 0026_epg_media_idx.sql. Nunca tinha sido aplicada em produção — as rotas
-- de lineup respondiam 500 por falta destas colunas — então renumerar não
-- desalinha banco nenhum. O fluxo normal da fábrica não dependia dela: lê a
-- linha com SELECT * / RETURNING *, e coluna ausente vira `undefined`.)
--
-- Jobs remotos do lineup de três janelas. Reaproveitam a fila da fábrica,
-- mas guardam o snapshot da grade separado do payload já resolvido pelo claim.
-- Publicação nasce desligada: primeiro o runner devolve uma prévia no R2.
ALTER TABLE commercial_build_jobs ADD COLUMN job_type TEXT NOT NULL DEFAULT 'horario';
ALTER TABLE commercial_build_jobs ADD COLUMN request_payload TEXT;
ALTER TABLE commercial_build_jobs ADD COLUMN publish INTEGER NOT NULL DEFAULT 0;
ALTER TABLE commercial_build_jobs ADD COLUMN preview_key TEXT;

CREATE INDEX IF NOT EXISTS idx_commercial_build_jobs_type_status
  ON commercial_build_jobs (job_type, status, created_at);
