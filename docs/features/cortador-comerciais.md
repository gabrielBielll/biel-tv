# Feature: cortador de comerciais (compilado → N comerciais)

> **v4 — 2026-07-15. O AUTOMÁTICO PERDEU; QUEM CORTA É O GABRIEL.**
> Estado: 🟡 EM USO, com o Claude no meio do fluxo (ver "Como está hoje").
>
> **A ideia em uma frase (v4):** o Gabriel marca início/fim de cada peça no
> editor, salva, e a máquina corta com precisão de frame, nomeia, sobe e aposenta
> a versão anterior.
>
> ⚠️ A v3 abria com *"sem revisão, sem conferência, sem operador"*. Está errado, e
> o custo de descobrir foi de dois dias — a autópsia inteira está abaixo.

## O placar que decidiu tudo

| quem cortou | peças | aprovadas por ele |
|---|---|---|
| **motor automático** (v3) | 24 | **1** (~4%) |
| **gabarito do Gabriel** | 16 | **16** |

E não foi falta de esforço: **nenhum sinal serve** neste material. Medido contra
as fronteiras que ele anotou à mão no compilado de 390s —

| sinal | acerta | mas |
|---|---|---|
| cena | 5 de 6 | dispara **138×** em 390s (96% falso) |
| silêncio | 3 de 6 | 39–92 disparos |
| buraco de fala (whisper) | **1 de 6** | e o único tem 33s de largura |
| preto | 0 de 6 | 2 ocorrências no arquivo inteiro |

Comercial de 2004 **emenda direto**: sem preto, sem silêncio, e com corte de cena
idêntico aos cortes de DENTRO do anúncio. Tentar casar as cenas com a grade de
15/30/60 também falhou (3/6) — com um corte a cada 2.8s existe um ponto perto de
qualquer lugar que se procure, então a "estrutura encontrada" era a que eu mandei
encontrar. Não há o que detectar.

Ele, assistindo, acertou tudo em minutos — e **todas** as fronteiras dele caem
redondas na grade (29s, 29.5s, 30s, 60s, 10s), o que confirma a leitura.

## Como está hoje (2026-07-15)

```
comercial já editado, subido no painel  → vai direto pro ar (intocado)
cortador automático                     → nasce 'disabled', espera no editor
ele marca no /r/cortar e SALVA          → corta → 'ready' → aposenta a anterior
peça ruim no ar                         → /r, ele reporta, ela sai
```

**Regra dele:** *"quando eu clicar em salvar, aí sim está aprovado pra ir pro ar"*
e *"deve desativar o vídeo antigo pra não ficar vários iguais na programação"*.

### ⚠️ O elo que falta: o Claude está no meio

O salvar grava em `cortes_marcados` (status `marcado`), mas **quem executa o corte
é `scripts/recorta-marcado.mjs` rodado à mão**. Ou seja: ele marca, e só sai peça
quando alguém pede pro Claude processar.

**Decisão dele (2026-07-15), explícita:** *"por hora pode depender de você; vou ir
vendo conforme for vendo a evolução, eu decido se deixo a fábrica automática ou
continuo usando você"*.

Então **não automatizar sem ele mandar**. O caminho, quando/se ele quiser, é um
`tickCorteMarcado()` na fábrica: claim de `cortes_marcados WHERE status='marcado'`
→ baixa a fonte → corta → ingere `--status ready` → desativa a fonte → marca
`pronto`. O esqueleto já existe no `tickComercial` (que hoje devolve 404 e é
ignorado de propósito — ver `factory-local.mjs`).

## As telas

| rota | o quê |
|---|---|
| `/r` (ou `/revisao`) | bancada: lista tudo, toca, ⏮ início / ⏭ fim, veredito + motivo, botão pro editor |
| `/r/cortar` | editor: marca ini/fim/nome, régua própria, ±1s/±0.5s/±0.1s, rascunho local |

O `/r` é **janela do que já está no ar**, não fila de aprovação — quem aprova é o
salvar do editor.

## O preto no fim das peças (não é bug do corte)

O pipeline pada toda mídia pra múltiplo de 10 (`tpad`, preenchendo com PRETO)
porque os segmentos têm que fechar na grade — é o que sincroniza os 3 canais.
Uma vinheta de 4.89s ocupa 10s: **5.11s de preto**. Medido no ar:
`black_start:4.87 → black_end:9.93`.

**Decisão dele:** deixar assim (congelar o último quadro foi rejeitado: *"congelar
é ruim"*). E ele já usa a regra a favor — marcou `0→10.00` e `0→19.99` de
propósito, encostando na dezena pra zerar o padding.

## A história em quatro viradas (leia antes de escrever qualquer linha)

| | premissa central | o que a derrubou |
|---|---|---|
| **v1** | "o operador revisa antes de ir pro ar" | O Gabriel: *"queria algo automático, só subir o compilado e ele tratar"* — ele não vai revisar. Morreu a aba de cards (~metade da complexidade). |
| **v2** | "preto ∩ silêncio acha os limites; o platô diz quando confiar" | **O acervo real.** Ver as medições abaixo. Morreu o motor inteiro. |
| **v3** | "cada sinal falha num lugar diferente; combine-os pelo que cada um sabe" | **O gabarito dele.** Combinar sinais ruins não faz sinal bom: 24 peças cortadas, 23 reprovadas. Morreu a detecção. |
| **v4** | *"ele marca, a máquina corta"* | (atual) |

A lição que a v2 pagou caro: **o teste sintético fabricava o mundo que a spec
afirmava.** Eu plantei preto+silêncio nos limites porque a spec dizia que era
assim que comercial emenda, e o motor achou 29/29. O primeiro arquivo real
derrubou tudo em 90 segundos. Teste que constrói a própria premissa não prova
nada — e a v3 só existe porque o Gabriel tinha o acervo à mão.

## O que o acervo REAL provou (medido, não suposto)

**Material:** `com_jetix_intervalo_comercial_hi` (600s, "Jetix Intervalo Comercial
HIGH") — reconstruído dos 60 segmentos `.ts` no R2 — e o rip de 41s "A seguir
Pucca + ID Basquetebol". O catálogo tem **6 compilados** (600s, 470s, 390s, 200s,
150s, 150s), todos com "Intervalo" no título; 4 deles têm id `ep_*` porque foram
reclassificados de episódio pra comercial (id é imutável, o `tipo` mudou).

### 1. O preto NÃO marca troca de comercial — e engana

**4 ocorrências em 600s** (57s, 272s, 339s, 601s), num intervalo com ~15-20
anúncios. Pior: o único preto daquela vizinhança cai **no meio de um anúncio** —
a locução faz "Ele é grande! / Enorme! / Gigante! / Imenso!" e há preto entre os
adjetivos. Cortar ali picotaria um comercial em quatro.

> Comercial de TV brasileira dos anos 2000 **emenda direto**. O preto era usado
> na entrada/saída do **bloco**, não entre anúncios. A "pegadinha nº 1" da v1/v2
> (`detectBlack` com `d=1.0` não acha preto curto) era verdadeira e **irrelevante**:
> ajustar pra `d=0.15` acha preto que não é limite.

### 2. O silêncio NÃO tem platô — decai continuamente

Sweep no compilado de 600s:

| dB | gaps | | dB | gaps |
|---|---|---|---|---|
| -18 | 434 | | -34 | 21 |
| -20 | 331 | | -38 | 15 |
| -24 | 111 | | -40 | 14 |
| -28 | 57 | | -42 | 14 |
| -30 | 40 | | -46 | 10 |
| -32 | 27 | | -50 | 6 |

**Não existe faixa estável.** O "14, 14" que o motor v2 abraçou como platô de 4dB
são dois degraus vizinhos de uma escada em queda livre. Áudio de intervalo
comercial é **comprimido/maximizado pra broadcast**: não há silêncio de verdade
entre as peças, só o ponto mais baixo de um decaimento contínuo. O platô só
existe em áudio sintético (transição instantânea) — foi por isso que funcionou no
teste fabricado.

E o silêncio erra dos dois lados: dá **falso positivo** (6 pausas internas dentro
de uma peça só) e **falso negativo** (limites reais sem silêncio a -30dB).

### 3. A transcrição acha os limites — onde há fala

`faster-whisper` no compilado: **164 segmentos** de fala com timestamp, em ~3min
de CPU. Os buracos de fala > 0.8s viram candidatos, e o **texto dos dois lados
decide**:

- **É limite:** a fala fecha com a assinatura da marca e a seguinte abre outro
  assunto. Comercial **fecha com a marca** — é isso que a transcrição mostra.
- **Não é limite:** a frase atravessa o gap (a sequência de adjetivos acima é o
  caso-escola: 3 buracos, 1 anúncio só).
- **Vinheta se anuncia sozinha:** as peças de canal dizem literalmente "você está
  vendo /continuem vendo <programa>". Não precisa de visão pra achá-las.

> ⚠️ **`scripts/transcreve.py` JÁ produz os timestamps e os JOGA FORA** na última
> linha (`" ".join(seg.text ...)`). Os `segments` do faster-whisper têm `.start`
> e `.end`, e o script já roda com `vad_filter=True`. A informação que a v3
> precisa é gerada hoje e descartada na saída — falta só uma flag `--json`.

### 4. Onde não há fala, o whisper é cego — mas a peça ainda assina

**91 segundos** (149-241s, 15% do compilado) sem uma palavra transcrita. Não é
silêncio: o volume médio é **-30.3dB contra -30.1dB** de um trecho com fala —
idêntico. É trilha + efeitos sem locução.

Investigado a fundo (o Gabriel suspeitou que fosse pedaço de desenho, depois que
fossem comerciais com efeitos+música):

- **zero cortes de cena** (`scene > 0.5`) nos 91s inteiros;
- estética contínua (gameplay verde → personagem → corredor azul);
- **fecha com o logo do JETIX** em ~238s.

Veredito: é **uma peça só** — uma promo institucional do canal, sem locução. A
regra do Gabriel: *"se for uma variação única, aí faz sentido remover"*.

> **O sinal que sai daí:** a peça **fecha com a assinatura** — só que **visual**
> (cartela/logo) em vez de textual. É o mesmo princípio do portão semântico,
> no canal que sobra quando não há fala. Comercial mudo de época termina igual:
> cartela da marca. **Isto cobre o ponto cego do whisper.**

### 5. O portão da grade sobreviveu

Foi o único da v2 que resistiu ao real: a promo de 90s **não é** 15/30/60 nem por
acidente, e a grade a mata sozinha. Continua sendo o portão mais forte, e pelo
mesmo motivo de antes: é o único **independente do arquivo** — vem de como
comercial é vendido, não de medir bits.

⚠️ Mas **não serve pra vinheta/ID de canal**: no rip de 41s as três peças reais
(vinheta "a seguir" 9.8s, ID de basquete 23.9s, Pucca 7.3s) não batem em nenhum
slot. A grade vale pra **anúncio de anunciante**, não pra peça de canal.

## A tabela que resume tudo — quem falha onde

| sinal | falso positivo | falso negativo | serve pra |
|---|---|---|---|
| **preto** | sim (no meio do anúncio) | sim (4 em 600s) | ~nada. Rebaixar a curiosidade. |
| **silêncio** | sim (pausas internas) | sim (limites sem silêncio) | **timestamp preciso** (±15ms) de um limite já confirmado |
| **cena** | sim (cortes internos: 89 em 600s) | não, mas afogado em ruído | refinar timestamp; detectar "bloco contínuo" (zero cenas = 1 peça) |
| **transcrição** | raro | **cego sem locução** (15% aqui) | **decidir SE é limite** onde há fala |
| **fecho visual (logo)** | ? (a testar) | ? | **decidir SE é limite** onde NÃO há fala |
| **grade 15/30/60** | ~10% por acaso | vinheta/ID não bate | matar trecho que não é anúncio |

## A arquitetura v3

Cada peça faz **só o que sabe fazer**:

1. **Whisper (local, grátis, sem cota)** → segmentos de fala com timestamp.
   Buracos > 0.8s = **candidatos** a limite.
   > ⛔ **ISTO FALHA NA MAIORIA DO ACERVO — medido em 2026-07-15, e é a 5ª
   > premissa desta feature a cair pelo mesmo motivo: calibrei num arquivo e
   > generalizei.**
   >
   > | compilado | segs | mediana | buracos ≥0.8s |
   > |---|---|---|---|
   > | `com_jetix_intervalo_comercial_hi` (603s) | 164 | **2.6s** | **36** |
   > | `ep_intervalos_jetix_brasil_2004` (470s) | 99 | 4.1s | **6** |
   > | `ep_jetix_brasil_intervalo_muscu` (390s) | 83 | 4.0s | **5** |
   >
   > O 600s — onde TODA a v3 foi calibrada, e de onde saiu a fixture — é a
   > **exceção**: é o único em que o whisper segmenta fino. Nos outros ele
   > agrupa em blocos de ~4s e os candidatos somem. Baixar o mínimo de 0.8s
   > pra 0.4s **não muda nada** (6 → 6): os segmentos são contíguos.
   >
   > E as pausas ESTÃO no áudio — no mesmo compilado 2 o ffmpeg acha **130
   > silêncios a -30dB** (59 a -35dB) e 65 cortes de cena. O whisper é que não
   > quebra nelas.
   >
   > **A lição:** a segmentação do whisper é COMPORTAMENTO DE MODELO (varia por
   > arquivo, sem aviso), enquanto silêncio é FÍSICA (está sempre lá). Elegi o
   > instável como fonte de candidatos.
   >
   > **Correção proposta (NÃO testada — precisa de gabarito do compilado 2,
   > anotado olhando frame):** candidatos = `silêncio ∪ buraco de fala`,
   > deduplicados; o LLM continua julgando pelo texto das bordas. O silêncio tem
   > falso positivo (pausa dentro da peça), mas é justamente o que o portão de
   > julgamento existe pra matar — e ele acertou 13/13 nisso.
2. **Zonas sem fala** (como os 91s) → não viram candidato por ausência; entram
   por **fecho visual** (procurar cartela/logo) e por `scene`: **zero cortes de
   cena num trecho longo = bloco contínuo = uma peça só**.
3. **DeepSeek lendo o texto** (`pedeJson`, já pago, tem cota) → *este buraco é
   limite?* A fala fechou com marca/slogan, ou a frase atravessa? **Texto, não
   imagem** — o Gemini sai da rota crítica e o problema de cota some.
   ✅ **TESTADO (07-15) — a premissa que decidia a v3.** 13 buracos anotados à
   mão (gabarito fixado ANTES), julgados cegos pelo DeepSeek: **13/13**, e
   **10/10** nos de alta confiança. Chegou pelo mesmo caminho ("sequência
   retórica do mesmo anúncio" pro caso-armadilha dos adjetivos; "vinheta de
   canal, indicando transição"), e usou até a **duração da pausa** como indício
   sem ninguém pedir. **A análise funciona sem o Claude na sala** — que era a
   única coisa que importava pro "sobe e trata".
   > ⚠️ Isso só apareceu depois de consertar um bug de instrumento: o
   > `json_object` do DeepSeek garante JSON válido, **não as nossas chaves** (ele
   > não tem `responseSchema` como o Gemini). Sem o schema no prompt ele
   > respondia com nomes próprios, o campo virava `undefined`, e `undefined` era
   > lido como veredito negativo — "3 erros" que eram meus. Consertado no
   > `llm.ts` (`a252356`), e **atinge os 4 módulos em produção** que usam o
   > helper.
4. **A precisão (o ONDE)** → ⛔ **A v3 AFIRMAVA "o ffmpeg dá ±15ms". É FALSO.**
   Medido nos 25 limites confirmados: **8 têm âncora limpa** (1 silêncio dentro
   do buraco), **11 são ambíguos** (o buraco tem 3, 4, até 27 silêncios — qual
   deles?) e **6 não têm nada**. Aqueles ±15ms foram medidos num limite cuja
   posição já se sabia; o problema real é justamente não saber. Ver a escada
   abaixo.
5. **Portões que sobraram:** grade de duração; borda técnica; bloco contínuo.

> **Whisper diz QUAIS. O LLM diz SE. O ONDE vem da margem — com o ffmpeg
> refinando quando tem o que refinar (1/3 das vezes).**
> É a regra da casa (`diretor.ts:2`) — o LLM decide, o código calcula.

### A escada da precisão (e por que a margem do Gabriel estava certa)

O placar de 8/25 assusta menos do que parece: **buraco curto não precisa de
âncora**. Metade dos limites tem buraco de 1–1.5s; cortar no meio erra ≤0.75s, e
o que está ali é música de transição, não conteúdo. O problema real são os
buracos longos (#8 = 12.3s, #15 = 91.7s), onde o meio erraria 6s e 45s.

**E o limite nunca está no meio do vazio — está grudado na ponta.** No #15 a fala
parou em 149.1s e a promo institucional começou logo depois; os outros 91s são a
promo inteira, sem locução. Faz sentido pela forma como comercial é feito: a
locução fecha com a marca, sobram 1–2s de trilha/cartela, e a próxima peça entra.

> Que é exatamente o que o Gabriel propôs por intuição de quem assistiu o
> material: *"aproveitar o fim da vinheta e deixar alguns segundos a mais, tipo
> no máximo 5, e depois cortar"*. A medição explica inclusive o teto: passou de
> ~5s do fim da fala, não se está mais no rabicho da peça — se está dentro da
> seguinte.

A escada (nenhum degrau depende de LLM ou de olho humano):

1. **1 silêncio no buraco** → ancora nele (±15ms). 8 dos 25.
2. **Vários silêncios** → o **primeiro depois do fim da fala**, dentro da margem.
3. **Nenhum** → `fim da fala + margem`, com **teto de 5s**.
4. **Buraco longo (>5s) sem âncora** → é bloco sem locução (promo/comercial
   mudo): **não cortar no escuro**. Trata como peça inteira e deixa a grade de
   duração decidir — foi o que matou a promo de 90s.

**Assimetria a resolver na implementação:** margem pra frente aumenta a chance de
invadir o vizinho. Folga quando o vizinho é outro anúncio (1s de comercial alheio
é inócuo); **zero** quando o vizinho é programa (1s de desenho estraga a peça).

## O que MORRE do que está commitado

- `achaThreshold()` / sweep de platô (`cortador.mjs`) — **o platô não existe** em
  áudio real. A correção de deriva (07-15) conserta um bug legítimo mas não salva
  o critério. Pode virar utilitário de diagnóstico; não é o motor.
- `portaoSinal()` (preto ∩ silêncio obrigatório) — **rejeitou 100%** do acervo
  real. É a premissa errada, codificada.
- `D_PRETO`/`detectBlack` como sinal de limite — 4 em 600s, e engana.
- `verify-cortador.mjs` (29/29) — **valida um mundo fabricado**. Manter só o que
  testa aritmética pura (`fundeZonas`, `segmenta`, grade); o resto tem que
  passar a rodar contra um **recorte do acervo real** commitado como fixture.
- `portaoVisual()` (`portoes.ts`) — a ideia (LLM extrai fato, código compara)
  **sobrevive e é boa**; muda o papel: de portão 4 pra **detector de fecho visual**
  nas zonas sem fala. As duas lições gravadas no topo do arquivo continuam
  válidas (não peça veredito, peça fato; indisponível ≠ reprovado).

## O que se APROVEITA

- **`fundeZonas()` (zona morta)** — o modelo continua certo: um limite é
  `[gapStart, gapEnd]`, o gap não é de ninguém, o erro cai no preto e não no
  conteúdo. Medido: invasão ≤ 1 frame (33ms), que é o **piso físico** (um gap de
  0.45s a 30fps dá 13,5 frames; não há corte no meio de um frame).
- **`extraiTrecho`** (`-ss` DEPOIS do `-i` + re-encode) — frame-accurate. `-c copy`
  gruda no keyframe e vaza o vizinho: proibido.
- **`detectSilence`** com `noise` obrigatório — continua certo, mas como
  **refinador de timestamp**, não como detector.
- **`pedeJson`/`pedeJsonComImagem`**, `diretor.ts` (molde do chat), download por
  link, staging R2, pipeline, fase 12, fila com retry — tudo pronto.
- **Descartar é grátis** (tem compilado infinito no YouTube); ingerir peça
  quebrada, não. Portões conservadores. 5 de 9 é sucesso.
- **O chat do editor** (opcional, DEPOIS, nunca bloqueante) — inalterado.

## Decisões abertas

1. ~~Margem assimétrica — confirmar a intenção do Gabriel~~ → **resolvida pela
   medição** (ver "A escada da precisão"): a margem é o mecanismo principal do
   ONDE, não um detalhe. Falta só calibrar o teto (5s é o palpite dele; os buracos
   curtos medidos são de 1–1.5s, então 5s tem folga de sobra).
2. **Fecho visual** — **rebaixado.** Era pra cobrir o ponto cego do whisper
   (zonas sem locução, 15% do compilado testado), mas o degrau 4 da escada já dá
   um destino seguro a esses blocos sem precisar de visão: não corta, trata como
   peça inteira, a grade decide. Vale testar depois, se o degrau 4 estiver
   jogando fora comercial mudo bom. (A chave do Gemini é **free tier**: medido
   503 "high demand" após 32s e 429 "exceeded quota" na chamada seguinte.)
3. **Peça de canal vs. anúncio** — a grade só vale pra anunciante. Vinheta/ID
   precisa de outro critério (a transcrição as identifica: "você está vendo X").
4. **Bloco contínuo** — quantos segundos sem corte de cena definem "uma peça só"?
   (Nos 91s: zero cenas > 0.5.)
5. **API de transcrição** — usar o `transcreve.py` local (faster-whisper `small`,
   ~3min por 600s de CPU) ou o serviço externo do Gabriel (ver o item "A nomear"
   no ROADMAP)? **Perguntar antes de apontar pra lá.**

## Teste — a regra nova

**Fixture real, não fabricada.** Um recorte curto (~60s) de um compilado do
acervo, commitado, com os limites anotados à mão. O sintético só vale pra testar
aritmética (fusão, grade, segmentação) — nunca pra validar detecção, porque quem
fabrica o compilado fabrica a premissa junto.

## Relacionado

- [construtor-comerciais.md](construtor-comerciais.md) — o outro lado do editor:
  molde + vazado → vinheta nova. O `alphaextract,negate,cropdetect` acha o buraco
  sozinho.
- [playlist-youtube.md](playlist-youtube.md) — N partes → 1 mídia (aqui é o
  inverso); o molde de `analisar → processar` e o esqueleto da fila.
