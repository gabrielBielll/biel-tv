# Feature: Construtor Modular de Lineup em 3 Janelas (até 20s)

> **Status:** ✅ renderização local implementada e aprovada; integração automática
> com a grade e publicação em produção ainda bloqueadas (2026-09-22). Ver
> [módulo de comerciais Jetix](modulo-comerciais-jetix.md).
> O módulo aprovado do Cartoon Network está registrado em
> [modulo-comerciais-cartoon-network.md](modulo-comerciais-cartoon-network.md).
> O protótipo em avaliação do Disney Channel está registrado em
> [modulo-comerciais-disney-channel.md](modulo-comerciais-disney-channel.md).
> **Arquitetura:** Multi-Canal (Jetix, Disney Channel, Cartoon Network), Modular, Dinâmico com a Grade de Programação (EPG/Diretor), 100% Determinístico em FFmpeg e Serverless (R2 + D1).

---

## 1. Visão Geral

O **Construtor Modular de Lineup** é o motor responsável por gerar vinhetas e chamadas dinâmicas de programação no formato clássico de TV a cabo dos anos 2000:
- **Duração máxima de 20,0 segundos**. O Disney Channel mira 19,0 s por
  segurança, impedindo que o segmentador acrescente outro bloco de 10 s.
- **Três Janelas / Telas Simultâneas**: exibem o programa atual e os dois seguintes (*"Você está assistindo {Série 1}, a seguir {Série 2}, e depois {Série 3}"*).
- **Cenas aceleradas em 1,5x** nas três janelas, como nas chamadas da época
  (decisão do Gabriel em 2026-09-23, depois de ver os exemplos). O valor fica
  em `visual.velocidade_janelas` no config de cada canal; sem o campo, 1x.
- **Trilha Sonora Oficial da Emissora**: iniciada no segundo 10 e atenuada sob a locução com mixagem sidechain balanceada.
- **Narradores Oficiais por Canal**: timbres selecionados com dicção jovem, alta empolgação e sotaque neutro/paulistano da capital.

---

## 2. Estrutura de Arquivos e Isolamento por Canal

Cada canal possui sua configuração declarativa e identidade visual/sonora isolada em `assets/comerciais/<canal>/`:

```text
assets/comerciais/
├── templates-lineup.json                # Banco de variações de frases por canal e tipo de bloco
├── jetix/
│   ├── lineup.config.json               # Configuração gráfica, fonte branca grossa, voz Liam e trilha
│   └── moldes/
│       ├── image-comercial-jtx-2.png    # Molde 3 janelas com ângulo 3D
│       └── trilha_jetix_lineup_3janelas.m4a
├── disney_channel/
│   ├── lineup.config.json               # Badges neon ciano, voz Camilla e trilha Asfalto Quente
│   └── moldes/
│       ├── image-comercial-disney-3janelas.png
│       ├── trilha_disney_wand_v01_v03_20s.m4a
│       └── variacoes/                    # Oito instrumentais Wand ID recortados
└── cartoon_network/
    ├── lineup.config.json               # Badges horizontais, voz Larissa B. e trilha clássica CN
    └── moldes/
        └── image-comercial-cartoon-3telas.png

packages/pipeline/src/
└── construtor-lineup.mjs                # Motor FFmpeg multi-janela e gerador de overlays

scripts/
├── monta-lineup-cli.mjs                 # CLI para renderização rápida sob demanda
└── gera-vozes-catalogo.mjs              # Gerador em lote de nomes/conectivos no ElevenLabs com upload R2/D1
```

O mesmo motor também é chamado por `scripts/factory-local.mjs` quando o Worker
entrega um job `lineup_3_janelas`. O caminho remoto não possui uma segunda
implementação visual: ele usa os mesmos JSONs e assets do Git, evitando diferença
entre a amostra aprovada e o vídeo produzido no GitHub Actions.

---

## 3. Identidade dos Canais e Narradores Oficiais

| Canal | Narrador | Voice ID (ElevenLabs) | Hiperparâmetros | Estilo Visual dos Rótulos |
|---|---|---|---|---|
| **Jetix** | Liam (provisória aprovada) | `TX3LPaxmHKxFdv7VOQHJ` | Eleven v3 · Creative (`0.0`) | **Texto branco puro, extra grosso** (`Ubuntu-B` reforçado) com contorno e sombra nítida, sem caixa/badge, alinhado às facetas 3D. |
| **Disney Channel** | Will — SP Capital (reserva aprovada) | `NNbmtunmMPGBeyrKu6KD` | Multilingual v2 · stab 0.38 · style 0.50 · speed 1.08 | **Badges luminosos em neon azul/ciano** com cantos arredondados (`roundrectangle`). |
| **Cartoon Network** | Larissa B. | `YfD2qVn2wwK9QFehYxSa` | Multilingual v2 · stab 0.26 · style 0.65 | **Badges horizontais compactos** sobre o topo de cada quadro. |

---

## 4. Integração com a Grade (EPG / Diretor)

Em produção, o comercial de lineup **não é gravado com nomes fixos manuais**. Ele é alimentado diretamente pelos dados do agendador:

$$\text{[Gancho]} \rightarrow \text{[Você tá assistindo \{série\_1\}]} \rightarrow \text{[A seguir \{série\_2\}]} \rightarrow \text{[Depois \{série\_3\}]} \rightarrow \text{[Assinatura]}$$

1. **Amostras de Vídeo**: Puxadas das séries correspondentes cadastradas no catálogo (`comerciais_16x9/` ou amostras de episódios).
2. **Áudios de Voz**:
   - Os nomes de todas as séries do catálogo já estão sintetizados com os narradores oficiais e salvos permanentemente no Cloudflare R2 (`fabrica/tts/<voz_id>/<hash>.mp3`) e indexados no D1 (`voice_clips`).
   - Os conectivos e ganchos modulares permitem variações dinâmicas sem repetição monótona no ar.

### 4.1 Onde o lineup entra na grade (implementado em 2026-09-23, DESLIGADO)

O código está em `apps/stream/src/lineup-grade.ts` e é chamado pelo `scheduler.ts`.
A regra foi combinada no card do Trello `d5HGORZp`:

- **O que identifica a peça é a sequência de séries X→Y→Z**, não um horário.
  A condição `lineup_grade` é lida pela série (`current`/`next[]` do
  `/lineup-jobs`, ou `seq: [X, Y, Z]`). Os `media_id` e `window_start` da
  condição ficam só como rastro. A mesma peça volta em qualquer dia em que a
  sequência se repetir.
- **Quem decide se ela entra é a própria grade planejada**, na hora de montar:
  a peça só entra num intervalo **dentro** do bloco de X, e só quando os dois
  blocos seguintes são exatamente Y e Z.
- **Nenhum horário se move.** A peça ocupa o lugar de anúncios do rodízio cego
  cuja duração soma exatamente a dela (20 s). Ela entra depois do último desses
  anúncios, então a vinheta "estamos de volta com X" continua fechando o
  intervalo. Se nenhuma combinação dá 20 s, o bloco fica sem lineup.
- **A grade é estendida em pedaços curtos**, então o encaixe olha também as
  últimas 6 h já gravadas. Um intervalo gravado que recebe a peça é reescrito na
  mesma faixa de tempo (DELETE+INSERT no mesmo batch do resto).
- **Rebuild parcial:** quando um lineup gravado antes do corte promete Y ou Z
  que vêm depois dele, o corte recua até antes do bloco de X, e a promessa é
  refeita junto (`recuaCorte`).
- **Lineup nunca cai no rodízio cego**, nem no modo livre (comerciais fiéis
  desligado), nem sem promessa. Toda mídia `com_lineup_*` fica fora do rodízio,
  porque o runner registra a peça antes de o `/done` gravar a condição.

**Liga por canal** no `config` do D1, com a posição (ainda decisão do Gabriel):

```sql
INSERT INTO config (k, v) VALUES ('lineup_grade:cartoon_network', 'ultimo')   -- ou 'meio'
```

Sem a chave, nada é encaixado.

**Testes:** `pnpm verify:lineup` (42 checagens: funções puras + `scheduleChannel`
real com D1 falso).

**Dry-run com os dados de produção** (só SELECT, não grava nada):

```bash
node --import ./scripts/_ts-registra.mjs scripts/lineup-dryrun.mjs --posicao ultimo
```

Ele planeja 48 h de cada canal duas vezes, sem lineup e com uma peça falsa para
cada sequência que aparece, e confere três coisas: os programas ficam nos mesmos
horários, a EPG continua contígua e nenhuma promessa é falsa.

Resultado em 2026-09-23 (48 h, posição `ultimo`): as três conferências passaram
nos três canais. Entraram 44 de 83 sequências no Jetix, 52 de 136 no Cartoon e
47 de 97 no Disney. **Quase tudo que ficou de fora é bloco sem intervalo
dentro dele** (36, 79 e 47 blocos). São episódios sem cue point e blocos de um
episódio só: o único intervalo deles é o que vem **depois** de X, quando X já
acabou. Ali "você está assistindo X" deixaria de ser verdade, então a regra atual
não usa esse intervalo. Só 3 a 5 blocos por canal ficaram de fora por falta de
anúncios que somassem 20 s.

### 4.2 Lote local: gerar e publicar os lineups da grade

Decisão do Gabriel em 2026-09-23: último intervalo do bloco de X (`ultimo`);
o intervalo **depois** de X não é usado; não esperar a grade final. Subir já
com a grade provisória e refazer quando ela mudar.

```bash
# 1. quais sequências a grade tem (7 dias, só leitura)
node --import ./scripts/_ts-registra.mjs scripts/lineup-dryrun.mjs --posicao ultimo --horas 168
# 2. gera voz + vídeo das que se repetem (≥2×/semana) e sobe pro R2, sem tocar no D1
node scripts/lineup-lote.mjs [--seco] [--min 2] [--canal X]
# 3. registra (mídia + promessa + liga o encaixe). Usar depois das 21h se a cota do dia estourou
node scripts/lineup-registra.mjs [--seco]
```

- **Retomável:** o lote pula a sequência que já tem registro (pendente ou
  aplicado). Com a grade mudada, é só repetir 1–3, e só as sequências novas
  são geradas.
- **Locução em cache pela frase** (`~/.cache/bieltv-lineup/vozes/`): refazer o
  vídeo de uma sequência que já existia não gasta ElevenLabs.
- **Texto** no formato das peças aprovadas. O Cartoon não tem comentário. No
  Jetix e no Disney vai uma frase por série; se a voz passar do teto do canal,
  desce de nível e tira comentário, em vez de deixar o motor cortar a fala.
  Cada locução é conferida por transcrição. Nome duvidoso sai marcado como
  `conferir` no manifesto (`~/.cache/bieltv-lineup/lote/manifesto.jsonl`).
- Os vídeos ficam para revisão em `~/storage/downloads/lineup-lote/`.

**Estado em 2026-09-23:** 93 sequências (Disney 32, Jetix 31, Cartoon 30),
cobrindo ~56% dos encaixes da semana; o resto são sequências que aparecem uma
vez só. O registro fica armado para 21:00:05 (`~/.cache/bieltv-lineup/registra-21h.sh`),
antes do replan da rotina das 21h, que já encaixa as peças.

⚠️ **Ainda não é automático.** Quando a grade muda, o lineup cuja sequência
sumiu simplesmente deixa de tocar, e isso é seguro. Mas sequência nova fica
sem peça até alguém rodar o lote de novo. Automatizar isso (reconciliador de
lineups no cron) é o próximo passo.

---

## 5. Como Sincronizar e Executar em Outro Computador

Para continuar o trabalho ou rodar o gerador a partir de outro computador:

### Passo 1: Atualizar o Repositório
```bash
git pull origin main
pnpm install
```

### Passo 2: Carregar as Credenciais
Certifique-se de que o `.envrc` do projeto está ativo (ou carregue o ambiente local):
```bash
direnv allow
# ou
source .envrc
```

### Passo 3: Testar a Renderização Modular via CLI
Para renderizar um lineup teste de 20s para qualquer canal:
```bash
# Jetix
node scripts/monta-lineup-cli.mjs --canal jetix --out scratch/teste-jetix.mp4

# Disney Channel
node scripts/monta-lineup-cli.mjs --canal disney_channel --out scratch/teste-disney.mp4

# Cartoon Network
node scripts/monta-lineup-cli.mjs --canal cartoon_network --out scratch/teste-cartoon.mp4
```

### Renderizar no Termux (celular)

Funciona desde 2026-09-23 e é rápido: **7–9 s por lineup** nos três canais.
Os renders de teste passaram no contrato (1280×720, H.264, AAC 48 kHz estéreo,
20,000 s, ou 19,000 s no Disney). A integrada ficou em −15,6 a −16,6 LUFS. O
master de entrega de 20 s segmenta em 2 blocos de 10 s.

Precisa de duas coisas que o Ubuntu do GitHub Actions já traz:

1. **ImageMagick:** `pkg install imagemagick`. ⚠️ Se o `magick` sair com
   `cannot locate symbol "x265_api_get_217"`, o pacote `libx265` ficou
   desatualizado em relação ao `libheif`. Atualizar só o `libx265` quebra o
   `ffmpeg`, que pede `libbluray.so.4`. Os pacotes do Termux não declaram
   versão mínima de dependência, então é preciso atualizar o `ffmpeg` junto
   com todas as dependências dele que tiverem versão nova
   (`apt-cache depends ffmpeg` cruzado com `apt list --upgradable`). Não
   use `pkg upgrade` geral: ele também atualiza o `nodejs-lts` que roda o
   Claude Code.
2. **Fontes:** os configs apontam para `/usr/share/fonts/...`, caminho que não
   existe no Termux. Quando o caminho configurado não existe, o
   `carregarConfigCanal` procura o arquivo de mesmo nome em `$LINEUP_FONTS_DIR`,
   `~/.fonts` e `$PREFIX/share/fonts/TTF`. Só o mesmo nome de arquivo serve:
   nunca troca a família. No celular ficam em `~/.fonts` os **mesmos arquivos
   das amostras aprovadas**, conferidos pelo sha256. Eles estão no R2 em
   `lineup-insumos/2026-09-23/fontes/`:
   - `Ubuntu-B.ttf`: `28c4c189a44803b1986fd16074187034dc6d94ad35f5e87de13dd0e786b70b73`
   - `LiberationSans-Bold.ttf`: `3973aa5054fb467dd5627245d3dc82e37bf16fe075756156a570455871351582`

3. **Travamento na virada pro fechamento (corrigido em 23/09):** com o ffmpeg
   8.1.3, cerca de 1 em cada 3 renders do Jetix parava no quadro ~540, sem
   erro nenhum. Ao levar SIGTERM, saía um MP4 **sem o fechamento**. A causa e a
   medição estão no comentário do `ffmpegArgs` em `construtor-lineup.mjs`. Se
   voltar a acontecer, o sintoma é render que não termina, e **não** erro.
   Por isso quem roda em lote usa `timeout` e **descarta** a saída de render
   morto por tempo, em vez de aproveitá-la.

As amostras baixadas do R2 ficam em cache em `~/.cache/bieltv-lineup/amostras/<series_id>.mp4`.

```bash
A=~/.cache/bieltv-lineup/amostras
node scripts/monta-lineup-cli.mjs --canal cartoon_network \
  --v0 $A/billy_e_mandy.mp4 --v1 $A/scooby_doo.mp4 --v2 $A/martin_mystery.mp4 \
  --out ~/storage/downloads/lineup-teste/teste-cartoon.mp4
```

### Fechamento animado do lineup Jetix

O lineup Jetix usa o molde de três janelas por 18 segundos, com os rótulos
**AGORA**, **A SEGUIR** e **DEPOIS**. Nos 2 segundos finais, o motor recorta o
trecho 8–10 s de
`assets/comerciais/jetix/moldes/jetix-next-template-chroma-wI1S3DKojRw.mp4`,
remove o verde, aplica o reenquadramento 16:9 aprovado e preserva o áudio do
trecho, inclusive a assinatura falada **"Jetix"**. Por isso a locução do lineup
não deve repetir o nome do canal.

Os três rótulos usam o formato visual da referência
`Promo%20de%20canal%20Jetix%20moderno.png`: letras grandes em Liberation Sans
Bold (`48 pt`), brancas, com sombra discreta e alinhadas à esquerda em uma única coluna.
Os textos continuam sendo **AGORA**, **A SEGUIR** e **DEPOIS**, em vez dos nomes
dos programas exibidos na imagem de referência.

A locução de lineup do Liam usa entrega rápida (`speed: 1.15`), frases curtas e
pontuação direta. Não usar reticências nem conectivos arrastados, para evitar o
prolongamento artificial das palavras no `eleven_v3`.
Cada programa pode receber um comentário breve; a locução completa deve ocupar
a maior parte dos 18 segundos de lineup, encerrando antes da assinatura final.
No exemplo aprovado tecnicamente, a voz começa em 1,6 s e dura 14,4 s.
As direções de animação são aplicadas globalmente e reforçadas entre os blocos:
`[2000s TV promo] [heroic] [high energy] [confident announcer] [bright]
[dynamic] [fast pace] [quick delivery] [punchy] [excited] [smiling]
[short clipped phrases]`. O reforço por trecho evita que o v3 comece animado e
perca energia nos nomes seguintes.

A tentativa de gerar cada frase isoladamente com energia máxima foi reprovada:
o Liam adquiriu um sotaque interiorano perceptível e uma interpretação
artificialmente forçada. Não usar a versão `super-animada` como referência. O
ponto de partida continua sendo a locução-base contínua; ajustes adicionais
devem ser discretos e feitos por ritmo, presença e compressão, sem nova
caricatura de interpretação.

Como resultado aprovado, foi criada a variante
`lineup-pucca-padrinhos-power-rangers-liam-v3-natural-mais-viva.wav` a partir
da locução-base, sem nova chamada à ElevenLabs. Ela usa apenas 2,5% de
aceleração, leve presença em 2,8 kHz e compressão 2:1. O render correspondente
é `videos_prontos/lineup_jetix/versoes/lineup-jetix-liam-natural-mais-vivo.mp4`;
esta é a referência auditiva oficial da Jetix desde 2026-09-22.

A cama dos primeiros 18 segundos vem do próprio áudio do template chroma usado
nas vinhetas curtas. O trecho musical 0–6,2 s é repetido com crossfades curtos,
sem trazer a assinatura antes da hora. A fala **"Jetix"** continua aparecendo
uma única vez, no recorte final de 8–10 s.
Na emenda final, o motor antecipa 0,2 s do áudio do encerramento e faz um
crossfade direto com a cama. Não deve haver fade para silêncio
antes da assinatura.
A cama `trilha_jetix_lineup_chroma_18s_mix.m4a` já traz o volume atenuado sob a
locução e uma subida musical entre 17,2 e 17,8 s até o mesmo nível do sting. Só então
ocorre o crossfade de 0,2 s com a assinatura, evitando a queda de volume.

O arquivo enviado como `Design%20gr%C3%A1fico%20moderno%20com%20logo%20Jetix.png`
foi conferido e é byte a byte idêntico ao molde já preservado em
`assets/comerciais/jetix/moldes/image-comercial-jtx-2.png`.

### Testar a variante curta "a seguir" da Jetix (10 s)

Em 2026-09-22 foi localizada a chamada
[Zatch Bell no Jetix](https://www.youtube.com/watch?v=N5Bd3i7DIrQ), publicada
como `Chamada de Zatch Bell no Jetix` (`N5Bd3i7DIrQ`). O áudio é um achado útil:
tem uma cama musical limpa durante toda a peça e já termina com a assinatura
falada **"Jetix"**, sem locução sobre o programa.

A trilha de referência foi preservada em
`assets/comerciais/jetix/moldes/trilha_jetix_a_seguir_com_assinatura.m4a`, e a
fonte original permanece separada em
`comerciais_16x9/_fontes_jetix/fonte-zatch-bell-a-seguir-jetix-N5Bd3i7DIrQ.mp4`;
ela não deve ser ingerida como comercial.

O render final não usa o PNG estático. Ele usa o **template animado com chroma
verde e áudio próprio** encontrado em
`assets/comerciais/jetix/moldes/jetix-next-template-chroma-wI1S3DKojRw.mp4`.
O primeiro trecho desse arquivo (0–10,48 s) é o formato de uma janela usado na
chamada. O verde é substituído pelas cenas do programa; a animação, efeitos,
trilha e encerramento do template são preservados.

Regras desta variante:

- saída estrita de **10,0 s**; os 10,48 s do template são comprimidos em 4,8%,
  sem cortar os quadros ou o áudio finais;
- a locução começa em 0,4 s e precisa terminar até 6,5 s, deixando a assinatura
  original respirar no fechamento;
- o narrador fala somente **"a seguir" + nome do programa + comentário curto**;
  não deve falar "na Jetix" nem "Jetix", pois a assinatura já está na trilha;
- o áudio da abertura do programa é descartado: a cama vem do próprio template
  chroma e a locução nova entra por cima;
- este template é exclusivo da chamada curta de um programa. Não deve substituir
  o lineup de 20 s em três janelas.

Render reproduzível do teste aprovado tecnicamente:

```bash
node scripts/monta-a-seguir-jetix.mjs \
  --video 'assets/comerciais/jetix/amostras/POWER RANGERS FORÇA ANIMAL ABERTURA (Traduzida) [41t36-S98aY] - 16x9 com audio.mp4' \
  --voz scratch/locucao-a-seguir-power-rangers-forca-animal.mp3 \
  --titulo 'Power Rangers Força Animal' \
  --inicio 9 \
  --out scratch/teste-jetix-a-seguir-power-rangers-trilha-zatch.mp4
```

Locução usada no teste: *"A seguir: Power Rangers Força Animal! Heróis
selvagens, prontos para entrar em ação!"* O texto na tela reproduz o essencial
da locução: nome do programa + **A SEGUIR**.

O mesmo montador aceita `--tipo voce_esta_assistindo` e
`--tipo estamos_de_volta`. A segunda variante usa a outra animação do arquivo
chroma (10,48–20,358 s); ambas preservam o áudio sincronizado do template e
produzem MP4 de 10 s.

### Direção de voz do narrador Jetix

O `eleven_multilingual_v2` continua adequado para falas modulares estáveis, mas
as chamadas curtas que precisam de energia usam `eleven_v3`. Segundo a
[documentação de prompting do Eleven v3](https://elevenlabs.io/docs/best-practices/prompting),
o modelo aceita tags de interpretação; pontuação e maiúsculas também alteram
ênfase e ritmo. A
[documentação de configurações](https://elevenlabs.io/docs/eleven-creative/playground/text-to-speech)
explica que estabilidade alta tende à monotonia e que valores baixos ampliam a
variação emocional.

O preset Jetix recuperado dos testes de 17–19/07/2026 é:

```text
[2000s TV promo] [heroic] [high energy] [confident announcer]
[bright] [dynamic] [fast pace] [quick delivery] [punchy]
[excited] [smiling]
```

As frases devem ser contínuas, sem reticências ou pausas excessivas. Palavras
principais usam maiúsculas e exclamações. A voz **Talis - Jetix Bumper** foi
testada inicialmente, mas reprovada na audição por soar pouco profissional no
`eleven_v3`. A explicação é compatível com a
[orientação oficial do v3](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices):
Professional Voice Clones ainda não estão plenamente otimizados para esse
modelo; para expressividade, a ElevenLabs recomenda priorizar IVC ou voz
projetada.

Em 2026-09-22 foram geradas audições com três vozes premade conhecidas:

- **Adam** (`pNInz6obpgDQGcFmaJgB`): firme, dominante e com ataque forte;
- **Liam** (`TX3LPaxmHKxFdv7VOQHJ`): jovem, quente e energético;
- **Brian** (`nPczCjzI2devNBz1zQrb`): grave, ressonante e adequado a anúncios.

Os áudios ficam em `assets/comerciais/jetix/falas/audicoes-v3/` e as seis
montagens de comparação em `videos_prontos/audicoes_voz_jetix/`.

Após a comparação auditiva, **Liam** foi aprovado em 2026-09-22 como a voz
provisória das variantes `voce_esta_assistindo` e `estamos_de_volta`, enquanto
a assinatura da voz original permanece pausada. Adam e Brian permanecem somente
como alternativas de referência; Talis está reprovada para essas chamadas.

O v3 usa estabilidade Creative (`0.0`) e uma semente registrada por geração.
Como o modelo é não determinístico e a resposta às tags depende do alcance da
voz, cada nova frase ainda precisa de revisão auditiva antes da publicação.

### Passo 4: Cadastrar ou Gerar Vozes para Novas Séries
Quando uma nova série entrar no catálogo da emissora:
1. Adicione a série em `scripts/gera-vozes-catalogo.mjs`.
2. Execute o gerador:
   ```bash
   node scripts/gera-vozes-catalogo.mjs
   ```
3. O script possui **cache determinístico**: ele verifica o R2 antes de chamar a API, gerando **apenas os arquivos inéditos** e economizando sua cota da ElevenLabs. Em seguida, sincroniza automaticamente com o D1 remoto e local.
