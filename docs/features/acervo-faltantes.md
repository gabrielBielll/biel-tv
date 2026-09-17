# O que falta baixar — acervo × grade-alvo (15/09/2026)

> Cruzamento **atual** entre o catálogo real (`media_items` + `media_channels`,
> só `status='ready'`) e [grade-alvo-2005.md](grade-alvo-2005.md). Substitui os
> checklists de julho ([cartoon](acervo-cartoon-vs-grade-2005.md) ·
> [jetix](acervo-jetix-vs-grade-2005.md) · [disney](acervo-disney-2005-2010.md)),
> que ficaram velhos — vários títulos listados como "faltando" já entraram.
>
> Prioridade: **✓ real** (horário copiado de grade da Folha de 2005) vem antes de
> **~ reconstruído** (madrugada/manhã estimadas). Um título que a grade repete em
> vários horários rende mais que um que aparece uma vez.

Hoje: **978 programas** no ar — CN 400 (19 séries), Jetix 394 (16), Disney 184 (8).

## 🔵 Cartoon Network

**Falta, com horário REAL na grade (prioridade máxima — 9 títulos)**

| Programa | Horários na grade-alvo |
|---|---|
| A Mansão Foster para Amigos Imaginários | 09:00 · 14:30 |
| O Laboratório de Dexter | 07:30 · 21:00 |
| O Clube das Winx | 13:00 · 15:00 |
| Betty Atômica | 12:30 · 15:30 |
| Mucha Lucha | 11:30 · 16:30 |
| Du, Dudu e Edu | 05:30 · 17:00 |
| Hi Hi Puffy AmiYumi | 19:00 |
| Pokémon | 22:00 |
| Super Choque (Static Shock) | 23:30 |

**Falta, faixa reconstruída (madrugada/manhã — 6 títulos)**
InuYasha · Dragon Ball GT · Yu Yu Hakusho · Cavaleiros do Zodíaco · Samurai X · Johnny Bravo

> **Zatch Bell!** está na grade da CN às 01:30 e nós já temos 32 eps — no Jetix.
> É só ligar a série ao `cartoon_network` também (mídia compartilhada já funciona,
> o agendador dedupa entre canais).

**Temos pouco (completar antes de baixar coisa nova)**

| Série | Eps | Observação |
|---|---:|---|
| Coragem, o Cão Covarde | 7 | ocupa 09:30 todo dia; 7 eps repetem rápido |
| A Vida e Aventuras de Juniper Lee | 5 | 2005, in-era |
| Hey Arnold | 2 | ⚠️ é **Nickelodeon**, não CN — decidir se fica |
| O Que Há de Novo, Scooby-Doo? | 7 | ⚠️ está **misturado** no mesmo `series_id` do Scooby clássico (32 eps): a grade-alvo trata como dois programas (04:30 clássico × 11:00/14:00/18:00/21:30 OQHDN). Separar em `scooby_doo` e `scooby_doo_oqhdn`. |
| Capitão Lento | 2 | ⚠️ o Gabriel já confirmou que é **comercial**, não episódio — tirar do pool de conteúdo |
| O Show dos Looney Tunes | 7 | ⚠️ é de **2011** — anacrônico pro alvo 2005 (o clássico, 32 eps, esse sim é da época) |

## 🔴 Jetix

**Falta, com horário REAL na grade (13 títulos)**

| Programa | Horários |
|---|---|
| Power Rangers: Tempestade Ninja | 09:00 · 16:30 · 22:30 |
| Power Rangers: Dino Trovão | 09:30 · 17:00 · 22:00 |
| Shaman King | 11:00 · 19:00 |
| Digimon | 04:00 · 12:00 · 20:00 |
| Beyblade G-Revolution | 10:00 · 18:00 (temos **1 ep** e sem `series_id`) |
| Megaman: NT Warrior | 10:30 · 20:30 |
| Sonic X | 02:00 · 07:30 · 15:30 |
| Fillmore! | 06:00 · 13:00 |
| Code Lyoko | 06:30 · 13:30 |
| Dragon Booster | 14:00 · 18:30 |
| Músculo Total | 12:30 · 15:00 |
| O Colégio do Buraco Negro | 23:00 |
| Ciência Travessa | 23:30 |

**Falta, faixa reconstruída (6 títulos)**
Goosebumps · So Weird (Sinistro) · A.T.O.M. · Medabots · Alergia Monstra · Inspetor Bugiganga

> **As Aventuras de Jackie Chan** está na grade do Jetix às 05:00 e já temos 25
> eps na CN — mesma solução do Zatch Bell: ligar ao `jetix` também.

**Temos pouco**

| Série | Eps | Observação |
|---|---:|---|
| Super Esquadrão dos Macacos Robôs | 2 | tem horário ✓ real (17:30) |
| Power Rangers: Galáxia Perdida | 6 | fora da grade 2005, decisão do Gabriel manter |
| Power Rangers: O Resgate | 2 | idem |
| Beyblade | 1 | taggear `series_id=beyblade_g_revolution` |

## 🟣 Disney Channel

Alvo aqui é a fase **2005-2010** por curadoria (a grade real de 2002 foi
descartada). Escolhas do Gabriel que ainda **não** temos:

| Programa | Tipo |
|---|---|
| Kim Possible | animação (4 horários na grade) |
| Lilo & Stitch: A Série | animação (3 horários) |
| A Nova Escola do Imperador | animação (3 horários) |
| Os Substitutos | animação |
| Cory na Casa Branca | sitcom |
| Boa Sorte, Charlie | sitcom |
| A Casa do Mickey Mouse | pré-escolar (faixa da manhã) |

**Clássicos Disney da manhã — a escolher** (o Gabriel pediu, ainda sem decisão):
A Turma do Pateta · O Point do Mickey (House of Mouse) · Os Caçadores de
Aventuras (DuckTales) · Tico e Teco: Defensores da Lei · O Fantástico Justiceiro
(Darkwing Duck) · A Patota do Pato Donald · Timão e Pumba · Aladdin: A Série ·
Hércules: A Série

**Temos pouco**

| Série | Eps | Observação |
|---|---:|---|
| American Dragon: Jake Long | 4 | tinha 3 `series_id` diferentes; hoje só sobrou `jacke_long_o_dragao_ocidental` — os outros sumiram do `ready` (conferir se foram rebaixados) |
| Os Feiticeiros de Waverly Place | 11 | |
| As Visões da Raven | 17 | ⚠️ caiu de 31 → 17: a leva `s2_e01-15` foi rebaixada por tarja (pillarbox). **Re-subir em 16:9.** |

**Emprestados de outros canais** (decisão antiga do Gabriel, mantida):
`padrinhos_magicos` (68), `danny_phantom` (19), `yin_yang_yo` (9) — Nick/Jetix
tocando na Disney.

## ♻️ Rebaixados (`status='disabled'`): o que vale recuperar e o que é lixo

Episódio rebaixado continua no catálogo e no R2, mas fora do ar (o agendador só
monta grade com `ready`). Foram tirados por defeito de imagem — tarja lateral
queimada na fonte ou marca d'água. **Mas a maioria já foi substituída por uma
leva nova e boa**, e aí o arquivo velho é só lixo ocupando R2:

| Série | Rebaixados | Tem substituto no ar? | O que fazer |
|---|---:|---|---|
| Os Padrinhos Mágicos (leva "bare", ids `ep_NN`) | 33 · 390 min | **Sim** — a leva `padrinhos_pl` (69 eps) cobre todos os 33 números | apagar (libera ~1,1 GB no R2) |
| American Dragon: Jake Long (`dragon_ocidental`) | 4 · 91 min | **Sim** — são os MESMOS E02-E05 que já estão no ar como `jacke_long_o_dragao_ocidental` | apagar |
| **As Visões da Raven** | **14 · 298 min** | **NÃO** — T02 **E01-E05 e E07-E15** não existem em nenhuma outra versão | **recuperar** |
| Looney Tunes E40 | 1 · 8 min | não | recuperar junto, é 1 |

⚠️ **O buraco da Raven é grande:** no ar a série pula de **T02E06 direto pra
T02E16**. Metade da 2ª temporada não existe pra quem assiste. É o único caso
onde reprocessar (cortar a tarja com `--crop` + `--fit fill`) devolve conteúdo
que hoje não tem substituto — ou, se a fonte original ainda existir, re-baixar
em 16:9 sai melhor que re-encodar o encode do R2.

## 🎬 Filmes — a faixa que hoje não existe

O acervo tem **um filme só**: `filme_as_meninas_superpoderosas_2002` (69 min, CN).
A grade-alvo da Disney tem **duas faixas de filme por dia** (00:00 e 20:30, ~2h
cada) que hoje não têm o que exibir.

**Disney — "O Maravilhoso Mundo de Disney" / DCOM** (dublados, da época)
High School Musical (2006) · High School Musical 2 (2007) · Camp Rock (2008) ·
Cadete Kelly (2002) · Vou Te Pegar! (2002) · Zenon (1999) · A Cidade do
Halloween (1998) · Casa Inteligente (1999) · Programa de Proteção para Princesas
(2009) · Minutemen: Viajantes do Tempo (2008) · Jump In! (2007) · Aos Treze
(Twitches, 2005)

**Cartoon Network — filmes/especiais que a CN exibia**
Scooby-Doo animados (Ilha dos Zumbis · O Monstro do México · A Lenda do Vampiro
· Cyber Perseguição) · Os Jovens Titãs: Missão Tóquio (2006) · Tom e Jerry: O
Filme · A Mansão Foster: especiais · ⚠️ Ben 10: O Segredo do Omnitrix é 2007 —
fora do alvo 2005

**Jetix — a "sessão de filme" do canal**
Os Padrinhos Mágicos: Abracatástrofe / Já Não Era Sem Tempo (os TV-movies, muito
fiéis ao canal) · Power Rangers: O Filme (1995) · Power Rangers Turbo: O Filme
(1997) · Digimon: O Filme · Sonic X: especiais

> Pro filme entrar na grade não basta ingerir: precisa de `channel_slot` de 2h
> (ou de um evento em `channel_events`), senão o agendador trata como episódio
> comum no rodízio.

## Como isso vira grade

1. Ingerir (ver [[ingest-local-termux]] nas memórias: `scripts/drena-local.sh`).
2. Ligar ao canal (`media_channels`) — e, pros compartilhados (Zatch Bell,
   Jackie Chan), ligar aos **dois** canais.
3. Criar `channel_slot` no horário da grade-alvo, senão o título só entra no
   rodízio dinâmico e nunca tem hora fixa.
4. A fábrica de comerciais precisa do **kit por série** (clipe `nome`, 2-3
   `frase`, amostra de vídeo) pra gerar o comercial daquele horário.
