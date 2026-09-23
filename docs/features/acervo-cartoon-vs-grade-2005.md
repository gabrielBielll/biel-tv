# Acervo × Grade-alvo — Cartoon Network 2005

> Cruzamento entre a grade-alvo (`grade-alvo-2005.md`, aba "24h Cartoon 2005" do
> xlsx) e o catálogo real no D1 (`media_items` + `media_channels`, canal
> `cartoon_network`). Gerado em 2026-07-29. Objetivo: saber **o que já temos** e
> **o que falta baixar** pra rodar a grade fiel.

## ✅ Já no acervo (5 títulos)

| Programa (grade) | series_id (D1) | Eps | Obs |
|---|---|---:|---|
| Os Jovens Titãs | `jovens_titas` | 26 | ok |
| Liga da Justiça | `liga_da_justica_sem_limites` | 25 | usada na madrugada |
| Coragem, o Cão Covarde | `coragem_o_cao_covarde` | 7 | ok |
| Scooby-Doo / O Que Há de Novo? | `scooby_doo` | 41 | ⚠️ **conflado** — mistura clássico (`ep_scooby_doo_eNN`) com "O Que Há de Novo" (`ep_oshwd...`). Separar em 2 series_id. |
| As Terríveis Aventuras de Billy e Mandy | `billy_e_mandy` | 2 | ⚠️ só 2 eps |

## ➕ Adições fora da grade 2005 (curadoria do Gabriel)

Clássicos que o Gabriel escolheu colocar na CN mesmo não estando na grade-alvo
de 2005 — assim como as temporadas extras de Power Rangers no Jetix. Época real
anterior a 2005, mas cabem no "espírito clássico" da manhã/madrugada da CN.

| Programa | series_id (D1) | Eps | Status |
|---|---|---:|---|
| Manda-Chuva (Top Cat, 1961) | `manda_chuva` | 18* | **ingerido** (2026-08-02): 18 eps `ready` e ligados ao `cartoon_network`. Fonte 528×384 4:3 → `--fit fill` 16:9. ⚠️ ainda SEM `channel_slot` → não aparece na grade até criar um (ver Próximos passos). |
| A Corrida Maluca (Wacky Races, 1968) | `corrida_maluca` | 15 blocos (30 corridas) | **ingerido** (2026-08-04): 15 arquivos, 2 corridas/bloco (~21min = 1 ep real de TV) → 30 corridas. Fonte 1920×1080 com pillarbox → `--crop 1424:1080:248:0 --fit fill --audio-lang por`. Slot 04:00 criado; materializa na próxima regeneração da madrugada. |

\* Manda-Chuva: MC 01-05, 07-10, 13, 14, 19, 20, 22-26 (com saltos; faltam 06,
11, 12, 15-18, 21 = 8). Ids seguem o número do arquivo: `ep_manda_chuva_s1e<NN>`.

## ⬇️ Faltando baixar (24 títulos) — checklist

**Originais / tarde CN**
- [ ] O Laboratório de Dexter
- [ ] As Meninas Superpoderosas
- [ ] Johnny Bravo
- [ ] Du, Dudu e Edu (Ed, Edd n Eddy)
- [ ] KND: A Turma do Bairro
- [ ] A Mansão Foster para Amigos Imaginários
- [ ] As Aventuras de Jackie Chan
- [ ] Mucha Lucha
- [ ] Betty Atômica
- [ ] O Clube das Winx
- [ ] Hi Hi Puffy AmiYumi
- [ ] Super Choque (Static Shock)

**Clássicos (Hanna-Barbera / Looney)**
- [ ] Tom e Jerry
- [ ] Pernalonga e Patolino
- [ ] Looney Tunes (clássico — NÃO o "Show dos Looney Tunes" de 2011)
- [x] Os Flintstones — **em ingestão** (2026-08-04): 21 eps S01E01-E21 `flintstones`, `--fit fill` 16:9
- [ ] Os Jetsons

**Ação / DC (madrugada)**
- [ ] X-Men: Evolution

> **Batman do Futuro: excluído da grade da CN** por decisão do Gabriel
> (2026-07-29). Não baixar. Deixa um buraco às 03:00 na aba "24h Cartoon 2005"
> do xlsx — preencher com outra ação/reprise da madrugada.

**Animes**
- [ ] Pokémon
- [ ] InuYasha
- [ ] Yu Yu Hakusho
- [ ] Samurai X
- [ ] Dragon Ball GT

> "Cartoon Cartoons" (bloco das 20h) não é série — monta-se com Dexter / MSP /
> Coragem / Foster quando existirem.

## ⚠️ No acervo mas fora da grade 2005 (decidir)

| Item | Eps | Situação |
|---|---:|---|
| O Show dos Looney Tunes (`looney_tunes_show`) | 7 | 2011 — anacrônico. Serve de "Looney Tunes" só se aceitar quebra de época. |
| A Vida e Aventuras de Juniper Lee | 5 | 2005-07 — **cabe na época**, dá pra encaixar. |
| Capitão Lento (`capitao_lento`) | 2 | 2010 — anacrônico. |
| Hey Arnold! (`hey_arnold`) | 2 | Nickelodeon — fora de marca. |
| Martin Mystery (`martin_mystery`) | 5 | era do **Jetix**, não CN → **migrar p/ `jetix`** (decisão 2026-07-29; documentado como pendência, ver Próximos passos — ainda NÃO executado no D1). |
| `ep_nicole_trabalho`, `ep_gentileza` | 2 | sem series_id; não parecem desenho — provável tag errada no CN. |

## Decisões (2026-07-29 / 2026-08-02)
- **Batman do Futuro** — fora da grade da CN. Não baixar.
- **Martin Mystery** — pertence ao **Jetix**; migrar de `cartoon_network` p/
  `jetix` (abaixo). Enquanto não migrado, ignorar na grade da CN.
- **Manda-Chuva (Top Cat)** — adição fora da grade 2005 (clássico Hanna-Barbera),
  ingerido no `cartoon_network` em 2026-08-02 (18 episódios, `--fit fill` 16:9).
  Falta criar `channel_slot` pra ele efetivamente entrar na grade.

## Próximos passos
- [ ] **Migrar `martin_mystery` CN → Jetix**: `DELETE FROM media_channels WHERE
  channel_id='cartoon_network' AND media_id IN (<eps martin_mystery>)` +
  `INSERT ... channel_id='jetix'`. Confirmar antes se o Jetix realmente lista
  Martin Mystery na aba "24h Jetix 2005".
- [ ] Separar o `scooby_doo` conflado em clássico vs "O Que Há de Novo".
- [ ] Repetir o cruzamento pra **Jetix** (aba "24h Jetix 2005") e **Disney** (aba "24h Disney 2002").
- [ ] Quando os episódios faltantes chegarem, ingerir e ligar ao `cartoon_network`.
- [ ] Alimentar a grade fiel (mapear horário → series_id) pra o Diretor tocar o episódio certo por faixa, em vez de 24 eps em sequência.
