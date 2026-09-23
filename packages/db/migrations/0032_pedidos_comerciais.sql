-- PEDIDOS DE COMERCIAIS: cards editoriais visiveis na Fabrica.
--
-- Diferente de commercial_build_jobs, um pedido ainda nao e um job automatico:
-- ele registra a peca que o Gabriel precisa decidir/gravar/montar. Quando a
-- peca estiver pronta, o card pode ser marcado como concluido sem desaparecer
-- do historico.
CREATE TABLE IF NOT EXISTS commercial_requests (
  id              TEXT PRIMARY KEY,
  canal           TEXT NOT NULL REFERENCES channels(id),
  titulo          TEXT NOT NULL,
  tipo            TEXT NOT NULL DEFAULT 'bloco',
  dias            TEXT NOT NULL DEFAULT '[]',
  hora            TEXT,
  texto_sugerido  TEXT NOT NULL,
  observacao      TEXT,
  status          TEXT NOT NULL DEFAULT 'pendente'
                  CHECK (status IN ('pendente', 'concluido')),
  prioridade      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_commercial_requests_status
  ON commercial_requests (status, prioridade DESC, canal, hora);

-- Primeira encomenda: pecas necessarias para a grade de fim de semana
-- 2005-2008. Promos originais que o Gabriel ja esta editando (Power Manhas,
-- Votatoon, A Viagem de Dexter etc.) nao sao duplicadas aqui.
INSERT OR IGNORE INTO commercial_requests
  (id, canal, titulo, tipo, dias, hora, texto_sugerido, observacao, prioridade)
VALUES
  ('req_jetix_sessao_filmes_dom_15', 'jetix', 'Sessão Jetix — filmes', 'filme', '[7]', '15:00',
   'Neste domingo, às três da tarde: Sessão Jetix. Uma aventura especial espera por você, na Jetix!',
   'Peça genérica do bloco. Não citar um título: o filme muda a cada semana. Enquanto os filmes não chegam, o horário recebe uma maratona provisória.', 100),
  ('req_cartoon_teatro_dom_14', 'cartoon_network', 'Teatro Cartoon — estreia', 'filme', '[7]', '14:00',
   'Domingo, às duas da tarde, tem Teatro Cartoon!',
   'Peça genérica para abrir a sessão de filmes. A chamada específica de A Viagem de Dexter continua separada.', 100),
  ('req_cartoon_teatro_dom_20', 'cartoon_network', 'Teatro Cartoon — reprise', 'filme', '[7]', '20:00',
   'E se você perdeu, tem mais Teatro Cartoon hoje, às oito da noite!',
   'Versão de reprise da mesma sessão exibida às 14h. O filme das 20h deve repetir exatamente o das 14h.', 95),
  ('req_disney_filme_sab_20', 'disney_channel', 'Filme Disney de sábado', 'filme', '[6]', '20:00',
   'Neste sábado, às oito da noite, prepare-se para um filme especial no Disney Channel!',
   'Chamada genérica: não citar título para poder rodar com qualquer filme da semana.', 100),
  ('req_disney_maravilhoso_dom_20', 'disney_channel', 'O Maravilhoso Mundo de Disney', 'filme', '[7]', '20:00',
   'Domingo, às oito da noite: O Maravilhoso Mundo de Disney!',
   'Identidade da sessão familiar de domingo. Até os filmes chegarem, o slot fica ocupado por especial provisório.', 100),
  ('req_jetix_maratona_pr_sab_15', 'jetix', 'Maratona Power Rangers', 'maratona', '[6]', '15:00',
   'Neste sábado, a partir das três da tarde: Maratona Power Rangers, na Jetix!',
   'A temporada pode mudar semanalmente; a peça deve anunciar Power Rangers sem prometer uma temporada específica.', 70),
  ('req_disney_maratona_sab_15', 'disney_channel', 'Maratona Disney', 'maratona', '[6]', '15:00',
   'Neste sábado, a partir das três da tarde, seus programas favoritos em uma maratona especial no Disney Channel!',
   'Peça genérica para Raven, Feiticeiros, Phineas e Ferb, Jake Long ou outra série escolhida na semana.', 60);
