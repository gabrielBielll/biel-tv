# Módulo de comerciais Cartoon Network

> **Estado em 2026-09-22:** primeiro protótipo local gerado; identidade visual,
> trilha, locução e encerramento ainda aguardam aprovação auditiva/visual de
> Gabriel. Automação e publicação permanecem desativadas.

## Primeira amostra

```text
videos_prontos/cartoon_network/amostra-voce-assistindo-depois-mais-tarde.mp4
```

Estrutura de 20 segundos:

1. `VOCÊ ESTÁ ASSISTINDO` — Billy e Mandy;
2. `DEPOIS` — Laboratório de Dexter;
3. `MAIS TARDE` — Meninas Superpoderosas;
4. encerramento animado do Cartoon Network no último segundo.

O render usa `image-comercial-cartoon-3telas.png`, barras pretas com texto
branco e filetes ciano/amarelo alinhados abaixo das janelas. A voz usada é a
Larissa provisória preservada em
`assets/comerciais/cartoon_network/falas/lineup-billy-dexter-meninas-larissa-provisoria.mp3`.

## Áudio do protótipo

A fonte integral está preservada em:

```text
assets/comerciais/cartoon_network/referencias/fonte-cartoon-summer-video-Zx7ogrmxk5w.m4a
```

Para a amostra, os primeiros 20 segundos foram normalizados e preservados em:

```text
assets/comerciais/cartoon_network/moldes/trilha_cartoon_lineup_3janelas.m4a
```

Essa faixa é provisória. Antes da aprovação final ainda pode ser necessário
escolher outro trecho da referência, criar um loop ou ajustar seu volume sob a
locução. O fechamento usado está em
`assets/comerciais/cartoon_network/moldes/final_cartoon_network_0s93.mp4`.

## Validação técnica da amostra

- duração: 20,000 s;
- vídeo: H.264, 1280×720, `yuv420p`;
- áudio: AAC, 48 kHz, estéreo;
- loudness integrado: -16,6 LUFS;
- true peak: -1,5 dBFS.

O protótipo não foi enviado ao R2/D1 e não integra a grade. O objeto
`automation` de `assets/comerciais/cartoon_network/lineup.config.json` deve
continuar com `enabled: false` até a aprovação.
