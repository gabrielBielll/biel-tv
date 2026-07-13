-- Interruptor "comerciais fiéis" POR CANAL (pedido do Gabriel: liberar o
-- acervo cru num canal enquanto o outro segue curado). 1 = fiel (padrão,
-- fase 12 manda) · 0 = livre (rodízio cego temporário).
-- ATENÇÃO: ALTER ADD COLUMN não é idempotente — aplicar 1x local e 1x remoto.
ALTER TABLE channels ADD COLUMN comerciais_fieis INTEGER NOT NULL DEFAULT 1;
