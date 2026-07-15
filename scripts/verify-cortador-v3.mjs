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
import { achaBuracos, ancoraCorte, MARGEM_MAX, fundePelaGrade, classificaPeca, resolveId } from '../packages/pipeline/src/cortador.mjs'

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

// ── 7. merge pela grade: remonta o que o corte quebrou ────────────────────
console.log('\n── merge pela grade (corretor, não portão) ──')
// o caso real: Beyblade partido em corpo + cartela final
const partido = [{ i: 0, ini: 17.7, fim: 23.7, dur: 6.0 }, { i: 1, ini: 23.7, fim: 46.3, dur: 22.6 }, { i: 2, ini: 46.3, fim: 55.0, dur: 8.7 }]
const fundido = fundePelaGrade(partido)
const bey = fundido.find((p) => p.fundido)
check('remonta o comercial partido', Boolean(bey), bey?.motivo?.slice(0, 44))
check('  ...escolhe o par CERTO (22.6+8.7=31.3, não 6.0+22.6=28.6)',
  bey && Math.abs(bey.dur - 31.3) < 0.05, `deu ${bey?.dur}s`)
check('  ...e deixa a peça vizinha intacta', fundido.some((p) => !p.fundido && Math.abs(p.dur - 6.0) < 0.05))
// guarda: dois anúncios legítimos de 15s NÃO podem virar um de 30s
const doisBons = [{ i: 0, ini: 0, fim: 15, dur: 15 }, { i: 1, ini: 15, fim: 30, dur: 15 }]
check('NÃO funde dois anúncios que já batem na grade (o Frankenstein)',
  fundePelaGrade(doisBons).length === 2)
// vinheta de 5s não funde com nada (5+5 não dá 15) — o material do Gabriel
const vinhetas = [{ i: 0, ini: 0, fim: 5, dur: 5 }, { i: 1, ini: 5, fim: 10, dur: 5 }]
check('vinhetas de 5s sobrevivem (não fundem)', fundePelaGrade(vinhetas).length === 2)

// ── 8. tudo entra (decisão do Gabriel: modo livre) ────────────────────────
console.log('\n── classificação: só fragmento é descartado ──')
check('vinheta de 5s entra', classificaPeca({ dur: 5 }).ok)
check('anúncio de 30s entra', classificaPeca({ dur: 30 }).ok)
check('chamada de 40s entra (fora da grade, mas entra)', classificaPeca({ dur: 40 }).ok)
check('fragmento de 0.7s NÃO entra', !classificaPeca({ dur: 0.7 }).ok)
check('o slot é informativo, não veredito', classificaPeca({ dur: 30 }).slot === 30 && classificaPeca({ dur: 40 }).slot === null)

// ── 9. id único: INSERT OR REPLACE não perdoa ─────────────────────────────
console.log('\n── colisão de id ──')
const jaTem = new Set(['com_jetix_cinescopio_volta'])
check('id livre passa limpo', resolveId('com_jetix_pucca_inicio', jaTem) === 'com_jetix_pucca_inicio')
const r1 = resolveId('com_jetix_cinescopio_volta', jaTem)
check('id colidido ganha sufixo (não sobrescreve)', r1 === 'com_jetix_cinescopio_volta_2', r1)
jaTem.add(r1)
check('  ...e o próximo também', resolveId('com_jetix_cinescopio_volta', jaTem) === 'com_jetix_cinescopio_volta_3')

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass}/${pass + fail}\n`)
process.exit(fail === 0 ? 0 : 1)
