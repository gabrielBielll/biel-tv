-- PEDIDOS DE ACERVO: checklist agrupado por canal no painel da Fabrica.
-- Cada item pode ser concluido individualmente quando o programa/filme entrar.
CREATE TABLE IF NOT EXISTS content_requests (
  id          TEXT PRIMARY KEY,
  canal       TEXT NOT NULL REFERENCES channels(id),
  tipo        TEXT NOT NULL CHECK (tipo IN ('programa', 'filme')),
  titulo      TEXT NOT NULL,
  destino     TEXT,
  observacao  TEXT,
  status      TEXT NOT NULL DEFAULT 'pendente'
              CHECK (status IN ('pendente', 'concluido')),
  prioridade  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_content_requests_canal
  ON content_requests (canal, status, tipo, prioridade DESC, titulo);

-- JETIX: primeiro os horarios confirmados por chamadas/grades; depois os
-- complementos que deixam manha, tarde, noite e madrugada sustentaveis.
INSERT OR IGNORE INTO content_requests
  (id, canal, tipo, titulo, destino, observacao, prioridade)
VALUES
  ('acv_jtx_atom', 'jetix', 'programa', 'A.T.O.M.', 'sáb e dom · 07:30', 'Horário confirmado por chamada original.', 100),
  ('acv_jtx_galactik', 'jetix', 'programa', 'Galactik Football', 'sáb e dom · 09:30', 'Horário confirmado por chamada original.', 100),
  ('acv_jtx_digimon', 'jetix', 'programa', 'Digimon', 'todos os dias · 20:00 no fim de semana', 'Necessário para a chamada “desde o início”.', 100),
  ('acv_jtx_space_goofs', 'jetix', 'programa', 'Space Goofs', 'seg–sex · 22:00', 'Horário confirmado por chamada original.', 100),
  ('acv_jtx_pr_dino', 'jetix', 'programa', 'Power Rangers: Dino Trovão', 'Power Manhãs + tarde/noite', 'Faz parte do trio anunciado no Power Manhãs.', 100),
  ('acv_jtx_pr_spd', 'jetix', 'programa', 'Power Rangers: S.P.D.', 'Power Manhãs + reprise à tarde', 'Faz parte do trio anunciado no Power Manhãs.', 100),
  ('acv_jtx_pr_mistica', 'jetix', 'programa', 'Power Rangers: Força Mística', 'Power Manhãs + reprise à tarde', 'Faz parte do trio anunciado no Power Manhãs.', 100),
  ('acv_jtx_pr_tempestade', 'jetix', 'programa', 'Power Rangers: Tempestade Ninja', 'tarde e noite', 'Faixa real de 2005; completa o rodízio Power Rangers.', 95),
  ('acv_jtx_shaman', 'jetix', 'programa', 'Shaman King', '19:00', 'Faixa de anime/ação da noite.', 90),
  ('acv_jtx_megaman', 'jetix', 'programa', 'MegaMan: NT Warrior', '20:30', 'Faixa real da noite.', 90),
  ('acv_jtx_sonic', 'jetix', 'programa', 'Sonic X', 'manhã + 15:30', 'Serve à grade diária e aos especiais.', 90),
  ('acv_jtx_beyblade', 'jetix', 'programa', 'Beyblade G-Revolution — completar', '10:00 + 18:00', 'Há somente um episódio identificado; baixar/taggear mais.', 90),
  ('acv_jtx_dragon_booster', 'jetix', 'programa', 'Dragon Booster', '14:00 + 18:30', 'Programa recorrente na grade real.', 90),
  ('acv_jtx_fillmore', 'jetix', 'programa', 'Fillmore!', '06:00 + 13:00', 'Abre a faixa diurna e reprisa à tarde.', 85),
  ('acv_jtx_code_lyoko', 'jetix', 'programa', 'Code Lyoko', '06:30 + 13:30', 'Abre a faixa diurna e reprisa à tarde.', 85),
  ('acv_jtx_medabots', 'jetix', 'programa', 'Medabots', 'madrugada/noite', 'Complementa o bloco de anime.', 75),
  ('acv_jtx_goosebumps', 'jetix', 'programa', 'Goosebumps', 'fim da noite/madrugada', 'Faixa de suspense do canal.', 70),
  ('acv_jtx_so_weird', 'jetix', 'programa', 'Sinistro (So Weird)', 'fim da noite/madrugada', 'Faixa de suspense do canal.', 70),
  ('acv_jtx_inspetor', 'jetix', 'programa', 'Inspetor Bugiganga', 'manhã/início da tarde', 'Ajuda a variar a programação leve.', 65),
  ('acv_jtx_monster_allergy', 'jetix', 'programa', 'Alergia Monstra', 'madrugada/manhã', 'Complemento da identidade Jetix.', 60),
  ('acv_jtx_filme_padrinhos_abra', 'jetix', 'filme', 'Os Padrinhos Mágicos: Abracatástrofe', 'Sessão Jetix · domingo 15:00', 'Primeira prioridade de filme para o bloco.', 100),
  ('acv_jtx_filme_padrinhos_tempo', 'jetix', 'filme', 'Os Padrinhos Mágicos: Já Não Era Sem Tempo', 'Sessão Jetix · domingo 15:00', 'TV-movie fiel ao canal e ao acervo atual.', 95),
  ('acv_jtx_filme_digimon', 'jetix', 'filme', 'Digimon: O Filme', 'Sessão Jetix · domingo 15:00', 'Casa com a futura faixa de Digimon.', 95),
  ('acv_jtx_filme_pr', 'jetix', 'filme', 'Power Rangers: O Filme', 'Sessão Jetix · domingo 15:00', 'Filme para alternar com as maratonas de ação.', 85),
  ('acv_jtx_filme_pr_turbo', 'jetix', 'filme', 'Turbo: Power Rangers 2', 'Sessão Jetix · domingo 15:00', 'Segundo filme para o rodízio Power Rangers.', 80);

-- CARTOON NETWORK.
INSERT OR IGNORE INTO content_requests
  (id, canal, tipo, titulo, destino, observacao, prioridade)
VALUES
  ('acv_cn_dexter_viagem', 'cartoon_network', 'filme', 'A Viagem de Dexter', 'Teatro Cartoon · domingo 14:00 e 20:00', 'Prioridade máxima: já existe chamada original com esses horários.', 100),
  ('acv_cn_foster', 'cartoon_network', 'programa', 'A Mansão Foster para Amigos Imaginários', '09:00 + 14:30', 'Dois horários na grade-base.', 95),
  ('acv_cn_betty', 'cartoon_network', 'programa', 'Betty Atômica', '12:30 + 15:30', 'Dois horários na grade-base.', 95),
  ('acv_cn_mucha', 'cartoon_network', 'programa', 'Mucha Lucha', '11:30 + 16:30', 'Dois horários na grade-base.', 95),
  ('acv_cn_edu', 'cartoon_network', 'programa', 'Du, Dudu e Edu', '05:30 + 17:00', 'Clássico forte do canal.', 95),
  ('acv_cn_puffy', 'cartoon_network', 'programa', 'Hi Hi Puffy AmiYumi', '19:00', 'Horário real da grade de 2005.', 90),
  ('acv_cn_ben10', 'cartoon_network', 'programa', 'Ben 10', 'sábado · episódio novo', 'A chamada existe, mas ainda falta recuperar o horário completo.', 90),
  ('acv_cn_macaco', 'cartoon_network', 'programa', 'Meu Amigo da Escola é um Macaco', 'sexta · 19:30', 'Horário confirmado por chamada original.', 90),
  ('acv_cn_johnny', 'cartoon_network', 'programa', 'Johnny Bravo', 'manhã/clássicos Cartoon Cartoons', 'Programa importante para a identidade do canal.', 80),
  ('acv_cn_inuyasha', 'cartoon_network', 'programa', 'InuYasha', 'madrugada/Toonami', 'Anime principal da madrugada.', 75),
  ('acv_cn_dbgt', 'cartoon_network', 'programa', 'Dragon Ball GT', 'madrugada/Toonami', 'Completa o bloco de anime.', 75),
  ('acv_cn_yuyu', 'cartoon_network', 'programa', 'Yu Yu Hakusho', 'madrugada/Toonami', 'Completa o bloco de anime.', 75),
  ('acv_cn_cavaleiros', 'cartoon_network', 'programa', 'Cavaleiros do Zodíaco', 'madrugada/Toonami', 'Completa o bloco de anime.', 70),
  ('acv_cn_samurai_x', 'cartoon_network', 'programa', 'Samurai X', 'madrugada/Toonami', 'Completa o bloco de anime.', 70),
  ('acv_cn_filme_ben10', 'cartoon_network', 'filme', 'Ben 10: O Segredo do Omnitrix', 'Teatro Cartoon', 'Filme de 2007 dentro da janela nostálgica.', 95),
  ('acv_cn_filme_titas', 'cartoon_network', 'filme', 'Os Jovens Titãs: Missão Tóquio', 'Teatro Cartoon', 'Casa com o acervo atual de Jovens Titãs.', 90),
  ('acv_cn_filme_scooby_zumbi', 'cartoon_network', 'filme', 'Scooby-Doo na Ilha dos Zumbis', 'Teatro Cartoon', 'Filme forte para o domingo.', 90),
  ('acv_cn_filme_scooby_cyber', 'cartoon_network', 'filme', 'Scooby-Doo e a Caçada Virtual', 'Teatro Cartoon', 'Também conhecido como Cyber Perseguição.', 85),
  ('acv_cn_filme_scooby_vampiro', 'cartoon_network', 'filme', 'Scooby-Doo e a Lenda do Vampiro', 'Teatro Cartoon', 'Amplia o rodízio de filmes Scooby.', 80),
  ('acv_cn_filme_scooby_mexico', 'cartoon_network', 'filme', 'Scooby-Doo e o Monstro do México', 'Teatro Cartoon', 'Amplia o rodízio de filmes Scooby.', 80),
  ('acv_cn_filme_tom_jerry', 'cartoon_network', 'filme', 'Tom e Jerry: O Filme', 'Teatro Cartoon', 'Filme familiar para alternar com ação.', 75);

-- DISNEY CHANNEL.
INSERT OR IGNORE INTO content_requests
  (id, canal, tipo, titulo, destino, observacao, prioridade)
VALUES
  ('acv_disney_kim', 'disney_channel', 'programa', 'Kim Possible', 'manhã + Zapping Zone', 'Uma das maiores lacunas da grade Disney.', 100),
  ('acv_disney_lilo', 'disney_channel', 'programa', 'Lilo & Stitch: A Série', 'manhã + tarde', 'Programa recorrente da época.', 95),
  ('acv_disney_imperador', 'disney_channel', 'programa', 'A Nova Escola do Imperador', 'manhã + tarde', 'Animação central de 2006–2008.', 95),
  ('acv_disney_zack_cody', 'disney_channel', 'programa', 'Zack & Cody: Gêmeos em Ação', 'Zapping Zone/tarde', 'Série essencial da fase 2005–2008.', 100),
  ('acv_disney_hannah', 'disney_channel', 'programa', 'Hannah Montana', 'Zapping Zone/noite', 'Série essencial da fase 2006–2008.', 100),
  ('acv_disney_phil', 'disney_channel', 'programa', 'Phil do Futuro', 'Zapping Zone/tarde', 'Ajuda a reconstruir o bloco de 2005.', 90),
  ('acv_disney_lizzie', 'disney_channel', 'programa', 'Lizzie McGuire', 'Zapping Zone/tarde/noite', 'Clássico live-action do canal.', 90),
  ('acv_disney_substitutos', 'disney_channel', 'programa', 'Os Substitutos', 'animações da manhã/tarde', 'Animação da janela 2006–2008.', 80),
  ('acv_disney_mickey', 'disney_channel', 'programa', 'A Casa do Mickey Mouse', 'Playhouse Disney/manhã', 'Base pré-escolar do bloco.', 90),
  ('acv_disney_einsteins', 'disney_channel', 'programa', 'Os Pequenos Einsteins', 'Playhouse Disney/manhã', 'Base pré-escolar do bloco.', 85),
  ('acv_disney_manny', 'disney_channel', 'programa', 'Manny, Mãos à Obra', 'Playhouse Disney/manhã', 'Base pré-escolar do bloco.', 85),
  ('acv_disney_doodlebops', 'disney_channel', 'programa', 'Os Doodlebops', 'Playhouse Disney/manhã', 'Programa da faixa matinal da época.', 75),
  ('acv_disney_stanley', 'disney_channel', 'programa', 'Stanley', 'Playhouse Disney/manhã', 'Programa da faixa matinal da época.', 75),
  ('acv_disney_house_mouse', 'disney_channel', 'programa', 'O Point do Mickey', 'clássicos Disney/manhã', 'Ótimo para o fim de semana familiar.', 75),
  ('acv_disney_aladdin', 'disney_channel', 'programa', 'Aladdin: A Série', 'clássicos Disney/manhã', 'Ajuda a formar o bloco clássico.', 70),
  ('acv_disney_filme_hsm', 'disney_channel', 'filme', 'High School Musical', 'Filme Disney · sábado 20:00', 'Prioridade máxima para inaugurar a sessão.', 100),
  ('acv_disney_filme_hsm2', 'disney_channel', 'filme', 'High School Musical 2', 'Filme Disney · sábado 20:00', 'Continuação central da janela 2007.', 100),
  ('acv_disney_filme_camp_rock', 'disney_channel', 'filme', 'Camp Rock', 'Filme Disney · sábado 20:00', 'DCOM de 2008.', 100),
  ('acv_disney_filme_twitches', 'disney_channel', 'filme', 'Twitches: As Bruxinhas Gêmeas', 'O Maravilhoso Mundo de Disney · domingo 20:00', 'Filme familiar de 2005.', 90),
  ('acv_disney_filme_jump_in', 'disney_channel', 'filme', 'Jump In!', 'Filme Disney · sábado 20:00', 'DCOM de 2007.', 90),
  ('acv_disney_filme_minutemen', 'disney_channel', 'filme', 'Minutemen: Viajantes do Tempo', 'Filme Disney · sábado 20:00', 'DCOM de 2008.', 90),
  ('acv_disney_filme_wendy', 'disney_channel', 'filme', 'Wendy Wu: A Garota Kung Fu', 'O Maravilhoso Mundo de Disney · domingo 20:00', 'Filme de aventura familiar de 2006.', 85),
  ('acv_disney_filme_cheetah', 'disney_channel', 'filme', 'The Cheetah Girls', 'Filme Disney · sábado 20:00', 'Musical para variar o rodízio.', 80),
  ('acv_disney_filme_cheetah2', 'disney_channel', 'filme', 'The Cheetah Girls 2', 'Filme Disney · sábado 20:00', 'Continuação de 2006.', 80),
  ('acv_disney_filme_cadete', 'disney_channel', 'filme', 'Cadete Kelly', 'O Maravilhoso Mundo de Disney · domingo 20:00', 'Filme anterior à janela, mas recorrente e nostálgico.', 75);

-- Novos pedidos de comerciais de IDENTIDADE. As chamadas originais que o
-- Gabriel já possui continuam fora daqui para evitar trabalho duplicado.
INSERT OR IGNORE INTO commercial_requests
  (id, canal, titulo, tipo, dias, hora, texto_sugerido, observacao, prioridade)
VALUES
  ('req_jetix_fimsemana', 'jetix', 'Fim de semana Jetix', 'institucional', '[6,7]', NULL,
   'Neste fim de semana, muita ação, aventura e os seus heróis favoritos esperam por você, na Jetix!',
   'Peça guarda-chuva sem horário e sem citar programa específico; usar cenas de Power Rangers, Pucca, W.I.T.C.H. e Três Espiãs.', 55),
  ('req_cn_cartoon_cartoons_20', 'cartoon_network', 'Cartoon Cartoons', 'bloco', '[1,2,3,4,5]', '20:00',
   'De segunda a sexta, às oito da noite: Cartoon Cartoons, no Cartoon Network!',
   'Usar cortes de Dexter, Meninas Superpoderosas, KND, Coragem e Billy e Mandy.', 75),
  ('req_cn_toonami_sab_20', 'cartoon_network', 'Toonami de sábado', 'bloco', '[6]', '20:00',
   'Todo sábado, às oito da noite, a ação começa no Toonami!',
   'Usar cenas de Jovens Titãs, Liga da Justiça, Megas XLR e dos animes disponíveis.', 70),
  ('req_cn_fimsemana', 'cartoon_network', 'Fim de semana Cartoon Network', 'institucional', '[6,7]', NULL,
   'Neste fim de semana tem votação, especiais e muito desenho no Cartoon Network!',
   'Peça guarda-chuva: sábado destaca Votatoon; domingo destaca Teatro Cartoon.', 55),
  ('req_disney_playhouse', 'disney_channel', 'Playhouse Disney', 'bloco', '[1,2,3,4,5]', '06:00',
   'Todas as manhãs, a diversão começa no Playhouse Disney!',
   'Criar quando houver pelo menos três programas pré-escolares no acervo.', 70),
  ('req_disney_zapping_zone', 'disney_channel', 'Zapping Zone', 'bloco', '[1,2,3,4,5]', '13:00',
   'De segunda a sexta, a partir da uma da tarde: Zapping Zone, no Disney Channel!',
   'Usar Raven, Cory, Feiticeiros e, quando chegarem, Zack & Cody, Hannah Montana e Phil do Futuro.', 80),
  ('req_disney_fimsemana', 'disney_channel', 'Fim de semana Disney Channel', 'institucional', '[6,7]', NULL,
   'Neste fim de semana, maratonas, filmes e seus programas favoritos esperam por você no Disney Channel!',
   'Peça guarda-chuva sem prometer um título específico.', 55);
