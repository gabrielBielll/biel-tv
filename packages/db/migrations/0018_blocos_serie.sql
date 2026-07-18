-- Agrupar episódios da mesma série em BLOCOS na grade automática (pedido do
-- Gabriel): em vez de 1 episódio de Danny Phantom pingando às 10h, 12h e 15h,
-- o diretor emenda 2..N episódios seguidos da série e só então troca de
-- programa — retém melhor a audiência. As séries entram em rodízio (um bloco de
-- cada por vez). Valor por canal: Jetix pode querer blocões de 4, outro só 2.
-- 1 = desliga o agrupamento (rodízio 1-a-1, como antes da fase). Padrão 2.
-- ATENÇÃO: ALTER ADD COLUMN não é idempotente — aplicar 1x local e 1x remoto.
ALTER TABLE channels ADD COLUMN episodios_por_bloco INTEGER NOT NULL DEFAULT 2;
