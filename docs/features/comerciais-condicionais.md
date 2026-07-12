# Feature: comerciais condicionais à programação

> Especificado em 2026-07-12 a partir da ideia do Gabriel.
> Estado: ✅ etapas 1 e 2 IMPLEMENTADAS e em produção (2026-07-12) —
> transcrição na fábrica (faster-whisper), extração da promessa por LLM,
> fila de revisão no painel, e agendador que segura promessa não confirmada
> e veicula "a_seguir" só colado no programa prometido.
> Prova: `pnpm verify:promessas` (10/10 com LLM real) + backfill no catálogo real.
> O que mudou vs o desenho original: modelo simplificado pra UMA tabela
> `media_promises` (transcript + proposta + condição + status) em vez de
> `ad_conditions`; "bloco_horario"/"evento" ficam RETIDOS (fora do rodízio)
> até a fase 10a garantir blocos fixos — nunca prometemos no escuro.
> Etapa 3 (programação guiada por promo) segue pendente — entra com a 10a.

## O problema

Nem todo comercial pode passar a qualquer hora. Tipos identificados:

| Tipo | Exemplo | Condição de veiculação |
|---|---|---|
| **Genérico** | comercial de brinquedo | nenhuma — é o que temos hoje |
| **Sequência ("a seguir")** | "você está assistindo X, a seguir Y e depois Z" | a grade real precisa ter exatamente X → Y → Z a partir dali |
| **Horário fixo semanal** | "Power Rangers, de segunda a sexta às 17h" | o canal PRECISA ter esse bloco fixo; promo roda enquanto a regra existir |
| **Evento/maratona** | "sexta, de 22h às 6h, maratona Padrinhos Mágicos" | o evento precisa estar agendado; promo roda só ANTES do evento (janela de promoção) |

## O conceito-chave: comercial como promessa

Uma promo dessas não é um arquivo solto — **é uma promessa que o canal precisa
cumprir**. Isso amarra veiculação e programação nos dois sentidos:

- **Grade → comercial** (matching): ao preencher um break, o Diretor só considera
  promos cujas condições a grade que ele mesmo está escrevendo satisfaz.
- **Comercial → grade** (restrição): promos "default que não mudam" (horário fixo)
  viram regras na `channel_master_grid` que o Diretor é obrigado a respeitar.
  Promo de maratona vira um evento agendado que o Diretor materializa.

Bônus (fase 3 da feature): **programação guiada por promo** — o Diretor pode
*escolher* montar a sequência X → Y → Z justamente porque tem a vinheta perfeita
pra ela. É o que canal de verdade faz.

## Modelo de dados proposto

```sql
-- condições de veiculação por comercial/vinheta (0 condições = genérico)
CREATE TABLE ad_conditions (
  media_id TEXT NOT NULL REFERENCES media_items(id),
  kind     TEXT NOT NULL CHECK (kind IN ('sequence','weekly_slot','event')),
  payload  TEXT NOT NULL,              -- JSON por tipo (abaixo)
  status   TEXT NOT NULL DEFAULT 'needs_review',  -- IA extraiu, humano confirma
  PRIMARY KEY (media_id, kind)
);

-- eventos agendados (maratonas, especiais)
CREATE TABLE channel_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  canal     TEXT NOT NULL,
  tipo      TEXT NOT NULL,             -- 'maratona' | 'especial'
  series_id TEXT,
  start_at  INTEGER NOT NULL,          -- unix
  end_at    INTEGER NOT NULL
);
```

Payloads:

```jsonc
// sequence — as próximas atrações citadas, em ordem (ids canônicos de série)
{ "sequence": ["pucca", "power_rangers", "padrinhos_magicos"] }

// weekly_slot — dias ISO (1=seg..7=dom) e hora local (America/Sao_Paulo)
{ "series": "power_rangers", "days": [1,2,3,4,5], "time": "17:00" }

// event — referência ao evento (ou dados p/ criá-lo)
{ "event_tipo": "maratona", "series": "padrinhos_magicos",
  "day": "friday", "from": "22:00", "until": "06:00" }
```

Pré-requisito importante: **ids canônicos de série** (`series_id`) — a promo fala
"Padrinhos Mágicos", o catálogo precisa saber que isso é `padrinhos_magicos`.
(Vem do Admin v2 / metadata_enricher com TMDB.)

## Captação: como as condições entram no sistema

Ideia do Gabriel, validada como o caminho certo: **transcrever o comercial na
ingestão** — comercial é curto (30–120s), transcrição é barata e o texto falado
diz exatamente a condição ("de segunda a sexta às cinco da tarde").

Camadas (mesmo padrão do resto do projeto — barato primeiro, humano confirma):

1. **Transcrição na fábrica** (pipeline, só p/ tipo comercial/vinheta):
   whisper.cpp modelo small PT-BR (grátis, roda na Action) ou API. Salva o texto
   em `metadata.transcript`.
2. **LLM extrai condições**: recebe transcript + título + duração → devolve JSON
   no schema acima (`kind` + `payload` + confiança). Sem menção a horário/série
   → genérico.
3. **Confirmação no admin** (`status: needs_review` → aba "revisar"): humano vê
   "detectei: horário fixo, Power Rangers, seg–sex 17:00 — confirma?" e ajusta se
   preciso. Promos `weekly_slot`/`event` confirmadas geram/checam a regra ou o
   evento correspondente (com aviso se a grade ainda não cumpre a promessa).
4. **Veiculação (Diretor, determinístico, sem LLM em runtime)**:
   - `sequence`: elegível no break B se as próximas atrações após B forem
     exatamente a sequência (o Diretor conhece a grade — ele a está escrevendo).
   - `weekly_slot`: elegível enquanto a regra correspondente existir na
     `channel_master_grid` (qualquer horário, ou com peso maior perto do slot).
   - `event`: elegível entre `agora` e `start_at` do evento (janela de promoção);
     auto-desativa depois que o evento passa.
   - Promo cuja promessa deixou de valer (regra removida, evento cancelado) sai
     do pool sozinha — nunca prometemos o que não vamos cumprir.

## Fases de implementação

1. **Modelo + matching manual** — tabelas, condições cadastradas à mão no admin,
   Diretor respeitando. Sem IA. Já entrega o valor central.
2. **Captação automática** — whisper na fábrica + LLM extrator + fila de revisão.
3. **Programação guiada por promo** — Diretor considera o acervo de promos ao
   montar a grade (sequências que ele consegue "cumprir" ganham prioridade).

## Riscos / cuidados

- **Fuso e horário de verão**: promos falam hora local (America/Sao_Paulo);
  grade é unix — conversão sempre num lugar só.
- **Promo desatualizada**: a regra de auto-desativação é essencial (pior que não
  ter promo é prometer o que não passa).
- **Transcrição errada** (números/horas em PT): por isso o humano confirma.
- **Normalização de nomes de série**: sem `series_id` canônico o matching quebra.
