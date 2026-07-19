-- Enquadramento de vídeo por job de ingestão. NULL/ausente = 'letterbox' (padrão
-- de sempre: preserva o aspecto com tarjas pretas). 'fill' = enche o 16:9 pra
-- fonte 4:3 com uma esticada lateral leve + zoom, cortando mais da base que do
-- topo (preserva o topo) — usado em desenhos 4:3 antigos (ex.: playlist YouTube).
-- ⚠️ ALTER ADD COLUMN não é idempotente: aplicar 1x local e 1x remoto.
ALTER TABLE ingest_jobs ADD COLUMN video_fit TEXT;
