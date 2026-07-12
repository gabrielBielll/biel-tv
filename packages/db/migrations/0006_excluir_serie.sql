-- Exclusão de série/temporada inteira pelo chat do Diretor.
-- SQLite não permite ALTER de CHECK constraint — reconstrói a tabela.
CREATE TABLE directives_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  canal       TEXT NOT NULL,
  tipo        TEXT NOT NULL CHECK (tipo IN ('excluir_media','excluir_serie')),
  payload     TEXT NOT NULL,
  vigente_de  INTEGER NOT NULL,
  vigente_ate INTEGER,
  origem      TEXT NOT NULL DEFAULT 'chat',
  status      TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa','cancelada')),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO directives_new (id, canal, tipo, payload, vigente_de, vigente_ate, origem, status, created_at)
  SELECT id, canal, tipo, payload, vigente_de, vigente_ate, origem, status, created_at FROM directives;

DROP TABLE directives;
ALTER TABLE directives_new RENAME TO directives;
