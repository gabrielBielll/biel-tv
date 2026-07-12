-- Fase 9: o upload do admin escolhe a quais canais a mídia pertence.
-- ATENÇÃO: ALTER TABLE não é idempotente — aplicar UMA vez por banco.
-- (No deploy real, usar `wrangler d1 migrations apply`, que rastreia o que já rodou.)
ALTER TABLE ingest_jobs ADD COLUMN canais TEXT NOT NULL DEFAULT '';
