# Referências sonoras do Disney Channel

## Wand ID instrumentals

- fonte: `https://www.youtube.com/watch?v=x7uCmvpyZi8`;
- título: `Disney Channel Wand ID music instrumentals (CLEANEST ONLINE)`;
- canal: `Inaudible`;
- duração da fonte preservada: aproximadamente 1 min 28 s;
- arquivo: `fonte-disney-wand-id-instrumentals-x7uCmvpyZi8.m4a`;
- finalidade: referência local para protótipos, sem publicação no R2/D1;
- estado: aguardando aprovação editorial do módulo Disney Channel.

A gravação contém oito instrumentais separados por silêncio. Eles foram
recortados sem alterar a fonte original, normalizados para aproximadamente
-16 LUFS e armazenados em `../moldes/variacoes/`:

| Variação | Intervalo na fonte |
|---|---|
| `disney-wand-v01.m4a` | 00:00.000–00:10.093 |
| `disney-wand-v02.m4a` | 00:11.076–00:21.075 |
| `disney-wand-v03.m4a` | 00:22.173–00:32.025 |
| `disney-wand-v04.m4a` | 00:33.199–00:43.129 |
| `disney-wand-v05.m4a` | 00:44.096–00:54.066 |
| `disney-wand-v06.m4a` | 00:55.141–01:05.089 |
| `disney-wand-v07.m4a` | 01:06.184–01:16.132 |
| `disney-wand-v08.m4a` | 01:16.985–01:26.914 |

O primeiro protótipo combinou `v01` e `v03` em 20 segundos, com crossfade
curto. A versão final de 19 segundos remove um segundo do **começo** dessa cama
e preserva integralmente o final de `v03`. Assim, o fragmento iniciado no
segundo 28 da fonte aparece no fim e fornece o fechamento musical pedido sem
ser truncado.

Quando a geração automática for habilitada, a seleção da variação deve ser
determinística a partir da revisão da grade. Não usar escolha aleatória em cada
execução, porque isso impediria reproduzir e auditar o comercial exibido.
