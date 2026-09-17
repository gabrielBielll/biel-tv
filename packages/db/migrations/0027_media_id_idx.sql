-- Mais dois índices por mídia, pela mesma razão do 0026: a exclusão de mídia
-- (DELETE /admin/media/:id) e o fluxo de upload consultam estas tabelas POR
-- media_id, e sem índice cada chamada varre a tabela toda.
--
-- Medido em 16/09/2026, já com o 0026 no lugar: `upload_sessions` custava 123
-- linhas por exclusão e `channel_events` 80 — pouco hoje (tabelas pequenas),
-- mas é exatamente a curva que estourou o limite do D1 quando a `epg_virtual`
-- cresceu. Índice agora, enquanto é barato.
CREATE INDEX IF NOT EXISTS idx_upload_sessions_media ON upload_sessions (media_id);
CREATE INDEX IF NOT EXISTS idx_channel_events_media ON channel_events (media_id);
