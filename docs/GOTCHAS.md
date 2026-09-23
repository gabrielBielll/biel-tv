# Pegadinhas da Biel TV

> Bugs reais encontrados, suas causas exatas e o fix — pra não redescobrir o
> mesmo problema duas vezes. Atualizado em 2026-09-23.

## 🔇 A família que dá mais trabalho: falha que NÃO dá erro

Em 22–23/09/2026, num único dia de trabalho, **seis problemas independentes
apareceram — e nenhum deles produziu mensagem de erro.** Cada um foi descoberto
por acaso ou por medição, nunca por alarme. Vale ler esta seção antes de
debugar qualquer coisa aqui, porque o instinto de "se estivesse quebrado eu
saberia" é falso neste projeto.

| o que aconteceu | o que apareceu | como foi achado |
|---|---|---|
| `git cherry-pick \| tail -6` escondeu a 2ª linha de conflito; `git add -A` engoliu os marcadores | commit verde, teste passando | a fábrica morreu 2 dias depois, e o erro do Actions era `SyntaxError` num JSON |
| `while IFS= read` pulou a última linha de um `.jsonl` sem newline final | "69 gravadas, 0 erros" — de 70 | contagem no banco não bateu |
| MULTIOS do zsh duplicou stdout num `cmd >arquivo \| grep` | medição plausível e errada | medir de novo por `spawnSync` deu outro número |
| `tickPlaylist`/`tickFabricaComerciais`/`tickComercial` lançavam em 5xx | run vermelha em 9s, sem dizer que era cota | `wrangler tail` mostrou `D1_ERROR: exceeded daily row write limit` |
| montagem de comercial começava no segundo 0 da amostra, onde há cartela parada | peça pronta, job `done` | o Gabriel viu no ar: "só passa uma imagem fixa" |
| variável de ambiente não chegou no processo, `detectScene` falhou, `catch` devolveu 0 | teste "provando" que o conserto não funcionava | os números eram zero demais pra serem verdade |

### O que essas seis têm em comum

1. **Um `catch` que devolve valor neutro.** `catch { return 0 }` e
   `catch { return false }` transformam falha em resposta plausível. Quando o
   fallback for silencioso, ele precisa **logar** — e o log precisa dizer que é
   fallback, não parecer operação normal.
2. **Truncar saída de comando cujo retorno importa.** `| tail -n`, `| head -n`,
   `2>/dev/null` e `| grep` escondem a linha que muda a conclusão. Em `git`,
   `ffmpeg` e `wrangler`, leia a saída inteira antes de decidir.
3. **Medir por um caminho e usar por outro.** Medição de shell não descreve o
   que o código vê (ver MULTIOS). Meça pelo mesmo mecanismo que vai consumir o
   resultado.
4. **Sucesso contado, não conferido.** "69 gravadas" é contagem do laço, não do
   banco. Depois de escrever N coisas, **leia as N de volta**.

### As regras que saíram disso

- Depois de resolver conflito: `git diff --cached | grep -c '^+<<<<<<<'` **antes**
  de commitar. Custa um segundo e teria evitado dois dias de fábrica parada.
- Ler `.jsonl` em bash: `done < <(cat arquivo; echo)` — nunca `done < arquivo`.
- Medir stream (stdout vs stderr): arquivos separados, `cmd 2>err 1>out`, **sem
  pipe**. Ou `spawnSync`. Ver a seção do zsh MULTIOS.
- Erro transitório (5xx, cota, rede) num subsistema **não pode** derrubar o
  processo inteiro: logue e siga. A regra ja estava escrita no comentário do
  `tickComercial` ("um tick de feature nova nunca pode quebrar os ticks que já
  funcionam") — só cobria o 404 e não o 500.
- Toda operação em lote termina com **releitura de verificação**: contou N,
  agora confirme N no banco.
- Quando um teste der um número redondo demais (tudo zero, tudo igual),
  desconfie do teste antes de desconfiar do código.

📌 E a contrapartida: **quando algo aqui grita, agradeça.** O `git commit` que
falha por falta de identidade, o lote de faixas que recusa aplicar meia grade e
o `claim` que desiste depois de 5 erros seguidos são desenhos deliberados que
trocam silêncio por barulho. Não os "conserte" pra ficarem quietos.

### Mais sete, no mesmo 23/09

| o que aconteceu | o que apareceu | como foi achado |
|---|---|---|
| 352 faixas aplicadas pelo endpoint singular, um replan por chamada: 9 replans comeram a cota e as outras 343 gravaram a faixa e morreram no replan | as 352 faixas estavam na tabela: "a grade entrou" | analytics hora a hora: 118.271 linhas em 13 minutos |
| rebuild fazia `DELETE` do futuro antes do `INSERT`; a cota acabou no meio | Disney com só o bloco no ar, sem erro em lugar nenhum | quase saiu do ar; a leitura do `scheduler.ts:305` deu o mecanismo (a chamada exata não foi reconstruída) |
| merge automático juntou **duas implementações** da mesma janela do `/epg` (`durationQuery` da main e `clampWindow` do branch), sem conflito | merge limpo, git satisfeito | `tsc` subiu de 5 para 9 erros (`Cannot redeclare 'past'`) |
| `node_modules/` **com barra** não casa symlink; `git add -A` versionou 3 links absolutos; o fast-forward seguinte fez checkout deles **por cima** dos `node_modules` reais | links apontando para si mesmos, dependências apagadas | testes com `ERR_MODULE_NOT_FOUND`; o horário do reflog bateu com o dos links |
| scratchpad da sessão apagado no reinício, com uma rotina agendada ainda viva | processo vivo, `pgrep` achava | `ls` dos arquivos dela: sumiram. Às 00:02 ela tiraria os índices e morreria antes das vinhetas |
| migration de outra sessão nunca aplicada, e ainda com número repetido (`0026`) | deploy verde | rotas de lineup respondendo 500 ao sondar depois do deploy |
| `pgrep -f nome` casa a **própria linha de comando** de quem pergunta | "processo ainda vivo" depois do `kill` | `kill -0 <pid>` disse que não estava |

⚠️ **Correção de registro:** a mensagem do commit `818f6de` diz que os `ln -sfn`
"rodaram no diretório do repo em vez do worktree". **Isso está errado.** Os links
foram criados no worktree, como era pra ser. Quem os pôs no repo foi o
fast-forward: `feat/playback@{07:58:14}` no reflog, o mesmo minuto dos links. O
git trata arquivo **ignorado** como descartável no checkout e o sobrescreve sem
avisar.

**Regras que saíram destas:**

- Depois de merge, **compare a contagem de erros do `tsc` com a de antes**.
  Merge sem conflito ainda pode duplicar uma feature feita dos dois lados.
- `.gitignore` com `node_modules` **sem barra** (casa diretório e symlink). E
  nada de `git add -A` numa árvore onde você criou symlink de conveniência.
- Rotina que roda por horas fica em `~/.cache/<projeto>/`, **nunca** no
  scratchpad da sessão.
- Aqui as migrations são aplicadas **à mão** e não há `d1_migrations` para
  acusar pendência. Depois de publicar código que depende de coluna nova,
  sonde uma rota que usa essa coluna. Antes de criar migration, confira número
  repetido: `ls packages/db/migrations | cut -c1-4 | sort | uniq -d`.
- Para saber se um processo está vivo, use `kill -0 <pid>`, não `pgrep -f`.
- Resultado "todas as N gravadas" sem conferir o efeito colateral
  (o replan) é o mesmo erro do "69 de 70": conte o efeito, não a chamada.

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

**Front buildado sem `VITE_API_BASE` = admin conversa com o Pages, não com o
Worker (`Unexpected token '<', "<!doctype "…`).** Descoberto em 2026-07-14: ao
tentar analisar uma playlist, o painel deu `✖ Unexpected token '<', "<!doctype
"... is not valid JSON`. NÃO era bug da playlist. O front usa URLs relativas
(`API = import.meta.env.VITE_API_BASE ?? ''`, `AdminApp.vue`) desenhado pra
"produção same-origin" — mas a produção é cross-origin: site no Pages
(`biel-tv.pages.dev`), API no Worker (`…workers.dev`). Um `vite build` pelado
(sem a env) gera `API=''`, então todo `/admin/*` bate no PRÓPRIO Pages → o Pages
devolve `index.html` (`<!doctype html>`, HTTP 200) pra qualquer rota → o
`res.json()` do front tenta parsear HTML e quebra. Confirmação em 1 request:
`curl https://biel-tv.pages.dev/admin/playlist` → `200 text/html <!doctype`. O
Worker NUNCA devolve HTML (Hono → texto; 401 → `text/plain`), então `<!doctype`
minúsculo = veio do Pages/SPA, não do Worker. **Fix:** buildar sempre com
`VITE_API_BASE=https://biel-tv-stream.biel-cesa95.workers.dev` — encapsulado no
script `pnpm web:deploy` (build com a env + `wrangler pages deploy`), pra não
depender de lembrar a env na mão (o `README.md` documenta os 2 comandos crus).
**Pegadinha nº 2 logo atrás:** feature nova = migration nova; o `<!doctype`
some depois do deploy do front, mas aí aparece `500`/"no such table" porque a
migration (ex.: `0014_playlist_ingest.sql`) só foi aplicada no D1 LOCAL. Aplicar
no remoto: `wrangler d1 execute biel-tv-db --remote --file
../../packages/db/migrations/00NN_*.sql` (o `ALTER ADD COLUMN` não é
idempotente — 1x local, 1x remoto; cheque `sqlite_master` antes de reaplicar).

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

## zsh desta máquina: `cmd >arquivo | grep` MEDE ERRADO

O shell aqui é zsh com **MULTIOS ligado** (padrão). Com redireção de stdout
**e** pipe na mesma linha, ele manda pros dois em vez de escolher:

```sh
zsh:   echo OLA >/dev/null | cat   →  OLA        # duplicou
bash:  echo OLA >/dev/null | cat   →  (vazio)    # POSIX
zsh:   unsetopt multios; echo OLA >/dev/null | cat  →  (vazio)
```

**Consequência:** qualquer medição de *"esse comando escreve em stdout ou
stderr?"* feita com `cmd >algo | grep` mede errado — o pipe recebe justamente o
que você achou que tinha desviado. Foi assim que o `metadata=print:file=-` do
ffmpeg pareceu escrever em stderr nas duas variantes (17/17) e quase derrubou um
achado correto (22/09/2026).

⚠️ **Não confunda com a armadilha de ORDEM** (`2>&1 >/dev/null` duplica stderr
pro destino que o stdout tinha *naquele momento*). Ela é real e vale como regra
geral, mas **não** explica este caso: aqui as duas ordens dão o mesmo número,
porque o MULTIOS duplica de qualquer jeito.

**Como medir certo:** arquivos separados sem pipe (`cmd 2>err.txt 1>out.txt`), ou
— melhor — pelo mesmo mecanismo do código que vai usar o resultado (`spawnSync`,
`execFile`). É primo do sequestro de `grep`/`find` documentado no
`~/.claude/CLAUDE.md`: lá o binário é trocado, aqui o binário está certo e quem
mente é o shell.

## Banco de dados (D1/SQLite)

**🔴 O limite do D1 free é LINHAS LIDAS (5 mi/dia), não requisições — e query
sem piso derruba a TV.** Em 2026-09-15 os três canais devolveram HTTP 500 no
`/live` no meio do dia. Não foi audiência: o Worker recebeu **1.499 requisições
em 14h**, todas entre 23h e 01h (um espectador só). O que estourou foi o
**custo por requisição**: a `SQL_EPG_OVERLAP` só limitava o lado direito
(`start < ?3`), então o índice `(canal, start_time_virtual)` varria TODO o
passado do canal guardado na `epg_virtual` — **5.180 linhas por chamada**,
1.113 chamadas = 5,7 milhões de linhas. Corrigido com um **piso** em
`start_time_virtual` (`> ?2 - 6h`, folga sobre a linha mais longa possível):
~200 linhas por chamada. **Antes de criar query nova sobre `epg_virtual`,
`media_items` ou `media_cue_points`, pergunte quantas LINHAS ela varre por
chamada** — e confira no GraphQL:
`d1QueriesAdaptiveGroups(orderBy:[sum_rowsRead_DESC]){count sum{rowsRead} dimensions{query}}`.
O limite zera à meia-noite UTC (21h de Brasília) e, enquanto está estourado,
**qualquer** leitura falha — inclusive o painel e o `wrangler d1 execute`.

**Com a cota de leitura estourada, o que ainda funciona.** O limite do D1 free
bloqueia **leitura** — e a mensagem some até em consulta minúscula. Mas:

| funciona | não funciona |
|---|---|
| R2 (subir/baixar segmento, `/media/*`) | `/live` e `/epg` (leem a grade) |
| ffmpeg/pipeline: baixar, normalizar, segmentar, cue points | registrar mídia no D1 |
| ElevenLabs, GitHub Actions | painel admin, fila da fábrica (claim lê o D1) |
| escrita e DDL no D1 (`INSERT`, `DELETE`, `CREATE INDEX`) | qualquer `SELECT` |

Ou seja: **dá pra processar a leva inteira e registrar depois**. É pra isso que
existe `pnpm ingest ... --adiar-registro`, que sobe pro R2 e grava o SQL do
registro em `.registros-pendentes/<id>.sql`; quando a cota virar (00:00 UTC =
21h de Brasília), `pnpm registra:pendentes` aplica tudo de uma vez e move os
arquivos pra `aplicados/`.

**Apagar mídia em lote custa LEITURA, não escrita.** O `DELETE /admin/media/:id`
pergunta se a mídia está na grade (`... FROM epg_virtual WHERE media_id = ?`) e
depois apaga as linhas dela. Sem índice por `media_id`, cada exclusão varria a
`epg_virtual` inteira duas vezes — 105 exclusões = ~4 milhões de linhas lidas, o
que estourou o limite diário do D1 free e derrubou os canais em 15/09/2026
(**duas vezes no mesmo dia**, a segunda por causa da limpeza). Corrigido pela
migration `0026_epg_media_idx.sql`. Regra geral: antes de rodar QUALQUER laço
que bate no Worker centenas de vezes, olhe quais linhas cada chamada varre.

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

## Replanejar a grade custa caro (e por que isso derruba tudo)

Replan = apagar e reescrever as ~41h futuras do canal na `epg_virtual`. Cada
linha custa uma escrita na tabela **mais uma por índice**. Eram 5 índices
(6 escritas por linha, ~13 mil linhas por canal). A migration 0034 tirou 2, então
agora são 4 escritas por linha. O teto do D1 free é **100 mil linhas/dia**, e sem
cota a fábrica morre junto: `/admin/jobs/claim` também passa a devolver 500.

| operação | um replan por item | em lote |
|---|---|---|
| desativar 19 mídias do mesmo canal (21/09) | **397 mil linhas** | 1 replan |
| ajustar 11 faixas (22/09) | **144 mil** | 1 replan |
| aplicar 352 faixas (23/09) | 9 replans comeram o dia; as outras 343 falharam | 1 por canal |

A cota estourou três dias seguidos por isso. No terceiro, o Disney quase saiu do
ar. A história completa, com cada medição, está em
[features/cota-d1-e-replanejamento.md](features/cota-d1-e-replanejamento.md).

**O que vale desde 23/09/2026:**

- **Endpoint singular não replaneja mais na hora.** `POST`/`DELETE /slots`,
  `/media/:id/tipo`, `DELETE /media/:id` e os cancelamentos do diretor chamam
  `pedeReplan`: esperam 4 s e só o último de uma rajada replaneja. A resposta
  vem com `replan: 'coalescido'`. Se precisar da grade pronta na resposta, use
  o lote.
- **Rotas em lote replanejam na hora, uma vez por canal:**
  `POST /admin/media/status {ids[], status}`,
  `POST /admin/fabrica-comerciais/slots/lote {criar[], apagar[]}`,
  `POST /admin/promessas/lote {decisoes[]}`. O painel manda tudo numa "leva".
- **Rebuild é atômico.** O `DELETE` do futuro vai no mesmo `batch()` dos
  `INSERT`. Falha no meio mantém a grade antiga; não deixa mais o canal vazio.
- **Mexer numa faixa só reescreve dali pra frente** (`desde` =
  `proximaOcorrencia(dias, hora)`), então o guia que o app já mostrou não se
  embaralha.

📌 Ao criar rota nova que mexa na grade: se é por item, use `pedeReplan`; se é
em lote, junte os canais num `Set` e chame `scheduleChannel` uma vez por canal
no fim. O padrão já existia antes (`aplicaCanais`, `reconciliaComerciaisGrade`).

## Fábrica de comerciais / TTS

**Voz clonada morre junto com a assinatura do ElevenLabs.** Desde 15/09/2026 a
API responde `401 ivc_not_permitted` ("Instantly cloned voices are not available
on your current plan") para as vozes dos três canais, que são clonadas. **A
chave continua válida e com crédito** — voz do catálogo público sintetiza
normalmente, foi verificado. Não saia trocando `channels.voz_id`: gere com
`voz_id` de voz pública por parâmetro (todas as rotas de síntese aceitam) e veja
`docs/features/fabrica-comerciais.md` → "Voz provisória" pra receita completa,
inclusive como achar depois (`audio_key` guarda a voz no caminho) e regerar com
a voz clonada quando a assinatura voltar.

## Diretor / LLM (Gemini + DeepSeek)

**Evento (maratona) vence exclusão — de propósito, não é bug.** Em
`scheduler.ts`, o lookup de evento pra um slot de tempo lê `mediaTodas`
(SEM aplicar filtro de exclusão), então uma maratona ativa continua
escalando aquela mídia mesmo se ela (ou a série dela) estiver excluída.
Racional: uma ordem explícita do chat vale mais que uma regra geral. Ao
escrever testes ou debugar "por que X ainda está na grade", **sempre
verificar primeiro se não há um evento ativo cobrindo aquele horário** antes
de suspeitar de bug na exclusão.

**Grade em BLOCOS: episódios da mesma série saem emendados, séries em
rodízio.** Em `scheduler.ts`, `montaBlocos()` agrupa os conteúdos por
`series_id` em pedaços de até `episodios_por_bloco` episódios (em ordem de id)
e intercala as séries com um guloso (a cada passo, o próximo pedaço da série
com mais pedaços restantes que não seja a última — espalha a série longa em
vez de empilhá-la no fim). É o pedido do Gabriel: em vez de 1 episódio de um
desenho pingando às 10h/12h/15h, ele passa 2–4 seguidos e só então troca.
Coisas a saber: (1) **canal SEM `series_id` nos episódios → grade idêntica ao
comportamento antigo** (cada avulso é bloco de 1, sai na mesma ordem
menos-tocado-primeiro de antes) — por isso o agrupamento só "aparece" nas
séries realmente agrupadas no catálogo; (2) `episodios_por_bloco` é **por
canal** (coluna nova, migration 0018, default 2; 1 desliga o agrupamento),
editável no admin (painel "Identidades editoriais") — trocar replaneja o
canal na hora, igual ao `comerciais_fieis`; (3) maratona/evento **não** usa
blocos (tem a própria emenda, caminho intocado); (4) a lógica pura é
testada isolada: `pnpm verify:blocos` (roda o `.ts` direto, sem servidor).
**Migration 0018 (`ALTER ADD COLUMN`) não é idempotente — aplicar 1× local e
1× remoto.** O agendador tolera a falta da coluna (`?? 2` → cai no default,
grupa de 2 mesmo sem migration), mas **editar o tamanho do bloco no admin
quebra sem ela** (UPDATE numa coluna inexistente). Ou seja: sem aplicar em
prod, prod já agrupa de 2, mas o seletor por canal só funciona depois da
migration.

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

**O DeepSeek dá 400 se a palavra "json" não estiver LITERALMENTE no prompt** —
e isso mata o fallback inteiro em silêncio. A API recusa
`response_format: {type:'json_object'}` com `"Prompt must contain the word
'json' in some form"` quando nem o system nem o user contêm a palavra
(qualquer caixa serve: "JSON" passa). **Desenhar o formato com chaves não
conta**: um prompt que termina em `Responda APENAS {"itens":[...]}` toma 400.
Como o `pedeJson` engole erro e devolve `null`, o sintoma não é um erro — é o
recurso "não achar nada". Foi o que derrubou a ingestão da playlist da Raven
(2026-07-15): Gemini em 429 de cota + DeepSeek em 400 por isto = zero
classificação. **Mitigado na fonte:** o `pedeJson` (`llm.ts`) agora testa
`/json/i` no prompt e anexa "Responda em JSON." se faltar — vale por todos os
chamadores, presentes e futuros. Ao escrever um prompt novo, não confie nisso
como desculpa pra omitir; mas saiba que a rede de proteção existe.

**Corolário: um fallback que nunca foi exercitado não é um fallback.** O
`portaoSemantico` e o classificador de playlist tinham fallback de DeepSeek
"pronto" desde a fase 11c e nenhum dos dois jamais funcionou — o Gemini
primário sempre respondeu, e o 400 do DeepSeek só apareceu no dia em que a
cota do Gemini estourou. Ao montar cadeia primário→fallback, **testar o
fallback sozinho** (derrubar o primário de propósito), senão a descoberta vem
no pior dia possível.

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

**A 29,97fps NÃO existe 10,000s exato — aparar mirando o múltiplo cai no quadro
de CIMA.** Achado em 23/09/2026 ao aparar peças curtas pra caberem no bloco de
10s:

```
299 quadros a 29,97fps =  9,977s   ← abaixo do múltiplo, é o que se quer
300 quadros a 29,97fps = 10,010s   ← ACIMA: o pipeline completa pra 20s
```

Quem pede "10.0" ao ffmpeg ganha o quadro de cima e a peça **continua passando
do múltiplo** — e o efeito é caro: o pipeline arredonda pra cima, e uma peça de
10,010s vira bloco de 20s com ~10 segundos de preto. Foi assim que 17 peças
ficaram com metade do bloco vazia sem ninguém notar.

**Regra: mire um quadro ABAIXO do múltiplo**, não o múltiplo. E confira o
resultado com `ffprobe` antes de subir — na primeira passada desta correção,
quatro peças saíram em 10,010s justamente por mirar o valor redondo.

📌 É da família documentada no topo deste arquivo: a peça sai, o job fica
`done`, e só a grade percebe depois. Nada reclama.

## Playlist / ingestão de "episódios em partes"

**Acervo dublado em PT numera `T02E01` — com T de Temporada, não S de Season.**
O `episodioRegex` só conhecia `Episódio N`, `Ep N` e `S02E01`, então nos 111
títulos de "As Visões da Raven" ele achava a PARTE (`(1/5)`) e nunca o
EPISÓDIO → os 111 vídeos caíam em `sem_classificacao` → 0 episódios → o painel
"não acha os pedaços pra unir". Somado ao 400 do DeepSeek (ver "Diretor / LLM"),
foram **duas falhas independentes** escondendo uma à outra. Hoje o regex cobre
`Episódio/Capítulo N`, `Ep N`, `S02E01`, `T02E01` e `2x01`. **Ao ver "não achou
nada" numa playlist, teste o regex nos títulos reais ANTES de culpar o LLM** —
é determinístico e responde em 1 segundo.

**A playlist quase sempre tem vídeo que não é episódio** (abertura,
encerramento, trailer). "As Visões da Raven" = 22 eps × 5 partes + 1 abertura =
111. Cair em `sem_classificacao` é o comportamento CERTO pra esses — não é sinal
de falha do parser. O sinal de falha é `sem_classificacao` ≈ total.

**`waitUntil()` NÃO é confiável pra trabalho longo no dev/miniflare.** A
classificação da playlist (chamada de LLM de ~6s) rodava em
`c.executionCtx.waitUntil(analisaPlaylist(...))` após responder o `/entries` —
e o status ficava preso em `analisando` pra sempre: nem o sucesso nem o `catch`
rodavam (a promise pendurava). O Gemini respondia normal (testado direto por
curl, 5.6s), então não era o LLM. Fix: classificar **síncrono** dentro do
request (`await analisaPlaylist(...)`) — a fábrica não tem pressa. E blindagem
geral em `llm.ts`: `AbortSignal.timeout(30_000)` nos dois fetches, pra um LLM
travado nunca pendurar quem chamou. (extraiPromessa usa waitUntil e "funciona"
porque também é chamado no caminho awaited; não confie no waitUntil pro caso
que SÓ passa por ele.)

**Concat `-c copy` de partes com SAMPLE RATE de áudio diferente = áudio
dessincronizado (e o normalize NÃO conserta).** Descoberto em 2026-07-14
testando a junção com ffmpeg real. `concatParts()` juntava as partes cruas com
`-f concat -c copy` e só conferia se a **duração do container ≈ soma**. Mas
quando as partes têm sample rate divergente (ex.: uma 44,1 kHz + outra 48 kHz —
comum em acervos onde os pedaços foram subidos em épocas diferentes), o concat
demuxer reinterpreta as amostras na timebase errada e o **áudio "escorrega" do
vídeo**: medido, 4s de parte 48k viraram +0,73s de áudio; o container fechava na
duração certa (o skew cabia na tolerância de 2%), então **passava como `copy`** e
o episódio saía com o áudio adiantado — dali pra frente, permanente. Numa parte
real de ~240s isso vira ~13s de desync. O pipeline `normalize()` NÃO conserta
(o skew sobrevive ao re-encode). Causa: a validação olhava só a duração TOTAL,
nunca a sincronia A/V por stream, e o `-c copy` era tentado mesmo com áudio de
parâmetros diferentes.
**Fix:** `concatParts()` agora (1) só tenta `-c copy` se as partes
compartilham codec/sample rate/canais de áudio (`audioUniforme`) — divergiu, vai
direto pro `filter` (que reamostra tudo pra 48k); e (2) mesmo no `copy`, valida o
**skew A/V por stream** (`streamDurations()`, ≤0,5s), não só a duração total —
rede de segurança pra desync de qualquer origem (edit lists, priming, timebase
torta). Resolução/SAR de vídeo diferentes continuam no `copy` de propósito: aí o
`normalize()` reescala e absorve (skew 0,03s), sem re-encode à toa.
`verify-playlist` ganhou o caso que faltava: parte com sample rate diferente tem
que cair pro `filter` **sozinha** (sem `forcarFiltro`) e sair sincronizada — o
buraco de cobertura que deixou o bug passar (o teste antigo só forçava o filter
via `{ forcarFiltro: true }`, nunca exercitava a detecção automática).

**Concat `-c copy` de partes com CODEC DE VÍDEO diferente = os frames de metade
das partes não decodificam (e o erro só aparece na segmentação).** Descoberto em
2026-07-23, reproduzido com a fonte real que quebrou (Feiticeiros S3E01
"Francristina", 5 partes). O YouTube não serve o mesmo codec pra todo vídeo:
baixando com `bv*+ba`, as partes do MESMO episódio vieram `av1, h264, av1, av1,
h264`. O `concatParts()` decidia o `-c copy` olhando só os parâmetros de ÁUDIO —
codec/resolução de vídeo eram liberados de propósito, com o argumento de que "o
normalize reescala e absorve". Isso vale pra **resolução**, não pra **codec**:
o `-c copy` empilha os pacotes numa trilha só, e uma trilha MP4 declara UM
codec. O resultado é um arquivo que o ffprobe mostra saudável (`av1`, 1294.8s,
31043 frames) mas cujo decoder cospe `Unknown OBU type` nas partes h264 —
medido: **100 de 240 frames** sobrevivendo. As duas validações existentes passam
limpas, porque as duas olham TEMPO: a duração total bate (os timestamps somam
certo) e o skew A/V ficou em 0,067s. Os frames é que somem. O estrago só
aparece lá no fim do pipeline, como `segmentação gerou 9, esperava 11` — e essa
mensagem culpa "keyframes fora da grade", que é pista falsa: os keyframes estão
na grade, o que falta é imagem. Foi o que travou 5 jobs de fonte multipartes.
**Fix:** `concatParts()` agora também exige `videoUniforme` (mesmo
`vcodec` em todas as partes) pro caminho `-c copy`; codec divergente vai direto
pro concat filter, que re-encoda tudo pro perfil do canal. Resolução/SAR
diferentes continuam no `copy` de propósito (aí o normalize absorve mesmo).
`verify-playlist` ganhou o caso: parte com codec de vídeo diferente tem que cair
pro `filter` sozinha **e o juntado tem que decodificar inteiro** — a asserção é
em FRAMES DECODIFICADOS, não em duração, senão o teste não pegaria este bug.

## Telas com vídeo (`/r`, `/r/cortar`)

**`<video controls>` ROUBA o teclado, e o `preventDefault()` chega tarde.**
O controle nativo do Chrome vive num shadow DOM e trata a tecla no próprio
listener ANTES do evento bubblar até o `document` — então um
`addEventListener('keydown')` na página não consegue cancelar o
comportamento dele: os dois acontecem e SOMAM. Medido na página no ar
(playwright, `/r/cortar`): depois de clicar no player, `←` andava **−7.19s**
em vez de −1s (nosso −1 + o −5 nativo + drift), e `espaço` não fazia nada
(nós dávamos play, o nativo dava pause em seguida). Se a tela tem atalho
próprio, **não use `controls`** — desenhe a régua/transporte na mão
(pointer events); sem controle nativo não há foco pra roubar. Foi a causa
raiz do "mudei o momento do vídeo e a marcação sai" que o Gabriel reportou.

**Seta com `<select>` focado troca a opção — e leva o estado da tela junto.**
O padrão `if (e.target.tagName === 'SELECT') return` no handler global parece
proteger, mas faz o contrário do que aparenta: ele só desiste de tratar a
tecla, e aí o comportamento NATIVO do select roda inteiro — muda o valor,
dispara `change`, e o `onchange` recarrega tudo. Na v1 do marcador isso
trocava de compilado e **apagava todas as marcas**, sem aviso e sem desfazer;
como escolher o compilado no dropdown é a primeira coisa que se faz na tela, o
foco já estava lá. Resultado: a tabela `cortes_marcados` ficou VAZIA em
produção por dias — ele marcava, perdia, e nunca chegava a salvar. Fixes que
valem juntos: `blur()` no `change`, e **rascunho em `localStorage`** por item,
que torna a troca (proposital ou não) barata em vez de fatal.

**Campo de texto na tela come os atalhos — e some com a ação, calado.**
Com um `<input>` de nome por linha, o mesmo guard (`if target === 'INPUT'
return`) faz o `I`/`F` virarem LETRA dentro do campo: o nome sai "Tempestade
Ninjaif" e a marcação seguinte simplesmente não acontece, sem erro nenhum.
Sempre dar a saída explícita: `Enter`/`Esc` → `blur()`. Achado pelo teste, não
pela leitura — e ele *passou* na primeira rodada por acidente (a asserção
casava com um buraco que já existia por outro motivo).

**`el.style.display = ''` cai no `display:none` do CSS, não em "visível".**
Limpar o estilo inline devolve o controle pra folha de estilo — e se a regra
declara `display:none` como default (caso do `#ab`, o bloco da peça aberta), o
elemento continua invisível com `left`/`width` perfeitamente calculados.
Modelo certo, tela muda: nenhum teste de estado pega isso, só olhar o pixel
(ou `getComputedStyle`). Use `'block'` explícito.

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

**`waitUntil: 'networkidle'` é roleta em página com HLS.** O hls.js fica
baixando segmento continuamente (`maxBufferLength: 300` = dezenas de MB), então
"rede parada por 500ms" pode não chegar nunca — o `goto` do
`verify-marcador.mjs` passava local e estourava contra produção, de forma
intermitente. Use `domcontentloaded` + um `waitForFunction` num sinal do
**próprio app** (ex.: `typeof cur !== 'undefined' && cur`).

**`boundingBox()` medido antes do vídeo carregar aponta pro lugar errado.**
Até o `<video>` saber a própria proporção ele não tem altura; quando o
metadata chega, tudo abaixo dele escorrega — e um clique/arrasto em coordenada
velha erra o alvo e falha por motivo nenhum. Sintoma exato que isso deu: o
teste da régua acusou "arrastar não busca" enquanto o clique (feito 1s antes,
com a mesma box) passava. Fix: `waitForFunction(() => $('#v').readyState >= 1)`
antes de medir, e remedir a box a cada gesto.

**Playwright: `innerText` devolve o texto RENDERIZADO — inclusive
`text-transform: uppercase` do CSS.** Os `h2` dos cards do admin usam
uppercase via CSS, então `document.body.innerText.includes('Uploads
interrompidos')` NUNCA casa (o texto rendido é "UPLOADS INTERROMPIDOS")
enquanto o elemento existe normalmente no DOM. Em `waitForFunction`, compare
com `textContent` (ignora CSS) ou normalize o case. Já causou um ❌
falso num check cujo passo seguinte (que dependia do mesmo elemento) passava.
