# Pegadinhas da Biel TV

> Bugs reais encontrados, suas causas exatas e o fix — pra não redescobrir o
> mesmo problema duas vezes. Atualizado em 2026-07-12.

## 🔴 Risco operacional #1: a fábrica de produção não é automática

**A transcodificação só acontece se um processo Node estiver rodando nesta
EC2**, escutando a fila de produção. Ele **não sobe sozinho** se a máquina
reiniciar — e quando ele não está rodando, uploads pelo admin **ficam
`queued` para sempre, sem erro nenhum, sem aviso nenhum**. Foi exatamente
isso que aconteceu em 2026-07-12: 17 vídeos reais subidos pelo Gabriel
ficaram parados na fila porque a única fábrica ativa apontava pro Worker
*local*, não pro de produção.

**Checar se está rodando:** `ps aux | grep FACTORY_TARGET` (ou veja se
`ingest_jobs` na produção tem itens `queued` há mais de ~1 min).

**Religar:**
```bash
cd apps/stream
FACTORY_TARGET=remote \
BASE=https://biel-tv-stream.biel-cesa95.workers.dev \
ADMIN_TOKEN=<token de produção> \
R2_ACCOUNT_ID=97603ea0b9784ad4a9d3b80bd73f1ea4 \
R2_ACCESS_KEY_ID=<...> R2_SECRET_ACCESS_KEY=<...> R2_BUCKET=biel-tv-media \
node scripts/factory-local.mjs
```
(rodar em background/`nohup`, senão morre quando a sessão fecha)

**Solução definitiva:** fase 8 (fábrica no GitHub Actions) elimina esse
processo manual de vez. Até lá, checar se está viva é o primeiro passo de
qualquer sessão que for mexer em upload/ingestão.

## Infra & deploy

**R2 (S3 API) falha com SSL handshake em Node — sempre usar IPv4.**
O endpoint `https://<account>.r2.cloudflarestorage.com` resolve IPv6, e o
`fetch()` do Node dá `SSL routines:ssl3_read_bytes:ssl/tls alert handshake
failure` nesse ambiente. `curl` e `wrangler` funcionam normal (não é a rede).
Fix: sempre `node --dns-result-order=ipv4first` em qualquer script que faça
upload S3 (`aws4fetch`) pro R2 — `scripts/upload-all-remote.mjs` e
`scripts/factory-local.mjs` já aplicam isso.

**`--target remote` tem que ser explícito — "apontar pro Worker certo" não
basta.** O pipeline (`packages/pipeline/src/cli.mjs`) só grava no D1/R2 de
verdade se receber `--target remote`; sem isso, grava nos simulados
(`--local`) mesmo que o `BASE` do chamador aponte pra produção. Mesma
armadilha por trás do incidente da fábrica acima.

**`--base-url ''` (string vazia) é uma convenção válida, não "faltando".**
`''` significa "sem domínio próprio, serve via `/media/*` do Worker" — é o
esquema usado em todo o catálogo hoje. Um check `!baseUrl` trata isso como
falsy e recusa; o certo é `baseUrl === undefined`. Já corrigido no CLI, mas
vale lembrar o padrão ao adicionar validação de flags no futuro.

**`wrangler dev` duplicado trava a porta silenciosamente.** Depois de várias
retomadas de sessão (compactação de contexto, reconexões), é fácil acabar
com 2+ processos `wrangler dev --port 8787` competindo pela mesma porta —
sintoma: requests derrubam a conexão no meio (`SocketError: other side
closed`), de forma intermitente e difícil de atribuir à causa certa. Sempre
`ps aux | grep wrangler` (ou `ss -ltnp | grep 8787`) antes de assumir que um
`wrangler dev` novo é o único; `kill -9` os PIDs velhos antes de subir outro.

**Trocar `database_id` no `wrangler.toml` esvazia o D1 local.** O
miniflare/wrangler indexa o banco local simulado pelo `database_id` — trocar
de um placeholder pro id real (ex.: na hora do deploy) faz o D1 local
"esquecer" tudo. Sempre `wrangler d1 export --local` antes de trocar o id, e
restaurar o dump depois.

## Banco de dados (D1/SQLite)

**SQLite não permite `ALTER` de `CHECK` constraint — reconstrua a tabela.**
Pra adicionar um novo valor válido a uma coluna com `CHECK (col IN (...))`,
o padrão é: criar tabela nova com o CHECK atualizado → `INSERT SELECT` os
dados → `DROP` a antiga → `RENAME`. Ver `packages/db/migrations/0006_*.sql`.

**`directives.status` é feminino (`'ativa'`/`'cancelada'`), `channel_events.status`
é masculino (`'agendado'`/`'cancelado'`).** Fácil de digitar errado num
`UPDATE` manual — o `CHECK` rejeita silenciosamente… não, na verdade falha
alto (erro do d1()), mas ainda assim é um erro bobo de se cometer e perder
tempo depurando. Confira a migration antes de escrever SQL ad-hoc contra
essas tabelas.

## Diretor / LLM (Gemini + DeepSeek)

**Evento (maratona) vence exclusão — de propósito, não é bug.** Em
`scheduler.ts`, o lookup de evento pra um slot de tempo lê `mediaTodas`
(SEM aplicar filtro de exclusão), então uma maratona ativa continua
escalando aquela mídia mesmo se ela (ou a série dela) estiver excluída.
Racional: uma ordem explícita do chat vale mais que uma regra geral. Ao
escrever testes ou debugar "por que X ainda está na grade", **sempre
verificar primeiro se não há um evento ativo cobrindo aquele horário** antes
de suspeitar de bug na exclusão.

**O LLM (principalmente o DeepSeek, usado como fallback) às vezes ignora a
instrução de "uma ação `excluir_serie` só" e enumera `excluir_media` um por
um.** O resultado prático é o mesmo (todos saem da grade), mas cria N
diretrizes em vez de 1. Testado e mitigado: em vez de tentar forçar 100% de
aderência ao formato via prompt (já tem regra explícita + exemplo few-shot,
e mesmo assim falha às vezes), o `cancelar_exclusao` foi feito **robusto aos
dois formatos** — cancela tanto uma diretriz `excluir_serie` quanto qualquer
`excluir_media` individual cujo `media_id` pertença à série. **Padrão geral:
quando o LLM tem liberdade de expressar a mesma intenção de mais de um
jeito, é mais robusto fazer a operação inversa entender todos os formatos do
que tentar constranger 100% da saída do modelo.**

**Grupos de série feitos em loop de `curl` sem checar resposta perdem
chamadas silenciosamente.** Durante um smoke test real, um loop `for id in
...; do curl -s ... >/dev/null; done` pra agrupar 5 mídias numa série só
"pegou" em 2 — as outras 3 falharam (rede transiente) sem nenhum sinal.
Sempre verificar o HTTP status (ou pelo menos imprimir a resposta) dentro do
loop, nunca silenciar com `>/dev/null` sem checagem.

## ffmpeg / pipeline

**Nem todo vídeo-fonte segmenta no número exato de segmentos esperado, mesmo
com `-force_key_frames`.** Fonte com frame rate variável (ou outra
irregularidade de encode) pode fazer a etapa de corte (`-c copy`) gerar
menos segmentos que `duração/10`. Sintoma: `"segmentação gerou N segmentos,
esperava M — keyframes fora da grade?"`. **Não é bug do pipeline, e repetir
o job não resolve** (é determinístico pro arquivo) — precisa investigar o
arquivo-fonte especificamente (normalizar frame rate antes, por exemplo).
Deixa o job em `error` na fila; visível no admin.

## Scripts de verificação (`scripts/verify-*.mjs`)

**`d1()` (spawnSync de `wrangler d1 execute`) bloqueia o event loop por
~1-2s — um `fetch()` logo depois pode nascer numa conexão morta.** O
`wrangler dev` local fecha a conexão keep-alive nesse intervalo de bloqueio,
e o próximo `fetch()` falha com `TypeError: fetch failed` / `SocketError:
other side closed`. Fix: `scripts/_lib.mjs` exporta `fetchRetry()` (retry
com backoff); qualquer script novo que misture `d1()` com `fetch()` deve
importar isso. Truque pra aplicar sem editar cada call site: `import {
fetchRetry as fetch } from './_lib.mjs'` — sombreia o `fetch` global do
arquivo inteiro.

**Não reuse um `now` capturado no início do script pra checar "sumiu da
grade" depois de uma chamada ao LLM.** Chamadas de chat ao Gemini/DeepSeek
levam vários segundos (às vezes com rodada de reparo, ainda mais). O
servidor calcula o próprio `now` no momento em que processa a exclusão —
sempre um pouco depois do `now` do script. Uma linha cujo `start_time_virtual`
cai nesse intervalo sobrevive **corretamente** à exclusão (o servidor nem
sabia dela ainda), mas o teste acusaria falso-negativo se comparasse contra
o `now` antigo. Sempre recapturar `now` (`Date.now()`) **depois** que a
chamada assíncrona que muda estado retorna, antes de consultar o D1 pra
validar o efeito.

**`wrangler d1 execute --json` mistura texto solto com o JSON na saída.**
Todo `d1()` helper faz `JSON.parse(stdout.slice(stdout.indexOf('[')))` pra
pular o preâmbulo — funciona, mas é frágil a mudanças de formato do
wrangler. Mantenha esse padrão consistente se adicionar novo script (ou
centralize em `_lib.mjs` se aparecer uma terceira cópia).
