# Teatro Cartoon — aberturas editoriais

Aberturas locais de dez e vinte segundos construídas com três fontes originais
de fachada, saguão e auditório e com o recorte de bilheteria indicado no vídeo
de referência. A versão estendida de vinte segundos é a peça oficial. As fontes
ficam preservadas em `_fontes/` e `referencias/` e não devem ser ingeridas como
peças finais.

Para gerar a abertura curta:

```bash
node scripts/monta-abertura-teatro-cartoon.mjs
```

Para gerar a abertura estendida:

```bash
node scripts/monta-abertura-teatro-cartoon-estendida.mjs
```

A saída curta de revisão fica em
`videos_prontos/cartoon_network/teatro/testes/`. A saída oficial fica em
`videos_prontos/cartoon_network/teatro/abertura-teatro-cartoon-oficial-20s.mp4`.
Os scripts de montagem não cadastram, publicam nem agendam as peças.

A publicação oficial usa o `media_id` `vinheta_teatro_cartoon_abertura`. Os
segmentos estão no R2 sob `media/vinheta_teatro_cartoon_abertura/`, e o MP4 de
referência está em
`editoriais/cartoon_network/teatro/abertura-teatro-cartoon-oficial-20s.mp4`.
O registro D1 ficou adiado e com status `disabled`: a integração com a grade é
uma etapa separada e `publicacao_automatica` deve continuar `false` até ela
existir.
