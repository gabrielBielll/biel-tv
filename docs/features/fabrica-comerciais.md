# Feature: fábrica de comerciais (banco de falas → vinheta montada)

> Pedido do Gabriel em 2026-07-18. **Evolução** da
> [construtor-comerciais.md](construtor-comerciais.md): em vez de trazer UMA
> locução pronta por programa, o sistema **concatena** a locução a partir de um
> **banco de falas reutilizáveis** (horário/frequência/assinatura gravados uma vez servem
> todos os programas) e monta o vídeo em duas fases dentro do molde do canal.
> Estado: 🧱 V1 IMPLEMENTADA (2026-07-18): banco de falas/moldes/amostras,
> painel admin, fila própria e montador ffmpeg que entrega `comercial` no
> pipeline normal. Ainda falta a fase 2 ("a seguir" com 3 janelas) e o
> agendador cumprir automaticamente `bloco_horario`.
>
> **Uma frase:** o Diretor escolhe *programa + horário*, a fábrica **concatena a
> locução** ("...frase... Power Rangers Força Animal, de segunda a sexta, às
> quatro da tarde") e **monta o vídeo** (amostra em tela cheia → encolhe pro
> buraco do molde JTX + texto do horário) — um comercial dinâmico, por canal.

## A ideia, nas palavras dele

> *"vários arquivos de áudio com as falas dos horários (às 6 da manhã, até meio
> dia; à 1 da tarde; até meia noite), outra categoria com a frequência (todos os
> dias / de segunda a sexta / segunda), outra com o nome dos programas, e um
> áudio com as frases do programa ('uma equipe destemida pronta pra enfrentar o
> mal...') com umas variações. Ele junta tudo e fecha com: 'power rangers força
> animal de segunda a sexta às 4 da tarde'. Sobre a imagem tem o png do jtx: um
> espaço vazio preto onde o vídeo entra ao fundo, e a parte de baixo pro texto do
> horário. Passa uma amostra do programa enquanto fala, depois joga a imagem e
> diminui o vídeo pro espaço preto — comercial perfeito e dinâmico pro diretor
> montar conforme a programação. Mas segmentado por canal."*

## Decisões travadas (2026-07-18)

| Decisão | Escolha | Porquê |
|---|---|---|
| **Fonte do áudio** | Gabriel **traz TODOS os clipes gravados** (horário, frequência, nome, frase) | Timbre 100% dele, zero dependência de TTS. O sistema só **concatena**. |
| **Gatilho** | **Diretor sob demanda**: escolhe programa + slot no painel e manda montar | Foi como ele descreveu. Gatilho automático (desenho novo → nasce sozinho, da spec construtor) fica pra depois. |
| **Escopo v1** | **1 programa** (molde `image-comercial-jtx.png`, 1 janela preta) | A ideia exata dele. O molde de 3 janelas (`image-comercial-jtx-2.png` = vinheta "a seguir") é **fase 2, no MESMO motor** (ver abaixo). |

## O mapa (4 gavetas)

Uma vinheta = **ÁUDIO montado** + **VÍDEO montado**, casados, registrados **por canal**.

### 1. Banco de falas concatenável (a sacada nova)

Cinco categorias de clipe; horário, frequência e assinatura são gravados UMA vez
**por canal** e servem todos os programas daquele canal — é o que faz virar
*fábrica* em vez de montagem manual. Cada canal mantém seus próprios narradores:
uma fala Disney nunca entra em uma vinheta Jetix, por exemplo.

| Categoria | Exemplos | Quantidade | Escopo |
|---|---|---|---|
| **horario** | "às seis da manhã", "ao meio-dia", "às quatro da tarde" | finito | por canal (reusa em seus programas) |
| **frequencia** | "todos os dias", "de segunda a sexta", "às segundas" | finito (7 dias + combos) | por canal |
| **nome** | "Power Rangers Força Animal" | 1 por programa | por `canal` + `series_id` |
| **frase** | "uma equipe destemida pronta pra enfrentar o mal…" (+ variações) | N por programa | por `canal` + `series_id` |
| **conector** | "Na Jetix" | 1 por canal/assinatura | por canal (`chave=encerramento`) |

**Ordem da locução** (fixa):
```
[frase sorteada] → [nome] → [frequência] → [horário] → [assinatura do canal]
```
→ *"...uma equipe destemida... **Power Rangers Força Animal**, **de segunda a
sexta**, **às quatro da tarde**, **na Jetix**!"*

### 2. O "slot" estruturado manda em tudo (o pulo do gato)

O Diretor NÃO escolhe o clipe "às quatro da tarde" na mão — ele informa um **slot
estruturado**: `{ dias: [1,2,3,4,5], hora: "16:00" }`. Desse mesmo dado, uma fonte
só, saem **três coisas** (sem transcrição, sem erro de casamento):

1. qual clipe de **frequência** pegar (`[1..5]` → chave `seg-sex` → "de segunda a sexta");
2. qual clipe de **horário** pegar (`"16:00"` → "às quatro da tarde");
3. o **texto na tela** embaixo do molde (`"SEG A SEX · 16H"`).

O canal vem do molde escolhido. Esse valor também filtra todos os cinco clipes
antes da montagem, preservando a identidade do narrador em cada rede.

Fuso sempre `America/Sao_Paulo` num lugar só (mesma regra da fase 12).

### 3. Vídeo em duas fases (o que ele descreveu)

- **Fase A — gancho:** amostra do desenho (cenas/cortes que o Gabriel armazena,
  1–2 por série) em **tela cheia** enquanto a locução fala **só a frase**.
- **Transição (~0.5s):** o vídeo **encolhe** e desliza pro bbox do buraco; o molde
  (PNG) entra por cima.
- **Fase B — ficha:** vídeo reduzido dentro do buraco + molde por cima + **texto do
  horário** embaixo, enquanto a locução fala **nome + frequência + horário + assinatura**
  (*"Power Rangers Força Animal, de segunda a sexta, às quatro da tarde, na Jetix"*).

**Sincronia elegante:** como a fábrica concatenou e **mediu cada clipe**, ela sabe
o instante exato em que a locução termina a *frase* e começa o *nome* (`t_faseB`) —
a transição do vídeo (tela cheia → card) casa com a entrada do nome, sem número
chutado. A frase é o gancho sobre a imagem; o card é a ficha com o quê/quando.

### 4. Molde por canal + música de época

- **Recorte do buraco (detalhe técnico verificado nas imagens):** o buraco do
  `image-comercial-jtx.png` é **preto sólido** e **diagonal** (não é retângulo
  reto). Overlay num bbox retangular vazaria pro azul. Solução: derivar uma
  **máscara alpha do preto** (`preto → transparente`) e pôr **o molde POR CIMA do
  vídeo** — o recorte fica exato mesmo torto, de graça. Unifica com a spec
  construtor (que assumia buraco já vazado/alpha): só troca "acha o alpha" por
  "acha o preto" (`colorkey`/threshold + `cropdetect` pro bbox).
- **Texto:** cartela em duas linhas na área azul de baixo: **nome do programa em
  branco** e, abaixo, **frequência + horário em vermelho**. O render usa a
  `Liberation Sans Narrow Bold` versionada no projeto, convertida para PNG
  transparente por `@resvg/resvg-js`; não depende das fontes instaladas na
  máquina da fábrica. O box padrão fica contido no canto inferior esquerdo,
  sem avançar sobre a janela diagonal do vídeo, e cada molde pode sobrescrevê-lo
  com `texto_box`.
- **Variação por canal:** a Jetix usa a cartela condensada no canto inferior
  esquerdo. A Disney Channel usa `Anton`, condensada e extra-bold, com o
  horário na primeira linha e o nome na segunda, ambos no topo esquerdo da
  imagem. O molde escolhido decide o estilo automaticamente.
- **Música:** a cama enviada com o molde tem prioridade e substitui totalmente o
  áudio da amostra; se o molde não tiver música, a fábrica usa a faixa original
  do vídeo da amostra. A fonte escolhida entra em `amix` em volume reduzido
  (`0.34`); a locução normalizada recebe ganho moderado (`1.35`) e fica à frente
  sem encobrir a trilha.
- **Por canal:** a vinheta montada entra em `media_channels` do canal do molde.

## Fase 2 — vinheta "a seguir" (MESMO motor, re-parametrizado)

> Confirmado por ele em 2026-07-18: *"a fase 2 com o outro arquivo de imagem vai
> ter algo do tipo: você está vendo [programa], a seguir [programa] e depois
> [programa]. Mas isso já vamos aproveitar o motor da fase 1."*

Molde `image-comercial-jtx-2.png` (**3 janelas pretas**). A locução muda de
template, mas a fábrica é a **mesma**:

```
[você está vendo] [nome A] → [a seguir] [nome B] → [e depois] [nome C]
```

O que muda vs. fase 1 — tudo parâmetro, **nada de motor novo**:

| Peça | Fase 1 | Fase 2 |
|---|---|---|
| Template da locução | frase → nome → freq → horário → assinatura | conector→nome ×3 |
| Clipes usados | frase + **nome** + freq + horário + assinatura | **os mesmos `nome`** + `conector` novos |
| Buracos no molde | 1 | 3 (o mesmo achador de buraco/alpha, N vezes) |
| Amostras de vídeo | 1 (fase A→B) | 3 (uma por buraco; entram em sequência) |
| Promessa (fase 12) | `bloco_horario` | **`a_seguir`** — a sequência É os 3 próximos da grade real |
| Origem do conteúdo | Diretor escolhe programa+slot | Diretor (ou grade) informa **os 3 próximos** |

**O `nome` gravado uma vez serve as duas fases** — por isso o banco já nasce
modelado pra isso (categoria `nome` por `series_id`, sem acoplar ao template).
Os **conectores** ("você está vendo", "a seguir", "e depois") são genéricos e
finitos como horário/frequência: gravados uma vez, reusam sempre (categoria
`conector`). Casa naturalmente com a promessa `a_seguir` da fase 12: a peça
montada nasce fidedigna porque a sequência dos 3 nomes É a da grade.

## Modelo de dados (esboço)

```sql
-- banco de falas reutilizáveis (a fábrica concatena)
CREATE TABLE IF NOT EXISTS voice_clips (
  id         TEXT PRIMARY KEY,          -- vc_<hex>
  canal      TEXT NOT NULL,             -- identidade/narrador que pode usar o clipe
  categoria  TEXT NOT NULL,             -- 'horario'|'frequencia'|'nome'|'frase' (fase 1)
                                        --   + 'conector' (assinatura da fase 1 e conectores da fase 2)
  series_id  TEXT,                      -- p/ 'nome'|'frase'; NULL p/ genéricos
  chave      TEXT,                      -- casamento por slot: horario='16:00',
                                        --   frequencia='seg-sex'; NULL p/ nome/frase
  rotulo     TEXT NOT NULL,             -- "às quatro da tarde" / "de segunda a sexta" / nome
  audio_key  TEXT NOT NULL,             -- áudio JÁ NORMALIZADO no R2 (perfil de áudio único)
  duracao    REAL,                      -- medida na ingestão do clipe (p/ a sincronia)
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- molde por canal (reaproveitado da spec construtor-comerciais)
CREATE TABLE IF NOT EXISTS moldes (
  id          TEXT PRIMARY KEY,         -- md_<hex>
  nome        TEXT NOT NULL,
  canal       TEXT,                     -- de época: o molde é do canal
  molde_key   TEXT NOT NULL,            -- PNG (buraco preto ou alpha), no R2
  musica_key  TEXT,                     -- trilha de fundo, no R2
  buraco      TEXT,                     -- JSON bbox {x,y,w,h} CALCULADO (do preto/alpha)
  texto_box   TEXT,                     -- JSON bbox da área do texto embaixo
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS program_samples (
  id         TEXT PRIMARY KEY,         -- ps_<hex>
  series_id  TEXT NOT NULL,
  rotulo     TEXT NOT NULL,
  video_key  TEXT NOT NULL,            -- trecho no R2 (vazio se for link)
  source_url TEXT,                     -- abertura do YouTube baixada na montagem
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```

O job de montagem espelha o `ingest_job` (novo modo/coluna, como `corte` no
cortador): payload `{ molde_id, series_id, slot:{dias,hora}, frase_id? }`
(`frase_id` nulo = sorteia uma variação).

## O montador (na fábrica — tudo ffmpeg)

1. **Resolver clipes:** pelo `canal` do molde, buscar `nome(series_id)`,
   `frase(sorteada|frase_id)`,
   `frequencia(slot.dias→chave)`, `horario(slot.hora→chave)`,
   `conector(encerramento)`. Falta um → **erro
   legível** na fila (não monta pela metade).
2. **Concatenar a locução:** clipes já vêm normalizados no perfil de áudio →
   concat → `locucao.wav`; medir offsets (`t_faseB` = início do clipe de **nome**,
   i.e. fim da frase; `t_total`).
3. **Amostra do desenho:** trecho pré-armazenado por série (1–2 amostras de
   cenas/cortes) ou link de abertura do YouTube. Links são baixados por `yt-dlp`
   somente no momento da montagem. O executor da fábrica precisa ter `yt-dlp`
   disponível; o GitHub Actions já o instala. Duração ≥ `t_total`
   (loop/apara pra caber).
4. **Fechar a duração:** o montador calcula o próximo múltiplo de 10 segundos
   antes de renderizar. A sobra abre com até 2,5 s de vídeo+música antes da
   locução e permanece na ficha final com vídeo+música; assim o pipeline não
   precisa criar uma cauda preta perceptível.
5. **Montar o vídeo:** `[0,t_faseB)` tela cheia → transição encolhendo pro bbox
   do buraco (molde entra por cima) → `[t_faseB,t_total]` vídeo no buraco + molde
   (alpha do preto) por cima + PNG de texto em duas linhas no `texto_box`.
6. **Áudio:** `amix(locução, música)`, com música de fundo atenuada e locução em
   primeiro plano.
7. **Fechar:** render → master → **pipeline normal** (pad p/ múltiplo de 10 —
   regra de ouro intacta — segmenta, R2, D1). `media_channels = molde.canal`;
   metadata com `series_id`; nasce **fidedigna por construção** como promessa
   `bloco_horario` (o texto do slot É a promessa) — cai no rodízio do canal.

## Reaproveita (verificado no projeto)

- **Fábrica** GitHub Actions + fila `ingest_jobs` + progresso % — prontos.
- **`concatParts`** (ingestão de playlist) — concatenação de áudio.
- **`detectScene`/`detectBlack`** (cortador) — escolha do trecho + achar o preto.
- **Pipeline** (normaliza/pad/segmenta/R2/D1) + regra dos 10s — pronto.
- **Fase 12** (`media_promises`, tipo `bloco_horario`) + **fase 9** (`media_channels`,
  molde por canal) — prontos.
- Tabela **`moldes`** — já esboçada na spec construtor.

## Trabalho novo real

1. `voice_clips` + ingestão do clipe (normaliza áudio + mede duração + rótulo/chave).
2. **Montador** (concatena locução + 2 fases de vídeo + texto + música).
3. **UI do painel:** cadastrar clipes por categoria; escolher programa + slot e
   "montar vinheta".

## Operação em produção: como povoar a base

O painel da **Fábrica de Comerciais** é a entrada normal de produção. O nome do
arquivo ajuda a organização, mas o que determina o uso automático é a categoria
e a chave cadastradas no painel.

| Peça a cadastrar | Cadastro necessário | Reuso |
|---|---|---|
| Horário | categoria `horario`, canal e chave exata `HH:MM` (ex.: `14:00`) | todos os programas do canal |
| Frequência | categoria `frequencia`, canal e chave canônica (ex.: `seg-sex`) | todos os programas do canal |
| Nome | categoria `nome`, canal e série | uma vez por programa/canal |
| Chamadas | categoria `frase`, canal e série | duas ou mais variações por programa/canal |
| Assinatura | categoria `conector`, canal e chave `encerramento` | por canal/identidade |
| Amostra | vídeo enviado ou link do YouTube associado à série | uma ou mais cenas por programa |
| Molde | PNG e, opcionalmente, música associados ao canal | um ou mais por canal |

### Ordem recomendada de cadastro

1. Criar o molde do canal, com o PNG e a cama musical.
2. Para cada canal, cadastrar sua biblioteca de horários e frequências.
3. Cadastrar a assinatura do canal, como "Na Jetix".
4. Para cada programa, cadastrar seu nome gravado, duas ou três frases de
   chamada e uma ou duas amostras de vídeo; uma amostra pode ser a abertura
   oficial no YouTube.
5. No painel, escolher **molde + programa + dias + horário** e mandar montar.

O Diretor informa o slot estruturado, por exemplo `{ dias: [1,2,3,4,5], hora:
"14:00" }`. A fábrica resolve `seg-sex`, encontra os cinco clipes, gera o texto
`SEG A SEX · 14H` e publica o comercial no canal do molde. Se uma peça ainda
não existir, o job para com uma mensagem objetiva indicando a categoria/chave
que falta; ele nunca publica uma vinheta incompleta.

### Organização local de materiais

Enquanto os arquivos ainda estão sendo preparados, eles ficam separados em
`assets/comerciais/<canal>/`: `falas/`, `moldes/` e `amostras/`. A Jetix já está
organizada dessa forma e o PNG inicial da Disney está em
`assets/comerciais/disney_channel/moldes/`. O cadastro pelo painel continua
sendo a etapa que envia esses materiais ao R2 e registra suas categorias.

## Cuidados / gotchas antecipados

- **Nivelar volume entre clipes:** Gabriel grava em sessões/formatos diferentes →
  cada clipe passa por mini-normalize de áudio na ingestão (`loudnorm`), senão "de
  segunda a sexta" sai mais alto que "às quatro da tarde".
- **Buraco diagonal:** usar **alpha do preto**, nunca overlay num retângulo (vaza).
- **`drawtext` precisa de fontfile** versionado no repo.
- **Chave de frequência:** normalizar `dias[]` → chave canônica (`[1..5]`→`seg-sex`,
  `[1..7]`→`todos`, `[1]`→`seg`, …) num único mapa (áudio E texto saem dele).

## Decisões abertas (não bloqueiam a v1)

1. **Locução por canal?** O mesmo "de segunda a sexta" serve todos os canais, ou o
   timbre/vinheta muda por canal (clipe `canal`-específico)? v1: global.
2. **Trilha:** uma por canal vs rodízio de várias.
3. **Escolha do trecho:** heurística (cena+brilho) vs frame aprovado por Gemini
   (portão visual do cortador reusado).
4. **Texto:** só horário (`SEG A SEX · 16H`) vs nome + horário na cartela.

## Relacionado

- [construtor-comerciais.md](construtor-comerciais.md) — a origem desta ideia
  (molde + locução única). Esta spec é a versão "banco concatenável".
- [comerciais-condicionais.md](comerciais-condicionais.md) — fase 12: a vinheta
  montada nasce como promessa `bloco_horario`.
- [cortador-comerciais.md](cortador-comerciais.md) — o outro lado do editor;
  compartilha `detectScene`/`detectBlack` e os helpers de ffmpeg.
