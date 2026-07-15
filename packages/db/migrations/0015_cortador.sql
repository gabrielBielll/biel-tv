-- Cortador de comerciais (1 compilado → N peças). É a playlist AO CONTRÁRIO.
-- Spec: docs/features/cortador-comerciais.md
--
-- ⚠️ Esta tabela reflete a v3 do motor, não a v1 da spec original. O que NÃO
-- está aqui, e por quê:
--   · `plato`/`threshold` — o platô de silêncio NÃO EXISTE em áudio real
--     (medido: 434 gaps a -18dB decaindo até 6 a -50dB, sem faixa estável).
--     Era uma propriedade que o material não tem.
--   · status 'revisar' — o Gabriel não revisa. Nunca houve fila de revisão.
--
-- O que a v3 guarda é o RASTRO da decisão, porque ninguém audita a saída: o
-- Gabriel precisa poder abrir isto meses depois e entender por que uma peça
-- virou o que virou, em vez de interrogar um oráculo que já esqueceu.

CREATE TABLE IF NOT EXISTS comercial_cuts (
  id          TEXT PRIMARY KEY,           -- cc_<hex>
  source_url  TEXT,                       -- link do compilado (NULL se veio do catálogo)
  media_id    TEXT,                       -- ou o media_item de origem (recorte do acervo)
  staging_key TEXT,                       -- o compilado no R2
  canal       TEXT NOT NULL DEFAULT '',   -- ⚠️ FATO, não palpite: o LLM alucinou
                                          -- "Cartoon Network" pra uma peça do Beyblade
                                          -- num compilado do Jetix. O canal vem daqui.
  status      TEXT NOT NULL DEFAULT 'baixando'
              CHECK (status IN ('baixando','transcrevendo','analisando','cortando','pronto','rejeitado','error')),
  dur_seg     REAL,
  fala        TEXT,                       -- JSON do transcreve.py --json: [{start,end,text}]
  pecas       TEXT,                       -- JSON: [{ini,fim,dur,metodo,nome,id,funcao,fundido}]
  n_pecas     INTEGER NOT NULL DEFAULT 0, -- quantas entraram (o painel mostra "21 de 22")
  n_descartadas INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_comercial_cuts_status ON comercial_cuts (status, created_at);

-- ⚠️ NÃO existe coluna `corte` em ingest_jobs, ao contrário do que a v1 da spec
-- propunha ("1 ingest_job por comercial, apontando pro staging + [start,end]").
-- Motivo: o cli.mjs ingest já normaliza/segmenta/sobe/registra a partir de um
-- arquivo em DISCO, e a peça recortada JÁ ESTÁ em disco na fábrica. Subir pro
-- staging só pra baixar de volta seria round-trip puro — e a fábrica nem sabe
-- subir pro staging (ela só baixa; quem sobe é o navegador do Gabriel). A
-- fábrica corta e ingere direto; o `comercial_cut` é a unidade de retry.
