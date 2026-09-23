-- Jobs remotos do lineup de três janelas. Reaproveitam a fila da fábrica,
-- mas guardam o snapshot da grade separado do payload já resolvido pelo claim.
-- Publicação nasce desligada: primeiro o runner devolve uma prévia no R2.
ALTER TABLE commercial_build_jobs ADD COLUMN job_type TEXT NOT NULL DEFAULT 'horario';
ALTER TABLE commercial_build_jobs ADD COLUMN request_payload TEXT;
ALTER TABLE commercial_build_jobs ADD COLUMN publish INTEGER NOT NULL DEFAULT 0;
ALTER TABLE commercial_build_jobs ADD COLUMN preview_key TEXT;

CREATE INDEX IF NOT EXISTS idx_commercial_build_jobs_type_status
  ON commercial_build_jobs (job_type, status, created_at);
