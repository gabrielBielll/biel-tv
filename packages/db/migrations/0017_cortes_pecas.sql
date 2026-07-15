-- Peça com INÍCIO, FIM e NOME — o que o Gabriel marca de verdade (2026-07-15)
--
-- Pedido dele: "adiciona um outro botão de corte início e corte fim assim fica
-- mais fácil, e também permita eu dar nome para esse corte, assim fica fácil
-- para a IA entender e gerar um nome melhor e dados mais funcionais".
--
-- ⚠️ POR QUE O MODELO ANTIGO NÃO SERVIA (não é preferência de tela):
-- `marcas` guardava só FRONTEIRAS — JSON [segundos] — e a peça era o que sobrava
-- entre duas: N marcas ⇒ N+1 peças, cobrindo o compilado INTEIRO, sem furo. Duas
-- coisas que o material exige não cabem nesse modelo:
--
--   1. BURACO — o compilado tem lixo entre as peças. Ele mesmo, revisando o
--      intervalo da Jetix: "aos 2:30 começa o power rangers força animal e vai
--      até 2:59 (…) o RESTO É LIXO SÓ RECORTES" — 1:55→2:30 e tudo depois de
--      3:09 descartado. Fronteira não sabe dizer "isto aqui não é peça nenhuma":
--      todo segundo tem que pertencer a alguém.
--   2. NOME — fronteira é um número solto; não tem onde pendurar "Power Rangers:
--      Tempestade Ninja". E o nome é justamente o que ele sabe e a máquina não:
--      o whisper já inventou "Iue Falante" e "Margo" tentando adivinhar.
--
-- E o modelo certo JÁ EXISTIA, escrito à mão: o PLANO do
-- scripts/recorta-marcado.mjs é exatamente [{ini, fim, nome}] — foi transcrito
-- na unha dos comentários dele no chat porque a tela não sabia produzir isso.
-- Esta migration faz a tela produzir o que o cortador já consome.
--
-- POR QUE DROP DIRETO, SEM CONVERTER: `cortes_marcados` estava VAZIA em produção
-- (0 linhas, conferido em 2026-07-15) — a tela nunca chegou a salvar nada. Não é
-- coincidência: ela tinha um bug que apagava as marcas em silêncio (seta do
-- teclado com o <select> focado trocava de compilado e zerava tudo, sem aviso e
-- sem desfazer — reproduzido). Não há dado a preservar.
DROP TABLE IF EXISTS cortes_marcados;

CREATE TABLE cortes_marcados (
  compilado_id TEXT PRIMARY KEY,        -- o media_item do intervalo
  -- JSON: [{ini, fim, nome}] — em ordem de ini, sem sobreposição. Buraco entre
  -- uma peça e a seguinte é INTENCIONAL: é o lixo que ele mandou descartar.
  -- nome '' ou null = ele não nomeou ⇒ quem nomeia é o LLM (mesmo contrato do
  -- PLANO: `pc.nome ?? fallback`).
  pecas        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'marcado'
               CHECK (status IN ('marcado','cortando','pronto','error')),
  n_pecas      INTEGER NOT NULL DEFAULT 0,  -- preenchido pelo cortador, não pela tela
  error        TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
