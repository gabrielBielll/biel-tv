-- Fase A da voz automática (ElevenLabs): cada canal tem seu narrador.
-- voz_id     = voice_id do ElevenLabs (a identidade/narrador do canal).
-- voz_config = JSON de ajuste do timbre/emoção (model_id + stability/style/...).
-- Aditivo: canal sem voz segue no ar normalmente; só não sintetiza.

ALTER TABLE channels ADD COLUMN voz_id TEXT;
ALTER TABLE channels ADD COLUMN voz_config TEXT;

-- Vozes que o Gabriel já criou no ElevenLabs (o voice_id é só um identificador,
-- não é segredo). A Jetix usa a voz do narrador mais velho como padrão; a voz
-- jovem entra por override no clipe. A Cartoon fica sem voz até ele criar a dela.
UPDATE channels SET voz_id = 'pzLPDKHoM8CDtkoDM8X4' WHERE id = 'disney_channel' AND voz_id IS NULL;
UPDATE channels SET voz_id = '4AdcnNz1pZ7FHA7oyy6w' WHERE id = 'jetix'          AND voz_id IS NULL;
