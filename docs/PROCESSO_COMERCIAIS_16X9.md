# Processo de comerciais e programas de acervo em 16:9

Procedimento operacional aprovado pelo Gabriel em 2026-07-31. Use quando um
compilado antigo 4:3 precisar virar peças individuais para a Biel TV, sem
tarjas laterais e sem sacrificar demais a imagem. Serve tanto para comerciais
quanto para chamadas, vinhetas e trechos de programas.

## Resultado visual aprovado

O enquadramento final é **1280×720, H.264, yuv420p, AAC**, com este filtro:

```text
scale=1280:850,crop=1280:720:0:40,setsar=1,format=yuv420p
```

Na prática, ele amplia a fonte 4:3 até 1280 px de largura, aplica uma leve
esticada horizontal (cerca de 13%) e recorta pouco do alto/baixo (40 px no topo,
90 px na base). É o compromisso aprovado: preenche 16:9 sem tarja lateral e sem
perder muito da imagem. Este é o padrão usado nos comerciais Cartoon Network e
Disney de 2009.

Exemplo de renderização precisa a partir de uma fonte preservada:

```bash
ffmpeg -y -hide_banner -loglevel error \
  -ss "$INICIO" -i "$FONTE" -t "$DURACAO" \
  -vf 'scale=1280:850,crop=1280:720:0:40,setsar=1,format=yuv420p' \
  -c:v libx264 -preset medium -crf 18 -profile:v high -pix_fmt yuv420p \
  -c:a aac -b:a 192k -movflags +faststart "$SAIDA"
```

Com reencode, `-ss` antes de `-i` mantém busca precisa e não obriga o ffmpeg a
decodificar o compilado inteiro para cada corte.

## Corte: regra e revisão obrigatória

As minutagens de descrições de acervo são precisas **até o segundo**, não até o
quadro. Portanto, elas dão uma excelente base, mas o fim sempre precisa de
revisão visual/auditiva.

1. Para novos lotes, comece em `início marcado + 1,0 s`. Esse é o padrão atual
   para remover a sobra da peça anterior. O lote inicial histórico usou +0,5 s;
   preserve-o apenas ao refazer exatamente aquele lote.
2. Comece com o `fim marcado` como fim candidato.
3. Assista aos últimos 1,5–2 s e ajuste quadro a quadro: a fala, música e logo
   da peça precisam terminar completos, mas não pode entrar imagem/áudio
   identificável da próxima peça.
4. **Não aplique `+1 s` no fim cegamente.** Em 2026-07-31 ele foi usado para
   recuperar uma fala cortada em 105 peças já publicadas; em algumas fontes a
   margem expôs o começo do comercial seguinte. A correção futura é por item:
   use só a folga que completa a peça atual.

Se houver dúvida entre dois quadros, prefira terminar no último quadro/áudio da
peça atual. Um corte de alguns quadros é menos perceptível do que uma transição
para outro anúncio.

## Fluxo seguro

1. Baixe e preserve o compilado original em `comerciais_16x9/_fonte*.mp4` ou
   `comerciais_16x9/_fontes*/`. Esses arquivos são a fonte de verdade e **nunca
   devem ser ingeridos** como comerciais.
2. Faça um manifesto explícito com `fonte`, `arquivo de saída`, `início`, `fim`
   e o corte inicial. Não selecione arquivos por uma varredura aberta.
3. Renderize primeiro em staging dentro de `.ingest-work/`, valide todos os
   arquivos (1280×720, áudio presente, duração esperada) e só então substitua
   as saídas finais.
4. Mantenha uma cópia local das saídas anteriores antes de trocar. As fontes
   longas também devem continuar guardadas.
5. Faça checagem visual de amostras no começo e, principalmente, no fim de cada
   família de cortes. Para um lote pequeno, revise todos os fins.

O script [refaz-comerciais-mais-um-segundo.mjs](../scripts/refaz-comerciais-mais-um-segundo.mjs)
é o exemplo reproduzível do lote de 105 peças de 2026-07-31: possui manifesto
fechado, staging retomável, validação e backup local. Ele não é um cortador
genérico; copie sua estrutura e faça um manifesto novo para cada fonte/lote.

## Publicação na Biel TV

Use exclusivamente os MP4 finais 16:9. As listas fechadas atuais protegem os
arquivos-base:

- `scripts/ingest-comerciais-locais-restantes.mjs` — 14 cortes iniciais + 38
  comerciais Disney;
- `scripts/ingest-cartoon-network-batch.mjs` — 53 peças do Cartoon Network.

Política editorial já definida:

- anúncios **externos/genéricos** entram em `jetix`, `cartoon_network` e
  `disney_channel`;
- chamadas, vinhetas, interprogramas e produtos que citam a marca/programas do
  Cartoon Network ficam somente em `cartoon_network` (aplique a mesma lógica
  aos equivalentes Disney/Jetix).

Depois do upload remoto, confirme no D1 que todas as peças estão `ready` e
reconstrua a grade do canal afetado pelo endpoint administrativo de schedule.
Reenviar com o mesmo `media_id` troca os segmentos usados pela grade; não crie
um segundo item para a mesma peça.

## Segmentação de 10 s

O player trabalha com segmentos de 10 s. Um pacote final AAC pode fazer um MP4
de exatamente 30 s aparecer como 30,03 s; sem tolerância ele viraria 40 s e
ganharia quase 10 s de tela preta. O CLI trata esse resíduo de até 50 ms em
[`packages/pipeline/src/cli.mjs`](../packages/pipeline/src/cli.mjs), preservando
o conteúdo editorial e evitando o segmento extra.

Antes de encerrar um lote, rode a verificação local com o Node do projeto:

```bash
PATH=/home/gabriel/.nvm/versions/node/v22.23.1/bin:$PATH \
  /home/gabriel/.nvm/versions/node/v22.23.1/bin/node scripts/verify-pipeline.mjs
```
