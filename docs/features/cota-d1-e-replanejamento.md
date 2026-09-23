# Cota de escrita do D1 e o custo de replanejar a grade

> **Estado (23/09/2026):** as três defesas de código estão no ar (Worker
> `88b3eb23`). A migration 0034, que tira 2 índices, e a 0035, do lineup
> remoto, estão **agendadas para 21:00 SP** junto com as condições das
> vinhetas, por uma rotina em `~/.cache/bieltv-21h/` (ver
> [Pendências](#pendências-e-como-conferir)).
>
> **Em uma frase:** replanejar a grade reescreve ~41h de linhas, e o D1 gratuito
> só aceita 100 mil linhas escritas por dia. Tudo aqui existe para que mexer na
> grade não tire a TV do ar nem mate a fábrica.

Leia junto: a seção [Replanejar a grade custa caro](../GOTCHAS.md#replanejar-a-grade-custa-caro-e-por-que-isso-derruba-tudo)
do GOTCHAS (a regra curta) e [comerciais-condicionais.md](comerciais-condicionais.md)
(as vinhetas ligadas no mesmo dia).

---

## O incidente de 23/09/2026

A cota estourou pelo terceiro dia seguido. Desta vez o Disney quase saiu do ar.

**Escrita por hora (UTC), medida no GraphQL de analytics da Cloudflare:**

```
00:00Z (21h SP)      693 linhas
01:00Z (22h SP)      298
02:00Z (23h SP)        0
03:00Z (00h SP)  118.271   ← 1.725 queries de escrita
                 ───────
                 119.262 de 100.000
```

**O que aconteceu às 03:16Z:** a grade nova, com 352 faixas, foi aplicada com
**uma chamada HTTP por faixa** no endpoint singular `POST /admin/fabrica-comerciais/slots`,
a ~6 chamadas por segundo:

```
03:16:30 → 03:16:48   cartoon_network   103 faixas
03:17:12 → 03:17:30   disney_channel    107
03:18:00 → 03:18:20   jetix             123
03:29                                   +19
```

O endpoint fazia `INSERT` da faixa e depois `scheduleChannel(canal, 48, true)`,
**um replan por chamada**. Um replan custava ~13 mil linhas, e sobravam ~99 mil
no dia: davam **7,6 replans**. O medido foi ~9. As ~343 chamadas restantes
gravaram a faixa, porque o `INSERT` vem antes do replan, e morreram no replan.
Por isso **as 352 faixas existiam na tabela** e mesmo assim a grade só tinha
sido refeita em parte. Parecia sucesso. Era sucesso parcial, sem erro visível.

**Por que o Disney quase saiu do ar:** o rebuild **apagava o futuro antes de
reescrever**:

```js
// scheduler.ts, antes
if (rebuild) {
  await env.DB.prepare('DELETE FROM epg_virtual WHERE canal = ?1 AND start_time_virtual >= ?2')...
}
// ... planeja ... e só no fim faz os INSERT
```

Quando o `DELETE` passava e o `INSERT` batia no teto, o canal ficava só com o
bloco que estava no ar. Grade vazia vira 404 no `/live` (ver o death-spiral em
[GOTCHAS](../GOTCHAS.md)).

Essa é a explicação que bate com os dados, mas não é uma reconstrução exata.
O teto do D1 é aplicado com atraso: o dia fechou 18 mil linhas acima do
limite, então não dá para saber em que chamada as escritas começaram a falhar.
Também não ficou provado qual rebuild deixou o Disney vazio. O conserto não
depende disso, porque fecha a classe inteira: nenhum rebuild consegue mais
apagar sem gravar.

⚠️ O endpoint em lote (`/slots/lote`, que replaneja uma vez por canal) já
existia e estava publicado. **Não foi ele que foi usado.** Isso orientou tudo o
que veio depois: não dá para depender de quem chama escolher a rota certa.

---

## As quatro defesas

### 1. Rebuild atômico (`da29a9d`)

**Motivo:** estouro de cota, timeout ou qualquer falha no meio do rebuild não
pode deixar o canal vazio.

**O que mudou:** o `DELETE` do futuro agora viaja no **mesmo `batch()`** dos
`INSERT`. O `batch()` do D1 roda numa transação e desfaz tudo se qualquer
statement falhar. Ou a grade nova entra inteira, ou a antiga continua no ar.

**A consequência que deu trabalho:** o `DELETE` rodava antes das leituras do
planejamento, e elas contavam com o futuro já apagado. Agora ele roda depois,
então as quatro leituras que dependiam disso passaram a filtrar por um `cut`:
cobertura (`MAX(end)`), futuro agendado (`futuroDe`), borda de downtime (`ult`)
e a consulta de reprise. Fora do rebuild, `cut = SEM_CORTE`
(`Number.MAX_SAFE_INTEGER`) e o filtro fica sempre verdadeiro.

**Duas armadilhas irmãs que apareceram junto:** quando o rebuild desistia por
"horizonte já coberto" (`t >= target`) ou "laço sem linhas", **o futuro já tinha
sido apagado** e a função voltava `added: 0` com o canal zerado. Agora ela
desiste sem apagar nada. Rebuild que não produz linha devolve
`skipped: 'rebuild sem linhas: grade anterior mantida'`.

### 2. Replan coalescido: `pedeReplan` (`da29a9d`)

**Motivo:** o endpoint singular é o que scripts, outras sessões e até a memória
do assistente mandavam usar. Endpoint precisa ser **seguro por construção**, não
por disciplina de quem chama.

**Como funciona:** cada chamada grava uma marca única em
`config['replan_pedido:<canal>']` e espera **4 s** (`DEBOUNCE_REPLAN_MS`). Quem
ainda encontra a própria marca é o último da rajada e replaneja. Os outros cedem
sem escrever nada. **352 chamadas viram 1 replan por canal.**

- **Por que 4 s:** a rajada medida foi ~6 chamadas por segundo. 4 s cobrem a
  rajada com folga sem deixar o ajuste manual com cara de travado.
- **A marca só some depois do replan dar certo.** Rajada interrompida (waitUntil
  morto, cota, Worker reciclado) deixa o pedido de pé, e o cron termina: o
  `runScheduler` varre `replan_pedido:%` e faz rebuild dos canais marcados.
- **A reconciliação de comerciais também entrou no debounce.** Antes rodava uma
  por chamada, 352 vezes.

**Ligado em:** `POST`/`DELETE /slots`, `/media/:id/tipo`, `DELETE /media/:id`,
cancelar diretriz e cancelar evento. Esses endpoints respondem na hora com
`replan: 'coalescido'`. **Os endpoints em lote continuam replanejando na hora**:
quem pediu muito paga uma vez e já recebe a grade pronta na resposta.

### 3. Rebuild parcial: `desde` (`8011362`)

**Motivo principal: a grade parava de se embaralhar.** Economizar cota vem em
segundo lugar. Todo rebuild descartava as ~41h seguintes e remontava em ordem
nova, então o guia que o app já tinha mostrado mudava debaixo de quem lia. Mexer
numa faixa das 21:30 reordenava a manhã.

**O que mudou:** `scheduleChannel(..., desde)` corta o futuro a partir do
instante pedido, nunca antes do fim do bloco no ar. Os endpoints de faixa passam
`proximaOcorrencia(dias, hora)`, que é quando a faixa nova (ou removida)
passa a valer.

**Economia medida** com as linhas reais de 23/09:

```
faixa das 21:30 → preserva 52% da grade   43.000 → 21.000 linhas
faixa das 15:00 → preserva 36%             43.000 → 27.000
faixa das 08:00 → preserva 19%             43.000 → 35.000
```

**A corrida que precisou de cuidado:** numa rajada, o `desde` tem de ser o
**menor** de todos. Se uma chamada mexe nas 07:00 e outra nas 21:30, replanejar
só das 21:30 deixaria a faixa das 07:00 valendo no papel e não na grade. As
chamadas são concorrentes, então o mínimo é calculado **dentro do UPSERT**:

```sql
INSERT INTO config (k, v) VALUES (?1, ?2)
ON CONFLICT(k) DO UPDATE SET v = CAST(min(CAST(v AS INTEGER), CAST(?2 AS INTEGER)) AS TEXT)
```

Ler, decidir e escrever em JS perderia a corrida, e perder significa faixa que
não entra no ar. Pedido sem `desde` vale 0 e força a rajada inteira a fazer
rebuild total, que é o lado seguro.

⚠️ **Num lote que refaz a grade inteira, o desconto é zero**: sempre há uma
faixa de manhã, então o corte volta para "agora". Está certo assim, porque não
há o que preservar. Quem barateia esse caso é a defesa 4.

### 4. Dois índices a menos: migration 0034 (`7182060`)

**Motivo:** `epg_virtual` tinha 5 índices, então cada linha custava 6 escritas.
Escrita é o recurso escasso aqui; leitura sobra.

Os dois índices removidos só existiam para consultas **globais** (sem `canal`
no filtro). Essas consultas foram fatiadas por canal e agora usam os índices
compostos que já existiam:

| índice removido | quem usava | agora |
|---|---|---|
| `idx_epg_start (start_time_virtual)` | `futuroDe`, `commitAired` | uma fatia por canal pelo `idx_epg_lookup (canal, start, end)` |
| `idx_epg_fim (end_time_virtual)` | limpeza da retenção | um `DELETE` por canal pelo `idx_epg_canal_fim (canal, end)` |

**Medido em produção antes de mexer** (`epg_virtual` com 14.603 linhas),
`rows_read` da forma global contra a soma das fatias:

```
futuroDe      7.102 → 7.104
commitAired  13.579 → 13.581
retenção          1 → 3
```

São 6 linhas lidas a mais por run do agendador. **Também conferi que o
resultado é idêntico**, e não só parecido: rodando as duas formas nos dados
reais, vieram os mesmos 463 registros no `futuroDe` e os mesmos 435 no
`commitAired`, sem nenhuma divergência. O `GROUP BY` continua cruzando canais
de propósito (mídia sindicada: Padrinhos no Jetix e no Disney continua de onde o
outro canal parou). A única diferença é que o máximo entre canais passou a ser
calculado no JS.

**Ganho:** cada linha passa de 6 para 4 escritas. Um replan dos três canais
cai de **~43 mil (43% da cota) para ~29 mil (29%)**.

🔴 **Ordem obrigatória: código antes, migration depois.** O código antigo usava
`INDEXED BY idx_epg_start`, que vira erro de SQL assim que o índice some. O
código novo funciona com ou sem os índices.

---

## Por que a defesa 3 veio antes da 4

Vale registrar, porque a primeira recomendação estava errada.

A primeira proposta foi fazer a 4 antes, porque dá 33% fixos em toda escrita.
Para a 3 foi citado "50–80%", **sem medir**. Medido, a 3 dá em média ~29% numa
faixa qualquer: **empata** com a 4 em cota.

O erro maior foi comparar as duas **só por cota**. A cota só dói nos dias em
que se mexe muito. O embaralhamento do guia acontece a cada ajuste, e a 4 não
resolve isso. A 3 também não precisava de migration e pôde ir ao ar no mesmo
dia. O Gabriel questionou a ordem e estava certo.

As duas se somam: numa faixa da noite, com a 3 e a 4 juntas, o replan fica ~48%
mais barato.

---

## Custo de referência (23/09/2026)

Linhas futuras por canal e custo de um rebuild total:

```
                linhas futuras   com 5 índices   com 3 índices (0034)
cartoon_network        871          10.452              6.968
disney_channel       1.435          17.220             11.480
jetix                1.277          15.324             10.216
                                   ───────             ──────
três canais                         42.996             28.664
```

O Disney tem 65% mais linhas que o Cartoon para as mesmas ~41h porque é ~88%
comercial, e comercial é linha curta. **Cada série nova que entra no Disney
também deixa o replan dele mais barato.**

---

## Pendências e como conferir

A rotina `~/.cache/bieltv-21h/aplica-21h.sh` espera 00:02 UTC (21:02 SP) e roda,
nesta ordem:

1. **Migration 0035** (colunas do lineup remoto do outro chat, nunca aplicada:
   as rotas `/lineup-jobs*` davam 500 em produção).
2. **Migration 0034** (tira os 2 índices).
3. **Condições das vinhetas** (`scripts/vinhetas-condicoes.mjs --aplicar`, uma
   chamada ao `/promessas/lote`).

Ela fica fora do scratchpad da sessão **de propósito**: o scratchpad é apagado
quando a sessão reinicia, e foi assim que a primeira versão dessa rotina morreu
(o processo continuou vivo, mas os arquivos dele sumiram).

**Para conferir no dia seguinte:**

```sh
cat ~/.cache/bieltv-21h/aplica-21h.log
# índices que devem sobrar: idx_epg_lookup, idx_epg_media, idx_epg_canal_fim
# preview de id falso do lineup: 404 (era 500)
```

Se o log estiver vazio, o Termux foi encerrado durante a noite. Nesse caso,
rode o script à mão depois das 21:00. Ele é idempotente: `DROP INDEX IF EXISTS`,
`CREATE INDEX IF NOT EXISTS`, e `ADD COLUMN` repetido só devolve "duplicate
column".

**Testes:** `pnpm verify:replan` (`scripts/verify-replan-atomico.mjs`, 21
checagens) cobre batch atômico, desistência sem apagar, debounce (20 pedidos → 1
replan), varredura do cron, `desde` pelo mínimo e retenção fatiada.
