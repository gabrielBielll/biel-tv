-- BLOCO NOMEADO: a faixa com identidade própria (Cinescópio, Toonami, Hora
-- Acme, Zapping Zone), que a TV anunciava como programa.
--
-- Por que existe: a fábrica só sabia fazer comercial de SÉRIE + horário ("Billy
-- e Mandy, todos os dias às 10h"). Mas metade da identidade desses canais eram
-- os blocos — "Invasão Anime, toda madrugada", "Cinescópio, sábado às 14h" —
-- e não havia onde declarar isso. Pedido do Gabriel (18/09/2026): "temos que
-- ter aqueles espaços especiais de programas, tipo um que era de anime, pra
-- criar o comercial certinho".
--
-- O bloco NÃO é dono de conteúdo: quem põe programa no ar continua sendo o
-- `channel_slots`. O bloco é o guarda-chuva — dá nome, hora de início e dias a
-- um conjunto de slots, e é isso que a fábrica anuncia. `channel_slots.bloco`
-- diz quais faixas moram nele.
--
-- Para a fábrica, o bloco se comporta como uma "série" cujo `series_id` é o
-- slug: os clipes `nome` e `frase` são cadastrados com `series_id = <slug>`,
-- e o comercial sai pelo mesmo motor (frase → nome → frequência → horário →
-- assinatura). A amostra de vídeo pode ser de qualquer série do bloco.
CREATE TABLE IF NOT EXISTS channel_blocos (
  id         TEXT PRIMARY KEY,
  canal      TEXT NOT NULL REFERENCES channels(id),
  slug       TEXT NOT NULL,                  -- vira o series_id do kit de voz
  nome       TEXT NOT NULL,                  -- "Cinescópio", "Hora Acme"
  dias       TEXT NOT NULL,                  -- json [1..7], como channel_slots
  hora       TEXT NOT NULL,                  -- HH:MM em que o bloco começa
  status     TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa','cancelada')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (canal, slug)
);

CREATE INDEX IF NOT EXISTS idx_channel_blocos ON channel_blocos (canal, status);

-- a que bloco esta faixa pertence (NULL = faixa solta, o normal)
ALTER TABLE channel_slots ADD COLUMN bloco TEXT;
