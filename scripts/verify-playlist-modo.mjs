// Teste do MODO da playlist: "episódios em PARTES" vs "1 vídeo = 1 EPISÓDIO".
//
// Motivo (Gabriel, 21/09/2026 — Power Rangers SPD): o parser assumia que todo
// "(Parte N)" no título era um PEDAÇO do episódio. Na playlist do SPD cada
// vídeo tem 22min — é o episódio INTEIRO — e o "(parte 1)/(parte 2)" é o nome
// da HISTÓRIA em duas partes, que na série são dois episódios numerados
// (EP01 "O Começo (parte 1)", EP02 "O Começo (parte 2)"). Resultado: 30 dos 38
// episódios reprovavam com "parte 1 faltando" ou "nenhuma parte numerada".
//
// Exercita o `montaGrupos` REAL, sem servidor e sem LLM (env vazio → cai no
// regex determinístico, que é justamente o caminho que rodou em produção).
// Invariantes:
//   1) playlist de inteiros (títulos reais do SPD) → os 38 episódios aprovam;
//   2) o nº de parte vira NOME, pra duas metades não ficarem com o mesmo
//      título no guia;
//   3) playlist de fragmentos (Jake Long, partes embaralhadas) não muda: junta
//      na ordem do TÍTULO, 1..6;
//   4) fragmento com buraco CONTINUA reprovando (a regra de ouro da feature);
//   5) um título errado do acervo (2 vídeos no mesmo nº) não vira a playlist
//      do avesso — o resto continua aprovando e só o ambíguo é reportado.
import { montaGrupos } from '../apps/stream/src/serie-partes.ts'

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`✅ ${name}${extra ? `  (${extra})` : ''}`) }
  else { fail++; console.log(`❌ ${name}${extra ? `  (${extra})` : ''}`) }
}

const entradas = (titulos) => titulos.map((title, i) => ({
  video_id: `v${i}`, url: `https://www.youtube.com/watch?v=v${i}`, title, playlist_index: i,
}))

// ── 1 e 2: os 38 títulos REAIS da playlist do Power Rangers SPD ────────────
const SPD = [
  "EP01 - O Começo -  ( parte 1 ) - SPD - HD",
  "EP02 - O Começo - ( parte 2 ) - SPD - HD",
  "EP03 - Rebaixando O Líder - SPD - HD",
  "EP04 - Paredes - SPD - HD",
  "EP05 - Ranger Canino - SPD - HD",
  "EP06 - Bridge O Super Detetive - SPD - HD",
  "EP07 - Sam ( parte 1) - SPD - HD",
  "EP08 - Sam ( parte 1) - SPD - HD",
  "EP09 - Ídolo - SPD -HD",
  "EP10 -  Tocaia - SPD - HD",
  "EP11 - Ranger Sombra - ( parte 1 ) - SPD - HD",
  "EP12 - Ranger Sombra ( parte 2 ) - SPD - HD",
  "EP13 - Abandonado - SPD - HD",
  "EP14 - Ligado ( parte 1 ) - SPD - HD",
  "EP15 - Ligado ( parte 2 ) - SPD -HD",
  "EP16 - Boom - SPD - HD",
  "EP17 - Reconhecimento - SPD - HD",
  "EP18 - Samurai - SPD - HD",
  "EP19 - Destituído - SPD - HD",
  "EP20 - Perspectiva - SPD - HD",
  "EP21 - O Mensageiro - ( Parte 1 )  - SPD - HD",
  "EP22 - O Mensageiro - ( Parte 2 ) - SPD - HD",
  "EP23 -  Batido - SPD - HD",
  "EP24 - SPD - Reflexo ( parte 2 ) - HD",
  "EP25 - Reflexos - ( Parte 2 ) - SPD - HD",
  "EP26  - S.W.A.T ( parte 1) - SPD - HD",
  "EP27  - S.W.A.T ( parte 2) - SPD - HD",
  "EP28 - Robôs em Massa - SPD - HD",
  "EP29 - Catástrofe - SPD - HD",
  "EP30 - Desaparecido - SPD - HD",
  "EP31 - Viagem no Tempo - SPD - HD",
  "EP32 -  Rota de Colisão - SPD - HD",
  "EP33 - O Distintivo - SPD - HD",
  "EP34 - Insônia - SPD - HD",
  "EP35 - Buraco de Minhoca - SPD - HD",
  "EP36 -  A Ressurreição - SPD - HD",
  "EP37 - O Fim ( parte 1 ) - SPD - HD",
  "EP38 - O Fim  ( Parte 2 )  -  SPD - HD",]

const spd = await montaGrupos({}, entradas(SPD), { series_id: 'power_rangers_spd' })
check('SPD: 38 episódios reconhecidos', spd.episodios.length === 38, `${spd.episodios.length}`)
check('SPD: nenhum vídeo sem classificação', spd.sem_classificacao.length === 0)
const reprovados = spd.episodios.filter((e) => !e.ok)
check('SPD: todos aprovam (1 vídeo = 1 episódio inteiro)', reprovados.length === 0,
  reprovados.map((e) => `ep${e.episodio}: ${e.aviso}`).join(' | '))
check('SPD: cada episódio tem 1 parte só', spd.episodios.every((e) => e.partes.length === 1))
check('SPD: ids saem por episódio', spd.episodios[0].media_id === 'ep_power_rangers_spd_e01',
  spd.episodios[0].media_id)
const t1 = spd.episodios.find((e) => e.episodio === 1).titulo
const t2 = spd.episodios.find((e) => e.episodio === 2).titulo
check('SPD: as duas metades de "O Começo" não ficam com o mesmo título', t1 !== t2, `${t1} ≠ ${t2}`)

// ── 3 e 4: o caso Jake Long (6 pedaços por episódio, FORA DE ORDEM) ────────
const jake = []
for (const ep of [1, 2, 3]) {
  for (const p of [1, 2, 6, 3, 4, 5]) { // a playlist real vem embaralhada assim
    jake.push(`Jake Long O Dragão Ocidental - Episódio 0${ep} - Spud, o Spudinífico (Parte ${p})`)
  }
}
const jl = await montaGrupos({}, entradas(jake), { series_id: 'jake_long', temporada: 1 })
check('Jake Long: 3 episódios de 6 partes', jl.episodios.length === 3 && jl.episodios.every((e) => e.partes.length === 6))
check('Jake Long: todos aprovam', jl.episodios.every((e) => e.ok))
check('Jake Long: partes ORDENADAS pelo título, não pela playlist',
  jl.episodios.every((e) => e.partes.map((p) => p.parte).join('') === '123456'),
  jl.episodios[0].partes.map((p) => p.parte).join(''))
check('Jake Long: temporada entra no id', jl.episodios[0].media_id === 'ep_jake_long_s1_e01',
  jl.episodios[0].media_id)

const furado = jake.filter((t) => !(t.includes('Episódio 02') && /Parte [134]\)/.test(t)))
const jf = await montaGrupos({}, entradas(furado), { series_id: 'jake_long', temporada: 1 })
const ep2 = jf.episodios.find((e) => e.episodio === 2)
check('Jake Long: episódio com buraco CONTINUA reprovando', !ep2.ok, ep2.aviso ?? '')
check('Jake Long: o buraco diz quais partes faltam', /1, 3, 4/.test(ep2.aviso ?? ''), ep2.aviso ?? '')
check('Jake Long: os episódios inteiros ao lado continuam aprovando',
  jf.episodios.filter((e) => e.episodio !== 2).every((e) => e.ok))

// ── 5: um título errado do acervo não vira a playlist do avesso ────────────
// (o SPD real tem isto: "EP07 - Sam ( parte 1)" e "EP08 - Sam ( parte 1)")
const amb = await montaGrupos({}, entradas([...SPD, 'EP09 - Ídolo - SPD - HD (reupload)']),
  { series_id: 'power_rangers_spd' })
const ep9 = amb.episodios.find((e) => e.episodio === 9)
check('duplicata: só o episódio ambíguo é reportado',
  !ep9.ok && ep9.partes.length === 2 && /mesmo nº de episódio/.test(ep9.aviso ?? ''), ep9.aviso ?? '')
check('duplicata: os outros 37 continuam aprovando',
  amb.episodios.filter((e) => e.episodio !== 9).every((e) => e.ok),
  `${amb.episodios.filter((e) => e.ok).length}/38 ok`)

console.log(`\n${fail === 0 ? '🎉' : '⚠️'} ${pass}/${pass + fail} checagens passaram`)
process.exit(fail === 0 ? 0 : 1)
