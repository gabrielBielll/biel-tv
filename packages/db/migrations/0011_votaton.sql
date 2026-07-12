-- Fase 10c: Votaton — o modo telespectador (docs/features/diretor-ia.md).
-- O espectador vota na maratona que quer; a "apuração" simula outros
-- telespectadores (nunca quebra a 4ª parede); vitória do usuário é
-- recompensa variável com pity timer, e o resultado vira evento REAL.
-- O desfecho é decidido no ABRIR da rodada (venceu/vencedora ficam ocultos
-- até fechar) — a apuração ao vivo é teatro determinístico rumo a ele.

CREATE TABLE IF NOT EXISTS votaton_rounds (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  canal            TEXT NOT NULL,
  series_user      TEXT NOT NULL,        -- o voto do espectador
  series_vencedora TEXT NOT NULL,        -- desfecho pré-decidido (oculto até fechar)
  venceu_usuario   INTEGER NOT NULL,     -- idem
  started_at       INTEGER NOT NULL,
  ends_at          INTEGER NOT NULL,
  fechado          INTEGER NOT NULL DEFAULT 0,
  event_id         INTEGER,              -- maratona criada no fechamento
  celebrado        INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_votaton_canal ON votaton_rounds (canal, started_at DESC);
