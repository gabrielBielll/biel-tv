# Roadmap da Biel TV

> Para onde estamos indo (atualizado em 2026-07-14).
> Pegadinhas conhecidas (bugs reais + causa + fix): [GOTCHAS.md](GOTCHAS.md).
>
> **Estado em 2026-07-14:** os 3 canais NO AR (Jetix, Cartoon Network, Disney
> Channel — o Disney com os Padrinhos Mágicos e as vinhetas de época no lugar
> certo). ~100 mídias no catálogo. Fábrica autônoma no GitHub Actions.
> **Fases 1–12 concluídas** — só sobram refinamentos (TMDB, presign, blocos
> fixos semanais) e o backlog. As fases originais do projeto estão FEITAS.

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
| **10a — Diretor editorial noturno** | O cron diário (e o botão "🌙 decidir a noite" no Modo God) chama o Gemini com a identidade do canal, as séries disponíveis e o histórico recente; ele decide se hoje tem maratona e de quê — validação 100% determinística (série real, janela 18h–madrugada de 1–4h, sem sobrepor, sem repetir a recente), materializada como evento de SÉRIE (episódios diferentes em sequência, migration 0010). Fecha o ciclo do sonho: a promo tipo "evento" da série (fase 12) roda nos intervalos SÓ na janela de promoção e some quando a maratona começa ou é cancelada. Fluxo guiado de exclusão + botão "reajustar a grade" fora do Modo God entregues junto | 2026-07-12 | 10/10 (`pnpm verify:editorial`, LLM real) + regressão canais 18/18, promessas 10/10, diretor 16/16 |
| **10c — Votaton (o modo telespectador)** | Na página da TV: "Votação do canal" — o espectador vota na maratona que quer, a apuração AO VIVO simula outros telespectadores (teatro determinístico, sem LLM), o desfecho nasce decidido com recompensa variável + pity timer (derrotas seguidas garantem a próxima vitória), e o resultado vira maratona REAL na grade (vencendo o usuário OU "a torcida" — a ilusão nunca quebra). Vitória = celebração em tela cheia + selo "PEDIDO DOS TELESPECTADORES"; cooldown de 4h entre rodadas. Público de propósito (sem token) | 2026-07-12 | 14/14 (`pnpm verify:votaton`) + web 13/13 + canais 18/18 + smoke em produção |
| **Progresso da transcodificação na fila (%)** | Pedido do Gabriel no mesmo dia, entregue no mesmo dia: o ffmpeg emite `-progress`, o pipeline converte em % do job (normalização 0–90, segmentação 92, cues 94, upload 94–99), a fábrica repassa pro Worker a cada 5s e o painel mostra "processando N%" com mini-barra. Claim zera, done fecha em 100 | 2026-07-12 | transcode local real (5%→89% fluindo) + 12/12 (`verify:admin`) |
| **11b — Uploads persistentes/retomáveis + deleção definitiva** | Sessão no D1 ANTES do 1º byte (lote inteiro reservado antes de transmitir); multipart pro R2 em partes fixas com timeout/retry/backoff e cancelamento por item; painel lista uploads interrompidos pós-reload e retoma só as partes ausentes ao reanexar (fingerprint: caminho relativo+nome+tamanho+mtime); `complete` idempotente (repetir nunca duplica job). Zona de perigo: deleção física exige disabled + confirmação digitada `EXCLUIR <id>` + fora da janela do player; apaga só o prefixo exato no R2 e replaneja os canais | 2026-07-12 | 25/25 (`pnpm verify:uploads`, com retomada real no Chromium) + 12/12 (`verify:admin` já no fluxo novo) + smoke em produção (uploads de 1 e 3 partes processados + deleção com todas as recusas) |
| **11c — Área "A nomear" + correção por canal** | Heurística detecta nome ruim (só números/consoantes emendadas/sem espaço) e lista pra renomear na mão; "✨ sugerir com IA" manda o lote pro Gemini com contexto livre; série digitada "como gente" vira slug sozinha. Remover mídia de um canal LIMPA a grade futura na hora; "Séries — canais em lote" move a temporada inteira | 2026-07-13 | 11/11 (`pnpm verify:nomear`, LLM real) |
| **11d — Ingestão por LINK (YouTube/acervos)** | Cola o link no admin → job com `source_url` → a fábrica baixa com yt-dlp (720p mp4, Deno resolve o desafio JS) e segue o pipeline (comercial baixado já sai transcrito+promessa). Cookies self-service no painel (🍪), botão ↻ retry por job | 2026-07-13/14 | 9/9 (`pnpm verify:link`) + 15 vídeos reais do YouTube processados |
| **Ingestão de PLAYLIST (episódios em partes)** | Cola o link da playlist → a fábrica lista (`yt-dlp --flat-playlist`) → o Worker classifica cada título em (série, episódio, parte) por LLM+regex (a ORDEM vem do TÍTULO, nunca da playlist) → o operador revisa o agrupamento (avisos de parte faltando/duplicada) e escolhe quantos baixar (primeiros 5/10/temporada toda) → 1 job por episódio com as partes ordenadas (`source_urls`) → a fábrica baixa em ordem, junta CRU (`concatParts`: `-c copy` + validação, fallback concat filter) e o pipeline normaliza o TODO uma vez só. Aba 🎬 Playlist no admin | 2026-07-14 | 19/19 (`pnpm verify:playlist`, LLM real + regex backstop) + smoke da UI no Chromium |
| **12 — Comerciais como promessa (fase inteira)** | whisper transcreve na ingestão → LLM propõe a promessa → operador revisa → o agendador cumpre. Tipos: `a_seguir` (colado no programa prometido), `durante`/"você está vendo X" (bumper de permanência — meio do episódio e emenda de maratona), `bloco_horario`/`evento` (retidos até a 10a). Modo **comerciais fiéis/livres POR CANAL** (🎯/🎲); reclassificar tipo no catálogo | 2026-07-12/14 | 16/16 (`pnpm verify:promessas`, LLM real) + backfill real + Disney no ar com as vinhetas dos Padrinhos |

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

### ~~Fase 8~~ ✅ CONCLUÍDA em 2026-07-12 — a fábrica roda no GitHub Actions
- **Fluxo:** job entra na fila (upload/POST) → Worker dispara `repository_dispatch`
  → workflow `fabrica` acorda, drena a fila inteira (FACTORY_DRAIN=1) e encerra.
  Cron diário re-dispara se sobrar fila; `workflow_dispatch` = botão manual na aba
  Actions (ou `gh workflow run fabrica`). Concurrency de grupo único: dispatches
  durante uma run colapsam em no máximo 1 run enfileirada.
- **Resiliência:** job preso em `processing` há 2h volta pra fila sozinho (runner
  morto no timeout); upload pro R2 com retry por segmento; erros de pipeline
  viram mensagem legível na fila (não crash dump).
- **Prova real:** dispatch automático acionado 3× por uploads reais do Gabriel;
  ep_avdaeasavntsdjnprlet03ep11 processado de ponta a ponta no runner (17:37 UTC)
  com progresso % ao vivo no painel; fila de 12 episódios drenando em produção.
- **EC2 aposentada da produção** — virou só máquina de dev (fallback manual da
  fábrica continua documentado em [GOTCHAS.md](GOTCHAS.md)).
- **Custo:** GitHub free = 2.000 min/mês de runner em repo privado; um episódio
  de ~22min consome ~8min de runner. Uso pessoal cabe com folga; se apertar,
  tornar o repo público zera o custo de minutos.
- whisper-ready: o runner já tem o ambiente pra fase 12 instalar o whisper no
  mesmo workflow.

### ~~Fase 9~~ ✅ CONCLUÍDA em 2026-07-12 (ver tabela acima)
Pendência levada pra fase 10: regras da `channel_master_grid` (blocos fixos por
dia/horário) entram junto com o planejamento editorial — hoje o agendador usa
rotação + pods; as regras fixas fazem mais sentido quando o Diretor IA as gerar.

### ~~Fase 10~~ ✅ COMPLETA em 2026-07-12 — Diretor IA + Votaton
**Spec:** [features/diretor-ia.md](features/diretor-ia.md). Entregues: 10a
(editorial noturno), 10b (chat Modo God), 10b.1 (exclusão de série) e 10c
(Votaton). O canal decide a própria noite, cumpre o que promete, e o
telespectador pede programação sem garantia — com conquista celebrada.
**Pré-requisito operacional do Votaton:** o canal precisa de ≥2 séries
agrupadas (≥2 episódios cada) pra "corrida" ter adversários — hoje o Jetix
tem só a `pucca`; agrupar Power Rangers/Hey Arnold no catálogo abre a urna.
**Refinamentos futuros (sem urgência):** blocos fixos semanais
(`channel_master_grid`) destravando promos `bloco_horario`; "programação
guiada por promo" (etapa 3 da fase 12); Modo God ajustar probabilidade do
votaton (previsto na spec).

### Fase 11 — Admin v2 — 11a, 11b, 11c e 11d ✅ FEITAS; faltam TMDB e presign
**Objetivo:** upar qualquer coisa e o sistema entender sozinho. Entregues: lote/
pasta (11a), uploads retomáveis + deleção definitiva (11b), área "A nomear" +
correção por canal (11c), ingestão por link YouTube/acervos (11d — ver tabela).
**Entregáveis restantes:**
- TMDB (título oficial, sinopse, **poster** → EPG rico).
- URL pré-assinada pro navegador enviar cada parte DIRETO ao R2 — junto com o
  **domínio próprio** (que também destrava o bucket público, ver fase 7).

### ~~Fase 12~~ ✅ COMPLETA em 2026-07-12/14 — comerciais como promessa
**Objetivo:** promos de sequência/horário/maratona só irem ao ar quando a grade cumpre.
**Spec:** [features/comerciais-condicionais.md](features/comerciais-condicionais.md).
Entregue: whisper na fábrica, LLM propõe a promessa (casador determinístico de
série), fila de revisão, agendador que cumpre. 4 tipos de promessa (`a_seguir`,
`durante`, `bloco_horario`, `evento`) + modo fiel/livre por canal + reclassificar
tipo. Ver tabela de fases concluídas.
**✅ Entregue em 2026-08-08 — fábrica de grade automática + destrave por âncora:**
`reconciliaComerciaisGrade()` (cron diário + criar/apagar âncora + POST
`/admin/fabrica-comerciais/reconciliar-grade`) gera job de comercial pra toda
âncora sem promo (quando o kit da série existe — clipes nome/frase, amostra,
molde; lacunas em `config.reconcilia_comerciais`), recolhe promo cuja âncora
sumiu (`ignorar` + marca `desatualizado`, reversível) e o comercial nasce
`confirmada` com condicao `bloco_horario` — o scheduler destrava contra as
`channel_slots` do canal (fiel por construção; era a metade "promos de horário
fixo destravarem quando a grade garantir o bloco").
**Falta (etapa 3, junto com a 10a):** programação GUIADA por promo — o Diretor
montar blocos/sequências justamente porque tem a promo perfeita pra eles.

## 📦 Backlog (sem fase definida)

- **Chegar na grade nostálgica 2005–2008** — escopo ampliado pelo Gabriel em
  21/09/2026: reconstruir os três canais com base nas grades reais e chamadas
  da época, sem exigir que tudo pertença ao mesmo dia de 2005. A base histórica
  continua em [features/grade-alvo-2005.md](features/grade-alvo-2005.md); os
  modelos distintos de sábado/domingo e os slots permanentes de filme estão em
  [features/grade-fim-de-semana-2005-2008.md](features/grade-fim-de-semana-2005-2008.md).
  Títulos emprestados atualmente nos canais permanecem por curadoria.

- **Diretor encomenda comerciais + vinhetas "a seguir" GERADAS por IA** —
  pedido do Gabriel (2026-07-13). A inversão genial do problema da fase 12:
  em vez de caçar promo de acervo que combine com a grade, GERAR a promo que
  combina com a grade que o Diretor acabou de montar. Em partes:
  1. *O Diretor diz o que falta*: relatório de lacunas determinístico
     (séries sem promo "a seguir", maratona agendada sem promo de evento) no
     painel/chat — ele "encomenda" as peças.
  2. *Geração da vinheta "a seguir"*: template fixo de época (fundo + 3
     quadros à direita, um por atração seguinte — como as vinhetas reais do
     Jetix) + 1 imagem por série (casa com os posters do TMDB, fase 11) +
     locução por IA ("A seguir: X! Depois, Y! E mais tarde, Z!") — TTS via
     ElevenLabs (free tier) ou **Piper TTS local no runner (grátis, pt-BR)**;
     montagem 100% ffmpeg (overlay/zoompan/drawtext) na própria fábrica —
     nenhum gerador de vídeo pago necessário pro formato template.
     → **Esta parte 2 virou spec própria em 2026-07-14:**
     [features/construtor-comerciais.md](features/construtor-comerciais.md)
     (o Gabriel evoluiu a ideia: locução que ele traz pronta em vez de TTS,
     **vídeo** no lugar da imagem estática, música de época, e gatilho
     automático quando um desenho novo entra no catálogo).
  3. *Fidedigna por construção*: a peça gerada já nasce com a promessa
     confirmada (sequência = a da grade real) — e no limite o agendador
     encomenda a vinheta certa pro intervalo certo (a "programação guiada
     por promo" da fase 12, invertida).
- ~~**Ingestão de playlist do YouTube (episódios em partes)**~~ ✅ FEITO
  (2026-07-14, ver tabela acima) — colar o link, agrupar as partes pela ordem do
  TÍTULO, escolher quantos episódios baixar, juntar cru e normalizar uma vez.
  Spec/implementação em [features/playlist-youtube.md](features/playlist-youtube.md).
- **"A nomear" → transcrever um trecho no projeto externo do Gabriel** — ideia
  dele (2026-07-13): pra arquivo de nome irrecuperável, exportar um trecho
  (ex.: 60s de áudio, que o pipeline já sabe extrair) e mandar pro projeto
  de transcrição de arquivos grandes que ele mantém; com um pedaço da
  transcrição dá pra deduzir série/temporada/episódio. Por ora a fila manual
  resolve; quando ele quiser, o gancho natural é um botão "baixar trecho"
  na área A nomear (ou uma API do projeto dele pra enviar direto).
- **Polimento noturno (tarja preta + volume)** — pedido do Gabriel
  (2026-07-12 áudio; 2026-07-14 tarja + cron noturno).
  **Spec:** [features/polimento-noturno.md](features/polimento-noturno.md).
  A ideia: o Gabriel sobe os vídeos e eles entram no ar mesmo "zuados"; um
  **cron de madrugada** (o `scheduled()` já roda 03:00 SP) varre o catálogo e
  conserta cada um sozinho. Dois consertos no `normalize()` do pipeline:
  (a) **`cropdetect`** tira a tarja "assada" (letterbox na fonte) — e política
  `fit`/`fill` por-item pro 4:3 de verdade; (b) **`loudnorm`** (EBU R128,
  I=-16 LUFS) nivela o volume. **Garantia contra "perder" o que já subiu:** os
  `.ts` no R2 são cópia completa → reprocesso reconstrói o master (`concat
  -c copy`), re-trata e re-sobe no mesmo prefixo; duração igual → **EPG
  intacto**. Jobs de link rebaixam a fonte (1ª geração). Modo `audio`
  (stream-copy de vídeo) quando só falta volume = muito mais barato. Também
  vira botão "✨ polir agora" por item. **Decisões abertas** (na spec): alvo de
  loudness, `fit`-vs-`fill` padrão, fonte do reprocesso.
- **Cortador de comerciais (compilado → N comerciais)** — pedido do Gabriel
  (2026-07-14). **Spec:** [features/cortador-comerciais.md](features/cortador-comerciais.md).
  Cola o link de um compilado (~4min com vários comerciais emendados) → **cada
  anúncio aparece sozinho no catálogo**, pronto pro rodízio. É a **playlist AO
  CONTRÁRIO** (1 fonte → N mídias). Tabela `comercial_cuts`, coluna nova
  `ingest_jobs.corte`.
  **⚠️⚠️ v3 (2026-07-15): o ACERVO REAL derrubou o motor.** Rodado no
  `com_jetix_intervalo_comercial_hi` (600s, reconstruído dos 60 `.ts` do R2), o
  motor commitado (`b379687`) **reprovou 100% dos candidatos**. As duas premissas
  centrais são falsas pra este material:
  - **preto não marca troca de comercial**: 4 ocorrências em 600s, e o único da
    vizinhança cai DENTRO de um anúncio (entre "grande!/enorme!/gigante!") —
    cortar ali picotaria um comercial em quatro. Comercial brasileiro dos anos
    2000 emenda direto; o preto era da entrada/saída do BLOCO.
  - **platô de silêncio não existe**: o sweep decai monotonicamente (434 gaps a
    -18dB → 6 a -50dB). Áudio de broadcast é comprimido — não há silêncio entre
    peças, só o fundo de um decaimento. O platô só existe em áudio SINTÉTICO.
  **A lição que custou caro:** o `verify-cortador` (29/29 ✅) FABRICAVA o
  compilado plantando preto+silêncio nos limites — construía o mundo que a
  premissa afirmava e verificava a premissa nele. Regra nova: fixture REAL.
  **Arquitetura v3:** whisper diz QUAIS (buraco de fala = candidato; o
  `transcreve.py` já gera os timestamps e os JOGA FORA na última linha), o LLM
  diz SE (o texto fechou com a marca? — texto vai pro DeepSeek, que tem cota; o
  Gemini sai da rota crítica), o ffmpeg diz ONDE (±15ms, medido). Onde não há
  locução (15% do compilado testado), a peça ainda **fecha com a assinatura
  VISUAL** (logo/cartela) — foi assim que se identificou uma promo institucional
  de 90s: zero cortes de cena + fecha com o logo do Jetix. Sobrevivem da v2: a
  **zona morta** (invasão ≤ 1 frame = piso físico) e a **grade de 15/30/60**
  (único portão que resistiu ao real — mas só vale pra anunciante, não pra
  vinheta/ID de canal).
  **⚠️ A spec já tinha sido REESCRITA na v2** — o Gabriel deixou claro que **não
  vai revisar** ("queria algo automático, só subir o compilado e ele tratar").
  Isso matou a aba de cards (juntar/dividir/aparar) da v1:
  - **Threshold medido, não chutado:** varre o `silencedetect` e acha o **platô**
    (a faixa de dB onde o resultado não muda) — cada compilado se auto-calibra.
    Medido: com chiado a -34dB, de -20 a -33dB dá o gap no mesmo timestamp
    (3.018594, sem mudar um dígito); a -34dB dá **zero**. **Sem platô → rejeita o
    compilado inteiro.** O sistema sabe quando não sabe — é o que autoriza rodar
    sem revisor.
  - **Precisão medida, não temida:** `silencedetect` erra **~15ms** (meio frame de
    TV) contra silêncio de posição conhecida. A precisão nunca foi o problema.
  - **Zona morta, não ponto médio:** um limite são DOIS pontos (`gap_start`,
    `gap_end`); o gap não pertence a ninguém. O erro cai no preto, não no anúncio.
  - **5 portões no lugar do humano:** sinal (preto ∩ silêncio) → **grade de
    15/30/60s** (o mais forte: independente do ffmpeg, vem de como comercial é
    vendido) → borda técnica → **visual (Gemini multimodal: "os 2 frames de borda
    são anúncios diferentes?")** → **semântico (DeepSeek: "a transcrição tem
    fecho ou morre no meio da frase?")**. Falhou em um → descarta.
  - **Descartar é de graça** (tem compilado infinito no YouTube); ingerir peça
    quebrada, não. Portões conservadores: 5 de 9 é sucesso.
  - **Chat do editor** (pedido 07-14): opcional e DEPOIS, nunca bloqueante —
    "ficou ruim, tira do ar" / "corta em 1:23". Espelha o `diretor.ts`.
  ⚠️ Pegadinha nº 1 já confirmada no código: o `detectBlack()` usa `d=1.0` e NÃO
  acha o preto curto (0.1–0.4s) entre anúncios — o cortador chama o mesmo helper
  com `d≈0.15`. O motor é o trabalho novo real; o resto é cola de peças prontas
  (link+cookies, staging, pipeline, transcrição, `llm.ts`, `diretor.ts`).
- **Construtor de comerciais (molde → comercial novo)** — pedido do Gabriel
  (2026-07-14). **Spec:** [features/construtor-comerciais.md](features/construtor-comerciais.md).
  **Futuro declarado** — não antes do cortador. O outro lado do mesmo "editor":
  molde PNG **com um pedaço vazado** + locução que ele traz pronta ("você está
  vendo Pucca na Jetix") + música de época → o sistema põe alguns segundos do
  desenho **dentro do vazado** e monta a vinheta. A sacada: o vazado é **alpha**,
  então o buraco se acha sozinho (`alphaextract,negate,cropdetect`) e o molde por
  cima recorta de graça — nenhuma coordenada digitada. **Gatilho:** desenho novo
  no catálogo → a vinheta dele nasce sozinha. É a **parte 2 do item "Diretor
  encomenda vinhetas GERADAS por IA"** (07-13) promovida a spec.
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
