// Verificação do motor v3 do cortador — contra FIXTURE REAL.
// `pnpm verify:cortador:v3` · sem ffmpeg, sem rede, sem LLM: roda em ms.
//
// A diferença pro verify-cortador.mjs (o antigo): aquele FABRICA o compilado,
// plantando preto+silêncio nos limites porque a spec afirmava que era assim que
// comercial emenda. Passa 29/29 e reprovou 100% no acervo real — quem fabrica o
// compilado fabrica a premissa junto. Este aqui roda contra dados DERIVADOS de
// um compilado de verdade (scripts/fixtures/cortador-jetix-70s.json), com o
// gabarito anotado à mão ANTES de qualquer julgamento automático.
//
// O que NÃO é testado aqui: se o LLM acerta quais buracos são limite. Isso é
// julgamento, mora no Worker (portoes.ts) e foi medido à parte: 13/13 contra o
// gabarito, com o DeepSeek. Aqui é só o CÓDIGO CALCULA.
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { achaBuracos, ancoraCorte, MARGEM_MAX } from '../packages/pipeline/src/cortador.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fx = JSON.parse(readFileSync(join(ROOT, 'scripts/fixtures/cortador-jetix-70s.json'), 'utf8'))

let pass = 0, fail = 0
const check = (nome, ok, extra = '') => {
  if (ok) { pass++; console.log(`✅ ${nome}${extra ? `  (${extra})` : ''}`) }
  else { fail++; console.log(`❌ ${nome}${extra ? `  (${extra})` : ''}`) }
}

console.log(`\n📼 fixture: trecho de ${fx.trecho_seg}s de um compilado REAL`)
console.log(`   ${fx.fala.length} segmentos de fala · ${fx.buracos.length} buracos anotados à mão\n`)

// ── 1. achaBuracos reproduz exatamente os buracos anotados ────────────────
console.log('── candidatos (whisper diz QUAIS) ──')
const buracos = achaBuracos(fx.fala)
check('acha o mesmo nº de buracos do gabarito', buracos.length === fx.buracos.length,
  `${buracos.length} vs ${fx.buracos.length}`)
let batem = 0
for (const [i, b] of buracos.entries()) {
  const g = fx.buracos[i]
  if (g && Math.abs(b.ini - g.ini) < 0.01 && Math.abs(b.fim - g.fim) < 0.01) batem++
}
check('todos os buracos batem com o gabarito', batem === fx.buracos.length, `${batem}/${fx.buracos.length}`)
check('nenhum buraco menor que o mínimo', buracos.every((b) => b.dur >= 0.8))
check('o texto das bordas vem junto (é o que o LLM lê)',
  buracos.every((b) => b.textoAntes?.length > 0 && b.textoDepois?.length > 0))

// ── 2. a escada da precisão ───────────────────────────────────────────────
console.log('\n── escada da precisão (a margem diz ONDE) ──')
const limites = fx.buracos.filter((b) => b.limite)
const metodos = {}
for (const g of limites) {
  const b = buracos.find((x) => Math.abs(x.ini - g.ini) < 0.01)
  const a = ancoraCorte(b, fx.sinais)
  metodos[a.metodo] = (metodos[a.metodo] ?? 0) + 1
  const dentro = a.t === null || (a.t >= b.ini - 0.01 && a.t <= b.fim + 0.01)
  check(`  limite ${g.n} (${g.dur}s) → ${a.metodo}`, dentro,
    a.t === null ? a.motivo?.slice(0, 48) : `corta em ${a.t.toFixed(2)}s, ±${a.precisao}s`)
}
console.log(`   métodos usados: ${Object.entries(metodos).map(([k, v]) => `${k}=${v}`).join(' · ')}`)

// O corte NUNCA pode cair fora do buraco: fora dele há fala, ou seja, conteúdo.
check('nenhum corte cai em cima de fala', limites.every((g) => {
  const b = buracos.find((x) => Math.abs(x.ini - g.ini) < 0.01)
  const a = ancoraCorte(b, fx.sinais)
  return a.t === null || (a.t >= b.ini && a.t <= b.fim)
}))

// ── 3. o degrau 4: buraco longo sem âncora NÃO corta no escuro ────────────
console.log('\n── degrau 4: recusar > chutar ──')
const longo = { n: 99, ini: 100, fim: 195, dur: 95, textoAntes: 'x', textoDepois: 'y' }
const semSinal = { silencio_30db: [], silencio_24db: [], preto: [], cena: [] }
const rl = ancoraCorte(longo, semSinal)
check('buraco de 95s sem âncora → não corta (é bloco sem locução)',
  rl.t === null && rl.metodo === 'bloco', rl.motivo?.slice(0, 56))
// (foi exatamente este caso que revelou a promo institucional de 90s: cortar no
//  meio erraria 45s)

// ── 4. o degrau 3: buraco curto sem âncora → margem, erro ≤ dur/2 ─────────
console.log('\n── degrau 3: buraco curto sem âncora ──')
const curto = { n: 98, ini: 10, fim: 11.2, dur: 1.2, textoAntes: 'x', textoDepois: 'y' }
const rc = ancoraCorte(curto, semSinal)
check('buraco de 1.2s sem âncora → corta pela margem', rc.metodo === 'margem', `t=${rc.t}`)
check('  ...e o corte cai DENTRO do buraco', rc.t > curto.ini && rc.t < curto.fim)
check('  ...com erro ≤ metade do buraco (0.6s de trilha, não de conteúdo)', rc.precisao <= 0.6)

// ── 5. a margem tem teto (a regra do Gabriel) ─────────────────────────────
console.log('\n── o teto de 5s ──')
check('MARGEM_MAX é 5s', MARGEM_MAX === 5)
const medio = { n: 97, ini: 10, fim: 14.5, dur: 4.5, textoAntes: 'x', textoDepois: 'y' }
const rm = ancoraCorte(medio, semSinal)
check('buraco de 4.5s (< teto) ainda corta', rm.t !== null, `${rm.metodo} em ${rm.t?.toFixed(2)}s`)
check('  ...e nunca corta além do teto do fim da fala', rm.t - medio.ini <= MARGEM_MAX)

// ── 6. degrau 1 tem prioridade sobre a margem ─────────────────────────────
console.log('\n── prioridade: âncora limpa > margem ──')
const comAncora = { n: 96, ini: 10, fim: 13, dur: 3, textoAntes: 'x', textoDepois: 'y' }
const um = { silencio_30db: [{ start: 11.4, end: 11.9 }], silencio_24db: [], preto: [], cena: [] }
const ra = ancoraCorte(comAncora, um)
check('1 silêncio no buraco → ancora nele, não na margem', ra.metodo === 'silencio', `t=${ra.t}`)
check('  ...e a zona morta é o silêncio (o gap não é de ninguém)',
  ra.zona.gapStart === 11.4 && ra.zona.gapEnd === 11.9)

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass}/${pass + fail}\n`)
process.exit(fail === 0 ? 0 : 1)
