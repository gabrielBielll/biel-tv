# Feature: Diretor IA (fase 10)

> Especificado em 2026-07-12. Estado: em desenho. Depende de: fase 9
> (Diretor determinístico) — o Diretor IA é uma camada FINA por cima dele.

## O princípio que organiza tudo: o LLM decide, o código calcula

O LLM **nunca** escreve na `epg_virtual` diretamente. LLM é ótimo em decisão
editorial ("sábado pede maratona", "esse comercial combina com esse horário")
e ruim em aritmética de timestamps. Então a divisão é:

```
contexto ──▶ LLM (1 chamada/dia) ──▶ PLANO editorial (JSON validado)
                                          │
                          compilador determinístico (fase 9)
                                          │
                              linhas exatas na epg_virtual
                     (matemática de 10s, cue points, rodízio, promos)
```

Se o LLM falhar, alucinar id, ou a API cair: o **fallback é o próprio montador
determinístico**, que estende a grade sozinho. A TV nunca depende do LLM pra
continuar no ar — o LLM só a deixa mais interessante.

## Ciclo diário

1. **Cron** no Worker (03:00 America/Sao_Paulo) — mesmo trigger da fase 9.
2. **Coleta de contexto** (D1): resumo do catálogo (séries, episódios em ordem,
   durações, tags, `last_played_at`), o que passou nas últimas 48h, dia da
   semana + feriados BR + datas especiais (Halloween, Natal…), regras fixas da
   `channel_master_grid`, diretrizes do dono (tabela `config`, ex.:
   `diretriz_semana = "foca em Power Rangers"`), eventos agendados.
3. **Chamada ao modelo** com **structured outputs** (`output_config.format`
   com JSON schema) — a API garante JSON válido no schema; zero parsing frágil.
4. **Validação dura em código**: todos os `media_id`/séries existem? blocos
   cabem no dia? regras fixas respeitadas? campanhas satisfazíveis?
   → inválido: 1 retry com a mensagem de erro; falhou de novo → fallback + log.
5. **Compilação**: plano → linhas da `epg_virtual` (append-only, como hoje).
6. **Visibilidade**: plano + tema do dia salvos na `config` → admin mostra
   "grade de amanhã" (e o front pode exibir o tema, tipo "Sábado de Ação").

## Contrato de saída (rascunho do schema)

```jsonc
{
  "tema_do_dia": "Sábado nostalgia anos 2000",
  "blocos": [
    {
      "inicio": "07:00",                    // compilador arredonda pra grade de 10s
      "nome": "Manhã Animada",
      "playlist": [                          // refs, nunca timestamps
        { "tipo": "serie_sequencial", "series_id": "pucca", "episodios": 4 },
        { "tipo": "media", "media_id": "flm_madagascar" }
      ],
      "breaks": { "duracao_alvo_seg": 120 }  // pods de ~2min nos cues/entre programas
    }
  ],
  "eventos": [
    { "tipo": "maratona", "series_id": "padrinhos_magicos",
      "inicio": "22:00", "fim": "06:00" }
  ],
  "campanhas": [
    { "media_id": "com_power_rangers", "min_execucoes": 5, "faixa": "18:00-22:00" }
  ]
}
```

O compilador resolve refs → mídias concretas (rotação por `last_played_at`
dentro do que o plano pede), fatia nos cue points, preenche breaks até a
duração-alvo, aplica campanhas e valida promos condicionais (fase 12).

## Modelo e custo

| Opção | Preço (in/out por MTok) | Custo estimado* | Quando |
|---|---|---|---|
| `claude-opus-4-8` (recomendado) | $5 / $25 | ~US$ 0,10/dia ≈ US$ 3/mês | decisão editorial melhor; padrão |
| `claude-haiku-4-5` | $1 / $5 | ~US$ 0,02/dia ≈ US$ 0,60/mês | knob de economia máxima |

\* 1 chamada/dia ≈ ~5k tokens de contexto + ~3k de plano. Prompt caching não
compensa em job diário (TTL de minutos/horas) — não usar.

Implementação: SDK oficial `@anthropic-ai/sdk` (roda em Worker — é fetch puro),
`ANTHROPIC_API_KEY` via `wrangler secret put`. Structured outputs via
`client.messages.parse()` + `zodOutputFormat(PlanoSchema)` (Zod já valida os
tipos; a validação de NEGÓCIO — ids existem etc. — continua em código nosso).
Adaptive thinking ligado (`thinking: {type: "adaptive"}`).

## Autonomia (decisão do Gabriel — em aberto)

- **Modo auto**: a grade de amanhã vai ao ar sem intervenção.
- **Modo revisão**: aba "grade de amanhã" no admin com aprovar/regenerar.
- **Sugestão (meio-termo)**: auto com **janela de veto** — o plano fica visível
  no admin o dia inteiro; sem veto até 23h, vai ao ar. Autonomia + controle.

## Perguntas em aberto (decisões do dono do canal)

1. **Identidade editorial**: qual é a "cara" da Biel TV? (nostalgia 90s/2000s?
   infantil? mix por faixa horária — manhã infantil, noite nostalgia?)
   Isso vira o núcleo do prompt do Diretor.
2. **Autonomia**: auto, revisão, ou janela de veto?
3. **Frequência**: 1x/dia planejando D+1 (padrão) ou também um "replan" leve
   à tarde?
4. **Modelo**: Opus 4.8 (~US$3/mês, melhor gosto editorial) ou Haiku
   (~US$0,60/mês)?

## Fases de implementação

1. **(fase 9 — pré-requisito)** Compilador determinístico no cron do Worker:
   `channel_master_grid`, rotação, pods com duração-alvo, shuffle com seed.
2. **10a — Diretor IA mínimo**: contexto → structured output → validação →
   compilação → fallback. Prompt com a identidade editorial do canal.
3. **10b — Refinos**: janela de veto no admin, temas sazonais/feriados,
   campanhas de comerciais, "replan" intradiário opcional.
