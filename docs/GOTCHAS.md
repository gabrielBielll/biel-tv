# Pegadinhas da Biel TV

> Bugs reais encontrados, suas causas exatas e o fix — pra não redescobrir o
> mesmo problema duas vezes. Atualizado em 2026-07-12.

## Fábrica: GitHub Actions desde 2026-07-12 (a EC2 é só fallback)

A transcodificação roda no workflow `fabrica` (`.github/workflows/fabrica.yml`),
acordado automaticamente pelo Worker quando entra job na fila. **Se uploads
ficarem presos em `queued`:** (1) veja a aba Actions do repo (run travada?
falhou no setup?); (2) dispare na mão: `gh workflow run fabrica`; (3) o cron
diário do Worker também re-dispara enquanto houver fila. Job preso em
`processing` volta pra fila sozinho após 2h.

**Fallback manual (EC2 ou qualquer máquina com ffmpeg):**
```bash
cd biel-tv
FACTORY_TARGET=remote \
BASE=https://biel-tv-stream.biel-cesa95.workers.dev \
ADMIN_TOKEN=<token de produção> \
CLOUDFLARE_API_TOKEN=<cfat_...> CLOUDFLARE_ACCOUNT_ID=97603ea0b9784ad4a9d3b80bd73f1ea4 \
R2_ACCOUNT_ID=97603ea0b9784ad4a9d3b80bd73f1ea4 \
R2_ACCESS_KEY_ID=<...> R2_SECRET_ACCESS_KEY=<...> R2_BUCKET=biel-tv-media \
node scripts/factory-local.mjs
```
(sem FACTORY_DRAIN ele vira daemon; com `FACTORY_DRAIN=1` drena e sai)

## GitHub Actions (aprendizados do primeiro dia, 2026-07-12)

**O pipeline precisa de DOIS conjuntos de credenciais — R2 *e* Cloudflare.**
O sintoma da segunda faltando é cruel: o job transcodifica 8 minutos, sobe
tudo pro R2… e morre no ÚLTIMO passo (`✖ wrangler d1 execute falhou
(register-<id>)`), porque o registro no D1 usa wrangler, que exige
`CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID`). Na EC2 nunca doeu porque
o token sempre esteve no ambiente. Custou uma leva inteira de jobs falhados.

**ffmpeg do runner ≠ ffmpeg da EC2 — e isso muda o comportamento do Node.**
O runner usa o ffmpeg do Ubuntu; a EC2 usa build estático (BtbN). Versões
diferentes despejam volumes diferentes de avisos (rips antigos com timestamps
tortos geram aviso POR FRAME), e o `execFile` do Node mata o processo com
`maxBuffer exceeded` (padrão: 1 MiB). Sintoma: job morre DEPOIS de minutos de
trabalho com um crash dump cujo rodapé ("Node.js vX") era o que acabava
gravado como erro. Fixes permanentes: `maxBuffer: 64 MiB` em todas as
chamadas + `uncaughtException/unhandledRejection → ✖ mensagem limpa` no cli.

**Runs fixam o commit do MOMENTO do evento.** Push depois do dispatch NÃO
entra na run pendente (nem na ativa). Pra rodar código novo: cancele as runs
velhas e dispare de novo (`gh run cancel` + `gh workflow run fabrica`).

**Push de `.github/workflows/` exige escopo `workflow` no token do gh.** O
login padrão do gh não inclui; use `gh auth login --web --scopes workflow`
(device flow — precisa do Gabriel no navegador) já com o escopo junto.

**O login do gh é da MÁQUINA, não do projeto — e o Gabriel usa várias contas.**
Um `gh auth login` dele pra outro projeto pode SUBSTITUIR a conta
`gabrielBielll` (aconteceu em 2026-07-12: entrou gabrielfranca95/menu95 e a
gabrielBielll saiu). Sintomas em cascata: `git push` deste repo falha com
"could not read Password" E o `GH_DISPATCH_TOKEN` do Worker morre junto (o
token antigo é revogado) — uploads param de acordar a fábrica em silêncio
(o cron diário e o botão manual da aba Actions seguram as pontas). Conserto:
`gh auth login --web --scopes workflow` na conta gabrielBielll (as contas
CONVIVEM — o problema é substituir, não somar) e depois
`gh auth token --user gabrielBielll | npx wrangler secret put GH_DISPATCH_TOKEN`
em apps/stream. O vínculo por repositório
(`credential.https://github.com.username=gabrielBielll`) sobrevive e acha a
conta certa sozinho quando ela existe no gh.

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

## R2 multipart (uploads retomáveis)

**Toda parte, exceto a última, precisa ter EXATAMENTE o mesmo tamanho.** O R2
é mais rígido que o S3 (que só exige ≥5 MiB): partes de tamanhos mistos fazem
o `complete` falhar. Por isso o `PUT /admin/uploads/:sid/parts/:n` valida o
tamanho byte a byte (parte n < total = `part_size` exato; última = resto) — um
cliente bugado falha na hora com mensagem clara, e não minutos depois no
complete. O simulador local (miniflare) é mais permissivo que o R2 real —
não conclua que "funcionou local" cobre essa regra; o smoke de produção cobre.

**`resumeMultipartUpload()` não valida nada** — retorna na hora mesmo se o
uploadId não existe mais; o erro só aparece no `uploadPart`/`complete`
seguinte. Trate esses dois pontos como o lugar de detectar sessão morta.

**`wrangler r2 object put biel-tv-media/<key> --file <f> --local` escreve no
MESMO estado que o wrangler dev em execução lê** (`.wrangler/state/v3`) — é o
jeito de plantar fixtures de R2 em testes e2e sem rota de upload (usado em
`verify-uploads.mjs` pros testes de deleção).

## YouTube / yt-dlp no runner (ingestão por link)

**O YouTube barra IP de datacenter com "Sign in to confirm you're not a
bot"** — o runner do GitHub (e qualquer nuvem) toma isso do cliente web.
Visto no primeiro smoke real (2026-07-13). A defesa tem TRÊS camadas, em
ordem — as duas primeiras já implementadas, a terceira pronta pra ativar:

1. **Tentativa normal** (nada a fazer): vídeos comuns muitas vezes baixam
   de primeira; o erro, quando vem, aparece legível na fila
   (`download falhou: ... Sign in to confirm ...`).
2. **Cliente de TV** (já no código): a fábrica chama o yt-dlp com
   `--extractor-args "youtube:player_client=default,tv_simply,tv"`.
   **VEREDITO 2026-07-13: INSUFICIENTE** — testado com 9 vídeos reais no
   runner e TODOS tomaram "Sign in" mesmo pelos clientes de TV (o YouTube
   fechou o cerco em IP de datacenter). Fica no código porque não custa
   nada e pode voltar a funcionar, mas NÃO re-teste esperando resultado
   diferente: pra YouTube no runner, vá direto pra camada 3.
**⚠️ SÃO DUAS MURALHAS INDEPENDENTES (descoberto 2026-07-13, testado em
isolamento):** (a) o bot-check "Sign in to confirm" barra ANTES de tudo em
IP de datacenter → só cookies resolvem; (b) o "n challenge" (JS) esconde os
formatos DEPOIS ("Only images are available" / "n challenge solving
failed") → precisa de runtime JS + resolvedor: **Deno + `pip install
"yt-dlp[default]" yt-dlp-ejs`** (no runner: action `denoland/setup-deno@v2`;
na EC2: `curl -fsSL https://deno.land/install.sh | sh` e ~/.deno/bin no
PATH). A receita completa que FUNCIONA = cookies + Deno + yt-dlp-ejs.

3. **Cookies do Gabriel** (plano definitivo, ativar só se a camada 2 falhar):
   o yt-dlp se apresenta como o navegador logado dele — o YouTube não barra.
   Passo a passo:
   - Gabriel instala a extensão **"Get cookies.txt LOCALLY"** (Chrome/Firefox),
     abre youtube.com LOGADO e exporta o `cookies.txt` (formato Netscape);
   - `gh secret set YT_COOKIES --repo gabrielBielll/biel-tv < cookies.txt`;
   - pronto — o workflow detecta o secret sozinho, escreve `/tmp/yt-cookies.txt`
     e exporta `YT_COOKIES_FILE`; a fábrica adiciona `--cookies` quando a var
     existe. Sem o secret, nada muda.
   - **EXPORTE DE UMA JANELA ANÔNIMA — regra de ouro aprendida na prática
     (2026-07-13):** cookies exportados do navegador NORMAL morreram em ~20h
     ("cookies configurados" no log da run + "Sign in" na mesma run = prova).
     Causa: o Google ROTACIONA os tokens de sessão (SIDCC/__Secure-*PSIDTS)
     enquanto o navegador continua usando o YouTube — o snapshot exportado
     fica órfão. O jeito documentado pelo próprio yt-dlp: abrir janela
     anônima → logar no YouTube → exportar → FECHAR a janela sem navegar
     mais. Esses cookies nunca rotacionam e duram meses.
   - Manutenção: quando voltar o "Sign in" (a fila mostra a mensagem 🍪 com
     a instrução), re-exportar (anônima!) e rodar o `gh secret set` de novo;
     depois é só clicar ↻ nos jobs. CUIDADO: cookies dão acesso à conta
     Google dele — só como secret do repo, nunca em arquivo commitado/log.
   - **Re-login automático NÃO existe por design**: automatizar exigiria
     guardar a senha do Google ou manter um navegador logado rodando — troca
     péssima. O caminho é tornar a renovação rara (perfil/janela nova) e
     barata (self-service no painel, abaixo).

**Renovação self-service dos cookies (2026-07-14):** o painel tem a caixa
"🍪 cookies do YouTube" (no card Enviar mídia). O Gabriel cola os cookies →
`POST /admin/yt-cookies` guarda no D1 (`config.yt_cookies`) e reenfileira os
jobs de link em erro. A fábrica busca via `GET /admin/yt-cookies` (primário),
fallback pro secret YT_COOKIES do GitHub. `GET /admin/config` exclui
`yt_cookies` (grande+sensível; o painel usa `/yt-cookies/status`).

**Aceita DOIS formatos de export** (`cookiesParaNetscape`): o `.txt` Netscape
(extensão "Get cookies.txt LOCALLY") E o JSON (Cookie-Editor / EditThisCookie).
Pegadinha real: quando o Gabriel colou o JSON, a validação antiga passava (o
JSON contém ".youtube.com"/"SID" como texto) mas guardava o JSON cru e o
yt-dlp não lia → "Sign in" em silêncio. Agora detecta `[`/`{` e converte
(domain/flag/path/secure/exp/name/value).

**Auto-renovação (PUT /admin/yt-cookies):** o Google gira o `__Secure-3PSIDTS`
a cada uso; cookie exportado de navegador EM USO morre em horas (visto: 18
downloads OK, o 19º pegou "cookies no longer valid, rotated in browser"). O
yt-dlp reescreve o `--cookies` com os cookies rotacionados a cada download OK
→ a fábrica devolve esse arquivo pro D1 (PUT silencioso), mantendo-os vivos
entre lotes. **Mas a cura de verdade continua sendo o fresh-export**: perfil
NOVO (não anônimo — login trava lá) → logar → exportar → FECHAR sem navegar.
Aí só o yt-dlp rotaciona (e a gente devolve), e os cookies duram.

**Fingerprint do cookie que FUNCIONA (validado 2026-07-14):** exportar do
navegador NORMAL logado também serve — o que mata os cookies em ~20h é
continuar navegando no YouTube depois de exportar (rotação do
`__Secure-3PSIDTS`). "Perfil novo → logar → exportar → fechar sem navegar"
evita isso. E o login do Google trava no MODO ANÔNIMO (bloqueia cookies de
terceiros que o SSO usa) — por isso usar PERFIL novo, não anônimo.

Bônus: o mesmo campo de link aceita **archive.org e URLs diretas de .mp4**
(extractor genérico do yt-dlp) — acervos fora do YouTube não têm bot-check
nenhum, costumam ser o caminho mais tranquilo.

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

**`python3 - <<'EOF'` engole o stdin do pipe.** `echo "$X" | python3 - <<EOF`
NÃO funciona: o heredoc vira o stdin (é de onde o python lê o script), então
o pipe é descartado e `sys.stdin.read()` volta vazio. Ou passa os dados por
argumento/arquivo, ou embute no script. Custou dois "vigias" de background
imprimindo lixo em silêncio.

**Playwright: `innerText` devolve o texto RENDERIZADO — inclusive
`text-transform: uppercase` do CSS.** Os `h2` dos cards do admin usam
uppercase via CSS, então `document.body.innerText.includes('Uploads
interrompidos')` NUNCA casa (o texto rendido é "UPLOADS INTERROMPIDOS")
enquanto o elemento existe normalmente no DOM. Em `waitForFunction`, compare
com `textContent` (ignora CSS) ou normalize o case. Já causou um ❌
falso num check cujo passo seguinte (que dependia do mesmo elemento) passava.
