-- Âncoras de grade: slots FIXOS por canal (série X, dias ISO, hora local) que o
-- scheduler passa a honrar, MANTENDO o enchimento dinâmico ao redor. É o que
-- torna VERDADE um comercial de horário fixo ("programa X toda quarta às 4"):
-- sem um horário fixo real, a promessa seria mentira (a grade era 100% rotativa).
--
-- Aditivo e REVERSÍVEL: canal sem âncora tem grade idêntica à de hoje (rodízio
-- dinâmico puro). O scheduler pula a âncora se a série não tiver episódio pronto,
-- e a maratona (channel_events) tem prioridade sobre a âncora — a TV nunca
-- depende de nada disso pra ficar no ar. Tudo múltiplo de 10s.
--
-- (channel_master_grid do 0001 fica como legado do desenho antigo; esta tabela é
-- a que o código lê.) CREATE IF NOT EXISTS é idempotente — seguro reaplicar.
CREATE TABLE IF NOT EXISTS channel_slots (
  id         TEXT PRIMARY KEY,               -- ex.: 'sl_ab12cd34'
  canal      TEXT NOT NULL,
  series_id  TEXT NOT NULL,
  dias       TEXT NOT NULL,                  -- JSON [1..7] ISO (1=seg .. 7=dom)
  hora       TEXT NOT NULL,                  -- 'HH:MM' America/Sao_Paulo
  episodios  INTEGER NOT NULL DEFAULT 1,     -- quantos episódios emendados no slot
  status     TEXT NOT NULL DEFAULT 'ativa',  -- 'ativa' | 'inativa'
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_channel_slots ON channel_slots (canal, status);
