# Feature: cortador de comerciais (compilado → N comerciais) — backlog

> Especificado em 2026-07-14 a partir de um pedido do Gabriel.
> Estado: 📦 BACKLOG (planejado, não implementado).
>
> **A ideia em uma frase:** colar o link de um **compilado** do YouTube (~4min
> com vários comerciais emendados), o sistema **detecta os limites** entre os
> anúncios, propõe os cortes pro operador revisar, e cada trecho confirmado vira
> um `media_item` tipo `comercial` no catálogo — pronto pro rodízio da grade.

## O problema

O acervo bom de comerciais antigos no YouTube quase sempre vem **compilado**:
um vídeo de 4–10min com 6–15 anúncios emendados. Hoje, pra usar um só, o Gabriel
teria que baixar, abrir num editor, achar os cortes na mão e exportar cada peça —
inviável no volume que ele quer. A feature automatiza o **fatiamento**.

## A sacada de arquitetura: é a playlist AO CONTRÁRIO

- Playlist (`playlist-youtube.md`): **N partes → 1 mídia** (baixa várias, concatena).
- Cortador: **1 fonte → N mídias** (baixa uma, fatia).

O **esqueleto é idêntico** e deve ser reusado: `analisar → revisar → confirmar
→ processar`, com uma aba no admin e uma tabela de ciclo espelhando
`playlist_ingests`. A regra de ouro também é a mesma: **não cortar errado no
silêncio** — o operador revisa antes de qualquer coisa ir pro ar.

## Fluxo

1. **Operador cola o link** do compilado (ou faz upload) na aba nova
   "✂️ Comerciais", escolhe canal(is). (Detecta que não é playlist — sem `list=`.)
2. **A fábrica baixa 1× (yt-dlp)**, guarda o arquivo no **staging (R2)**, roda o
   **motor de detecção** e devolve os cortes propostos → status `revisar`.
3. **O operador revisa** os cortes (thumbnail + início–fim + duração + quais
   sinais concordaram), e ajusta: **juntar** dois trechos, **dividir** num
   timestamp na mão, **aparar** a borda, **descartar** (intro/outro do canal do
   YouTube quase sempre é lixo), **nomear**.
4. **Confirma** → 1 `ingest_job` por comercial mantido, cada um apontando pro
   compilado no staging + um intervalo `[start, end]`.
5. **A fábrica corta e ingere** cada trecho pelo **pipeline normal** → cada um
   vira um `media_item` tipo `comercial`, que já **transcreve** (whisper, fase
   12), propõe a **promessa** e cai na área **"A nomear"** (fase 11c) se o nome
   não puder ser deduzido.

## O motor de detecção (o coração da feature)

Nenhum sinal isolado acha os limites entre anúncios de forma confiável. A força
vem de **fundir três sinais do ffmpeg** e ranquear por concordância.

### Os três sinais

| Sinal | Comando (esboço) | Pega | Parse |
|---|---|---|---|
| **Preto** | `-vf blackdetect=d=0.15:pic_th=0.98:pix_th=0.10 -an -f null -` | flash preto entre anúncios | `black_start`/`black_end` → limite no **ponto médio** |
| **Silêncio** | `-af silencedetect=n=-30dB:d=0.3 -vn -f null -` | queda de áudio entre anúncios (**o mais confiável**) | `silence_start`/`silence_end` → limite no ponto médio |
| **Corte de cena** | `-vf select='gt(scene,0.4)',metadata=print -an -f null -` | cortes SECOS (sem preto nem silêncio) | `pts_time` de cada cena |

> ⚠️ **PEGADINHA CRÍTICA (já confirmada no código):** o `detectBlack()` de hoje
> (`packages/pipeline/src/ffmpeg.mjs`) usa `d=1.0` — pensado pra cue point de
> intervalo comercial (≥1s de preto). **Entre anúncios o preto é curtíssimo
> (0.1–0.4s)**, então com `d=1.0` ele NÃO ACHA NADA. O cortador precisa chamar o
> mesmo helper com **`d≈0.15`** (a assinatura já aceita `{ d, picTh, pixTh }` —
> não precisa reescrever, só chamar com o parâmetro certo). Valor diferente do
> cue point; não reusar o default.

### A fusão (o algoritmo)

1. Junta todos os candidatos (timestamp + sinal de origem) numa lista.
2. **Clusteriza** candidatos dentro de uma janela `W ≈ 0.5s` num único limite;
   guarda **quais sinais** contribuíram → `confianca` = nº de sinais distintos
   (peso extra quando **preto ∩ silêncio** coincidem — o padrão típico de troca
   de comercial).
3. Ordena os limites por tempo. Os **segmentos** são os intervalos entre limites
   consecutivos (mais o começo `0` e o fim `D`).

### Pós-processo (limpeza — onde os cortes falsos morrem)

- **Merge de trecho curto:** segmento < `MIN_AD` (~5–8s) é quase sempre um corte
  falso DENTRO de um anúncio (fade/pausa dramática) → funde no vizinho de
  **limite mais fraco** (menor confiança).
- **Flag de trecho longo:** segmento > `MAX_AD` (~90–120s) → marca "pode ser
  mais de um anúncio" pra divisão manual.
- **Apara a borda:** tira preto/silêncio das pontas de cada trecho (o clip começa
  no conteúdo, não no gap).
- **Marca as bordas:** primeiro e último segmento → `borda: true` ("provável
  vinheta/intro do canal") — candidatos a descarte, **nunca ingeridos no
  automático**.
- **Thumbnail:** 1 frame ~1s dentro de cada trecho (`-ss <start+1> -i comp -frames:v
  1 -vf scale=240:-1`) → base64 no JSON de revisão (ou objeto pequeno no R2).

**Saída:** `cortes = [{ i, start, end, dur, confianca, sinais:['preto','silencio'],
thumb, borda, aviso }]`.

## Modelo de dados (espelha `playlist_ingests`)

```sql
CREATE TABLE IF NOT EXISTS comercial_cuts (
  id          TEXT PRIMARY KEY,            -- cc_<hex>
  source_url  TEXT,                        -- link do compilado (ou NULL se upload)
  staging_key TEXT,                        -- o compilado baixado, no R2
  canais      TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'baixando'
              CHECK (status IN ('baixando','analisando','revisar','confirmado','error')),
  cortes      TEXT,                        -- JSON dos cortes propostos (com thumb)
  error       TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_comercial_cuts_status ON comercial_cuts (status, created_at);

-- Um job pode ser "corte um trecho do staging" (espelha o source_urls da playlist)
ALTER TABLE ingest_jobs ADD COLUMN corte TEXT;  -- JSON {start,end} · presente = fatiar
-- ATENÇÃO: ALTER ADD COLUMN não é idempotente — aplicar 1x local, 1x remoto.
```

`corte` presente no job = a fábrica lê o `staging_key`, extrai `[start,end]` e
manda o trecho pro pipeline. Ausente = job normal (como hoje). O `staging_key`
já existe em `ingest_jobs`; o `corte` é a única coluna nova.

## Endpoints no Worker (espelham os de `/playlist` em `admin.ts`)

- `POST /admin/comerciais` — cola o link/marca upload → cria `comercial_cuts`
  (status `baixando`) → `dispatchFabrica`.
- `POST /admin/comerciais/claim` — a fábrica reivindica (self-heal de preso, igual
  playlist).
- `POST /admin/comerciais/:id/cortes` — a fábrica devolve os cortes detectados →
  status `revisar`.
- `POST /admin/comerciais/:id/error`.
- `GET  /admin/comerciais` — lista pro painel.
- `POST /admin/comerciais/:id/confirmar` — o operador manda os cortes FINAIS (já
  ajustados: juntados/divididos/aparados/nomeados) → cria 1 `ingest_job`
  (`tipo=comercial`, `staging_key`, `corte={start,end}`) por trecho mantido.

## Fábrica (`scripts/factory-local.mjs`)

- **`tickComercial()`** (como `tickPlaylist()`): claim → baixa o compilado
  (`baixarUrl`, reusa cookies/Deno) → sobe pro staging → roda o **módulo novo de
  detecção** → `POST /comerciais/:id/cortes`. Prioridade alta na fila `tick()`
  (rápido, só detecta — destrava a revisão antes dos cortes pesados), igual a
  análise de playlist.
- **`processJob()`**: se `job.corte` existe → baixa o `staging_key` do R2, extrai
  `[start,end]` pra um arquivo temp e roda o `cli.mjs ingest` de sempre com
  `--tipo comercial --id <job.id>`. (Ler o compilado ~40MB do R2 uma vez por
  anúncio é barato; alternativa de otimização abaixo.)

## Pipeline (`packages/pipeline/src/ffmpeg.mjs`)

Helpers novos (o `detectBlack` já serve, só chamar com `d=0.15`):
- `detectSilence(file, { noise=-30, d=0.3 })` → `[{start,end}]`.
- `detectScene(file, { th=0.4 })` → `[t, …]`.
- `proponhaCortes(file, duration, opts)` → **a fusão + pós-processo** (o núcleo).
- `extraiTrecho(file, start, end, out)` → `-ss <start> -i file -to <dur>` com seek
  preciso (re-encode; o pipeline re-encoda de novo, então precisão > velocidade).
- `thumbnail(file, t, out)`.

## UI de revisão (`apps/web/src/admin/AdminApp.vue`)

Aba **✂️ Comerciais**: colar link → analisar → lista de cortes propostos como
**cards**: `thumbnail`, `start–end`, `duração`, badges dos **sinais** (⬛ preto /
🔇 silêncio / ✂️ cena) e da `confiança`. Ações por card: **juntar** com o
vizinho, **dividir** (input de timestamp), **aparar** início/fim, **descartar**,
**nomear**. Botão "confirmar os N comerciais". Trechos `borda` já vêm
**desmarcados** por padrão (candidatos a lixo).

## Precauções / pegadinhas (o Gabriel perguntou explicitamente)

1. **Preto curto** — `blackdetect d≈0.15`, senão não detecta NADA entre anúncios
   (a pegadinha nº 1, já confirmada no código).
2. **Corte falso dentro do anúncio** — fade/pausa no meio vira limite fantasma →
   o merge por `MIN_AD` mata. Um comercial vive em ~10–60s.
3. **Compilado sem preto nem silêncio** (corte seco) — por isso o sinal de
   **cena** existe; e se nada casar, o operador corta na mão na revisão.
4. **Corte frame-accurate** — `-c copy` gruda no keyframe e pode vazar pedaço do
   anúncio vizinho. Como o pipeline re-encoda cada trecho, extraia com seek
   preciso (`-ss` DEPOIS do `-i`) — **a regra dos 10s continua intacta**: cada
   trecho é padado pra múltiplo de 10 individualmente; o corte em si é timestamp
   livre.
5. **Lixo de borda** — 1º/último trecho = vinheta/intro do canal do YouTube;
   `borda: true`, nunca ingerido no automático.
6. **Nomear** — cada anúncio sai transcrito (whisper) → LLM sugere nome; o que
   não der, cai na "A nomear" (11c). Nunca ingerir comercial com id genérico
   calado (regra da casa).
7. **SSRF / download** — o endpoint recebe URL de terceiro. Validar `http(s)` +
   host de vídeo conhecido; **o download roda no GitHub Actions isolado** (não no
   Worker), mesma postura da ingestão por link — a URL não vira `fetch` do
   servidor de dentro da rede.
8. **Custo de runner** — 1 compilado de 4min ≈ 6–10 comerciais = 6–10 passadas
   de pipeline. Cabe no free tier (2000min/mês), mas é um lote; **teto/aviso** de
   quantos por vez, e **logar** o que ficou de fora (nada de corte silencioso).
9. **Idempotência** — reanalisar o mesmo compilado não deve duplicar; o registro
   `comercial_cuts` é o ciclo (igual `playlist_ingests`). Confirmar 2× o mesmo
   corte reusa o mesmo id de mídia (`INSERT OR REPLACE`).

## Decisões abertas (pro Gabriel confirmar ao implementar)

1. **Thresholds:** `MIN_AD` (5–8s?), `MAX_AD` (90–120s?), `silencedetect` noise
   floor (-30dB?), janela de fusão `W` (0.5s?).
2. **Um job por anúncio** (recomendado — cabe no "1 job = 1 mídia" da fila, com
   progresso/retry/self-heal de graça) **vs.** um único "job de corte" que baixa
   1× e faz os N cortes (baixa menos, mas quebra o modelo da fila). Começar com o
   primeiro.
3. **Thumbnails**: base64 no JSON (simples, some com a revisão) vs objeto pequeno
   no R2 (persistente). Começar com base64.
4. **Auto-descartar bordas** vs só desmarcar por padrão. (Spec propõe desmarcar.)

## Esforço estimado

- Migration (`comercial_cuts` + `ingest_jobs.corte`): **pequeno**.
- Motor de detecção (3 sinais + fusão + pós-processo + thumbnails): **médio** — é
  o trabalho novo de verdade; merece testes com compilados reais variados.
- Worker (endpoints espelhando os de playlist): **médio**.
- Fábrica (`tickComercial` + o ramo de corte no `processJob`): **médio**.
- UI de revisão de cortes (cards + juntar/dividir/aparar/descartar/nomear):
  **médio**.
- Teste e2e (`verify-cortador`): um compilado sintético com N clipes separados
  por preto+silêncio → detecta N-1 limites → confirma → N comerciais no catálogo.

## Reaproveita (quase tudo já existe)

- `detectBlack()` (só re-tunar `d`) — pronto; + `detectSilence`/`detectScene` novos.
- Download por link + cookies self-service + Deno (11d) — pronto.
- Staging no R2 (uploads/11b) — pronto.
- Pipeline normaliza/segmenta/transcreve/registra — pronto (recebe cada clip).
- Transcrição de comercial → promessa (fase 12) + "A nomear" (11c) — prontos.
- Esqueleto `analisar → revisar → confirmar` + aba no admin (playlist) — o molde.
- Fila `ingest_jobs` com progresso %, retry ↻ e self-heal de job preso — de graça.
