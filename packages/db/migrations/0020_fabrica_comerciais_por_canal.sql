-- Narradores, horários e assinaturas pertencem à identidade de cada canal.
-- O acervo criado antes desta separação era todo da Jetix.

ALTER TABLE voice_clips ADD COLUMN canal TEXT;

UPDATE voice_clips
SET canal = 'jetix'
WHERE canal IS NULL;

CREATE INDEX IF NOT EXISTS idx_voice_clips_canal_lookup
  ON voice_clips (canal, categoria, series_id, chave, created_at);
