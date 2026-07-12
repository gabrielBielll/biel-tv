# Roadmap da Biel TV

> Para onde estamos indo (atualizado em 2026-07-12).
> Pegadinhas conhecidas (bugs reais + causa + fix): [GOTCHAS.md](GOTCHAS.md) —
> **leia antes de mexer em upload/ingestão** (risco operacional #1 lá).

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
| **Progresso da transcodificação na fila (%)** | Pedido do Gabriel no mesmo dia, entregue no mesmo dia: o ffmpeg emite `-progress`, o pipeline converte em % do job (normalização 0–90, segmentação 92, cues 94, upload 94–99), a fábrica repassa pro Worker a cada 5s e o painel mostra "processando N%" com mini-barra. Claim zera, done fecha em 100 | 2026-07-12 | transcode local real (5%→89% fluindo) + 12/12 (`verify:admin`) |
| **11b — Uploads persistentes/retomáveis + deleção definitiva** | Sessão no D1 ANTES do 1º byte (lote inteiro reservado antes de transmitir); multipart pro R2 em partes fixas com timeout/retry/backoff e cancelamento por item; painel lista uploads interrompidos pós-reload e retoma só as partes ausentes ao reanexar (fingerprint: caminho relativo+nome+tamanho+mtime); `complete` idempotente (repetir nunca duplica job). Zona de perigo: deleção física exige disabled + confirmação digitada `EXCLUIR <id>` + fora da janela do player; apaga só o prefixo exato no R2 e replaneja os canais | 2026-07-12 | 25/25 (`pnpm verify:uploads`, com retomada real no Chromium) + 12/12 (`verify:admin` já no fluxo novo) + smoke em produção (uploads de 1 e 3 partes processados + deleção com todas as recusas) |

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

### 🔴 Fase 8 — Fábrica no GitHub Actions (subiu de prioridade)
**Objetivo:** transcodificação de graça e a EC2 virar só máquina de dev (desligável).
**Por que é urgente agora:** a fábrica de produção hoje é um processo Node manual
nesta EC2 (`FACTORY_TARGET=remote node scripts/factory-local.mjs`) que **não
sobrevive a um reboot e não sobe sozinho** — se ele cair, uploads pelo admin
ficam presos na fila sem erro nenhum (foi exatamente o que aconteceu em
2026-07-12, ver [GOTCHAS.md](GOTCHAS.md)). Enquanto a fase 8 não existir,
**checar se a fábrica está viva é o primeiro passo de qualquer sessão que for
mexer em upload**.
**Entregáveis:** workflow com ffmpeg + whisper-ready rodando o mesmo pipeline
(`--target remote` já pronto e testado em produção); Worker dispara a Action via
`repository_dispatch` quando entra job na fila; secrets R2/D1 no repo.
Depende de: fases 6 e 7 (ambas concluídas — sem bloqueio).

### ~~Fase 9~~ ✅ CONCLUÍDA em 2026-07-12 (ver tabela acima)
Pendência levada pra fase 10: regras da `channel_master_grid` (blocos fixos por
dia/horário) entram junto com o planejamento editorial — hoje o agendador usa
rotação + pods; as regras fixas fazem mais sentido quando o Diretor IA as gerar.

### Fase 10 — Diretor IA (Gemini) — 10b + 10b.1 (chat + exclusão de série) ✅ FEITAS; faltam 10a e 10c
**Objetivo:** cada canal parecer ter o diretor de programação do canal original.
**Spec completa:** [features/diretor-ia.md](features/diretor-ia.md).
**Feito (10b + 10b.1):** chat funcionando em produção com Gemini→DeepSeek→fallback,
excluir mídia/série com prazo, maratona materializada na grade, cancelamento
robusto aos dois formatos que o LLM pode escolher. Ver tabela de fases concluídas.

**Falta:**
- **10a — planejamento noturno automático**: hoje a grade é só rotação +
  intervalos determinísticos (fase 9); falta o cron chamar o Gemini pra decidir
  temas/maratonas sozinho, seguindo a identidade de cada canal (editável no
  Modo God desde a fase 9, mas ainda não consumida por nada automático).
- **10c — Votaton**: pedidos de programação SEM garantia no front da TV (não no
  admin), com votação simulada, pity timer e celebração da conquista —
  recompensa variável de propósito. Zero código ainda; só o chat direto
  (Modo God) existe.

### Fase 11 — Admin v2 (ingestão inteligente) — 11a (lote/pasta) e 11b (retomáveis + deleção) ✅ FEITAS; falta o resto
**Objetivo:** upar qualquer coisa e o sistema entender sozinho.
**11b entregue** (spec e decisões: [features/uploads-resumiveis.md](features/uploads-resumiveis.md)):
sessões multipart retomáveis substituíram o upload monolítico — reload não perde
mais nada e arquivo grande não esbarra no limite de request. O POST /admin/upload
antigo ficou só como compatibilidade temporária.
**Entregáveis restantes:**
- **11c — Classificação por LLM com "contexto do lote" (campo de texto livre)** —
  pedido do Gabriel (2026-07-12): ao subir arquivos de nome obscuro
  ("julyperli 01.mp4"), um campo livre no upload deixa explicar do que se trata
  ("subi 5 episódios da série X, sem especificação nos nomes"). O Gemini recebe
  nomes + caminhos + durações + esse contexto e devolve, POR ARQUIVO, título
  limpo/série/episódio/tipo/canais + grau de confiança (JSON garantido via
  responseSchema, mesmo padrão do chat do Diretor, com fallback DeepSeek).
  Confiança baixa → fila `needs_review` pro operador confirmar antes de ir ao ar.
  Campo opcional: sem texto, a heurística atual continua valendo. O contexto
  fica guardado na sessão de upload (a 11b já criou o lugar natural pra isso).
- TMDB (título oficial, sinopse, **poster** → EPG rico).
- URL pré-assinada pro navegador enviar cada parte DIRETO ao R2 (hoje as partes
  passam pelo Worker via binding — funciona e é retomável, mas gasta invocações;
  presign entra junto com o **domínio próprio**, com CORS restrito ao painel).
  Gabriel vai providenciar o domínio nos próximos dias — quando chegar, o mesmo
  domínio destrava TAMBÉM o bucket público (segmentos fora do Worker, ver fase 7).

### Fase 12 — Comerciais condicionais ("promessas")
**Objetivo:** promos de sequência/horário/maratona só irem ao ar quando a grade cumpre.
**Spec completa:** [features/comerciais-condicionais.md](features/comerciais-condicionais.md).
Interna em 3 etapas: modelo+matching manual → captação por transcrição (whisper+LLM
+confirmação humana) → programação guiada por promo. Pré-requisito (`series_id`
canônico) já existe e está em uso real desde a fase 10b.1 — falta só o resto.

## 📦 Backlog (sem fase definida)

- **Upload: consistência da UI ao anexar durante um envio** — pedido do Gabriel
  (2026-07-12): anexar mais arquivos enquanto um lote sobe SUBSTITUI a lista
  visual (os em andamento continuam subindo por baixo — chegam a aparecer como
  "interrompido" até concluírem sozinhos), e os novos ficam bloqueados até o
  lote atual terminar. Consertos: (a) anexar no meio deve SOMAR ao lote (fila
  única de envio, não substituir), (b) itens em voo continuam visíveis com
  progresso, (c) após terminar, o botão "enviar pra fila" vira "enviado ✓"
  (desabilitado) pra não sugerir reenvio — reenvio hoje é inofensivo (o servidor
  deduplica), mas a UI não deve nem convidar.
- **Mídia placeholder** — segmento de fallback pra buraco de EPG (hoje o slot some).
- **Estender `scripts/_lib.mjs`** — `verify-pipeline.mjs`, `verify-admin.mjs` e
  `verify-stream.mjs` ainda usam `fetch()` cru; migrar pro `fetchRetry`
  compartilhado só quando (se) começarem a apresentar a mesma falha
  intermitente que `verify-diretor.mjs`/`verify-canais.mjs` já tiveram (ver
  [GOTCHAS.md](GOTCHAS.md)) — não vale a pena mexer no que não está quebrado.
- **Sharding multi-conta R2 (30GB grátis)** — 1 domínio por conta OU mini-Worker por
  conta via workers.dev (custom domain exige zona na mesma conta).
- **Auth real no admin** — Cloudflare Access ou login, no lugar do token único.
- **Observabilidade** — analytics do Worker; alerta de "grade vai acabar em X horas".
- **Player** — code-split do hls.js (~590KB) e UI de erro com retry.
- **Northflank (2 serviços free)** — reserva p/ algum serviço 24/7 fora de Worker, se surgir.
