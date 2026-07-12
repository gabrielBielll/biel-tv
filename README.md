# Biel TV

> 📚 **Onde estamos e pra onde vamos:** [docs/ARQUITETURA.md](docs/ARQUITETURA.md) ·
> [docs/ROADMAP.md](docs/ROADMAP.md) · specs de features em [docs/features/](docs/features/)

Canal de TV linear 24/7, 100% serverless: os vídeos são pré-segmentados em `.ts` de 10s
(R2), e um Cloudflare Worker gera a playlist HLS "ao vivo" por matemática de relógio a
partir da grade (`epg_virtual` no D1). Um "Diretor de programação" (IA via cron) escreve
a grade; o Worker só lê. Reescrita cloud-native do `my-tv/` (versão anterior, Python).

## Estrutura

| Pacote | O quê |
|---|---|
| `apps/stream` | Worker (Hono): `/live/:canal`, `/epg/:canal`, `/health`, `/media/*` + cron do Diretor |
| `packages/db` | Schema D1 (migrations SQL) + tipos/SQL compartilhados |
| `scripts/` | Fase 1: mídia de teste, seed do EPG local, verificação e2e |
| `apps/web` | Frontend Vue 3 + Vite + hls.js: player ao vivo, AGORA/A SEGUIR, grade 24h |
| `packages/pipeline` | CLI de ingestão: normaliza → segmenta → cue points → R2 → D1 |

## Rodando local (fase 1)

```bash
pnpm install
pnpm db:migrate:local   # cria as tabelas no D1 simulado
pnpm media:test         # gera episódio (120s) + comercial (20s) segmentados, com ffmpeg
pnpm media:put:local    # sobe os .ts para o R2 simulado
pnpm seed:local         # preenche ~3h de grade no canal bieltv_1
pnpm dev                # wrangler dev em http://127.0.0.1:8787
pnpm verify:stream      # (noutro terminal) checagens e2e da playlist ao vivo
```

Assistir: `ffplay http://127.0.0.1:8787/live/bieltv_1` ou hls.js apontando pra mesma URL.
Debug: `?at=<unix>` viaja no tempo (var `ALLOW_TIME_TRAVEL`, só em dev).

## Ingerindo mídia de verdade (fase 2)

```bash
pnpm ingest ./PowerRangers_S01E01.mkv \
  --id ep_pr_s1e01 --tipo episodio --title "Power Rangers S1E01" \
  --series pr_s1 --episode 1 --tags acao,anos90
```

O CLI normaliza pro perfil único (720p H.264 CRF 23 + AAC 128k 48kHz stereo — mesmos
parâmetros do my-tv), força keyframes na grade de 10s, faz padding do final com
preto/silêncio até fechar múltiplo de 10, corta os `.ts`, detecta intervalos por tela
preta (`blackdetect d=1.0`, cue arredondado pra grade) e registra tudo.

- `--target local` (padrão): R2 simulado + D1 local — pra desenvolver.
- `--target remote --base-url https://media1.seudominio.com`: R2 real via API S3
  (exporte `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
  [, `R2_BUCKET`]) + D1 remoto via wrangler.
- `pnpm verify:pipeline` roda o teste e2e: fabrica um vídeo fora do padrão (47s,
  360p/25fps/mono, preto no meio), ingere e confere normalização, padding, cue point
  e reprodução no `/live`.

## Painel admin (fase 5, local-first)

`/admin.html` — upload de mídia pelo navegador, com sugestão automática de
tipo/título/id (heurística por duração + nome; camada LLM entra depois), fila de
processamento e catálogo com ativar/desativar. Protegido por `ADMIN_TOKEN`
(dev: `bieltv-dev-2026` no wrangler.toml; produção: `wrangler secret put ADMIN_TOKEN`).

O processamento é feito pela **fábrica** (`pnpm factory`): ela faz poll da fila
(`/admin/jobs/claim`), baixa do staging (R2), roda o pipeline e re-gera a grade
**sem tocar no bloco que está no ar** (append-only). Em produção, o mesmo papel
será de uma GitHub Action (mesma API) — decisão registrada; a EC2 vira só dev.

`pnpm verify:admin` — e2e completo: Chromium faz upload de um vídeo real pela
tela, confere sugestões, espera a fábrica concluir e valida catálogo + grade.

## Frontend (fase 3)

```bash
pnpm web:dev      # http://localhost:5173 (proxy /live|/epg|/media → worker :8787)
pnpm verify:web   # builda + abre num Chromium headless e confere player/EPG
```

O app junta as partes de um episódio separadas por comercial numa entrada única do
guia (via `segment_index_start`), esconde comerciais da grade, e sincroniza o relógio
com o servidor. Autoplay começa mudo (política dos navegadores) com botão de som.

Deploy: Cloudflare Pages apontando para `apps/web` (`pnpm build`, saída `dist/`).
Se o Worker estiver em outro domínio, defina `VITE_API_BASE=https://…workers.dev`
na build. Os segmentos resolvem sozinhos contra a origem da playlist.

## Regras de ouro do sistema

1. **Todo tempo é múltiplo de 10s** — segmentos duram exatamente 10.000s
   (`-force_key_frames`), e o EPG só corta em fronteira de segmento.
2. **Catálogo em perfil único** — 720p H.264 high + AAC 128k 48kHz stereo; descontinuidade
   entre perfis diferentes engasga player (Safari nativo, principalmente).
3. **O Worker de streaming é burro** — função pura de (relógio, EPG) → m3u8. Toda a
   inteligência (maratonas, comerciais, temas) mora no Diretor, que só escreve `epg_virtual`.

## Deploy (quando chegar a hora)

`wrangler d1 create biel-tv-db` + `wrangler r2 bucket create biel-tv-media`, colar o
`database_id` real no `wrangler.toml`, `wrangler deploy`. Desligar `ALLOW_TIME_TRAVEL`.
