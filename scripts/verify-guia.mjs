// Teste do GUIA (/epg) — função pura `montaGuia`, sem servidor e sem banco.
// O guia é o que os apps desenham; o que se checa aqui é o que fazia o app
// travar ao trocar de canal (15/09/2026: 1,5 MB e 6.560 itens por troca):
//   1) comercial e vinheta NÃO são programa;
//   2) episódio picado pelos intervalos vira UM item;
//   3) o programa cobre o vão até o próximo → sempre existe "no ar" (o app não
//      fica sem legenda no intervalo, e o verify-canais continua valendo);
//   4) título ganha o nome da série quando não o traz;
//   5) reprise do mesmo episódio mais tarde é um item NOVO (não funde).
import { montaGuia } from '../apps/stream/src/guia.ts'

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`✅ ${name}${extra ? `  (${extra})` : ''}`) }
  else { fail++; console.log(`❌ ${name}${extra ? `  (${extra})` : ''}`) }
}

const T = 1_000_000
const linha = (media_id, tipo, start, end, seg = 0, meta = {}) => ({
  id: start, canal: 'cn', media_id, tipo,
  start_time_virtual: start, end_time_virtual: end, segment_index_start: seg,
  base_url: '', path_prefix: `media/${media_id}`, segment_count: 10,
  metadata: JSON.stringify(meta),
})

// grade real em miniatura: episódio com 2 intervalos no meio, pod entre
// programas, e o programa seguinte
const grade = [
  linha('ep_scooby_01', 'episodio', T, T + 600, 0, { title: 'O Fantasma do Museu', series_id: 'scooby_doo' }),
  linha('com_1', 'comercial', T + 600, T + 660),
  linha('com_2', 'comercial', T + 660, T + 720),
  linha('ep_scooby_01', 'episodio', T + 720, T + 1200, 60, { title: 'O Fantasma do Museu', series_id: 'scooby_doo' }),
  linha('com_3', 'comercial', T + 1200, T + 1260),
  linha('vin_1', 'vinheta', T + 1260, T + 1280),
  linha('ep_tom_05', 'episodio', T + 1280, T + 1700, 0, { title: 'Tom & Jerry - Ratoeira', series_id: 'tom_e_jerry' }),
]

{
  const g = montaGuia(grade, T + 100, new Map([['scooby_doo', 'Scooby-Doo']]))
  check('comercial/vinheta fora do guia', g.every((i) => i.tipo !== 'comercial' && i.tipo !== 'vinheta'))
  check('episódio picado vira UM item', g.length === 2, `${g.length} itens: ${g.map((i) => i.media_id).join(', ')}`)
  check('o item cobre o episódio inteiro (intervalos por dentro)', g[0].start === T && g[0].end >= T + 1200,
    `${g[0].start - T}s → ${g[0].end - T}s`)
  check('o programa cobre o vão até o próximo', g[0].end === T + 1280, `${g[0].end - T}s`)
  check('título ganha o nome da série', g[0].title === 'Scooby-Doo — O Fantasma do Museu', g[0].title)
  check('título que já traz a série não repete', g[1].title === 'Tom & Jerry - Ratoeira', g[1].title)
  check('nome da série sem clipe cai no slug bonito', g[1].serie === 'Tom e Jerry', String(g[1].serie))
}

// ── "no ar" em cada instante da grade ───────────────────────────────────────
for (const [quando, esperado, desc] of [
  [T + 100, 'ep_scooby_01', 'dentro do episódio'],
  [T + 650, 'ep_scooby_01', 'DURANTE o intervalo do meio'],
  [T + 1230, 'ep_scooby_01', 'no intervalo ENTRE programas (o guia segura o anterior)'],
  [T + 1400, 'ep_tom_05', 'no programa seguinte'],
]) {
  const g = montaGuia(grade, quando)
  const noAr = g.filter((i) => i.is_now)
  check(`exatamente 1 "no ar" — ${desc}`, noAr.length === 1 && noAr[0].media_id === esperado,
    noAr.map((i) => i.media_id).join(',') || 'nenhum')
}

// ── reprise: mesmo episódio de novo mais tarde é item novo ──────────────────
{
  const comReprise = [
    ...grade,
    linha('ep_scooby_01', 'episodio', T + 1700, T + 2300, 0, { title: 'O Fantasma do Museu', series_id: 'scooby_doo' }),
  ]
  const g = montaGuia(comReprise, T)
  check('reprise do mesmo episódio é item separado', g.length === 3 && g[2].media_id === 'ep_scooby_01',
    g.map((i) => i.media_id).join(', '))
}

// ── guia vazio não quebra ───────────────────────────────────────────────────
{
  check('grade só de comercial → guia vazio, sem erro',
    montaGuia([linha('com_1', 'comercial', T, T + 60)], T).length === 0)
  check('nada no intervalo pedido → lista vazia', montaGuia([], T).length === 0)
}

console.log(`\n${fail === 0 ? '🎉' : '⚠️'} ${pass}/${pass + fail} checagens passaram`)
process.exit(fail === 0 ? 0 : 1)
