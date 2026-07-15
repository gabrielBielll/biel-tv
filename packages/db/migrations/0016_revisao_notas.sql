-- O veredito do Gabriel sobre cada peça recortada — o gabarito que faltava.
-- Ideia dele (2026-07-15): "era bom poder colocar um comentário do porquê ficou
-- ruim, e estou removendo pra você ir aprendendo o que deu errado e melhorar
-- esse cortador".
--
-- POR QUE ISTO VALE MAIS QUE O RESTO DA FEATURE: o cortador teve 5 premissas
-- derrubadas, todas pelo mesmo motivo — eu media num arquivo e generalizava. As
-- correções que colaram vieram de confronto com material real. Esta tabela é
-- esse confronto virando dado, gerado enquanto ele revisa, sem trabalho extra.
--
-- A CATEGORIA é o que torna isto acionável: motivo em texto livre se lê, mas não
-- se conta. Cada categoria aponta pra uma parte ESPECÍFICA do motor:
--
--   corte_no_meio    → o julgamento (LLM) perdeu um limite, ou a fonte de
--                      candidatos não gerou um ali (o buraco de fala do whisper
--                      — a premissa que já sabemos que falha em 4 dos 6
--                      compilados)
--   pedaco_vizinho   → a escada da precisão / a margem: cortou tarde ou cedo
--   nao_e_peca       → o porteiro de densidade e o PECA_MAX deixaram passar um
--                      bloco (programa, promo longa, trecho sem locução)
--   nome_errado      → o nomeador: vocabulário incompleto ou função trocada
--                      (já sei de uma: "voltamos já com X" saindo como volta
--                      quando é saída)
--   preto_demais     → a regra dos 10s (arquitetural, não é o corte) — se esta
--                      dominar, o alvo é o tpad do normalize(), não o cortador
--   outro            → texto livre; se acumular, vira categoria nova
--
-- 'boa' também é registrado de propósito: sem exemplo positivo não dá pra saber
-- se uma mudança melhorou ou só mudou o erro de lugar.

CREATE TABLE IF NOT EXISTS revisao_notas (
  media_id   TEXT PRIMARY KEY,          -- 1 nota por peça; a última vale (INSERT OR REPLACE)
  veredito   TEXT NOT NULL CHECK (veredito IN ('boa', 'ruim')),
  categoria  TEXT,                      -- NULL quando veredito='boa'
  motivo     TEXT NOT NULL DEFAULT '',  -- o texto livre dele
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_revisao_notas_veredito ON revisao_notas (veredito, categoria);

-- ── marcação manual de cortes (2026-07-15) ────────────────────────────────
-- O Gabriel: "quando eu subir um comercial você pode jogar ele para essa etapa
-- de ajuste nessa aba; aí eu passo lá, dou uma revisão, e depois ele pode
-- terminar de ajustar — não tomou muito do meu tempo".
--
-- ⚠️ ISTO REVERTE A PREMISSA CENTRAL DA FEATURE, e é a decisão certa:
-- No dia 1 ele disse "queria algo automático, só subir o compilado e ele
-- tratar", e isso matou a tela de revisão da v1. Dois dias depois, o placar do
-- automático contra o acervo real: 24 peças cortadas, 23 reprovadas por ele.
-- E o motivo não é falta de esforço — é que o material NÃO TEM marca que a
-- máquina reconheça. Medido contra o gabarito dele no compilado de 390s:
--     cena           → acerta 5/6, mas dispara 138× (96% falso)
--     silêncio       → 3/6
--     buraco de fala → 1/6 (e o único tem 33s de largura)
--     preto          → 0/6 (2 em 390s)
-- Comercial de 2004 emenda direto: sem preto, sem silêncio, e com corte de cena
-- idêntico aos cortes de DENTRO do anúncio. Não há o que detectar.
--
-- Enquanto isso, ele assistiu e me deu fronteiras exatas em minutos — todas
-- caindo redondas na grade (29s, 29.5s, 30s, 60s). A v1 supunha que a revisão
-- era mais segura; agora se sabe que ela é a ÚNICA coisa que funciona aqui.
CREATE TABLE IF NOT EXISTS cortes_marcados (
  compilado_id TEXT PRIMARY KEY,        -- o media_item do intervalo
  marcas       TEXT NOT NULL,           -- JSON: [segundos] das fronteiras, em ordem
  status       TEXT NOT NULL DEFAULT 'marcado'
               CHECK (status IN ('marcado','cortando','pronto','error')),
  n_pecas      INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
