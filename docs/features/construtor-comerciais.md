# Feature: construtor de comerciais (molde → comercial novo) — backlog futuro

> Pedido do Gabriel em 2026-07-14, no meio da discussão do cortador.
> Estado: 📦 BACKLOG — **futuro declarado** ("isso é uma task para o futuro mas já
> pode salvar"). Não implementar antes do [cortador](cortador-comerciais.md).
>
> **A ideia em uma frase:** em vez de **cortar** comercial de compilado, **montar**
> comercial novo a partir de um **molde** — e quando um desenho novo entrar no
> catálogo, a vinheta dele já nasce sozinha.

## A ideia, nas palavras dele

> *"eu mando o áudio do locutor que eu fiz com IA falando 'você está vendo Pucca
> na Jetix', mando a imagem base com um pedaço vazado e ele coloca alguns segundos
> de frame da Pucca dentro do bloco vazado e a música de fundo dos comerciais da
> Jetix. Isso tornaria ele um construtor de comerciais. Aí quando subisse um
> desenho novo ele sozinho já montava o comercial das vinhetas."*

## Relação com o item de backlog que já existia no ROADMAP

O item **"Diretor encomenda comerciais + vinhetas 'a seguir' GERADAS por IA"**
(pedido de 2026-07-13) já previa a parte 2: *template fixo de época (fundo + 3
quadros à direita, como as vinhetas reais do Jetix) + 1 imagem por série + locução
por IA + montagem 100% ffmpeg na fábrica*. **É a mesma feature** — esta spec é
aquela parte 2 promovida, com três evoluções que vieram do pedido de 2026-07-14:

| Backlog 07-13 | Evolução 07-14 (esta spec) |
|---|---|
| Locução gerada por TTS (ElevenLabs/Piper) | **O Gabriel traz o áudio pronto** (feito com IA por ele) — mais simples, e o timbre é escolha dele |
| 1 imagem estática por série (poster TMDB) | **Vídeo** no buraco: "alguns segundos de frame da Pucca" — mais rico |
| — | **Música de fundo** de época (a dos comerciais do Jetix) |
| Diretor "encomenda" quando falta | **Gatilho automático**: desenho novo no catálogo → vinheta montada sozinha |

As partes 1 (*relatório de lacunas*) e 3 (*fidedigna por construção*) daquele item
continuam sendo do Diretor e ficam lá.

## A peça central: o molde é um PNG com alpha

A sacada que faz isso ser simples: **"um pedaço vazado" = um PNG com região
transparente**. Não precisa de chroma key, não precisa detectar região por cor.

E o buraco **não precisa ser configurado**: dá pra achá-lo sozinho pelo canal alpha.

```
# bounding box da região transparente do molde (o "vazado"):
ffmpeg -i molde.png -vf "alphaextract,negate,cropdetect" -f null -
#         alpha → luma        buraco vira branco    → bbox do buraco
```

O Gabriel sobe o molde, o **código calcula** onde é o buraco. Nenhuma coordenada
digitada — mesma postura "sobe e trata" do cortador.

**Composição (tudo ffmpeg, na fábrica):**

```
[trecho]scale=<W_buraco>:<H_buraco>[v];   # o pedaço do desenho, no tamanho do vazado
[fundo][v]overlay=<X_buraco>:<Y_buraco>[tmp];
[tmp][molde]overlay                       # o molde POR CIMA — o alpha faz o resto
```

O molde por cima e o vídeo por baixo é o que dá recorte exato de graça: onde o
molde é opaco aparece o molde; onde é vazado, aparece o desenho.

**Áudio:** `amix` do locutor + música de época. Toque profissional que vale o
custo: **`sidechaincompress`** — a música abaixa sozinha quando o locutor fala e
volta quando ele cala. É como comercial de verdade soa.

## De onde sai "alguns segundos de frame da Pucca"

O desenho **já está no catálogo** (é o gatilho da feature). Escolher o trecho é o
único julgamento real aqui, e vale reusar o que o cortador construiu:

- **Nunca** pegar do começo (abertura/logo do canal) nem do fim (créditos).
- Preferir trecho **movimentado**: `select='gt(scene,0.4)'` (o mesmo `detectScene`
  do cortador) acha as regiões com corte de cena — mais vivo que uma cena parada.
- Evitar trecho escuro: o `detectBlack` já sabe dizer onde tem preto.
- Duração: a do buraco na tela = a do locutor (ver abaixo).

## Duração: quem manda é o locutor

O áudio que o Gabriel traz define o comprimento da peça, arredondado pra **grade
de 15/30s** (a mesma do portão de duração do cortador). O trecho de vídeo é
loopado/aparado pra caber. **A regra dos 10s do pipeline continua intacta:** a
peça montada entra pelo pipeline normal como qualquer mídia.

## Modelo de dados (esboço)

```sql
CREATE TABLE IF NOT EXISTS moldes (
  id          TEXT PRIMARY KEY,        -- md_<hex>
  nome        TEXT NOT NULL,           -- "vinheta Jetix — você está vendo"
  canal       TEXT,                    -- de época: o molde é do canal
  molde_key   TEXT NOT NULL,           -- PNG com alpha, no R2
  musica_key  TEXT,                    -- música de fundo, no R2
  buraco      TEXT,                    -- JSON {x,y,w,h} — CALCULADO do alpha, não digitado
  tipo_promessa TEXT,                  -- 'durante' | 'a_seguir' (casa com a fase 12)
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
```

O job de construção espelha o `ingest_job` (`molde_id` + `series_id` + `locucao_key`).

## Gatilho automático (o pulo do gato)

Desenho novo registrado com `series_id` inédito → enfileira "montar vinheta" pra
cada molde do canal. Quando o Gabriel sobe Pucca, a vinheta "você está vendo Pucca
na Jetix" **já nasce**, entra na fase 12 como promessa `durante` e cai no rodízio.
Ele não pede — aparece.

⚠️ A locução, porém, é **por série** ("você está vendo **Pucca**"). Então ou:
(a) o Gabriel sobe a locução junto com o desenho novo (1 arquivo, e o resto é
automático), ou (b) TTS gera a locução (volta pro Piper/ElevenLabs do item de
07-13, agora só pro nome da série). **Decisão aberta** — (a) é o que ele descreveu.

## Decisões abertas

1. **Locução:** o Gabriel traz por série (o que ele descreveu) vs. TTS gera o nome.
2. **Escolha do trecho:** heurística (cena+brilho) vs. um frame que o Gemini
   aprova ("isso mostra o personagem principal?" — o portão visual do cortador,
   reusado).
3. **Molde por canal ou por tipo de promessa?** (Jetix "você está vendo" vs.
   "a seguir" têm molde diferente.)
4. **Música:** trilha única por canal vs. várias em rodízio.

## Reaproveita

- `detectScene`/`detectBlack` (do cortador) — escolha do trecho.
- Portão visual multimodal (do cortador) — validar o frame escolhido.
- Staging no R2 + fila `ingest_jobs` + pipeline — prontos.
- Fase 12 (promessa) + fase 11 (séries/`series_id`) — prontos; a peça montada
  nasce **fidedigna por construção** (o texto da locução É a promessa).

## Relacionado

- [cortador-comerciais.md](cortador-comerciais.md) — o outro lado do "editor":
  1 compilado → N comerciais. Compartilha os helpers de ffmpeg e o portão visual.
- ROADMAP: "Diretor encomenda comerciais + vinhetas GERADAS por IA" (07-13).
