-- Progresso da transcodificação visível na fila do painel ("processando 37%").
-- A fábrica reporta via POST /admin/jobs/:id/progress; o claim zera, o done
-- fecha em 100. ATENÇÃO: ALTER ADD COLUMN não é idempotente — aplicar 1x só.
ALTER TABLE ingest_jobs ADD COLUMN progress INTEGER NOT NULL DEFAULT 0;
