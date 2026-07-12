-- Fase 9: canais nostálgicos. Cada canal emula um canal da infância;
-- a coluna `identidade` é o prompt editorial do Diretor (editável no admin).

CREATE TABLE IF NOT EXISTS channels (
  id               TEXT PRIMARY KEY,          -- 'jetix', 'cartoon_network', ...
  nome             TEXT NOT NULL,
  cor              TEXT NOT NULL DEFAULT '#ff2d55',
  identidade       TEXT NOT NULL DEFAULT '',
  break_target_seg INTEGER NOT NULL DEFAULT 120,  -- duração-alvo dos intervalos
  ordem            INTEGER NOT NULL DEFAULT 0
);

-- Uma mídia pode pertencer a mais de um canal (ex.: comercial institucional).
CREATE TABLE IF NOT EXISTS media_channels (
  media_id   TEXT NOT NULL REFERENCES media_items(id),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  PRIMARY KEY (media_id, channel_id)
);

INSERT OR IGNORE INTO channels (id, nome, cor, ordem, identidade) VALUES
('jetix', 'Jetix', '#8CC63F', 1,
 'Emular o Jetix Brasil da era 2004-2009: canal de acao e aventura. Ritmo acelerado, blocos intensos de desenhos de acao e comedia radical a tarde e no comeco da noite, maratonas de fim de semana. Entre um programa e outro, vinhetas da casa (a seguir) e comerciais de brinquedo e da epoca. Tom energetico, radical, o canal do heroi. Madrugada pode repetir os destaques do dia.'),
('cartoon_network', 'Cartoon Network', '#f5f5f5', 2,
 'Emular a Cartoon Network Brasil dos anos 2000: desenho animado e humor o dia inteiro. Manha mais leve, tarde com os sucessos da casa, Curtas e Groovies entre programas como respiro curto e musical, Votatoon como evento especial em que a audiencia escolhe o que passa. Comerciais da propria casa e de brinquedos. Tom divertido, irreverente e auto-referente ao canal.'),
('disney_channel', 'Disney Channel', '#2E9BFF', 3,
 'Emular o Disney Channel Brasil dos anos 2000: desenhos e clima de familia. Manha infantil, tarde com desenhos e series, noite com sessao de filme anunciada com vinheta propria. Tom magico e acolhedor, com a identidade visual forte da casa. Comerciais da propria programacao e de produtos da marca.');
