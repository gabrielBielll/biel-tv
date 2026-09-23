# Feature: molde de vinheta do Cartoon (vem aí / volta já / você está assistindo)

> **Estado: 🟢 COMPLETO.** Gerador pronto e medido, com locução funcionando —
> imagem, texto, trilha e voz numa peça só.
>
> **A ideia em uma frase:** pegar UMA vinheta de época, apagar o nome do programa
> e o selo, e transformá-la em molde — a mesma animação serve para qualquer
> série, trocando só o texto.

## Por que existe

O acervo tem vinheta de época bonita, mas **uma peça por série**. Séries sem
vinheta ficavam sem chamada, e não há fonte para todas. O molde resolve pelo
avesso: em vez de caçar a peça de cada série, reusa uma peça e escreve o nome.

## O pipeline, em quatro camadas

```
fonte de época (vinheta 4:3 ou 16:9)
  └─ 1. APAGA a área de texto      → retângulo na cor do fundo
      └─ 2. ESCREVE o nome         → 1 ou 2 linhas, corpo medido
          └─ 3. ESCREVE o selo     → "VEM AÍ" com caixa colorida
              └─ 4. TRILHA por baixo → áudio original descartado
```

**A locução entra por `voice_clip` sintetizado**, como nos comerciais — ver
[fabrica-comerciais.md](fabrica-comerciais.md).

✅ **TTS FUNCIONA** (testado 22/09/2026). `POST /admin/fabrica-comerciais/voz/preview`
`{canal, texto}` devolve o mp3 direto, sem gravar no D1 — serve para testar sem
gastar cota de escrita. A `ELEVENLABS_API_KEY` está nos segredos do Worker (NÃO
no cofre local `~/bieltv-cred.env`; concluir pela ausência lá dá resposta errada).

Mixagem que funcionou: voz entrando em **0.9s** (depois da abertura, não em cima
do corte) e trilha **9dB abaixo** dela.

## O gerador

`~/bieltv-scripts/gera-vem-ai.mjs`

```sh
node ~/bieltv-scripts/gera-vem-ai.mjs <fonte.mp4> "NOME DO PROGRAMA" <saida.mp4> ["SELO"]
```

Ativos fixos (fora do diretório da sessão, para sobreviver entre conversas):

| | |
|---|---|
| `~/bieltv-scripts/trilha.m4a` | trilha padrão do tipo — serve para vem aí, volta já e você está assistindo |
| `~/bieltv-scripts/fontes/Quicksand.ttf` | título (SIL OFL) |
| `~/bieltv-scripts/fontes/Arvo-Bold.ttf` | selo (SIL OFL) |

⚠️ **Gotham Rounded e Rockwell foram pedidas e NÃO são usadas** — são comerciais
licenciadas. Quicksand e Arvo são as aproximações de licença aberta. Se as
licenças forem adquiridas, trocar o `.ttf` no script basta.

## As medidas (desta fonte; outra peça exige remedir)

| o quê | valor | como foi obtido |
|---|---|---|
| área de texto | `x 660, y 220, 510x262` | cropdetect + varredura de borda |
| cor do fundo | `rgb(253,253,253)` | amostragem em 6 pontos ao redor |
| centro horizontal | `x 915` | centro da área |
| nome, 1 linha | `y 288` | alinhado à 2ª linha do caso de 2 |
| nome, 2 linhas | `y 254 - 0.42·entrelinha` | bloco centrado |
| entrelinha | `1.18 · corpo` | 1.12 fazia os acentos colapsarem |
| selo | `y 386`, `boxborderw 16\|58` | baixo e folgado nas laterais |
| janela do texto | quadros **1 a 113** | medição de brilho quadro a quadro |
| descida | 30px em 8 quadros | aproxima a entrada original |

🔴 **As duas pontas da janela precisam ser medidas, não supostas.** O quadro 0 é
escuro: pintar a partir dele faz um retângulo branco saltar 33ms antes da
animação abrir. E a partir do 114 entra a cartela do canal, que ocupa a MESMA
região: pintar até o fim a apagaria. Errei as duas na primeira tentativa.

## O encaixe do nome é MEDIDO, não estimado

`AS AVENTURAS DE JUNIPER LEE` ocupa **924px** no corpo 62 — atravessa o quadro
inteiro. O gerador quebra em até 2 linhas pelo espaço mais equilibrado e encolhe
o corpo de 2 em 2 até a linha mais larga caber em 470px.

A largura vem de **renderizar o texto e medir a extensão da tinta**, não de
contar caracteres: nome cheio de `I`/`L` ocupa muito menos que um de `M`/`W`, e o
erro só apareceria na peça pronta.

## Quatro armadilhas do ffmpeg desta máquina

Nenhuma dá mensagem óbvia; todas custaram uma tentativa cada.

1. **Ordem das opções do `drawtext`** — `fontfile=` antes de `text=` faz o parser
   ignorar o texto e reclamar que nenhum foi fornecido. `text=` primeiro resolve.
2. **`$VAR:` no zsh** — `$DN:enable=` vira `${DN:e}` + `nable=`, porque `:e` é
   modificador de parâmetro. Use `${DN}`.
3. **`drawbox` recusa expressão com vírgula** (`clip(x,0,1)`), mesmo entre aspas;
   `drawtext` aceita. Solução: a faixa colorida é `drawtext` com `box=1`, não um
   `drawbox` animado — um filtro a menos e o problema some.
4. **Fonte variável renderiza só no peso padrão.** `Quicksand[wght].ttf` sai
   sempre leve. Peso diferente exige arquivo estático (a Poppins ainda publica).

## Pendências

- **Persistir a locução** — o preview não grava. Para a peça definitiva, o clipe
  deve virar `voice_clip` no banco. Hoje: 483 clipes, nenhum `voz_provisoria`.
  Atenção ao ciclo "gerar provisório → refazer → apagar" se a voz usada não for
  a do canal (`fabrica-comerciais.ts`).
- **Resíduo nos 2 primeiros quadros** — a animação original espalha elementos
  FORA da área apagada. Opções: alargar a área (apaga mais da peça) ou atrasar o
  texto (preserva a abertura). Não decidido.
- **Outras eras** — as medidas acima valem para ESTA fonte. Peça de outra era
  tem geometria e janela próprias; remedir antes de gerar.

## Relacionado

- [fabrica-comerciais.md](fabrica-comerciais.md) — de onde vem a locução
- [cortador-comerciais.md](cortador-comerciais.md) — como as peças de época são
  recortadas do compilado
