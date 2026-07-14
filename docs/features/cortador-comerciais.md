# Feature: cortador de comerciais (compilado → N comerciais) — backlog

> Especificado em 2026-07-14. **Reescrito no mesmo dia**, depois de uma discussão
> com o Gabriel que mudou o requisito central (ver "A virada", abaixo).
> Estado: 📦 BACKLOG (planejado, não implementado).
>
> **A ideia em uma frase:** colar o link de um **compilado** do YouTube (~4min
> com vários comerciais emendados) e **cada anúncio aparecer sozinho no
> catálogo**, pronto pro rodízio. Sem revisão, sem conferência, sem operador.

## O problema

O acervo bom de comerciais antigos no YouTube quase sempre vem **compilado**:
um vídeo de 4–10min com 6–15 anúncios emendados. Usar um só exigiria baixar,
abrir num editor, achar os cortes na mão e exportar cada peça — inviável no
volume que o Gabriel quer.

## A virada (o que mudou da v1 desta spec — leia antes de implementar)

A v1 tinha como **regra de ouro** "o operador revisa antes de qualquer coisa ir
pro ar", com uma aba de cards (juntar/dividir/aparar/descartar/nomear). O Gabriel
foi explícito: **ele não vai revisar.** Nem cards, nem conferir corte, nem ficar
dando comando. O requisito real é *sobe o compilado e trata*.

Isso mata três coisas da v1 e obriga a resolver o problema de verdade:

| v1 (morta) | v2 (esta) |
|---|---|
| Aba de revisão com cards | **Não existe.** Era ~metade da complexidade. |
| `confiança` = nº pro humano olhar | **Portão automático** que descarta sozinho |
| `silencedetect n=-30dB` (chute) | **Threshold medido** por platô, por compilado |
| Merge de trecho curto (*salvar* o duvidoso) | **Descartar** o duvidoso |
| Thumbnail do miolo pro operador | Frames de **borda** pro portão visual |

E deixa a pergunta que a v1 escondia atrás do humano: **quem garante o corte, se
ninguém olha?** O resto da spec é a resposta.

## O medo do Gabriel, medido em vez de discutido

Ele perguntou: *"o corte vai ser no momento exato entre um comercial e outro?"*.
Fabricamos um áudio com silêncio em posições **conhecidas** e medimos o ffmpeg:

| Verdade (construída) | `silencedetect` reportou | erro |
|---|---|---|
| silêncio começa em 3.000 | 3.018594 | +18ms |
| silêncio acaba em 3.400 | 3.413333 | +13ms |
| silêncio começa em 6.400 | 6.408707 | +9ms |
| silêncio acaba em 6.650 | 6.664127 | +14ms |

**Um frame de TV dura 33ms.** O erro é de meio frame, sempre pra frente (o
detector precisa de algumas amostras pra confirmar a queda — viés constante).

### Descoberta 1 — a precisão não é o problema

Achar *onde* está o silêncio é sub-frame. E **extrair** no timestamp pedido
também é resolvido: `-ss` DEPOIS do `-i` + re-encode é frame-accurate. O jeito de
errar seria `-c copy`, que gruda no keyframe e vaza pedaço do vizinho — proibido
aqui (o pipeline re-encoda cada trecho de qualquer forma; precisão > velocidade).

### Descoberta 2 — o threshold é tudo, e ele se descobre sozinho

Repetimos o teste com chiado de fundo a -34dB (fita VHS), varrendo o threshold:

| threshold | gaps achados | 1º gap |
|---|---|---|
| -20dB a **-33dB** | 2 (correto) | **3.018594** — idêntico em toda a faixa |
| -34dB pra baixo | 0 | — |

Existe um **platô**: 13dB de largura onde o resultado não muda *um dígito*. Então
o noise floor **não pode ser uma constante na spec** — ele é uma propriedade
medida de cada compilado:

> **Auto-calibração:** varre o `silencedetect` de -20dB a -45dB, acha a faixa
> contígua onde o nº de gaps e os timestamps não mudam, usa o **meio** dela.

Isso apaga a decisão aberta nº 1 da v1 ("qual noise floor? -30dB?"). Não é chute
que alguém tem que acertar — é medição.

### Descoberta 3 — a falha é barulhenta, não sutil (é isso que autoriza o modo automático)

Com threshold acima do chiado: acerta sub-frame. Abaixo: **acha zero**. Não existe
o caso do meio ("achou, mas errou por meio segundo"). E a largura do platô vira a
medida de confiança de graça:

- **Platô largo** → existe uma resposta estável → pode cortar.
- **Sem platô** (o nº de gaps muda a cada dB) → **rejeita o compilado inteiro**,
  loga, fim. O Gabriel cola outro link.

> **O princípio que sustenta a feature sem revisor: o sistema sabe quando ele não
> sabe.** Um sistema que erra achando que acertou precisa de alguém olhando. Um
> que ou acerta com meio frame de erro ou levanta a mão e desiste, não precisa.

## O modelo certo de um limite: zona morta, não ponto

A v1 mandava usar o **ponto médio** do `black_start`/`black_end` como limite. Está
errado — ou pelo menos é pior de graça. Entre dois anúncios **não existe uma
fronteira**: existe um **gap** (preto+silêncio, 0.2–1s). Qualquer ponto dentro
dele é um corte correto.

Um limite são **dois** pontos, não um:

- fim do comercial A = `gap_start` (último frame de conteúdo dele)
- início do comercial B = `gap_end` (primeiro frame de conteúdo dele)
- **o gap inteiro não pertence a ninguém** e é descartado

Ganho duplo: nenhum dos dois carrega preto na ponta (o ponto médio dava ~0.1s de
preto de brinde pra cada um), e o **erro cai na zona morta em vez do conteúdo** —
se a detecção do gap errar 15ms pra dentro, você perde 15ms de preto, não de
anúncio.

## Os três sinais (detecção)

| Sinal | Comando (esboço) | Pega |
|---|---|---|
| **Silêncio** | `-af silencedetect=n=<AUTO>dB:d=0.3 -vn -f null -` | o mais confiável; **threshold pelo platô**, nunca fixo |
| **Preto** | `-vf blackdetect=d=0.15:pic_th=0.98:pix_th=0.10 -an -f null -` | flash preto entre anúncios |
| **Corte de cena** | `-vf select='gt(scene,0.4)',metadata=print -an -f null -` | cortes SECOS (sem preto nem silêncio) |

> ⚠️ **PEGADINHA CRÍTICA (confirmada no código):** `detectBlack()` em
> `packages/pipeline/src/ffmpeg.mjs:249` usa `d=1.0` — pensado pro cue point de
> intervalo (≥1s de preto). **Entre anúncios o preto é curtíssimo (0.1–0.4s)**:
> com `d=1.0` ele **não acha nada**. Chamar o mesmo helper com **`d≈0.15`** (a
> assinatura já aceita `{ d, picTh, pixTh }` — não reescrever, só chamar certo).

**Fusão:** clusteriza candidatos numa janela `W ≈ 0.5s`, guarda quais sinais
contribuíram, e cada cluster vira uma **zona** `[gap_start, gap_end]` (não um ponto).

## Os portões (o que substitui a revisão humana)

Cada comercial candidato passa por cinco portões **independentes** — eles erram de
formas diferentes, que é o ponto. Ordem importa: **determinístico primeiro** (grátis
e reprodutível), LLM só no que sobreviveu.

1. **Portão de sinal** — preto ∩ silêncio na mesma janela. *O limite é real?*
   Sinal solto não passa.
2. **Portão de duração (o mais forte, e novo)** — comercial de TV é vendido em
   slot de **15s / 30s / 60s**. Se o trecho deu 29.8s, os **dois** limites estão
   certos — e essa confirmação **não vem do ffmpeg, vem de como o mundo funciona**.
   É um sinal genuinamente independente. Fora da grade (ex.: 43s) → descarta.
3. **Portão de borda técnica** — depois de cortar, checa se o clipe **começa e
   termina com conteúdo** (não com preto/silêncio). Se abre com preto, o corte
   vazou → descarta. É o detector conferindo o próprio resultado.
4. **Portão visual (Gemini)** — manda os **dois frames de borda** (último antes do
   corte, primeiro depois) e pergunta *"são dois anúncios diferentes ou o mesmo
   cortado no meio?"*. É a conferência que um humano faria com o olho, automática.
   Precisa de multimodal: **Gemini 3.5 Flash** (a chave já está no projeto).
   ⚠️ `llm.ts:pedeJson` é **texto puro** (`parts: [{ text }]`) — precisa de uma
   variante que aceite `inline_data`. **Não se sabe se `deepseek-v4-flash` é
   multimodal** (o helper nunca mandou imagem pra ele): se não for, **não há
   fallback visual** — sem Gemini, o duvidoso é **descartado** em vez de aprovado.
5. **Portão semântico (DeepSeek/Gemini)** — o whisper já transcreve na ingestão
   (fase 12, de graça). Um anúncio inteiro **tem fecho**: slogan, marca, "vá até
   uma revenda". Cortado no meio, a transcrição morre no meio da frase. `pedeJson`
   com schema de 2 campos. Classificação binária de transcrição curta —
   `deepseek-v4-flash` dá conta folgado e já é pago.

Passou nos cinco → catálogo → rodízio → no ar. Falhou em **qualquer um** → lixo,
com uma linha de log.

### O que NÃO passa pro LLM (a regra da casa)

`diretor.ts:2` já cravou: **"o LLM DECIDE (ações tipadas em JSON garantido), o
CÓDIGO CALCULA"**. Aplicado aqui: threshold, sinais, grade de duração e borda
técnica são **medição e aritmética** — não vão pro LLM. Perguntar pro DeepSeek se
"29.8 está perto de 30" troca uma linha de JS reprodutível por 300ms, uma chamada
de rede que pode cair, e uma resposta que **pode variar entre execuções**. Como
ninguém audita a saída, o sistema **precisa** ser reprodutível: quando um
comercial sair torto, o Gabriel tem que poder olhar o número e saber por quê — não
interrogar um oráculo que já esqueceu. O LLM entra só nos portões 4 e 5, que são
julgamento de verdade (visual e linguagem), e no nome.

## A assimetria que autoriza descartar sem dó

- Descartar um comercial bom → custo **≈ zero**. Tem compilado infinito no
  YouTube; é só colar outro link.
- Ingerir um comercial cortado no meio → **vai pro ar quebrado**, e ninguém está
  conferindo.

Logo, **os portões devem ser brutalmente conservadores**. De 9 candidatos, ingerir
5 e jogar 4 fora é *sucesso*, não desperdício. A v1 tentava salvar o duvidoso (o
"merge de trecho curto"); sem revisor, salvar é o comportamento errado.

**Nada de corte silencioso:** o descartado vai pra uma tabela de log (com o motivo
e o portão que barrou). É **log, não fila de trabalho** — ninguém precisa abrir.
O painel mostra uma linha: *"compilado X: 9 candidatos, 5 no ar, 4 descartados"*.

## O chat do editor (a válvula — opcional, nunca bloqueante)

Pedido do Gabriel (2026-07-14). A distinção que ele fez, e que a spec adota:

> **Revisão** = trabalho obrigatório, antes, com ele de gargalo. ❌ Rejeitada.
> **Chat** = opcional, depois, quando *ele* notar algo. ✅ É o que ele quer.

Nada espera pelo chat. Ele existe pra dois usos:

1. **Feedback pós-ar:** *"o comercial da Kaiser ficou ruim"* → tira do ar/descarta.
2. **Corte na mão, por cima do automático:** *"no compilado X corta em 1:23 e
   2:47"* — o Gabriel passa os timestamps direto e o sistema fatia, **pulando os
   portões** (a ordem dele é a autoridade).
3. Consequência de graça: *"por que você descartou 4?"* → o log responde.

**Espelha o Diretor** (`diretor.ts`), não inventa padrão: o LLM emite **ações
tipadas** (`cortar_em`, `descartar`, `aparar`, `refazer_compilado`) e o **código
valida contra o catálogo e executa**. Mesma cadeia Gemini→DeepSeek, mesmo
`PlanoChat`, mesmos backstops determinísticos (o `diretor.ts:238` já ensina que
modelo flash fala a data certa na resposta e esquece de preencher o campo).

**Decisão aberta:** aba de chat própria ("✂️ Editor") vs. ações novas no chat do
Diretor que já existe no Modo God. Inclinação: aba própria — o contexto do system
prompt é outro (compilados e cortes recentes, não a grade).

## Modelo de dados

```sql
CREATE TABLE IF NOT EXISTS comercial_cuts (
  id          TEXT PRIMARY KEY,            -- cc_<hex>
  source_url  TEXT,                        -- link do compilado (ou NULL se upload)
  staging_key TEXT,                        -- o compilado baixado, no R2
  canais      TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'baixando'
              CHECK (status IN ('baixando','analisando','cortando','pronto','rejeitado','error')),
  threshold   REAL,                        -- o dB escolhido pelo platô (auditoria)
  plato       TEXT,                        -- JSON {min,max} do platô medido
  candidatos  TEXT,                        -- JSON: cada trecho + portões + veredito
  error       TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_comercial_cuts_status ON comercial_cuts (status, created_at);

ALTER TABLE ingest_jobs ADD COLUMN corte TEXT;  -- JSON {start,end} · presente = fatiar
-- ATENÇÃO: ALTER ADD COLUMN não é idempotente — aplicar 1x local, 1x remoto.
```

Sem status `revisar` (não existe mais revisão). `threshold`/`plato` ficam gravados
**pra auditoria**: é como o Gabriel descobre, meses depois, por que um compilado
foi rejeitado. `corte` presente no job = a fábrica lê o `staging_key`, extrai
`[start,end]` e manda pro pipeline. Ausente = job normal.

## Endpoints no Worker (`admin.ts`)

- `POST /admin/comerciais` — cola o link → cria `comercial_cuts` → `dispatchFabrica`.
- `POST /admin/comerciais/claim` — a fábrica reivindica (self-heal, igual playlist).
- `POST /admin/comerciais/:id/resultado` — a fábrica devolve candidatos + vereditos
  dos portões → cria 1 `ingest_job` por **aprovado** (sem passar por humano).
- `POST /admin/comerciais/:id/error`.
- `GET  /admin/comerciais` — lista pro painel (a linha de contagem + o log).
- `POST /admin/editor/chat` — o chat (espelha o do Diretor).

## Fábrica (`scripts/factory-local.mjs`)

- **`tickComercial()`** (como `tickPlaylist()`): claim → baixa o compilado
  (`baixarUrl`, reusa cookies/Deno) → staging R2 → **sweep de threshold** → platô?
  → detecta zonas → aplica portões 1–3 → extrai os frames de borda → portões 4–5
  → `POST /comerciais/:id/resultado`. Prioridade alta na fila `tick()`.
- **`processJob()`**: se `job.corte` existe → baixa o `staging_key` do R2, extrai
  `[start,end]` e roda o `cli.mjs ingest` de sempre com `--tipo comercial`.

## Pipeline (`packages/pipeline/src/ffmpeg.mjs`)

- `detectBlack` já serve — **chamar com `d=0.15`** (não o default 1.0).
- `detectSilence(file, { noise, d=0.3 })` → `[{start,end}]`.
- `achaThreshold(file)` → **o sweep + platô** → `{ db, plato:{min,max} }` ou `null`.
- `detectScene(file, { th=0.4 })` → `[t, …]`.
- `proponhaZonas(file, duration, opts)` → fusão → `[{gapStart, gapEnd, sinais}]`.
- `extraiTrecho(file, start, end, out)` → `-ss` DEPOIS do `-i`, re-encode.
- `frameEm(file, t, out)` → 1 frame (serve pros portões de borda e visual).
- `temConteudoNaBorda(file)` → o portão 3.

## Teste (`verify-cortador`) — sem depender do Gabriel

Ele não vai conferir, e **não precisa**: o teste sintético valida o motor sozinho.
Constrói um compilado falso com N clipes de **duração escolhida por nós**,
separados por preto+silêncio, e verifica que o motor acha **exatamente** os
limites plantados (tolerância de 1 frame / 33ms) e que a grade de duração bate.
Foi assim que as três descobertas acima foram medidas — a mesma técnica, no motor
inteiro em vez de só no áudio.

O que o sintético **não** prova é se compilado real do YouTube se comporta como o
falso. **O platô cobre esse buraco:** se o real for bagunçado demais, não tem
platô e é rejeitado sozinho. A falha é segura.

## Decisões abertas

1. ~~Noise floor do `silencedetect`~~ → **resolvida**: platô, medido por compilado.
2. **Tolerância da grade** de 15/30/60s: ±1s? ±2s? (Comercial de época pode ter
   sido cortado fora do padrão; conservador demais descarta acervo bom — mas
   descartar é barato.)
3. **Largura mínima de platô** pra aceitar um compilado: 5dB? 8dB? (No sintético
   deu 13dB, mas ele é limpo demais.)
4. Chat do editor: **aba própria vs. ações no Diretor** (ver acima).
5. Janela de fusão `W` (0.5s?) e `d` do silêncio (0.3s?).

## Reaproveita (quase tudo já existe)

- `detectBlack()` (só chamar com `d` certo) — pronto.
- **`llm.ts:pedeJson`** (Gemini 3.5 Flash → `deepseek-v4-flash`, JSON com schema,
  timeout 30s) — pronto pro portão semântico; **precisa de variante multimodal**
  pro portão visual.
- **`diretor.ts`** — o molde do chat (ações tipadas + executor + backstops).
- Download por link + cookies self-service + Deno (11d) — pronto.
- Staging no R2 (uploads/11b) — pronto.
- Pipeline normaliza/segmenta/transcreve/registra — pronto.
- Transcrição → promessa (fase 12) + "A nomear" (11c) — prontos.
- Fila `ingest_jobs` com progresso %, retry ↻ e self-heal — de graça.

## Esforço

- Migration: **pequeno**.
- Motor (sweep/platô + 3 sinais + zonas + portões 1–3 + frames): **médio** — é o
  trabalho novo real.
- Portões 4–5 (variante multimodal do `pedeJson` + 2 prompts): **pequeno**.
- Worker (endpoints): **médio**. Fábrica (`tickComercial` + ramo de corte): **médio**.
- Chat do editor: **médio** (espelha o Diretor).
- UI: **pequeno** — colar link + uma linha de contagem + o log. (A v1 tinha uma
  aba inteira de cards aqui; morreu.)

## Relacionado

- [construtor-comerciais.md](construtor-comerciais.md) — o outro lado do mesmo
  "editor": em vez de **cortar** comercial de compilado, **montar** comercial
  novo a partir de molde. Pedido do Gabriel em 2026-07-14, futuro.
- [playlist-youtube.md](playlist-youtube.md) — o esqueleto (N partes → 1 mídia;
  aqui é 1 fonte → N mídias) e o molde de `analisar → processar`.
