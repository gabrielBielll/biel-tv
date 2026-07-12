-- Fase 10b: o chat do Modo God emite ações que viram linhas aqui.
-- O agendador trata diretrizes ativas como restrições DURAS e materializa
-- eventos (maratonas) na grade.

CREATE TABLE IF NOT EXISTS directives (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  canal       TEXT NOT NULL,
  tipo        TEXT NOT NULL CHECK (tipo IN ('excluir_media')),
  payload     TEXT NOT NULL,                 -- JSON: {"media_id": "..."}
  vigente_de  INTEGER NOT NULL,              -- unix
  vigente_ate INTEGER,                       -- unix; NULL = até cancelar
  origem      TEXT NOT NULL DEFAULT 'chat',
  status      TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa','cancelada')),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS channel_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  canal      TEXT NOT NULL,
  tipo       TEXT NOT NULL CHECK (tipo IN ('maratona')),
  media_id   TEXT NOT NULL,
  start_at   INTEGER NOT NULL,
  end_at     INTEGER NOT NULL,
  criado_por TEXT NOT NULL DEFAULT 'chat',
  status     TEXT NOT NULL DEFAULT 'agendado' CHECK (status IN ('agendado','cancelado')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
