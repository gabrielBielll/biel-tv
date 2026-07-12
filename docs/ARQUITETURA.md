# Arquitetura da Biel TV

> Onde estamos (2026-07-12). O que cada peça faz e por quê.
> Pegadinhas conhecidas: [GOTCHAS.md](GOTCHAS.md). Roadmap: [ROADMAP.md](ROADMAP.md).

**No ar:** https://biel-tv.pages.dev (site) · https://biel-tv-stream.biel-cesa95.workers.dev
(API) · https://github.com/gabrielBielll/biel-tv (repo, privado).

## A ideia central

TV linear 24/7 **sem nenhum servidor de vídeo**: todo conteúdo é pré-transcodificado
uma única vez em segmentos `.ts` de exatamente 10s, e "transmitir" é matemática de
relógio — um Worker gera a playlist HLS ao vivo calculando qual segmento de qual
mídia cobre cada slot de 10s do tempo real, segundo a grade (`epg_virtual`).

```
 ingestão (ffmpeg, 1x por vídeo)          tempo real (por espectador)
┌──────────────────────────────┐      ┌─────────────────────────────────┐
│ vídeo → normaliza → segmenta │      │ player poll /live a cada ~10s   │
│  → cue points → R2 + D1      │      │ Worker: relógio+EPG → m3u8      │
└──────────────────────────────┘      │ segmentos direto do R2 (CDN)    │
        escreve o catálogo            └─────────────────────────────────┘
                 ↑                                   ↑ só LÊ
        Diretor (scheduler) escreve a grade em epg_virtual
```

Três cérebros, um contrato:
- **Operador** (`apps/stream`, Worker): burro, rápido, só lê `epg_virtual`. Nunca decide nada.
- **Diretor determinístico** (`apps/stream/src/scheduler.ts`, cron diário + sob demanda):
  esperto mas sem IA — rotação, pods de intervalo, respeita diretrizes/eventos, só
  escreve `epg_virtual`. Mantém a grade sozinho mesmo sem nenhum LLM.
- **Diretor IA** (`apps/stream/src/diretor.ts`, chat do Modo God): conversa em
  português, decide via Gemini→DeepSeek, mas **nunca** escreve SQL — emite ações
  tipadas que o código valida e executa (`directives`/`channel_events`), e quem de
  fato altera a grade continua sendo o Diretor determinístico. Falta o cron
  editorial automático (fase 10a) e o Votaton (10c) — ver [ROADMAP.md](ROADMAP.md).

## Peças

| Peça | O quê | Onde |
|---|---|---|
| `apps/stream` | Worker Hono: `/live/:canal`, `/epg/:canal`, `/channels`, `/media/*`, `/health`, `/admin/*` (API do painel + Diretor IA), cron diário (reconciliação + agendador) | Cloudflare Workers (produção) |
| `apps/stream/src/scheduler.ts` | Diretor determinístico: grade de 48h por canal, rotação por `last_played_at`, pods de intervalo, respeita diretrizes/eventos ativos, reconciliação R2↔D1 | idem |
| `apps/stream/src/diretor.ts` | Diretor IA: chat do Modo God (Gemini→DeepSeek→fallback), ações `excluir_media`/`excluir_serie`/`maratona`/`cancelar_exclusao`/`replan` | idem |
| `apps/web` | Vue 3 + hls.js: player multi-canal, AGORA/INTERVALO/A SEGUIR, grade; `/admin.html`: upload (individual/lote/pasta), fila, catálogo, Modo God | Cloudflare Pages (produção) |
| `packages/db` | Migrations SQL + tipos/SQL compartilhados | D1 (SQLite, produção + simulado local) |
| `packages/pipeline` | CLI: probe → normaliza → segmenta → blackdetect → upload → registra (`--target local\|remote`) | roda onde tiver ffmpeg |
| `scripts/factory-local.mjs` | Fábrica: drena `ingest_jobs` via `/admin`, roda o pipeline (com progresso % pro painel), re-gera a grade | **GitHub Actions** (workflow `fabrica`, acordado por dispatch do Worker; `FACTORY_DRAIN=1`); EC2 = fallback manual/dev |
| `scripts/seed-epg.mjs` | Atalho fino: só chama `POST /admin/schedule/run` no Worker | idem |
| `scripts/_lib.mjs` | `fetchRetry()` compartilhado pelos scripts de verificação | dev |

## Tabelas (D1)

- `media_items` — catálogo: tipo, duração, `segment_count`, `base_url` ('' = mesma origem),
  `path_prefix`, metadata JSON (inclui `series_id` opcional), status (`ready`/`disabled`/`ingesting`).
- `media_cue_points` — onde PODE haver break (blackdetect ou manual), múltiplos de 10s.
- `media_channels` — a quais canais cada mídia pertence (N:N).
- `channels` — canais nostálgicos (Jetix, Cartoon Network, Disney Channel…), com
  `identidade` (prompt editorial, editável no Modo God) e `break_target_seg`.
- `epg_virtual` — a grade. Linha = (canal, media_id, start, end, `segment_index_start`).
  Comercial no meio de episódio = 3 linhas (parte 1, comercial, parte 2 com salto de índice).
- `directives` — ordens do Diretor IA com vigência: `excluir_media`/`excluir_serie`
  (payload `{media_id}` ou `{series_id}`), status `ativa`/`cancelada`.
- `channel_events` — maratonas agendadas (`media_id`, `start_at`, `end_at`); status
  `agendado`/`cancelado`. Um evento ativo **sempre vence** uma diretriz de exclusão.
- `channel_master_grid` — regras fixas por canal/horário (insumo da fase 10a; ainda vazia).
- `ingest_jobs` — fila do admin (queued → processing → done/error), com `canais` e `series_id`.
- `config` — chave-valor (inclui a flag `god_mode`).

## Regras de ouro (invariantes)

1. **Todo tempo é múltiplo de 10s.** Segmentos duram 10.000s exatos
   (`-force_key_frames "expr:gte(t,n_forced*10)"` + duração padded com preto/silêncio);
   grade só corta em fronteira de segmento; cue points arredondados.
2. **Perfil único de mídia**: 1280x720 letterbox, 30fps, H.264 high CRF 23, AAC 128k
   48kHz stereo (silêncio injetado se a fonte não tem áudio). Descontinuidade entre
   perfis diferentes engasga player (Safari nativo principalmente).
3. **Playlist é função pura de (relógio, EPG)** — todos os espectadores recebem a mesma
   resposta (sincronia de TV de verdade + cacheável). `MEDIA-SEQUENCE` = slot global
   (`floor(unix/10)`); `DISCONTINUITY-SEQUENCE` = id da linha do EPG do 1º segmento
   (exige inserção cronológica das linhas — contrato do Diretor).
4. **Grade é append-only em produção**: re-gerar nunca toca no bloco que está no ar.
5. **Janela**: 4 slots atrás + atual + 1 futuro (segmentos futuros já existem).
   Delay percebido ~15s (decisão do Gabriel, 2026-07-12).
6. **LLM decide, código calcula.** O Diretor IA nunca grava na `epg_virtual`
   diretamente — emite ações tipadas em JSON garantido (`responseSchema`/
   `response_format`), o código valida contra o catálogo real e só então
   executa. Fallback determinístico sempre disponível: a TV nunca depende do
   LLM pra continuar no ar.
7. **Evento explícito vence regra geral.** Uma maratona agendada (`channel_events`)
   continua escalando sua mídia mesmo que ela esteja sob uma diretriz de
   exclusão ativa — uma ordem específica do chat pesa mais que uma exclusão
   genérica. Decisão de design, não bug (documentado em GOTCHAS.md).

## Decisões tomadas (e porquês)

| Decisão | Porquê |
|---|---|
| Worker (Hono) em vez de Nest.js no streaming | `/live` não pode dormir e é ~300 linhas de função pura; hospedagem Node grátis hiberna; Workers free = 100k req/dia. Nest fica p/ admin futuro se quiser. |
| D1 + SQL puro (sem ORM por ora) | 2 consultas no hot path; Drizzle entra se o schema crescer. |
| CRF 23 / preset veryfast | Portado do my-tv (normalization_worker); bom custo/qualidade p/ 720p. |
| Fábrica de transcodificação = GitHub Actions | ffmpeg não roda em Worker; EC2 é cara e vira só dev; GH free = 2000 min/mês, runner 2-core. Worker pode disparar via `repository_dispatch`. |
| Infra provisionada via wrangler (sem Terraform) | wrangler cria/deploya D1, R2, Worker, secrets; `wrangler.toml` versionado = infra as code. Falta só o API Token do Gabriel. |
| MVP com 1 conta R2 | Custom domain de bucket exige a zona DNS na MESMA conta (free não tem zona de subdomínio) → 3 contas = 3 domínios ou mini-Worker por conta. Shard depois. `r2.dev` é rate-limited: nunca usar p/ vídeo. |
| Upload do admin: sessões multipart retomáveis via Worker | Sessão no D1 antes do 1º byte; partes fixas de 10 MiB pro R2 (binding), retomada pós-reload por fingerprint, `complete` idempotente (`apps/stream/src/uploads.ts`). URL pré-assinada (parte direto no R2, sem passar pelo Worker) fica como evolução junto com o domínio próprio. |
| LLM do Diretor: Gemini 3.5 Flash → DeepSeek v4-flash | Free tier do Gemini ⇒ custo zero; DeepSeek como fallback de cota/erro (créditos do Gabriel). `responseSchema`/`response_format` garantem JSON válido nos dois. |
| Cancelamento robusto a formato, não o prompt perfeito | O LLM às vezes enumera `excluir_media` em vez de emitir um `excluir_serie` só; em vez de tentar 100% de aderência via prompt, o cancelamento entende os dois formatos (ver GOTCHAS.md). |
| **Comerciais 100% fidedignos** (decisão do Gabriel, 2026-07-12) | A experiência é REAL: promo só vai ao ar se a promessa é cumprida — inclusive nada de promos de outras temporadas do mesmo desenho (confunde). Promo não-verificável = fora do rodízio (`ignorar`), sem exceção de "charme nostálgico". Comercial de PRODUTO de época (brinquedo, comida) é fidedigno por natureza — é o pool genérico ideal. |

## Ambiente

**Produção:** Worker + Pages + D1 + R2 na Cloudflare (conta `biel-cesa95`), tudo
provisionado via `wrangler` (sem Terraform — o `wrangler.toml` versionado já é a
infra as code). Fábrica de transcodificação: **GitHub Actions** (workflow
`fabrica` — o Worker dispara via `repository_dispatch` quando entra job; cron
diário re-dispara se sobrar fila; ver GOTCHAS.md pro fallback manual). Deploy:
`docs/../README.md` tem os comandos exatos.

**Dev local (EC2 atual):**
- `pnpm dev` → Worker em `127.0.0.1:8787` · vite em `100.76.123.18:5173` (IP Tailscale;
  acesso direto do navegador do Gabriel, sem túnel) · `pnpm factory` → fábrica local
  (aponta pro Worker local — **não** processa a fila de produção; ver GOTCHAS.md).
- Admin: `/admin.html`, token dev `bieltv-dev-2026` (produção: secret real, gerado
  no deploy — token fica só no scratchpad da sessão que fez o deploy).
- Verificações e2e: `pnpm verify:stream` (13), `verify:pipeline` (11), `verify:web` (13,
  Chromium headless assiste TV), `verify:admin` (11-12, Chromium usa o painel de
  verdade), `verify:canais` (18, pureza de canal + reconciliação real com R2),
  `verify:diretor` (16, chamadas REAIS ao LLM — exclusão/série/maratona/cancelamento).
- ffmpeg estático (BtbN) em `~/.local/bin`. Debug de tempo: `?at=<unix>` (`ALLOW_TIME_TRAVEL`,
  `"0"` em produção).
- Git: identidade local `gabriell b <gabrielbarbosa.ff@gmail.com>`; push desta pasta
  autentica como `gabrielBielll` (`credential.https://github.com.username` local —
  outros repos seguem o global, `jmmasterdev`).
