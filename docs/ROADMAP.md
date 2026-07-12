# Roadmap da Biel TV

> Para onde estamos indo (atualizado em 2026-07-12).

## ✅ Fases concluídas

| Fase | O quê | Quando | Prova |
|---|---|---|---|
| **1 — Núcleo** | Worker `/live`/`/epg`: janela deslizante, MEDIA-SEQUENCE global, DISCONTINUITY(-SEQUENCE), PDT | 2026-07-11 | 13/13 checks (`pnpm verify:stream`) |
| **2 — Pipeline** | CLI de ingestão: normaliza → pad → segmenta → blackdetect → R2 → D1; `--target remote` pronto | 2026-07-11 | 11/11 (`pnpm verify:pipeline`) |
| **3 — Frontend** | Vue 3 + hls.js: player ao vivo, AGORA/INTERVALO/A SEGUIR, grade com merge | 2026-07-11 | 11/11 em Chromium headless (`pnpm verify:web`) |
| **4a — Montador determinístico** | Grade com ritmo de TV (vinheta → programa c/ breaks nos cues → comercial em rodízio), append-only | 2026-07-12 | rodando no canal `bieltv_1` |
| **5a — Admin local-first** | Upload no navegador c/ sugestão automática, fila, fábrica local, catálogo | 2026-07-12 | 11/11 (`pnpm verify:admin`); conteúdo real do Gabriel no ar |
| **9 — Diretor determinístico + canais** | Canais Jetix/CN/Disney c/ identidade editável; agendador no cron do Worker (48h por canal, rotação `last_played_at`, pods ~120s, shuffle c/ seed); mídia→canal no upload/catálogo; multi-canal no front c/ branding; reconciliação R2↔D1 auto-curativa; flag Modo God no admin | 2026-07-12 | 17/17 (`pnpm verify:canais`) + suítes antigas verdes (66 checks) |
| **10b — Chat do Diretor (Modo God)** | Chat real com IA por canal (Gemini 3.5 Flash → DeepSeek em cota/erro → aviso): exclusões com prazo, maratonas materializadas na grade, cancelamentos; snap de id + backstops determinísticos de datas + rodada de reparo; "ordens em vigor" com cancelar no painel | 2026-07-12 | 11/11 (`pnpm verify:diretor`, com LLM real) + smoke em produção |
| **11a — Upload em lote/pasta** | Múltiplos arquivos ou pasta inteira no admin; série+episódio deduzidos ("pwr rangers/001.mp4" → `ep_pwr_rangers_e01`); envio sequencial pra fila | 2026-07-12 | e2e Playwright (pasta real → 3 jobs na fila) |
| **10b.1 — Exclusão de série inteira** | Ação `excluir_serie` no chat do Diretor (uma ordem tira todos os episódios de uma série agrupada); endpoint pra agrupar mídia numa série retroativamente + editor no catálogo; `cancelar_exclusao` resolve diretriz de série OU exclusões individuais dos episódios (o LLM às vezes enumera em vez de usar a ação de série — o cancelamento cobre os dois formatos) | 2026-07-12 | 16/16 (`pnpm verify:diretor`) + smoke test real em produção (5 comerciais do Power Rangers, agrupados como série `pwr_rangers`, excluídos e restaurados) |

## ▶ Fases restantes

### ~~Fase 6~~ ✅ CONCLUÍDA em 2026-07-12 — https://github.com/gabrielBielll/biel-tv (privado)

### ~~Fase 7~~ ✅ CONCLUÍDA em 2026-07-12 — A TV ESTÁ NO AR
- **Site:** https://biel-tv.pages.dev (Cloudflare Pages)
- **API/Worker:** https://biel-tv-stream.biel-cesa95.workers.dev (D1 + R2 + cron 06:00 UTC)
- **Repo:** https://github.com/gabrielBielll/biel-tv (privado)
- D1 `biel-tv-db` (4 migrations + catálogo), R2 `biel-tv-media` (133 segmentos),
  3 secrets (ADMIN_TOKEN forte, GEMINI, DEEPSEEK), `ALLOW_TIME_TRAVEL=0`,
  alerta de gasto US$1 configurado. Verificado e2e em navegador na URL pública.
- **Pendência de otimização** (não urgente): segmentos servidos via rota
  `/media/*` do Worker (base_url=''), o que gasta invocações do Worker. Quando
  Gabriel tiver domínio próprio → bucket público + custom domain tira isso do
  Worker. Pro uso pessoal atual, o free tier (100k req/dia) sobra.

### Fase 8 — Fábrica no GitHub Actions
**Objetivo:** transcodificação de graça e a EC2 virar só máquina de dev (desligável).
**Entregáveis:** workflow com ffmpeg + whisper-ready rodando o mesmo pipeline;
Worker dispara a Action via `repository_dispatch` quando entra job na fila;
secrets R2/D1 no repo. Depende de: fases 6 e 7.

### ~~Fase 9~~ ✅ CONCLUÍDA em 2026-07-12 (ver tabela acima)
Pendência levada pra fase 10: regras da `channel_master_grid` (blocos fixos por
dia/horário) entram junto com o planejamento editorial — hoje o agendador usa
rotação + pods; as regras fixas fazem mais sentido quando o Diretor IA as gerar.

### Fase 10 — Diretor IA (Gemini) — 10b (chat) ✅ FEITA; faltam 10a e 10c
**Objetivo:** cada canal parecer ter o diretor de programação do canal original.
**Spec completa:** [features/diretor-ia.md](features/diretor-ia.md).
**Entregáveis:** planejamento noturno por canal via **Gemini** (free tier ⇒ custo
zero; JSON garantido via `responseSchema`) com prompt de identidade imitando a
programação original; validação + compilação determinística + fallback (a fase 9
segura a grade se o LLM falhar); **Votaton** no front (pedidos de programação SEM
garantia, com votação simulada, pity timer e celebração da conquista — recompensa
variável de propósito); **Modo God escondido** (flag `god_mode` + easter egg no
admin): chat direto com ações garantidas → tabela `directives` → replan append-only.

### Fase 11 — Admin v2 (ingestão inteligente) — 11a (lote/pasta) ✅ FEITA; falta o resto
**Objetivo:** upar qualquer coisa e o sistema entender sozinho.
**Entregáveis restantes:** classificação por LLM (nome sujo → título/série/episódio +
confiança, hoje é heurística); fila `needs_review`; TMDB (título oficial, sinopse,
**poster** → EPG rico); multipart presigned pro R2 (arquivos grandes sem passar
pelo Worker — hoje o upload bufferiza no Worker, limitado pelo tamanho de request).

### Fase 12 — Comerciais condicionais ("promessas")
**Objetivo:** promos de sequência/horário/maratona só irem ao ar quando a grade cumpre.
**Spec completa:** [features/comerciais-condicionais.md](features/comerciais-condicionais.md).
Interna em 3 etapas: modelo+matching manual → captação por transcrição (whisper+LLM
+confirmação humana) → programação guiada por promo. Depende de: fases 9 e 11 (series_id canônico).

## 📦 Backlog (sem fase definida)

- **Mídia placeholder** — segmento de fallback pra buraco de EPG (hoje o slot some).
- **Sharding multi-conta R2 (30GB grátis)** — 1 domínio por conta OU mini-Worker por
  conta via workers.dev (custom domain exige zona na mesma conta).
- **Auth real no admin** — Cloudflare Access ou login, no lugar do token único.
- **Observabilidade** — analytics do Worker; alerta de "grade vai acabar em X horas".
- **Player** — code-split do hls.js (~590KB) e UI de erro com retry.
- **Northflank (2 serviços free)** — reserva p/ algum serviço 24/7 fora de Worker, se surgir.
