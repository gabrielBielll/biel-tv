# Módulo de comerciais Jetix gerados pela grade

> **Estado em 2026-09-22:** identidade e renderizadores aprovados localmente.
> **Produção: BLOQUEADA aguardando a nova grade.** Gabriel ainda vai alterar a
> programação. Nenhuma IA, script, cron ou operador deve gerar, cadastrar,
> publicar ou agendar peças derivadas da grade atual até ele confirmar
> explicitamente que a alteração terminou.

Este documento é a fonte de verdade da família de comerciais contextuais da
Jetix. Ele registra o resultado visual e sonoro aprovado, os quatro formatos
montados, os arquivos canônicos e o contrato para a futura geração automática
a partir da programação real.

## Decisão editorial fechada

O sistema deverá criar automaticamente peças que descrevem exatamente o que
está no ar e o que virá depois. A grade é a fonte de verdade; o texto, as cenas
e a condição de exibição nascem do mesmo snapshot da programação. Uma peça
nunca pode ser reaproveitada depois que sua sequência deixar de ser verdadeira.

A automação somente poderá ser habilitada depois destas duas confirmações:

1. Gabriel declara que a nova grade da Jetix está finalizada.
2. Um dry-run mostra as peças propostas, os horários e os `series_id`, sem
   upload nem alteração do D1. Gabriel aprova o lote.

Até lá, os comandos deste documento servem apenas para reproduzir ou revisar
os exemplos locais já existentes. Não usar a grade atual para produzir um lote.
O mesmo bloqueio está registrado de forma legível por máquina em
`assets/comerciais/jetix/lineup.config.json`, no objeto `automation`. Uma
implementação futura deve recusar jobs automáticos enquanto `enabled` for
`false`; o CLI manual continua disponível apenas para revisão local.

## Família aprovada

| Tipo | Duração | Contexto da grade | Condição futura no agendador |
|---|---:|---|---|
| `lineup_3_janelas` | 20 s | programa atual + próximos dois | sequência exata do snapshot; exige condição nova, não reduzir a um único `a_seguir` |
| `a_seguir_curto` | 10 s | próximo programa | `a_seguir` com o `series_id` prometido |
| `voce_esta_assistindo` | 10 s | programa atualmente no ar | `durante`, `momento: saida` |
| `estamos_de_volta` | 10 s | programa que retorna após o intervalo | `durante`, `momento: volta` |

Os três formatos curtos são montados por
`scripts/monta-a-seguir-jetix.mjs`. O lineup de três janelas é montado por
`packages/pipeline/src/construtor-lineup.mjs`, com entrada local em
`scripts/monta-lineup-cli.mjs`.

## Renders que definem o padrão

Estes arquivos são referências de aprovação, não itens já publicados:

```text
videos_prontos/a-seguir-power-rangers-jetix.mp4
videos_prontos/voce-esta-assistindo-power-rangers-jetix.mp4
videos_prontos/estamos-de-volta-power-rangers-jetix.mp4
videos_prontos/lineup_jetix/versoes/lineup-jetix-liam-natural-mais-vivo.mp4
```

O último é a referência oficial de voz e mixagem do lineup. As versões em
`videos_prontos/audicoes_voz_jetix/`, `videos_prontos/revisao_energia_jetix/`
e os arquivos com `super-animado` no nome são somente histórico de avaliação.
Não devem alimentar a automação.

## Identidade visual

- Saída obrigatória: MP4, H.264 High, `yuv420p`, AAC 48 kHz estéreo,
  1280×720 e duração exata de 10 ou 20 segundos.
- Conversão de fontes 4:3: usar o padrão aprovado
  `scale=1280:850,crop=1280:720:0:40,setsar=1,format=yuv420p` e seguir
  [PROCESSO_COMERCIAIS_16X9.md](../PROCESSO_COMERCIAIS_16X9.md).
- Template animado:
  `assets/comerciais/jetix/moldes/jetix-next-template-chroma-wI1S3DKojRw.mp4`.
- Molde do lineup:
  `assets/comerciais/jetix/moldes/image-comercial-jtx-2.png`.
- Chroma: verde removido com `chromakey`, seguido de `despill`.
- Lineup: rótulos `AGORA`, `A SEGUIR` e `DEPOIS`, alinhados na mesma coluna,
  em Liberation Sans Bold branca, 48 pt, com sombra discreta. Não substituir
  esses rótulos pelos nomes dos programas.
- As três janelas recebem amostras de vídeo reais das séries; não usar imagem
  estática quando houver amostra aprovada no catálogo.

## Identidade sonora

### Trilha oficial reutilizável

A cama de fundo pedida para o lineup já está isolada e pronta:

```text
assets/comerciais/jetix/moldes/trilha_jetix_lineup_chroma_18s_mix.m4a
```

Ela vem do áudio do template Jetix, contém uma repetição musical limpa para os
primeiros 18 segundos e sobe suavemente entre 17,2 e 17,8 s. Em 17,8 s começa a
sobreposição de 0,2 s com o encerramento, evitando queda de volume antes da voz
“Jetix”. Não recriar essa cama a cada job e não aplicar outro fade antes da
assinatura.

Nas peças curtas, a música, os efeitos e a assinatura vêm do próprio template
animado. O narrador não fala “Jetix”, porque a palavra já existe no áudio final.
O áudio das cenas do programa é descartado.

### Narrador aprovado

- Voz: **Liam — Energetic, Social Media Creator**.
- Papel: voz provisória oficial enquanto a assinatura da voz original estiver
  pausada. A troca futura da voz não altera templates, trilha nem regras da
  grade; cria apenas uma nova versão do perfil e do cache.
- ElevenLabs voice ID: `TX3LPaxmHKxFdv7VOQHJ`.
- Modelo usado nos testes: `eleven_v3`.
- A fala deve ser contínua, clara, animada e natural, com frases curtas, sem
  reticências e sem prolongar palavras.
- Não gerar cada bloco isoladamente com “energia máxima”. Esse teste criou
  sotaque interiorano e animação artificial e foi reprovado.

O acabamento aprovado parte de uma locução contínua natural e aplica somente:

```text
atempo=1.025
equalizer em 2,8 kHz com +1,3 dB
compressão suave 2:1
loudnorm I=-16 LUFS, TP=-2 dB
```

A referência processada está em:

```text
assets/comerciais/jetix/falas/lineup-pucca-padrinhos-power-rangers-liam-v3-natural-mais-viva.wav
```

Não é necessário gerar novamente uma frase que já esteja no cache. Quando a
grade futura exigir uma combinação inédita, a fábrica deve gerar uma única
locução contínua, guardar o áudio bruto, aplicar o acabamento determinístico e
cachear ambos pelo hash de `texto + voice_id + model + settings + versão do
tratamento`. Toda voz nova continua sujeita a audição antes da publicação.

### Execução remota sem assinatura ativa

A produção deve ser **cache-first**. O Worker já usa chaves determinísticas em
`fabrica/tts/<voice_id>/<hash>.mp3` e consulta o R2 antes de chamar a API. Assim,
uma fala provisória gerada uma vez continua disponível mesmo se a assinatura ou
a cota da ElevenLabs forem pausadas depois.

Ordem obrigatória no remoto:

1. Procurar a locução completa pelo hash de texto, voz e configurações.
2. Se não existir, tentar compor com os `voice_clips` provisórios já cadastrados
   no D1 e preservados no R2.
3. Somente no cache miss, e apenas se houver chave/cota, chamar a ElevenLabs com
   Liam e gravar imediatamente o resultado no R2.
4. Se a API estiver sem chave, sem cota ou indisponível, deixar o job em
   `waiting_voice`/`aguardando_voz`. Não marcar como erro definitivo, não
   publicar sem locução e não trocar silenciosamente por outra voz.

Antes de liberar a geração pela nova grade, a biblioteca finita deve ser
pré-assada: conectores, nomes de todas as séries presentes na grade e frases
curtas aprovadas. Isso permite que o GitHub Actions monte os comerciais usando
somente D1 + R2, sem precisar da ElevenLabs durante a renderização. O perfil
remoto canônico está também em `scripts/gera-vozes-catalogo.mjs`; executar esse
script consome créditos apenas para hashes que ainda não existirem.
Os arquivos provisórios do Liam que já existem localmente também podem ser
cadastrados pelo painel como `voice_clips` enviados (`sintetizar: false`): nesse
fluxo eles sobem ao R2 sem nenhuma chamada ou crédito da ElevenLabs.

## Regras de cada formato

### Lineup de três janelas

- 18 s de cartela com as três séries e 2 s de encerramento animado.
- A voz começa em 1,6 s e termina antes do encerramento.
- Estrutura: “Agora, {atual}” + comentário curto; “A seguir,
  {proximo}” + comentário; “Depois, {seguinte}” + comentário.
- Os comentários podem variar, mas não podem fazer promessas de horário,
  episódio ou evento que não venham do snapshot da grade.
- O recorte 8–10 s do template fornece o fechamento e a assinatura falada.
- A cama oficial é a faixa `trilha_jetix_lineup_chroma_18s_mix.m4a`.

### A seguir

- Usa o trecho 0–10,48 s do template, ajustado para 10 s sem cortar o fim.
- A voz entra em 0,4 s e termina até 6,5 s.
- Texto falado: “A seguir: {programa}!” + comentário curto opcional.
- Condição: tocar somente imediatamente antes da série prometida.

### Você está assistindo

- Identifica somente a série que realmente está no ar naquele intervalo.
- Deve abrir um intervalo da própria série, nunca entrar no rodízio genérico.
- Condição: `durante`, `series_id` atual, `momento: saida`.

### Estamos de volta

- Identifica a série que retorna imediatamente após a peça.
- Deve fechar o intervalo e ficar colada ao retorno do programa.
- Condição: `durante`, `series_id` atual, `momento: volta`.

## Contrato da automação futura

A geração não deve ler apenas “os três primeiros itens” de uma consulta solta.
Ela precisa operar sobre um snapshot versionado da grade. Entrada mínima do job:

```json
{
  "canal": "jetix",
  "tipo": "lineup_3_janelas",
  "schedule_revision": "<hash ou versão da grade confirmada>",
  "window_start": 0,
  "current": { "media_id": "...", "series_id": "...", "start": 0, "end": 0 },
  "next": [
    { "media_id": "...", "series_id": "...", "start": 0, "end": 0 },
    { "media_id": "...", "series_id": "...", "start": 0, "end": 0 }
  ],
  "template_version": "jetix-2026-09-22",
  "voice_profile": "liam-natural-mais-vivo-v1"
}
```

Os tempos acima são epoch reais no job de produção. O identificador do job e o
nome do objeto no R2 devem ser determinísticos a partir da revisão da grade,
tipo, séries, janela e versões de template/voz. Repetir o mesmo pedido reutiliza
o resultado; mudar a grade cria outro hash e invalida a peça anterior.

Fluxo obrigatório:

1. Ler a grade confirmada e congelar `schedule_revision`.
2. Resolver `series_id`, título exibível e amostra aprovada de cada programa.
3. Gerar o texto somente com fatos do snapshot.
4. Reutilizar a locução cacheada ou criar uma locução contínua nova.
5. Renderizar em staging, nunca diretamente na chave final do R2.
6. Validar duração, codecs, resolução, áudio, quadros inicial/final e ausência
   de tela preta ou verde residual.
7. Criar a condição de exibição a partir do mesmo snapshot, sem transcrição ou
   inferência posterior.
8. Mostrar o dry-run para aprovação no primeiro lote após a troca da grade.
9. Só então publicar no R2/D1, marcar `ready` e reconstruir a grade afetada.
10. Se `schedule_revision` mudar, retirar os derivados antigos do pool antes de
    tornar os novos ativos.

Para o lineup de três janelas será necessário ampliar o modelo de promessas. O
tipo atual `a_seguir` representa apenas uma série. A implementação deve criar
uma condição própria, por exemplo `lineup_grade`, contendo a série atual, as
duas próximas e a janela válida. Até essa condição existir no scheduler, o
lineup automático não pode ser publicado como se fosse um comercial genérico.

## O que já existe e o que falta

| Componente | Estado |
|---|---|
| Configuração Jetix declarativa | pronta em `assets/comerciais/jetix/lineup.config.json` |
| Bloqueio legível por máquina | ativo em `automation.enabled: false` |
| Render de três janelas | pronto localmente |
| Três renders curtos | prontos localmente |
| Template, molde e trilha | prontos e preservados |
| Perfil final do Liam | aprovado |
| Política remota cache-first | definida; TTS suporta `speed` |
| Biblioteca provisória completa no R2/D1 | precisa de auditoria após a nova grade |
| Seleção dos programas pela grade | pendente |
| Snapshot/revisão da grade | pendente |
| Job automático e cache determinístico | pendente |
| Condição `lineup_grade` no scheduler | pendente |
| Dry-run no painel | pendente |
| Upload R2/D1 e invalidação de derivados | pendente |
| Testes de integração | pendentes |
| Liberação operacional | **bloqueada pela troca da grade** |

## Comandos locais de reprodução

Lineup de três janelas, usando entradas explícitas ou os exemplos locais do
CLI:

```bash
node scripts/monta-lineup-cli.mjs \
  --canal jetix \
  --voz assets/comerciais/jetix/falas/lineup-pucca-padrinhos-power-rangers-liam-v3-natural-mais-viva.wav \
  --out scratch/revisao-lineup-jetix.mp4
```

Peça curta:

```bash
node scripts/monta-a-seguir-jetix.mjs \
  --tipo a_seguir_curto \
  --video '<amostra-16x9.mp4>' \
  --voz '<locucao-aprovada.mp3>' \
  --titulo '<nome do programa>' \
  --inicio 0 \
  --out scratch/revisao-a-seguir-jetix.mp4
```

Troque `--tipo` por `voce_esta_assistindo` ou `estamos_de_volta` para as outras
variantes. Esses comandos não autorizam upload nem geração baseada na grade
enquanto o bloqueio deste documento estiver ativo.

## Verificação antes de qualquer publicação

Cada saída deve passar por `ffprobe` e confirmar:

- 1280×720, H.264, `yuv420p`;
- AAC, 48 kHz, dois canais;
- duração exata de 10,000 ou 20,000 s;
- loudness próximo de -16 LUFS e true peak no máximo -1,5 dBFS;
- voz inteligível, natural e sem sotaque/caricatura surgida na síntese;
- nenhum afundamento da música antes da assinatura “Jetix”;
- programa, rótulo, locução e condição de grade descrevendo a mesma série;
- fonte original preservada e fora da ingestão.

## Próximo módulo: Cartoon Network

Gabriel indicou esta referência para a futura trilha de fundo do Cartoon
Network: [vídeo `Zx7ogrmxk5w`](https://www.youtube.com/watch?v=Zx7ogrmxk5w).
O áudio integral foi preservado sem recompressão em
`assets/comerciais/cartoon_network/referencias/fonte-cartoon-summer-video-Zx7ogrmxk5w.m4a`.
Ele está registrado como `reference_only_pending_edit_and_approval`: ainda não
foi recortado, transformado em loop nem aprovado como trilha de produção. Os
metadados e o hash ficam no `README.md` da mesma pasta. O módulo Cartoon será
tratado separadamente; não reutilizar suas regras visuais ou sonoras na Jetix.

## Documentos relacionados

- [Construtor modular de lineup](construtor-lineup-3janelas.md)
- [Fábrica de comerciais](fabrica-comerciais.md)
- [Comerciais condicionais](comerciais-condicionais.md)
- [Processo de comerciais 16:9](../PROCESSO_COMERCIAIS_16X9.md)
