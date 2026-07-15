# Feature: cortador de comerciais (compilado → N comerciais) — backlog

> **v3 — reescrita em 2026-07-15, depois de rodar contra o ACERVO REAL.**
> Estado: 📦 BACKLOG. O motor v1 está commitado (`b379687`) e **não serve** —
> ver "O que morre", no fim. Não implementar em cima dele.
>
> **A ideia em uma frase:** colar o link de um **compilado** e **cada anúncio
> aparecer sozinho no catálogo**, sem revisão, sem conferência, sem operador.

## A história em três viradas (leia antes de escrever qualquer linha)

| | premissa central | o que a derrubou |
|---|---|---|
| **v1** | "o operador revisa antes de ir pro ar" | O Gabriel: *"queria algo automático, só subir o compilado e ele tratar"* — ele não vai revisar. Morreu a aba de cards (~metade da complexidade). |
| **v2** | "preto ∩ silêncio acha os limites; o platô diz quando confiar" | **O acervo real.** Ver as medições abaixo. Morreu o motor inteiro. |
| **v3** | *"cada sinal falha num lugar diferente; combine-os pelo que cada um sabe"* | (atual) |

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
2. **Zonas sem fala** (como os 91s) → não viram candidato por ausência; entram
   por **fecho visual** (procurar cartela/logo) e por `scene`: **zero cortes de
   cena num trecho longo = bloco contínuo = uma peça só**.
3. **DeepSeek lendo o texto** (`pedeJson`, já pago, tem cota) → *este buraco é
   limite?* A fala fechou com marca/slogan, ou a frase atravessa? **Texto, não
   imagem** — o Gemini sai da rota crítica e o problema de cota some.
4. **ffmpeg** → *onde exatamente*: o gap de silêncio mais próximo do buraco dá o
   corte com **±15ms** (medido). O whisper dá ±1s e **não pode** cortar.
5. **Portões que sobraram:** grade de duração; borda técnica; bloco contínuo.

> **Whisper diz QUAIS. O LLM diz SE. O ffmpeg diz ONDE.**
> É a regra da casa (`diretor.ts:2`) — o LLM decide, o código calcula — aplicada
> na única divisão que o acervo real sustenta.

### Margem de segurança (pedido do Gabriel, 07-15)

Ele notou que pode entrar pedaço de programa no corte e propôs "deixar alguns
segundos a mais, no máximo 5". A tensão a resolver ao implementar: margem **pra
frente** aumenta a chance de invadir o vizinho. A saída é ser **assimétrico**:
folga quando o vizinho é outro anúncio (pegar 1s de comercial alheio é inócuo),
**zero** quando o vizinho é programa (1s de desenho estraga a peça). **Decisão
aberta:** confirmar a intenção dele (garantir que a peça não seja truncada?).

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

1. **Margem assimétrica** — confirmar a intenção do Gabriel (acima).
2. **Fecho visual** — como achar a cartela final sem gastar cota: 1 frame no fim
   de cada candidato? Só nas zonas sem fala? (A chave do Gemini é **free tier**:
   medido 503 "high demand" após 32s e 429 "exceeded quota" na chamada seguinte.)
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
