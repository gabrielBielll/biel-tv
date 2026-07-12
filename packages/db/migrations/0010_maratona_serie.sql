-- Fase 10a: maratona de SÉRIE — o evento pode apontar uma série inteira e o
-- agendador rotaciona episódios DIFERENTES dentro da janela (maratona de
-- verdade, não o mesmo episódio em loop). media_id continua preenchido (1º
-- episódio) por compatibilidade com o painel e com o NOT NULL original.
-- ATENÇÃO: ALTER ADD COLUMN não é idempotente — aplicar 1x local e 1x remoto.
ALTER TABLE channel_events ADD COLUMN series_id TEXT;
