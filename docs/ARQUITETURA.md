# Arquitetura da Biel TV

> Onde estamos (2026-07-12). O que cada peça faz e por quê.

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

Dois cérebros, um contrato:
- **Operador** (`apps/stream`, Worker): burro, rápido, só lê `epg_virtual`. Nunca decide nada.
- **Diretor** (scheduler; hoje `scripts/seed-epg.mjs`, futuro cron + IA): lento, esperto,
  só escreve `epg_virtual`. Toda inteligência de programação mora aqui.

## Peças

| Peça | O quê | Onde |
|---|---|---|
| `apps/stream` | Worker Hono: `/live/:canal` (m3u8), `/epg/:canal`, `/media/*` (R2), `/health`, `/admin/*` (API do painel), cron stub do Diretor | Cloudflare Workers (hoje: wrangler dev local) |
| `apps/web` | Vue 3 + hls.js: player, AGORA/INTERVALO/A SEGUIR, grade; `/admin.html`: upload + fila + catálogo | Cloudflare Pages (hoje: vite dev) |
| `packages/db` | Migrations SQL + tipos/SQL compartilhados | D1 (SQLite) |
| `packages/pipeline` | CLI: probe → normaliza → segmenta → blackdetect → upload → registra (`--target local\|remote`) | roda onde tiver ffmpeg |
| `scripts/factory-local.mjs` | Fábrica: drena a fila `ingest_jobs` via API `/admin`, roda o pipeline, re-gera a grade | EC2 hoje; GitHub Actions no futuro |
| `scripts/seed-epg.mjs` | Montador de grade determinístico (embrião do Diretor) | idem |

## Tabelas (D1)

- `media_items` — catálogo: tipo, duração, `segment_count`, `base_url` ('' = mesma origem),
  `path_prefix`, metadata JSON, status (`ready`/`disabled`/`ingesting`).
- `media_cue_points` — onde PODE haver break (blackdetect ou manual), múltiplos de 10s.
- `epg_virtual` — a grade. Linha = (canal, media_id, start, end, `segment_index_start`).
  Comercial no meio de episódio = 3 linhas (parte 1, comercial, parte 2 com salto de índice).
- `channel_master_grid` — regras fixas por canal/horário (insumo do Diretor; ainda vazia).
- `ingest_jobs` — fila do admin (queued → processing → done/error).
- `config` — chave-valor.

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

## Decisões tomadas (e porquês)

| Decisão | Porquê |
|---|---|
| Worker (Hono) em vez de Nest.js no streaming | `/live` não pode dormir e é ~300 linhas de função pura; hospedagem Node grátis hiberna; Workers free = 100k req/dia. Nest fica p/ admin futuro se quiser. |
| D1 + SQL puro (sem ORM por ora) | 2 consultas no hot path; Drizzle entra se o schema crescer. |
| CRF 23 / preset veryfast | Portado do my-tv (normalization_worker); bom custo/qualidade p/ 720p. |
| Fábrica de transcodificação = GitHub Actions | ffmpeg não roda em Worker; EC2 é cara e vira só dev; GH free = 2000 min/mês, runner 2-core. Worker pode disparar via `repository_dispatch`. |
| Infra provisionada via wrangler (sem Terraform) | wrangler cria/deploya D1, R2, Worker, secrets; `wrangler.toml` versionado = infra as code. Falta só o API Token do Gabriel. |
| MVP com 1 conta R2 | Custom domain de bucket exige a zona DNS na MESMA conta (free não tem zona de subdomínio) → 3 contas = 3 domínios ou mini-Worker por conta. Shard depois. `r2.dev` é rate-limited: nunca usar p/ vídeo. |
| Upload do admin bufferizado no Worker | MVP local. Em produção: multipart direto no R2 via URL pré-assinada (limite de body do Worker). |

## Ambiente de dev (EC2 atual)

- `pnpm dev` → Worker em `127.0.0.1:8787` · vite em `100.76.123.18:5173` (IP Tailscale;
  acesso direto do navegador do Gabriel, sem túnel) · `pnpm factory` → fábrica de olho na fila.
- Admin: `/admin.html`, token dev `bieltv-dev-2026` (produção: `wrangler secret put ADMIN_TOKEN`).
- Verificações e2e: `pnpm verify:stream` (13 checks), `verify:pipeline` (11), `verify:web` (11,
  Chromium headless assiste TV), `verify:admin` (11, Chromium usa o painel de verdade).
- ffmpeg estático (BtbN) em `~/.local/bin`. Debug de tempo: `?at=<unix>` (`ALLOW_TIME_TRAVEL`).
- Git: identidade local `gabriell b <gabrielbarbosa.ff@gmail.com>`; push exige `gh auth login`
  dessa conta (gh atual: jmmasterdev).
