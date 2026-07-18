-- Fábrica de comerciais (banco de falas + molde + amostra -> comercial pronto).
-- Spec: docs/features/fabrica-comerciais.md

CREATE TABLE IF NOT EXISTS voice_clips (
  id         TEXT PRIMARY KEY,          -- vc_<hex>
  categoria  TEXT NOT NULL CHECK (categoria IN ('horario','frequencia','nome','frase','conector')),
  series_id  TEXT,                      -- usado por nome/frase
  chave      TEXT,                      -- horario='16:00', frequencia='seg-sex', conector='a_seguir'
  rotulo     TEXT NOT NULL,             -- texto falado aproximado
  audio_key  TEXT NOT NULL,             -- objeto no R2 (raw; a fábrica normaliza na montagem)
  duracao    REAL,                      -- opcional/cache futuro
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_voice_clips_lookup
  ON voice_clips (categoria, series_id, chave);

CREATE TABLE IF NOT EXISTS moldes (
  id          TEXT PRIMARY KEY,         -- md_<hex>
  nome        TEXT NOT NULL,
  canal       TEXT NOT NULL REFERENCES channels(id),
  molde_key   TEXT NOT NULL,            -- PNG no R2; preto/alpha vira buraco na fábrica
  musica_key  TEXT,                     -- trilha opcional no R2
  buraco      TEXT,                     -- JSON {x,y,w,h}; cache futuro calculado pelo ffmpeg
  texto_box   TEXT,                     -- JSON {x,y,w,h}; opcional
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_moldes_canal ON moldes (canal, created_at);

CREATE TABLE IF NOT EXISTS program_samples (
  id         TEXT PRIMARY KEY,          -- ps_<hex>
  series_id TEXT NOT NULL,
  rotulo    TEXT NOT NULL,
  video_key TEXT NOT NULL,              -- trecho/amostra no R2
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_program_samples_series
  ON program_samples (series_id, created_at);

CREATE TABLE IF NOT EXISTS commercial_build_jobs (
  id          TEXT PRIMARY KEY,         -- cb_<hex>
  media_id    TEXT NOT NULL,            -- id final no catálogo (com_...)
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued','processing','done','error')),
  error       TEXT,
  progress    INTEGER NOT NULL DEFAULT 0,
  molde_id    TEXT NOT NULL REFERENCES moldes(id),
  series_id   TEXT NOT NULL,
  slot_dias   TEXT NOT NULL,            -- JSON [1..7] (1=seg, 7=dom)
  slot_hora   TEXT NOT NULL,            -- 'HH:MM'
  frase_id    TEXT,
  sample_id   TEXT,
  payload     TEXT,                     -- rastro da montagem resolvida
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_commercial_build_jobs_status
  ON commercial_build_jobs (status, created_at);
