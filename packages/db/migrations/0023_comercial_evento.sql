-- Fase B: o Diretor editorial, ao agendar uma maratona, enfileira um comercial
-- que a promete. O job carrega o channel_events de origem (event_id); o /done
-- materializa a promessa como 'evento' (confirmada) amarrada à SÉRIE do evento —
-- o scheduler liga por series_id e toca só na janela agora→start_at, sumindo
-- quando a maratona começa. Aditivo: ALTER ADD COLUMN (não idempotente, aplicar 1x).
ALTER TABLE commercial_build_jobs ADD COLUMN event_id INTEGER;
