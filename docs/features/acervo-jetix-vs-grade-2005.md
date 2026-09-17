# Acervo × Grade-alvo — Jetix 2005

> Cruzamento entre a grade-alvo (aba "24h Jetix 2005" do xlsx — dia
> representativo **09/03/2005**) e o catálogo real no D1 (`media_items` +
> `media_channels`, canal `jetix`). Gerado em 2026-07-29. Já passou pela
> **curadoria do Gabriel** (nem tudo da grade real entra — ver Decisões).
>
> Obs.: a aba "24h" usa 09/03/2005; o `grade-alvo-2005.md` usou 28/12/2005 —
> por isso títulos como W.I.T.C.H., Dragon Booster, A.T.O.M. e Super Esquadrão
> dos Macacos aparecem lá mas não aqui.

## ✅ Já no acervo (3 títulos que batem com a grade)

| Programa (grade) | series_id (D1) | Eps | Obs |
|---|---|---:|---|
| Os Padrinhos Mágicos | `padrinhos_magicos` | 102 | ok, farto |
| Power Rangers: Força Animal | `power_rangers_forca_animal` | 39 | ok |
| Beyblade G-Revolution | `ep_beyblade_pt_br_episodio_1` | 1 | ⚠️ 1 ep só e **sem series_id** — taggear (`series_id=beyblade_g_revolution`) e baixar mais |

## ⬇️ Faltando baixar — checklist (curado)

**Ação/aventura ocidental**
- [ ] Inspetor Bugiganga
- [ ] Fillmore!
- [ ] Code Lyoko
- [ ] Três Espiãs Demais
- [ ] Dave, o Bárbaro
- [ ] Homem-Aranha
- [ ] Action Man
- [ ] O Colégio do Buraco Negro

**Power Rangers (da grade)**
- [ ] Power Rangers: Tempestade Ninja
- [ ] Power Rangers: Dino Trovão

**Power Rangers (extras — adição do Gabriel, além da grade 2005)**
- [ ] Power Rangers: S.P.D. (Superpatrulha Delta, 2005)
- [ ] Power Rangers: Força Mística (Mystic Force, 2006)
- [ ] Power Rangers: Operação Sobrecarga (Operation Overdrive, 2007)
- [ ] Power Rangers: Fúria da Selva (Jungle Fury, 2008)

**Animes / mecha**
- [ ] Kirby: Right Back at Ya!
- [ ] Medabots
- [ ] Digimon 4
- [ ] Sonic X
- [ ] Shaman King
- [ ] MegaMan: NT Warrior
- [ ] Beyblade G-Revolution (completar — hoje só 1 ep)

**Curtos / variedades / live-action**
- [ ] Músculo Total
- [ ] Ciência Travessa
- [ ] Sinistro (So Weird)
- [ ] Goosebumps

## ⚠️ No acervo mas fora da grade 2005 (decidir)

| Item | Eps | Situação |
|---|---:|---|
| Power Rangers: Galáxia Perdida (`pwr_rangers_glx_perd`) | 6 | temporada mais antiga; fora da grade 09/03/2005. Manter? |
| Power Rangers: O Resgate (`pwr_rangers_oresgate`) | 2 | idem |
| Super Esquadrão dos Macacos (`super_esquadrao_dos_macacos`) | 2 | estava na grade de **28/12/2005** — encaixável |
| Pucca (`pucca`) | 2 | estreou **2006** — anacrônico p/ 2005 |
| Yin Yang Yo! (`yin_yang_yo`) | 9 | estreou **2006** — anacrônico p/ 2005 |

## Decisões (2026-07-29)
- **Fora da grade / remover do canal jetix** (fora de marca, tag errada):
  `ep_madagascar_cupcake` (Madagascar) e `ep_seu_madruga_vai_aos_eua` (Chaves).
- **Manter o restante** dos faltantes.
- **Adicionar 4 temporadas extras de Power Rangers** (acima) — expansão além da
  grade real, por gosto do Gabriel; S.P.D. é 2005, as outras 2006-2008.

## Próximos passos
- [ ] **Remover do jetix** `ep_madagascar_cupcake` e `ep_seu_madruga_vai_aos_eua`
  (`DELETE FROM media_channels WHERE channel_id='jetix' AND media_id IN (...)`).
- [ ] Taggear o Beyblade (`ep_beyblade_pt_br_episodio_1`) com `series_id`.
- [ ] Decidir sobre PR Galáxia Perdida / O Resgate / Super Esquadrão / Pucca / Yin Yang Yo.
- [ ] (Pendência da CN) migrar `martin_mystery` CN → jetix — não aparece nesta
  grade 09/03, mas era desenho do Jetix.
- [ ] Ingerir os faltantes quando chegarem e ligar ao `jetix`.
