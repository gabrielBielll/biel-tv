# Feature: polimento noturno (tarja preta + volume) — backlog

> Especificado em 2026-07-14 a partir de um pedido do Gabriel.
> Estado: 📦 BACKLOG (planejado, não implementado).
>
> **A ideia em uma frase:** o Gabriel sobe os vídeos e eles entram no ar na
> hora, mesmo "zuados" (com tarja preta e áudio desnivelado); um **cron de
> madrugada** varre o catálogo e conserta cada um — sem ele fazer nada.

## O problema (dois, distintos)

1. **Tarja preta.** Muitos desenhos/comerciais entram com barra preta — às
   vezes **na lateral** (conteúdo 4:3 num quadro 16:9) e às vezes **em cima/
   embaixo** (letterbox "assado" no vídeo que alguém subiu).
2. **Volume desnivelado.** Uns vídeos entram MUITO mais altos que outros — hoje
   o pipeline **não normaliza loudness nenhum** (o `-af` em `ffmpeg.mjs:79` é só
   `aresample=48000,apad`).

## O medo que motivou isto — e por que ele NÃO se concretiza

O Gabriel está subindo muitos vídeos e com medo de "no futuro não dar pra
normalizar". **Dá — retroativamente, em qualquer vídeo.** A garantia é
estrutural: **cada mídia vira segmentos `.ts` no R2** (`media/<id>/segNNNNN.ts`,
ver `upload.mjs`), e esses segmentos são uma **cópia completa e reproduzível**
do vídeo. Mesmo depois que o arquivo original é apagado
(`factory-local.mjs` deleta o `src` no `finally`), o master reconstrói:

1. baixa `media/<id>/seg*.ts` do R2 (em ordem);
2. junta com `-f concat -c copy` (sem re-encode) → mp4 inteiro de novo;
3. roda o tratamento novo (recorte + loudness) em cima;
4. re-segmenta e sobe pro **mesmo** prefixo `media/<id>/`;
5. re-registra no D1 (`buildRegisterSql` já é `INSERT OR REPLACE` — idempotente).

Como a duração não muda, `segment_count` e `duracao_seg` continuam iguais →
**a grade (EPG) nem precisa ser mexida.** Nada do que já foi ingerido fica
preso. Único custo honesto: reprocessar a partir do `.ts` é um re-encode de 2ª
geração (o `.ts` já é H.264 CRF 23) — perda visual mínima nesse CRF.

**Pros jobs de LINK/PLAYLIST é ainda melhor:** a URL fica salva no D1
(`ingest_jobs.source_url` / `source_urls`), então dá pra **rebaixar do zero** e
tratar a fonte pristina — 1ª geração, zero perda.

## As duas correções técnicas

### 1. Tarja — `cropdetect` (com uma nuance importante)

O `normalize()` faz `scale=…force_original_aspect_ratio=decrease` + `pad=1280:720`
— preserva proporção e preenche o resto com preto. São dois casos diferentes:

- **Tarja "assada" no vídeo** (letterbox que já veio dentro dos pixels da
  fonte). Hoje o pipeline escala o quadro inteiro *com a barra junto* → a barra
  fica. **Correção limpa e sempre-boa:** o filtro **`cropdetect`** analisa os
  frames, acha a borda preta e devolve um `crop=w:h:x:y`; aplica ANTES do scale
  e a barra some. Resolve a maioria dos casos (filmes/comerciais letterboxed,
  uploads mal cortados). O recorte **não muda duração** → a regra de ouro dos
  10s continua intacta (ver ARQUITETURA.md).
- **Conteúdo 4:3 de verdade** (desenho quadrado num canal 16:9). Aqui **não há
  barra "a mais" pra remover** — a tarja lateral é o resultado honesto de
  mostrar 4:3 em 16:9. Encher a tela exige uma decisão de gosto:
  - `fit` (padrão recomendado): mantém 4:3 com pillarbox — honesto, não corta
    imagem;
  - `fill`: zoom-crop pra 16:9 (`force_original_aspect_ratio=increase` +
    `crop=1280:720`) — enche a tela mas corta ~25% de cima/baixo;
  - `stretch`: estica (distorce) — evitar.

  Proposta: **política por-item/por-canal**, padrão `fit`, e o operador marca
  itens específicos como `fill` no catálogo.

**Cuidado com `cropdetect`:** cenas escuras / fade-to-black enganam uma detecção
de passada única. Boa prática: amostrar o crop em vários timestamps (ou varrer o
arquivo e pegar o crop mais conservador), exigir dimensões pares e travar em
proporções sãs pra nunca cortar demais.

### 2. Volume — `loudnorm` (EBU R128)

Adicionar o filtro **`loudnorm`** ao `-af`. Duas passadas = fiel:

```
# pass 1 (só mede, rápido, só áudio): loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json
# pass 2 (aplica): loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=…:measured_TP=…:…:linear=true
```

- **Alvo recomendado: I=-16 LUFS / TP=-1.5 dBTP / LRA=11** — volume de conteúdo
  web/streaming (broadcast puro seria -23, mais baixo). *Decisão aberta pro
  Gabriel confirmar.*
- **Pular quando o vídeo não tem áudio** (o pipeline injeta `anullsrc` de
  silêncio — não faz sentido normalizar silêncio; guardar em `hasAudio`).
- 1 passada (`loudnorm` dinâmico direto no `-af`) é mais barata e "boa o
  bastante" pra só nivelar; 2 passadas é o certo pra consistência de canal.

## Arquitetura: os dois caminhos (não é um OU outro)

| | O que faz | Cobre |
|---|---|---|
| **A. Corrigir o pipeline** (`ffmpeg.mjs` `normalize()`) | cropdetect + loudnorm viram parte da normalização | tudo ingerido **daqui pra frente** já nasce limpo |
| **B. Job de reprocessamento** + **cron noturno** | varre o catálogo, reconstrói do R2 (ou rebaixa do link) e re-trata | **o backlog** já no ar **e** "polir esse arquivo específico" |

### O cron noturno (a ideia do Gabriel)

O Worker já tem o gancho: `scheduled()` roda no cron `0 6 * * *` UTC = **03:00
São Paulo** (`index.ts:124`, `wrangler.toml:26`), fazendo reconcile → editorial
→ scheduler → `dispatchSeTemFila`. O polimento entra como mais um passo:

1. **Marcar o que falta polir.** Coluna nova em `media_items`, ex.
   `polido_em INTEGER` (NULL = ainda cru). Toda ingestão ANTERIOR ao fix do
   pipeline nasce com `polido_em = NULL`; ingestões novas (pós-fix) já nascem
   polidas (`polido_em = unixepoch()`).
2. **De madrugada, enfileirar.** O `scheduled()` seleciona N mídias
   `status='ready' AND polido_em IS NULL` e cria jobs de reprocessamento
   (`ingest_jobs` com um tipo/flag novo apontando pro `media_id`). **Rate-limit**
   por noite pra nunca estourar o free tier de runner (2000 min/mês) — e
   **logar quantas ficaram pra próxima** (regra da casa: nada de corte
   silencioso).
3. **A fábrica reprocessa.** Novo caminho no `factory-local.mjs`: se o job é de
   reprocessamento, ele **reconstrói o master do R2** (baixa os `.ts`, concat
   `-c copy`) — ou **rebaixa do `source_url`** quando existir e a gente quiser 1ª
   geração — roda o `normalize()` novo, re-segmenta, sobe no mesmo prefixo e
   marca `polido_em`.
4. **Grade intacta.** Mesma duração → mesmo `segment_count` → EPG não muda.

### Barato quando só falta o áudio

Se o ÚNICO problema de um item é o volume (sem tarja), dá pra pular o re-encode
de vídeo: **`-c:v copy -af loudnorm -c:a aac`** → re-segmenta (`-c copy`, os
keyframes já estão na grade) → sobe. **Muito** mais barato que re-transcodificar.
O reprocessamento pode escolher: `audio` (barato) vs `full` (crop + áudio).

### Per-file (sob demanda)

Botão **"✨ polir agora"** num item do catálogo → enfileira 1 job de
reprocessamento na hora. Mesmo motor do cron, só que disparado à mão.

## Modelo de dados (esboço)

- `media_items.polido_em INTEGER` (NULL = cru; timestamp = polido).
- `media_items.metadata.aspecto` = `'fit' | 'fill' | 'stretch'` (padrão `fit`),
  editável no catálogo — política por-item da tarja.
- `ingest_jobs`: reusar a tabela com um tipo/flag de reprocessamento + o
  `media_id` alvo + o modo (`audio` | `full`).
- (Opcional, à prova de futuro) arquivar o **master original** em `masters/<id>`
  no R2 pra reprocessos futuros começarem sempre da 1ª geração — custa storage,
  mas o caminho via `.ts` já deixa seguro sem isso.

## Cuidados / pegadinhas

- **`cropdetect` em conteúdo escuro** — amostrar vários pontos, crop conservador,
  dimensões pares, travar proporção (ver acima).
- **Reprocesso do `.ts` = 2ª geração** — aceitável no CRF 23; pros jobs de link,
  preferir rebaixar do `source_url` (1ª geração).
- **Custo de runner** — varredura de catálogo inteiro re-encoda vídeo (o passo
  caro). Mitigar com rate-limit noturno + modo `audio` (stream-copy) quando só
  falta volume.
- **`loudnorm` em silêncio** — pular quando `hasAudio` é falso.
- **Idempotência** — reprocessar 2× o mesmo id é seguro (`INSERT OR REPLACE` +
  mesmo prefixo R2); marcar `polido_em` evita re-fila infinita.
- **Bloco no ar** — o replanejamento da grade já preserva o bloco tocando agora;
  reprocessar um `media_id` que está no ar naquele segundo é raro, mas vale
  respeitar a mesma janela que a deleção física respeita (fase 11b).

## Decisões abertas (pro Gabriel confirmar antes de implementar)

1. **Volume-alvo:** -16 LUFS (web/streaming, recomendado) ou -23 LUFS
   (broadcast, mais baixo)?
2. **4:3 de verdade:** padrão `fit` (barra lateral, sem cortar) e marcar `fill`
   item a item — ou `fill` como padrão?
3. **Fonte do reprocesso noturno:** reconstruir do R2 (sempre funciona, 2ª
   geração) por padrão, e rebaixar do link só sob demanda? (recomendado)

## Reaproveita o que já existe

- Pipeline `normalize()`/`segment()`/`detectBlack()` — só ganham `cropdetect` +
  `loudnorm`; o resto do fluxo é intacto.
- Fila `ingest_jobs` + claim + progresso % + self-heal de job preso — prontos.
- Cron `scheduled()` do Worker (reconcile → editorial → scheduler → dispatch) —
  o gancho de madrugada já existe.
- Download por `source_url` (fase 11d) + cookies self-service — pro reprocesso
  que prefere rebaixar a fonte.
- Upload R2 com retry por segmento — pronto; falta só o **download** dos `.ts`
  do R2 (a operação inversa) pro caminho de reconstrução.
