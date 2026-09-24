# Cinescópio — saída e retorno de intervalo

Peças locais de cinco segundos montadas a partir da entrada do Cinescópio,
do fechamento com o mascote usado no lineup Jetix e dos dois recortes de áudio
indicados no vídeo de referência.

A fonte visual original fica preservada em `_fontes/` e não deve ser ingerida.
O áudio integral de referência fica em `referencias/`. As minutagens, hashes e
nomes de saída estão fechados em `manifesto.json`.

Para gerar as duas versões:

```bash
node scripts/monta-cinescopio-jetix.mjs
```

As versões oficiais — abertura, saída e retorno — ficam juntas em
`videos_prontos/cinescopio_jetix/`. Os scripts de montagem não cadastram nem
agendam as peças. A publicação no R2 usa o prefixo editorial
`editoriais/jetix/cinescopio/`; a integração com a grade permanece separada e
`publicacao_automatica` continua desligada.

A abertura, a saída e o retorno oficiais têm 10 segundos e cabem no contrato do
player. Na saída e no retorno, os 5 segundos originalmente aprovados permanecem
intactos no centro, com 2,5 segundos antes e 2,5 segundos depois. Os respiros
usam micro movimento nos quadros de entrada e saída, evitando preto ou
congelamento aparente; o mascote mantém a velocidade normal. As versões
originais de 5 segundos estão arquivadas no R2 sob
`editoriais/jetix/cinescopio/arquivo-5s/`.

As peças de 10 segundos estão no catálogo como
`vin_jetix_cinescopio_saida` e `vin_jetix_cinescopio_retorno`, ambas exclusivas
da Jetix e condicionadas a `series_id: cinescopio`, nos momentos `saida` e
`volta`. Elas não entram no rodízio genérico. Só aparecem no EPG quando houver
conteúdo de filme associado à sessão Cinescópio.
