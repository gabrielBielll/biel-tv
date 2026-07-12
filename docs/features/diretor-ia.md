# Feature: Diretor IA (fase 10)

> v2 — atualizado em 2026-07-12 com as decisões do Gabriel: LLM = **Gemini**
> (free tier ⇒ custo zero), **canais nostálgicos** com identidade própria,
> **chat com o Diretor** no admin, e resiliência a remoção de mídia.
> Depende de: fase 9 (compilador determinístico + estrutura de canais).

## A visão: canais nostálgicos

A Biel TV não é um canal — é **vários**, cada um imitando um canal da infância:

- **Jetix** — só programação da era Jetix (desenhos, vinhetas e comerciais dela)
- **Cartoon Network** — desenhos, comerciais e filmes da CN
- **Disney Channel** — mesmo modelo
- (outros conforme a nostalgia pedir)

Uso pessoal: a graça é a experiência da TV linear da infância — ligar e "estar
passando" — que streaming não reproduz. Logo, o trabalho do Diretor de cada
canal é um só: **imitar a programação do canal original** — ritmo, blocos
típicos, horários característicos, vinhetas da casa entre programas,
comerciais da época nos intervalos.

Estrutura:

- Tabela `channels`: id (`jetix`, `cartoon_network`, `disney_channel`), nome
  de exibição, **`identidade`** (o prompt editorial: como aquele canal
  programava — blocos, faixas horárias típicas, tom) e branding (cor/logo
  pro front). Identidade é um campo editável no admin — eu escrevo a
  primeira versão com base em referências históricas, Gabriel ajusta.
- Mídia → canal: campo `canais` no metadata, definido no upload (o admin
  ganha um seletor; a sugestão automática deduz pelo nome — "Jetix" no
  arquivo → canal jetix).
- O Diretor roda **por canal**, enxergando só o catálogo daquele canal.
- O schema já suporta (`canal` em todas as tabelas de grade desde o dia 1).

## O princípio (inalterado): o LLM decide, o código calcula

O LLM nunca escreve na `epg_virtual`. Ele produz um **plano editorial** em
JSON; validação de negócio e compilação em linhas exatas (matemática de 10s,
cue points, rodízio, promos) são do código (fase 9). Qualquer falha do LLM →
**fallback determinístico** estende a grade sozinho. A TV nunca sai do ar por
causa de modelo.

## LLM: Gemini (decisão do Gabriel, 2026-07-12)

Free tier da API do Gemini ⇒ custo zero. 1–2 chamadas/dia por canal + o chat
cabem com folga nas cotas gratuitas.

- **Chamada**: REST puro (`generativelanguage.googleapis.com`) direto do
  Worker — fetch, sem SDK pesado. `GEMINI_API_KEY` via `wrangler secret put`.
- **JSON garantido**: `generationConfig.responseMimeType: "application/json"`
  + `responseSchema` — o equivalente Gemini de structured outputs.
- **Function calling** para o chat (ações tipadas, abaixo).
- **Modelo**: começar no tier flash (cota gratuita generosa); subir se o
  gosto editorial pedir.

**Fallback de provedor (decisão do Gabriel, 2026-07-12): Gemini → DeepSeek.**
Se o Gemini responder erro de cota (`429` / `RESOURCE_EXHAUSTED`), a mesma
chamada é repetida no **DeepSeek** (`api.deepseek.com`, API compatível com o
formato OpenAI, modelo `deepseek-v4-flash`, `response_format: json_object` +
validação nossa por cima — o Gabriel tem créditos lá). Se os dois falharem →
fallback determinístico, como sempre. `DEEPSEEK_API_KEY` via secret.

A arquitetura é agnóstica de provedor: o LLM é uma função
`(contexto) → plano JSON`. A cadeia Gemini → DeepSeek → determinístico cobre
cota, indisponibilidade e resposta inválida — nada mais se move.

## Falar com o canal: dois modos (decisão do Gabriel, 2026-07-12)

Separação de poderes: **Votaton = pedidos SOFT** (o Diretor pondera, sem
garantia) · **Modo God = ordens HARD** (código executa, garantido).

### Votaton — o modo telespectador (a experiência padrão)

Inspirado nos votatons da época (o Votatoon da Cartoon): na **página da TV**
(não no admin), por canal, um espaço "peça sua programação". O pedido **não é
garantido** — de propósito. A incerteza simula outros telespectadores votando
e transforma o atendimento em conquista (recompensa variável, o "gatilho" que
o Gabriel descreveu).

1. Pedido entra na tabela `votaton_requests` (canal, pedido, data, status:
   `pendente`/`atendido`/`perdeu`, peso).
2. Na resolução (no planejamento noturno e/ou em **eventos de votaton**
   agendados, ex.: sexta à tarde, como era na TV), o Diretor atende com
   **probabilidade configurável** (padrão ~50%) e gera concorrentes
   plausíveis + placar simulado pra imersão: *"Pucca 38% × Padrinhos 41% ×
   Kick Buttowski 21%"*.
3. **Pity timer**: pedido que perde ganha peso na rodada seguinte — a
   conquista sempre chega, só não se sabe quando. (Sem isso, azar em série
   vira frustração; com isso, vira expectativa.)
4. **A vitória é celebrada**: selo "PEDIDO DOS TELESPECTADORES" na grade +
   aviso na UI ("Você pediu, vai passar: hoje às 19h!").
5. A UI **nunca quebra a quarta parede** — jamais admite que existe um único
   telespectador.

### Modo God — escondido

O chat direto com o Diretor (o poder de verdade) fica fora da vista pra não
quebrar a imersão do votaton:

- Vive no admin, mas a aba **só aparece com a flag `god_mode` ligada**
  (tabela `config`).
- Ativação discreta — proposta padrão: **easter egg** (clicar 5× no logo
  BIEL TV do admin liga/desliga a flag); alternativa: toggle minúsculo no
  rodapé do admin. O front do votaton nunca menciona que o modo existe.
- Conversa em linguagem natural com **ações garantidas** (o LLM emite ações
  tipadas, nunca SQL): `add_directive` (ex.: *"retire tal desenho da
  programação dos próximos 2 meses"* — exclusão/preferência com vigência),
  `schedule_event` (maratona/filme com data e hora), `replan_today`
  (recompila o resto do dia, **append-only** — nunca corta o que está no ar),
  `answer` (só conversa).
- Código valida (mídia existe? datas ok?) e executa; o chat confirma o que de
  fato aconteceu: *"Feito — Padrinhos Mágicos fora da grade do Jetix até
  12/09."*
- Tabela `directives`: (canal, tipo, payload JSON, vigente_de, vigente_ate,
  origem, status). O planejamento noturno trata diretrizes ativas como
  **restrições duras** — valem até expirar, não só hoje.
- Pelo Modo God também se ajusta o próprio votaton: probabilidade, frequência
  dos eventos, ou forçar um resultado.

## Resiliência a remoção de mídia

Gabriel vai remover vídeos para renovar o catálogo. Três camadas de defesa:

1. **Remover pelo admin é o caminho feliz**: botão "remover" = apaga os
   segmentos do R2 + marca `removed` no D1 + expurga a mídia da grade futura
   (reflow a partir do fim do bloco atual).
2. **Reconciliação noturna** (roda antes do planejamento): para cada mídia
   `ready`, confere no R2 (HEAD no primeiro e no último segmento); sumiu →
   `disabled` + aviso no admin; grade futura órfã → recompilada.
3. **Compilador só escala `status='ready'`** (já é assim hoje) e valida cada
   id citado no plano do LLM — plano citando mídia removida = erro de
   validação → retry com a mensagem de erro → fallback.

Última linha de defesa no player: o clamp defensivo já existe, e a mídia
placeholder (backlog) cobre o pior caso com tela de "já voltamos".

## Decisões em aberto

- **Autonomia do plano noturno**: auto vs janela de veto. Com o chat dando
  controle fino a qualquer momento, sugerido: **auto**.
- Conteúdo das identidades (prompts Jetix/CN/Disney): primeira versão minha,
  revisão do Gabriel no campo editável.

## Ordem de implementação

1. **(fase 9)** Compilador no cron + tabela `channels` + mapeamento
   mídia→canal + reconciliação + troca de canal no front.
2. **10a** — Planejamento noturno por canal (Gemini + responseSchema +
   validação + fallback), com o prompt de identidade de cada canal.
3. **10b** — Chat do Diretor (function calling + `directives` + replan).
4. **10c** — Refinos: temas sazonais/feriados, campanhas de comerciais,
   janela de veto se o Gabriel quiser.
