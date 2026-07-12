-- Fase 12: comerciais como PROMESSA (docs/features/comerciais-condicionais.md).
-- O whisper transcreve na ingestão; o LLM propõe a condição; o operador
-- confirma; o agendador só veicula quando a grade cumpre. Uma linha por
-- comercial/vinheta.
--
-- status:
--   pendente   — IA detectou uma promessa; aguarda revisão humana.
--                FICA FORA do rodízio até decidirem (não prometemos no escuro).
--   confirmada — condição em `condicao` vale; o agendador aplica
--                (a_seguir = só no intervalo imediatamente antes da série alvo;
--                 bloco_horario/evento = retida até a fase 10a garantir blocos).
--   generico   — sem promessa; rodízio normal (igual comercial comum).
--   ignorar    — nunca veicular automaticamente.
--
-- proposta/condicao (JSON): { "tipo": "a_seguir"|"bloco_horario"|"evento"|"generico",
--   "series_id"?: string, "descricao"?: string, "confianca"?: number }

CREATE TABLE IF NOT EXISTS media_promises (
  media_id   TEXT PRIMARY KEY REFERENCES media_items(id),
  transcript TEXT,
  proposta   TEXT,
  condicao   TEXT,
  status     TEXT NOT NULL DEFAULT 'pendente'
             CHECK (status IN ('pendente','confirmada','generico','ignorar')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
