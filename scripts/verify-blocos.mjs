// Teste unitário da montagem de BLOCOS da grade (pedido do Gabriel: agrupar
// episódios da mesma série em sequência, com as séries em rodízio). Verifica a
// função pura `montaBlocos` — sem servidor, sem banco. Node ≥ 22 lê o .ts
// direto (type stripping) e o único import de runtime (@bieltv/db) também é .ts.
import { montaBlocos } from '../apps/stream/src/scheduler.ts'

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`✅ ${name}${extra ? `  (${extra})` : ''}`) }
  else { fail++; console.log(`❌ ${name}${extra ? `  (${extra})` : ''}`) }
}

// PRNG fixa: teste reproduzível (as propriedades checadas independem do shuffle,
// mas seed fixa evita flakes)
function rng(seed) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
}
const ep = (id, series_id, last_played_at = 0) => ({ id, series_id, last_played_at })
const serieDe = (b) => b[0].series_id ?? `avulso:${b[0].id}`
const flat = (blocos) => blocos.flatMap((b) => b.map((m) => m.id))

// ── 1. episódios da mesma série viram pedaços em ordem, tamanho ≤ maxLen ─────
{
  // ordem de entrada embaralhada de propósito: a saída tem que sair ordenada
  const A = [ep('danny_04', 'danny'), ep('danny_01', 'danny'), ep('danny_03', 'danny'), ep('danny_02', 'danny')]
  const blocos = montaBlocos(A, 2, rng(1))
  const soDanny = blocos.filter((b) => serieDe(b) === 'danny')
  const tamOk = soDanny.every((b) => b.length <= 2) && soDanny.length === 2
  const ordemOk = flat(soDanny).join(',') === 'danny_01,danny_02,danny_03,danny_04'
  check('série de 4 eps → 2 blocos de 2, episódios em ordem de id', tamOk && ordemOk, flat(soDanny).join(' '))
}

// ── 2. as séries ALTERNAM (rodízio): dois blocos da mesma série não encostam ─
{
  // A (5 eps → 3 pedaços com maxLen 2) é a que mais tende a "empilhar";
  // last_played distinto fixa a ordem das séries e evita depender do shuffle
  const A = [1, 2, 3, 4, 5].map((i) => ep(`a_0${i}`, 'A', 0))
  const B = [1, 2].map((i) => ep(`b_0${i}`, 'B', 10))
  const C = [ep('c_01', 'C', 20)]
  const D = [ep('avulso_x', null, 30)] // conteúdo solto = série de si mesmo
  const blocos = montaBlocos([...A, ...B, ...C, ...D], 2, rng(7))
  let encostou = false
  for (let i = 1; i < blocos.length; i++) {
    if (serieDe(blocos[i]) === serieDe(blocos[i - 1])) encostou = true
  }
  check('rodízio: nenhuma série aparece em dois blocos seguidos', !encostou,
    blocos.map((b) => serieDe(b) + '×' + b.length).join(' → '))
  // e a série que mais empilha (A, 3 pedaços) aparece 3 vezes, sempre em blocos ≤2
  const blocosA = blocos.filter((b) => serieDe(b) === 'A')
  check('série longa (5 eps) sai em 3 blocos de ≤2, espalhados', blocosA.length === 3 && blocosA.every((b) => b.length <= 2))
}

// ── 3. cobertura: nenhum conteúdo perdido nem duplicado ─────────────────────
{
  const todos = [...[1, 2, 3, 4, 5].map((i) => ep(`a_0${i}`, 'A')), ...[1, 2].map((i) => ep(`b_0${i}`, 'B')), ep('z', null)]
  const saida = flat(montaBlocos(todos, 3, rng(3))).sort()
  const entrada = todos.map((m) => m.id).sort()
  check('cobertura: saída é permutação exata da entrada', JSON.stringify(saida) === JSON.stringify(entrada),
    `${saida.length} itens`)
}

// ── 4. maxLen = 1 desliga o agrupamento (tudo bloco de 1) ───────────────────
{
  const todos = [...[1, 2, 3].map((i) => ep(`a_0${i}`, 'A')), ep('z', null)]
  const blocos = montaBlocos(todos, 1, rng(5))
  check('maxLen=1: todos os blocos têm 1 episódio (rodízio 1-a-1 de antes)',
    blocos.every((b) => b.length === 1) && blocos.length === 4)
}

// ── 5. canal sem series_id nenhum → todos avulsos, nenhum agrupamento ────────
{
  const todos = ['x', 'y', 'w', 'k'].map((id) => ep(id, null))
  const blocos = montaBlocos(todos, 4, rng(9))
  check('sem series_id: nada agrupa (grade idêntica ao comportamento antigo)',
    blocos.length === 4 && blocos.every((b) => b.length === 1))
}

// ── 6. menos-tocado lidera (fairness preservada no nível da série) ───────────
{
  const velha = [ep('old_1', 'OLD', 0), ep('old_2', 'OLD', 0)] // nunca tocada (0)
  const nova = [ep('new_1', 'NEW', 9999), ep('new_2', 'NEW', 9999)] // tocada agorinha
  const blocos = montaBlocos([...nova, ...velha], 2, rng(2))
  check('série menos-tocada lidera a grade', serieDe(blocos[0]) === 'OLD',
    `1º bloco: ${serieDe(blocos[0])}`)
}

console.log(`\n${fail === 0 ? '🎉' : '💥'} ${pass}/${pass + fail} checagens passaram`)
process.exit(fail === 0 ? 0 : 1)
