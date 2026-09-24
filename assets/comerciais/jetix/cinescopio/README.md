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

A abertura tem 10 segundos e já cabe no contrato atual do player. A saída e o
retorno aprovados têm 5 segundos cada. Eles estão preservados no R2 como MP4s
editoriais, mas não devem passar pelo pipeline atual sem adaptação: ele completa
toda mídia para segmentos de 10 segundos e acrescentaria 5 segundos de preto.
A integração deve preservar os 5 segundos originais, sem desacelerar o mascote,
repetir a peça ou congelar o quadro final.
