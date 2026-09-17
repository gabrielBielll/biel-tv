# Grade da Cartoon Network — blocos por tom + problemas conhecidos

> Registro do desenho da grade da CN por **tom** e dos problemas em aberto.
> Aplicado em 2026-08-04. Objetivo: a grade fluir sem "quebrar o clima" de quem
> assiste — e listar o que ainda falta resolver.

## Princípio (curadoria do Gabriel)

Não fazer **ping-pong** entre desenho sério e comédia. O problema não é trocar de
programa; é **trocar e ficar voltando** (sério → comédia → sério → comédia). A
faixa deve ser um **degradê que passa por cada tom uma vez** (ex.: ação →
meio-termo → leve → comédia), sem voltar. Clássicos ficam **isolados** no seu
próprio bloco (manhã/madrugada).

### Classificação por tom (acervo CN)

| Categoria | Séries |
|---|---|
| 📺 **Clássicos "das antigas"** (isolada, própria) | Tom & Jerry · Looney Tunes (clássico) · Os Flintstones · Manda-Chuva · A Corrida Maluca |
| 🎬 **Ação / sério** | Liga da Justiça · Jovens Titãs · Jackie Chan |
| 😐 **Meio-termo** (ação c/ humor) | As Meninas Superpoderosas · Juniper Lee · Martin Mystery |
| 🧩 **Leve / grounded** (comédia não "bobinha") | Scooby-Doo · O Show dos Looney Tunes |
| 😂 **Comédia** (moderna) | Billy e Mandy · KND · Coragem · Hey Arnold |

Notas: o **Show dos Looney Tunes** (2011) ≠ Looney clássico — é moderno, vai no
"leve" junto do Scooby, não nos clássicos nem na comédia pura.

## Faixa da tarde aplicada (13h–17h, diária)

Degradê 🎬 → 😐 → 🧩 → 😂:

```
13:00 Liga da Justiça 🎬 · 13:30 Jovens Titãs 🎬 · 14:00 Jackie Chan 🎬
14:30 Meninas 😐 · 15:00 Juniper Lee 😐
15:30 Scooby-Doo 🧩 · 16:00 Show Looney 🧩
16:30 KND 😂 · 17:00 Billy e Mandy 😂
```

Billy também às 10:00 e 12:00/12:30 (seg-sex). Clássicos no bloco 04:00–06:30.

---

## ⚠️ PROBLEMA 1 — filler entre âncoras ignora o tom (o principal)

As **âncoras** (horários fixos) ficam com o tom certo, mas o scheduler enche os
**buracos entre elas** com episódios extras escolhidos por **"menos tocado
recentemente"** (`last_played_at` / frescor em `apps/stream/src/scheduler.ts`),
**sem olhar tom**. As séries com pool grande (ex.: **Liga da Justiça**, 25 eps)
sempre têm episódio "fresco" e por isso **dominam o filler** — furando os blocos
calmos.

Exemplo real (grade de 05/08):
```
15:00 Juniper 😐 → 15:25 Liga 🎬 (!) → 15:30 Scooby 🧩
16:00 Show Looney 🧩 → 16:29 Liga 🎬 (!) → 16:30 KND 😂
```

**Soluções possíveis (nenhuma implementada):**
1. **Comerciais/vinhetas nos buracos** (recomendado): com pool de comercial gordo,
   os buracos enchem de propaganda de época em vez de cartoon fora de tom —
   resolve a quebra E dá cara de TV real. Depende do acervo de comerciais
   (ver `comerciais-epoca-2005-2010.md`).
2. **`eps=2` nas âncoras**: o programa da faixa ocupa mais os 30min, sobra menos
   buraco pro filler.
3. **Ajuste no scheduler** (código): filler tom-aware — preferir mesmo tom ou
   conteúdo neutro (comercial/vinheta/clássico) ao preencher.

## ⚠️ PROBLEMA 2 — séries magras repetem cedo

Rotação da âncora é **round-robin por id** (`scheduleAncora`), sem cooldown. Série
com poucos eps em vários slots repete no mesmo dia. **Aceito por ora** — o Gabriel
vai subir mais episódios. Magras hoje: corrida_maluca(2), billy_e_mandy(2),
hey_arnold(2), juniper(5), coragem(7), looney_tunes_show(7). Regra de bolso:
`episódios ≥ airings/dia × 7` pra não repetir na semana.

## ⚠️ PROBLEMA 3 — reschedule append-only não reposiciona horas já geradas

Ao criar/mudar slot, o replan é **append-only** e preserva o que já foi gerado.
Por isso a **Corrida Maluca (04:00)** — eps prontos e no canal — só aparece a
partir de ~06/08 (a madrugada de 05/08 já estava gerada). Pra valer na hora,
precisa **forçar regeneração** dessa janela.

## Estado (2026-08-04)
- Tarde por tom: **aplicada**.
- Flintstones: ingestão **concluída** (21/21 prontos, no cartoon_network).
  Corrida Maluca: 2/2 prontas.
- Manhã ainda NÃO reorganizada por tom (tem Jovens Titãs 🎬 solto às 10:30 no meio
  de comédia) — fazer depois.
