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

A arquitetura é agnóstica de provedor: o LLM é uma função
`(contexto) → plano JSON`. Se o free tier mudar um dia, trocar de modelo é
trocar essa função — nada mais se move.

## Chat com o Diretor (aba no admin)

Conversa em linguagem natural, por canal. Exemplos reais do Gabriel:

- *"retire tal desenho da programação dos próximos 2 meses"*
- *"faz uma maratona de X"*
- *"passa um filme hoje à noite"*

Como funciona (mesmo princípio — o LLM emite **ações tipadas**, nunca SQL):

1. Mensagem → Gemini com function calling + contexto do canal (catálogo,
   grade, diretrizes ativas).
2. O LLM responde com ações: `add_directive` (exclusão/preferência com
   vigência), `schedule_event` (maratona/filme com data e hora),
   `replan_today` (recompila o resto do dia), ou `answer` (só conversa).
3. Código valida (a mídia existe? as datas fazem sentido?) e executa; o chat
   confirma o que de fato aconteceu: *"Feito — Padrinhos Mágicos fora da
   grade do canal Jetix até 12/09."*
4. Tabela `directives`: (canal, tipo, payload JSON, vigente_de, vigente_ate,
   origem, status). O planejamento noturno trata diretrizes ativas como
   **restrições duras** — pedido no chat vale até expirar, não só hoje.
5. Pedido para hoje → replan imediato do resto do dia, **append-only** (nunca
   corta o que está no ar).

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
