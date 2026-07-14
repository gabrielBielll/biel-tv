# Feature: ingestão de playlist do YouTube (episódios em partes)

> Especificado em 2026-07-14 a partir de um caso real do Gabriel.
> Estado: ✅ FEITO (2026-07-14). Verificação e2e `pnpm verify:playlist` (19/19)
> + smoke da UI no Chromium. Reaproveitou yt-dlp/cookies (11d), o pipeline
> intacto, o classificador LLM (`pedeJson`, 11c) e o agrupamento por série.
>
> **Como ficou (resumo da implementação):**
> - Migration `0014_playlist_ingest.sql`: tabela `playlist_ingests` (ciclo da
>   análise) + coluna `ingest_jobs.source_urls` (partes ordenadas de 1 job).
> - Parser `apps/stream/src/serie-partes.ts`: `montaGrupos()` (LLM+regex →
>   agrupa/ordena por parte, valida 1..N, avisa buraco/duplicata). A ORDEM sai
>   do TÍTULO, nunca da playlist.
> - Endpoints em `admin.ts`: `POST /playlist` (analisar) · `/playlist/claim`
>   (fábrica) · `/playlist/:id/entries` (classifica na hora) · `.../error` ·
>   `GET /playlist` · `/playlist/:id/confirmar` (1 job por episódio escolhido).
> - Fábrica (`factory-local.mjs`): `tickPlaylist()` lista via
>   `yt-dlp --flat-playlist`; job com `source_urls` baixa cada parte em ordem e
>   `concatParts()` (em `ffmpeg.mjs`) junta CRU (`-c copy` + validação de
>   duração; fallback concat filter). O pipeline normaliza o TODO uma vez só.
> - UI: aba 🎬 Playlist (colar link → revisar agrupamento → escolher quantos
>   baixar: primeiros 5 / 10 / temporada toda, ou por episódio).
>
> **Fronteira do teste:** o `yt-dlp --flat-playlist` real não roda no e2e (usa
> fixtures servidos pelo Worker, mesma fronteira do verify-link). O resto —
> classificação, ordenação, detecção de buraco, criação dos jobs, download
> múltiplo e concat — é exercitado de ponta a ponta.

## O problema

Muitos acervos no YouTube têm **episódios partidos em pedaços de ~4min** dentro
de uma playlist (herança da época em que o YouTube limitava vídeos a 10min).
O Gabriel quer colar o link da playlist e o sistema **baixar tudo, juntar as
partes na ordem certa e salvar como episódios inteiros** no catálogo.

## O que a playlist REAL revelou (o caso que motivou isto)

`https://youtube.com/playlist?list=PLrpAMYjIPpHcvqeKVF0cmRps2v8zsOpvE`
— "Jake Long: O Dragão Ocidental — 1ª Temporada":

- 1 playlist = uma TEMPORADA INTEIRA (episódios 01, 02, 03, 04, 05…), **não** um
  episódio só. Então "playlist = 1 episódio" está ERRADO pra este caso.
- Cada episódio = **6 partes** de ~240s (a última ~165s) → ~22min por episódio.
- ⚠️ **AS PARTES ESTÃO FORA DE ORDEM NA PLAYLIST.** Exemplos reais:
  - Ep 03 (índices 13–18): partes **1, 2, 6, 3, 4, 5**
  - Ep 05 (índices 25–30): partes **1, 4, 6, 5, 2, 3**
  - Juntar na ordem da playlist = episódio embaralhado.

**A regra de ouro desta feature:** o número do episódio e da parte vêm do
TÍTULO, NUNCA da posição na playlist. Título típico:
`"Jake Long ... Episódio 03 - Spud, o Spudinífico (Parte 2)"`.

## Fluxo proposto

1. **Colar o link da playlist** no admin (detecta `list=` na URL).
2. **Analisar** (botão): a fábrica lista a playlist e devolve os títulos pro
   Worker classificar (ver "Parsing"). O painel mostra o AGRUPAMENTO proposto
   (Ep 01 = 6 partes ✓, Ep 02 = 6 partes ✓, Ep 03 = 6 partes ✓…) pra revisão —
   incluindo avisos de parte faltando/duplicada.
3. **Confirmar** → o Worker cria UM job por episódio, cada um com a lista
   ORDENADA de URLs das partes.
4. **A fábrica** baixa as partes, junta, e o pipeline transforma em 1 mídia.
5. **Resultado:** `ep_jake_long_s1e01`, `_s1e02`… já agrupados na série
   `jake_long`, prontos pra grade / Votaton / tudo.

## Parsing (o coração da feature): título → (série, episódio, parte)

Dois níveis, mesmo padrão do resto do projeto (barato + robusto):

- **Primário — LLM (Gemini→DeepSeek, reusa `pedeJson`/fase 11c):** manda todos os
  títulos numa chamada, recebe por vídeo `{id, serie, episodio, parte,
  titulo_limpo}`. Robusto a qualquer nomenclatura ("Episódio 05-Ató 4, Cena
  15(Parte 2)" etc.).
- **Fallback determinístico / validação:** regex `epis[óo]dio\s*(\d+)` +
  `parte\s*(\d+)` — barato, confere o LLM.
- **Sanidade antes de confirmar:** por episódio, checar que as partes formam
  1..N sem buraco nem repetição; senão marcar pra revisão manual (não juntar
  errado em silêncio — regra da casa).

## Modelo de dados

O job passa a poder ter VÁRIAS fontes ordenadas. Duas opções:
- Coluna nova `ingest_jobs.source_urls` (JSON com a lista ordenada), OU
- Tabela `ingest_job_parts (job_id, ordem, source_url)`.
O `source_url` único de hoje vira o caso especial de 1 parte.

## Processamento na fábrica (junção)

1. Baixa cada parte EM ORDEM (yt-dlp + cookies do painel; retry por parte).
2. **Concatena.** Caminho seguro que reusa o pipeline INTACTO (1 encode só):
   - Junta as partes CRUAS com o concat demuxer: `ffmpeg -f concat -safe 0 -i
     lista.txt -c copy joined.mp4`. Partes da MESMA playlist/uploader quase
     sempre têm codec/resolução iguais → `-c copy` gera um arquivo limpo sem
     re-encodar.
   - **Validação:** `ffprobe joined.mp4` — a duração ≈ soma das partes? Se
     divergir (partes com encoding diferente quebram o `-c copy`), cair pro
     **concat filter** (`-filter_complex concat`, re-encoda, aguenta qualquer
     entrada) como plano B.
   - Passa `joined.mp4` pro pipeline de sempre (normaliza → keyframes na grade
     global de 10s → segmenta → cues → transcreve → sobe → registra). O
     pipeline NÃO muda — só recebe um arquivo já juntado.
3. Resultado: 1 `media_item` por episódio.

**Por que juntar CRU e deixar o pipeline normalizar (em vez de normalizar cada
parte e juntar):** se normalizar cada parte separada, os keyframes forçados a
cada 10s reiniciam no começo de cada parte → depois do 1º pedaço eles não caem
mais nos múltiplos globais de 10s → a segmentação quebra ("segmentação gerou N,
esperava M"). Juntar cru primeiro e normalizar o TODO uma vez põe os keyframes
na grade global certa. (Ver a regra de ouro dos 10s em ARQUITETURA.md.)

## Cuidados / pegadinhas

- **Ordem das partes ≠ ordem da playlist** — o erro nº 1. Sempre ordenar pelo
  número parseado.
- **Parte faltando** — a playlist real pode ter um episódio sem uma parte;
  detectar e avisar, não juntar com buraco.
- **Cookies** — playlist grande = muitos downloads seguidos; a auto-renovação
  (PUT /admin/yt-cookies) ajuda, mas playlist de 30+ vídeos pode esgotar a
  janela do YouTube. Baixar em série com retry; se cookies morrerem no meio,
  o job do episódio incompleto falha limpo e retoma com cookie novo (nível de
  episódio, não perde os já prontos).
- **Custo de runner** — 1 temporada = bastante minuto de transcode. Cabe no
  free tier (2000min/mês), mas é um lote grande; talvez limitar/avisar.
- **Concat `-c copy` glitch** — validar duração e ter o fallback do concat
  filter.

## Esforço estimado

- Migration (source_urls / job_parts): pequeno.
- Worker: endpoint de análise + parsing LLM + criação dos jobs por episódio: médio.
- Fábrica: download múltiplo + concat + validação + fallback: médio.
- UI: colar playlist → revisar agrupamento → confirmar: médio.
- Teste e2e: uma playlist pequena real (ou 2–3 vídeos curtos simulando partes).

## Reaproveita o que já existe

- Download por link + cookies self-service + Deno (fase 11d) — pronto.
- Pipeline normaliza/segmenta/transcreve — pronto (só recebe o arquivo juntado).
- Classificador LLM com contexto (fase 11c `pedeJson`) — pronto, é o parser.
- Agrupamento por série (`metadata.series_id`) + área "A nomear" pra ajustes.
- Botão ↻ retry, progresso %, self-heal de job preso — prontos.
