# Módulo de comerciais Disney Channel

> **Estado em 2026-09-22:** identidade visual, montagem, trilha conclusiva e
> Will como voz reserva aprovados por Gabriel. A fábrica remota já consegue
> produzir uma prévia a partir de um snapshot explícito. Geração automática e
> publicação permanecem desativadas até a confirmação da nova grade.

## Primeira amostra de lineup

```text
videos_prontos/disney-voce-assistindo-depois-mais-tarde.mp4
```

Estrutura-alvo de **19 segundos**, com limite rígido inferior a 20 segundos:

1. `VOCÊ ESTÁ ASSISTINDO` — Os Feiticeiros de Waverly Place;
2. `DEPOIS` — As Visões da Raven;
3. `MAIS TARDE` — Brandy & Sr. Bigodes.

O render usa `image-comercial-disney-3janelas.png`, três janelas simultâneas e
badges azuis arredondados com contorno ciano. O primeiro badge é mais largo e
usa fonte ligeiramente menor para manter `VOCÊ ESTÁ ASSISTINDO` em uma linha.

As cenas devem ultrapassar alguns pixels além das três áreas vazadas; nunca
devem terminar exatamente na borda da máscara. O molde e as cenas usam
reescalonamento Lanczos, e o recorte preto recebe feather suave, evitando
serrilhado ou frestas pretas nas diagonais. O badge `VOCÊ ESTÁ ASSISTINDO` usa
240 px de largura, começa em `x=540` e termina antes do logotipo à direita.

### Direção de voz em avaliação

A primeira locução com Camilla foi reprovada em 2026-09-22: a entrega ficou
desanimada, apresentou timbre estranho, prolongamento de palavras e entonação
ascendente no fim de afirmações. Ela foi preservada somente para rastreabilidade
em
`assets/comerciais/disney_channel/falas/lineup-feiticeiros-raven-brandy-camilla-provisoria.mp3`
e não deve ser usada como referência de produção.

A voz **Will — SP Capital** foi aprovada como reserva enquanto a voz oficial
`pzLPDKHoM8CDtkoDM8X4` permanece pausada. A primeira audição aprovada usa
`eleven_multilingual_v2`, estabilidade `0.42`, similaridade `0.80`, estilo
`0.35` e velocidade `1.08`. Ela está preservada em
`assets/comerciais/disney_channel/falas/audicoes/lineup-will-sp-capital-v1.mp3`.

A segunda audição mantém voz, texto, sotaque e velocidade, alterando somente a
animação: estabilidade `0.38` e estilo `0.50`. O arquivo está em
`assets/comerciais/disney_channel/falas/audicoes/lineup-will-sp-capital-v2-mais-animado.mp3`.

Contrato de direção:

- animação natural de chamada de TV, sem interpretação caricata;
- frases curtas, declarativas e com queda de entonação no final;
- proibir reticências, vogais prolongadas e afirmações pronunciadas como
  perguntas;
- evitar vírgulas desnecessárias antes do nome do canal ou do programa;
- a energia deve vir do ataque e do ritmo, não de pitch artificialmente alto.

O render atualizado é
`videos_prontos/disney-voce-assistindo-depois-mais-tarde-will-sp-capital-v2-animado-19s.mp4`.

## Limite de duração

Os lineups Disney devem mirar **19,0 s** e jamais ultrapassar **20,0 s**. O
segmentador pode completar uma peça maior que 20 segundos com mais um segmento
de 10 segundos, transformando-a indevidamente em 30 segundos. A margem de um
segundo evita essa expansão. O renderizador deve falhar no futuro se a duração
configurada exceder 20 segundos; não deve arredondar nem preencher a saída.

## Biblioteca de trilhas

A fonte integral e sua procedência estão documentadas em
`assets/comerciais/disney_channel/referencias/README.md`. Foram preservadas oito
variações de aproximadamente 10 segundos em
`assets/comerciais/disney_channel/moldes/variacoes/`.

A versão de 19 segundos usa a cama
`trilha_disney_wand_v01_v03_19s_fechamento_inteiro.m4a`: variação 1 na
abertura, variação 3 no segundo bloco e crossfade curto. Para reduzir a duração,
foi removido um segundo do **começo** da cama de 20 segundos, nunca do fim. O
fragmento da fonte a partir do segundo 28 permanece completo no encerramento.
Não há fade de áudio no fim; a própria resolução do instrumental fecha a peça.

Em produção, as variações podem alternar entre comerciais, mas a escolha deve
ser determinística pela revisão da grade. A combinação usada precisa ficar
registrada junto ao artefato gerado para permitir reprodução e auditoria.

## Trava de automação

O objeto `automation` de
`assets/comerciais/disney_channel/lineup.config.json` deve permanecer com
`enabled: false`. Aprovar esta amostra não autoriza usar a grade atual nem
publicar no R2/D1. A liberação exige, separadamente:

1. confirmação explícita da nova grade;
2. snapshot versionado da programação usada;
3. seleção determinística dos três programas e da variação musical;
4. dry-run aprovado antes da publicação.

## Montagem remota reproduzível

A fábrica remota usa a mesma função `montarLineup3Janelas` do teste local. O
Worker guarda o job e o snapshot; o runner do GitHub Actions baixa do R2 as
três amostras e a locução contínua, usa molde/trilha/configuração versionados no
Git e devolve um MP4 privado ao R2.

O endpoint é `POST /admin/fabrica-comerciais/lineup-jobs`. A entrada mínima é:

```json
{
  "canal": "disney_channel",
  "molde_id": "md_eb00f2dcb7",
  "schedule_revision": "grade-confirmada-sha256",
  "window_start": 1790120000,
  "current": {
    "media_id": "ep_feiticeiros",
    "series_id": "os_feiticeiros_de_waverly_place",
    "start": 1790120000,
    "end": 1790121200,
    "sample_id": "ps_aeb0791f22"
  },
  "next": [
    {
      "media_id": "ep_raven",
      "series_id": "as_visoes_da_raven",
      "start": 1790121200,
      "end": 1790122400,
      "sample_id": "ps_a781c4d7c5"
    },
    {
      "media_id": "ep_brandy",
      "series_id": "brandy_e_sr_bigodes",
      "start": 1790122400,
      "end": 1790123600,
      "sample_id": "ps_1d3e9eaf70"
    }
  ],
  "voice_clip_id": "vc_a3836b99a8",
  "template_version": "disney-channel-2026-09-22-v1",
  "voice_profile": "will-sp-capital-reserva-v2",
  "music_variant_id": "disney-wand-v01-v03-conclusive-19s-v1",
  "dry_run": true,
  "publish": false
}
```

### Inventário remoto aprovado

- molde Disney de três janelas: `md_eb00f2dcb7`;
- locução contínua Will v2: `vc_a3836b99a8`, armazenada em
  `fabrica/voice_clips/vc_a3836b99a8/lineup-will-sp-capital-v2-mais-animado.mp3`;
- Os Feiticeiros de Waverly Place: amostra `ps_aeb0791f22`;
- As Visões da Raven: amostra `ps_a781c4d7c5`;
- Brandy & Sr. Bigodes: amostra `ps_1d3e9eaf70`.

Esses IDs servem para reproduzir a amostra aprovada. Eles não representam a
grade futura e não autorizam geração agendada.

Regras operacionais:

- `dry_run` é verdadeiro por padrão e não cria job;
- `dry_run: false` enfileira a prévia remota, mas `publish: false` não cria
  mídia, promessa ou grade;
- a prévia pronta é lida em
  `GET /admin/fabrica-comerciais/lineup-jobs/<job_id>/preview`;
- pedidos idênticos reutilizam o mesmo hash/job;
- todos os três `sample_id` são obrigatórios; a API nunca substitui uma amostra
  omitida pela mais recente do catálogo;
- o runner exige `template_version=disney-channel-2026-09-22-v1` e registra o
  `GITHUB_SHA` usado no render;
- o runner rejeita duração acima de 20 s, duração diferente do alvo de 19 s,
  resolução/codecs incorretos ou uma trilha não versionada;
- a faixa aprovada corta no começo e preserva o encerramento musical completo;
- a prévia permanece com 19 s; na publicação, a fábrica cria um master de 20 s
  colocando o segundo complementar **antes** da peça (primeiro quadro congelado
  e áudio atrasado). Assim o segmentador não acrescenta silêncio depois da
  resolução musical, que continua sendo o último som do comercial;
- `publish: true` exige `LINEUP_PUBLISH_ENABLED=1` no Worker e a confirmação
  textual `confirm_publish=PUBLICAR_LINEUP`. Essa variável não deve ser ligada
  antes da nova grade e da integração da condição `lineup_grade` no scheduler.
  Enquanto isso, somente a prévia privada de 19 s está liberada.

A migration `0035_lineup_remoto.sql` (nasceu `0026`, renumerada por colisão) mantém no D1 o pedido original, o payload
resolvido, o resultado técnico e a chave da prévia. Assim outra IA consegue
reproduzir exatamente quais programas, amostras, voz, molde e trilha formaram a
peça.
