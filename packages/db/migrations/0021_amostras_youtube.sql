-- Uma amostra pode ficar no R2 ou apontar para uma abertura no YouTube.
-- video_key permanece vazio nas amostras por link para preservar o schema atual.

ALTER TABLE program_samples ADD COLUMN source_url TEXT;
