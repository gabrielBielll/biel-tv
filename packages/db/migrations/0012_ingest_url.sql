-- Ingestão por LINK (YouTube/acervos): o job pode nascer de uma URL em vez
-- de um upload — a fábrica baixa com yt-dlp no runner e segue o pipeline
-- normal (transcrição/promessas inclusas). staging_key fica '' nesses jobs.
-- ATENÇÃO: ALTER ADD COLUMN não é idempotente — aplicar 1x local e 1x remoto.
ALTER TABLE ingest_jobs ADD COLUMN source_url TEXT;
