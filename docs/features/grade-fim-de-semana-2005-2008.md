# Grade de fim de semana — janela nostálgica 2005–2008

> Decisão editorial do Gabriel em 21/09/2026. Este é o documento mestre para
> sábado e domingo dos três canais. A proposta não tenta reproduzir um único dia
> histórico: combina horários comprovados e a identidade brasileira dos canais
> entre 2005 e 2008.
>
> A distribuição completa das 00h às 24h, incluindo dias úteis, está em
> [grade-completa-2005-2008.md](grade-completa-2005-2008.md).

## Decisões fixas

- Cada canal tem três grades distintas: segunda–sexta, sábado e domingo.
- Sábado e domingo não usam a grade diária com uma maratona aleatória por cima.
- Os horários abaixo identificados como **FILME** continuam sendo de filme mesmo
  enquanto o acervo ainda não estiver pronto.
- Um especial de episódios pode ocupar temporariamente um slot de filme, mas não
  muda sua finalidade e não pode ser anunciado como filme.
- Promo que cita um filme ou programa ausente fica retida. Nesse período só pode
  tocar uma chamada genérica verdadeira do bloco provisório.
- Quando o filme chegar, ele substitui o especial sem mudar o horário da faixa.
- A reprise de um filme repete o mesmo `media_id`, e não outro título da sessão.

## Slots permanentes de filme

| Canal | Dia | Horário | Slot permanente | Ocupação provisória |
|---|---|---:|---|---|
| Jetix | domingo | 15:00–17:00 | **Sessão Jetix — filmes** | maratona de aventura da própria Jetix |
| Cartoon Network | domingo | 14:00–16:00 | **Teatro Cartoon — filme** | quatro episódios de Dexter |
| Cartoon Network | domingo | 20:00–22:00 | **Teatro Cartoon — reprise** | reprise exata do especial das 14h |
| Disney Channel | sábado | 20:00–22:00 | **Filme Disney de sábado** | especial de quatro episódios |
| Disney Channel | domingo | 20:00–22:00 | **O Maravilhoso Mundo de Disney** | especial familiar de quatro episódios |

O Jetix mantém **Digimon desde o início** às 20h e **Pucca** às 22h no fim de
semana; esses horários vieram de chamadas originais e não são slots de filme.

### Em produção desde 23/09/2026: sábado 1 sessão, domingo 2, cada canal no seu horário

Decisão do Gabriel em 23/09: uma sessão no sábado e duas no domingo, **cada canal
com horário próprio** (não os três às 20h). O Disney fica com as 20h da sessão
nobre, o Cartoon com a tarde e o fim de tarde (18h30), e o Jetix com cara de sessão da tarde
mais as 19h30. As 20h do Jetix continuam guardadas para o Digimon.

| Canal | Sábado | Domingo | `series_id` da sessão | Faixas (`channel_slots`) |
|---|---|---|---|---|
| Disney Channel | 20:00 | 15:00 e 20:00 | `o_maravilhoso_mundo_de_disney` | `sl_disney_filmes_dom` ([6,7] 20:00), `sl_disney_filmes_dom_tarde` ([7] 15:00) |
| Cartoon Network | 18:00 (depois do Votatoon) | 14:00 e 18:30 | `teatro_cartoon` | `sl_cn_teatro_cartoon_sab` ([6] 18:00), `sl_cn_teatro_cartoon_dom` ([7] 14:00), `sl_cn_teatro_cartoon_dom_noite` ([7] 18:30) |
| Jetix | 15:00 | 13:30 e 19:30 | `cinescopio` | `sl_jetix_cinescopio_sab` ([6] 15:00), `sl_jetix_cinescopio_dom` ([7] 13:30), `sl_jetix_cinescopio_dom_noite` ([7] 19:30) |

Vinhetas: abertura antes de cada sessão (`a_seguir` da série) e bumpers nos
intervalos (`durante` saída/volta): o do Disney sem voz por enquanto, e
Voltamos já / Estamos de volta no Teatro Cartoon.

- **Sessão de filme ocupa a janela inteira** (`9744574`). Quando o filme toca,
  a faixa de episódio que começaria antes do fim dele (menos 10 min) cede. Sem
  filme pronto, essas faixas tocam normalmente. Hoje isso afeta, só quando
  houver filme: Disney domingo 15h (Phineas, Brandy, Padrinhos, Danny Phantom);
  Jetix domingo 19h30 (Witch às 21h); CN domingo 14h (Dexter provisório) e
  18h30 (Looney Tunes Show, Corrida Maluca e Manda-Chuva).
- **Filme só toca na sessão.** Filme fica fora do rodízio e do encaixe
  (`scheduler.ts`, `9ba1d54`). Para cair na sessão, basta subir o filme com
  `--tipo filme` e o `series_id` da tabela. A sessão de sábado e a da tarde de
  domingo tocam o próximo filme, em ordem de `media_id` (byte a byte, `81a392d`).
- **REGRA: domingo à noite é REPRISE do filme da tarde, nos três canais**
  (Gabriel, 24/09). As faixas da noite têm `reprise = 1`: `sl_disney_filmes_dom`,
  `sl_cn_teatro_cartoon_dom_noite` e `sl_jetix_cinescopio_dom_noite`. A do Disney
  vale pra sábado e domingo ([6,7]); no sábado não passou filme antes no mesmo
  dia, e aí a reprise cai no filme novo. Ao recriar ou mover uma faixa da noite,
  mantenha o `reprise = 1`: a mudança do CN de 20:00 para 18:30 (23/09) perdeu
  essa marca.
- **O especial provisório cede ao filme** automaticamente quando as duas faixas
  caem no mesmo minuto e a do filme tem filme pronto (ex.: Dexter às 14h no CN).
- **Intervalos:** filme sem cue point toca direto; `scripts/cues-filme.mjs`
  acha cortes a cada ~20 min.
- **Acervo em 23/09:** Disney com Camp Rock, High School Musical e HSM 2; CN com
  As Meninas Superpoderosas — O Filme; Jetix ainda sem filme (a faixa espera).
- **Acervo a partir de 24/09 21h** (registro dos filmes que subiram pro R2 na
  madrugada sem registro no D1): Disney ganha O Rei Leão, Os Incríveis, Tarzan e
  Vida de Inseto; Jetix fica com Matilda, Os Batutinhas, Os Caça-Fantasmas e Os
  Goonies; CN ganha FormiguinhaZ, Os Sem-Floresta e Por Água Abaixo. O Pestinha 2
  subiu truncado (47 de ~90 min) e fica fora até subir de novo.

## Base provisória com o acervo atual

### Jetix

**Sábado — ação:** manhã de comédia; substitutos de A.T.O.M. e Galactik
Football; Maratona Power Rangers às 15h; faixa especial às 20h enquanto Digimon
não chega; Pucca às 22h.

**Domingo — aventura e cinema:** manhã leve; melhores da semana ao meio-dia;
Sessão Jetix de filmes às 15h (maratona provisória); Power Rangers às 18h;
substituto de Digimon às 20h; Pucca às 22h.

### Cartoon Network

**Sábado — participação:** clássicos pela manhã; ação no fim da manhã;
Cartoon Cartoons ao meio-dia; Votatoon às 15h; vencedor no começo da noite;
ação/anime à noite.

**Domingo — cinema:** clássicos e Scooby pela manhã; Teatro Cartoon às 14h;
comédias no fim da tarde; reprise exata do filme às 20h; ação à noite. Enquanto
`A Viagem de Dexter` não chega, quatro episódios de Dexter ocupam as duas
sessões sem usar a chamada que promete o filme.

### Disney Channel

**Sábado — maratona e filme:** animações pela manhã; sitcoms ao meio-dia;
Maratona Disney às 15h; Filme Disney às 20h; reprises selecionadas depois.

**Domingo — família:** Família Dinossauros e clássicos pela manhã; animações;
melhores da semana à tarde; O Maravilhoso Mundo de Disney às 20h. Até os filmes
chegarem, um especial familiar ocupa a faixa sem ser chamado de filme.

## Curadoria: títulos emprestados permanecem

Decisão do Gabriel: manter os programas atuais mesmo quando vieram de outro
canal ou estão fora do recorte estrito. Eles fazem parte da curadoria da Biel TV
e não são pendência de remoção:

- **Disney:** Os Padrinhos Mágicos, Danny Phantom e Yin Yang Yo!.
- **Cartoon:** Hey Arnold!, Martin Mystery, O Show dos Looney Tunes e Capitão
  Lento. Se Capitão Lento for uma peça comercial, ele permanece ligado ao canal,
  mas com o tipo correto (`comercial`), não como episódio.
- **Jetix:** Kid vs Kat e Zatch Bell!.

Essas exceções podem preencher os blocos provisórios e o rodízio, mas não
substituem para sempre os títulos históricos que o Gabriel ainda vai adicionar.

## Pedidos de comerciais

Os pedidos desta grade vivem como cards persistentes na aba **Fábrica** do
painel (`commercial_requests`, migration 0032). O card registra canal, dia,
horário, texto sugerido e observações, e pode ser marcado como concluído.

As chamadas originais que já estão em edição — Power Manhãs, A.T.O.M., Galactik
Football, Digimon, Pucca, Votatoon, A Viagem de Dexter etc. — não são duplicadas
nesses cards.

Além das sete peças iniciais, a migration 0033 encomenda as chamadas de
identidade que faltavam: fim de semana Jetix, Cartoon Cartoons, Toonami de
sábado, fim de semana Cartoon Network, Playhouse Disney, Zapping Zone e fim de
semana Disney Channel. Cada card traz texto sugerido, imagens/programas que
podem aparecer e a condição para a peça poder ir ao ar.

## Pedidos de programas e filmes

A migration 0033 cria também `content_requests`. A aba **Fábrica** mostra um
card para cada canal, dividido em **Programas** e **Filmes**. Cada título contém
o horário/bloco de destino e pode ser marcado individualmente quando entrar no
acervo. A borda amarela indica prioridade máxima — normalmente porque já existe
uma chamada original ou um slot fixo esperando aquele conteúdo.

O checklist é uma encomenda editorial, não uma restrição: os títulos que já
estão nos canais continuam no ar enquanto o novo acervo é reunido.
