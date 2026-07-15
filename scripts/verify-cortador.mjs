// Verificação do motor do cortador de comerciais (docs/features/cortador-comerciais.md).
//
// ⚠️ LEIA ISTO ANTES DE CONFIAR NO 29/29 QUE ESTA SUÍTE IMPRIME.
//
// Este teste FABRICA o compilado: planta preto+silêncio nos limites porque a
// spec afirmava que era assim que comercial emenda. Ou seja — ele constrói o
// mundo que a premissa descreve e depois verifica a premissa nesse mundo. Passa
// 29/29 e NÃO PROVA NADA sobre material real.
//
// Rodado no acervo de verdade (Jetix Intervalo Comercial HIGH, 600s), o mesmo
// motor reprovou 100% dos candidatos: o preto aparece 4x em 600s (e uma delas
// no MEIO de um anúncio), e o platô de silêncio não existe (434 gaps a -18dB
// decaindo até 6 a -50dB, sem faixa estável — áudio de broadcast é comprimido).
//
// O que continua tendo valor aqui: os testes de ARITMÉTICA PURA (fundeZonas /
// segmenta / portaoGrade) — esses independem de como o mundo é. O que precisa
// morrer: tudo que afirma "o motor acha os limites", porque só acha os limites
// que este arquivo plantou.
//
// Regra pra v3: fixture REAL (recorte de ~60s do acervo, anotado à mão). Quem
// fabrica o compilado fabrica a premissa junto.
//
// Não precisa de wrangler, D1, nem rede: é ffmpeg puro. `pnpm verify:cortador`.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FFMPEG, concatParts } from '../packages/pipeline/src/ffmpeg.mjs'
import { achaThreshold, analisaCompilado, fundeZonas, segmenta } from '../packages/pipeline/src/cortador.mjs'

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`✅ ${name}${extra ? `  (${extra})` : ''}`) }
  else { fail++; console.log(`❌ ${name}${extra ? `  (${extra})` : ''}`) }
}

const FF = FFMPEG()
const tmp = mkdtempSync(join(tmpdir(), 'verify-cortador-'))
const P = (n) => join(tmp, n)

// Hiss de fundo constante a ~-34dB em TUDO (inclusive nos gaps): sem isto o
// "silêncio" seria digital absoluto (-91dB), o platô sairia largo demais e o
// teste seria mais fácil que a realidade. Rip de VHS chia — o teste também.
const HISS = 'anoisesrc=color=white:amplitude=0.02:sample_rate=44100'
const V = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '44100', '-ac', '1']

/** Um "anúncio": cor sólida + tom audível + o hiss. */
function clipe(out, { cor, freq, dur }) {
  execFileSync(FF, [
    '-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=${cor}:s=320x240:d=${dur}:r=30`,
    '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${dur}:sample_rate=44100`,
    '-f', 'lavfi', '-i', `${HISS}:duration=${dur}`,
    '-filter_complex', '[1:a][2:a]amix=inputs=2:normalize=0[a]',
    '-map', '0:v', '-map', '[a]', ...V, out,
  ])
  return out
}

/** Um "gap" entre anúncios: preto + SÓ o hiss (sem tom) = o silêncio real. */
function gap(out, dur) {
  execFileSync(FF, [
    '-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=320x240:d=${dur}:r=30`,
    '-f', 'lavfi', '-i', `${HISS}:duration=${dur}`,
    '-map', '0:v', '-map', '1:a', ...V, out,
  ])
  return out
}

// ── o compilado fabricado ──────────────────────────────────────────────────
// Escolhido pra exercitar aprovação E recusa por motivos diferentes:
const ROTEIRO = [
  { nome: 'intro do canal', cor: 'gray', freq: 300, dur: 10, esperado: 'recusado: borda' },
  { gap: 0.4 },
  { nome: 'anúncio 15s', cor: 'blue', freq: 440, dur: 15, esperado: 'aprovado' },
  { gap: 0.35 },
  { nome: 'anúncio 30s', cor: 'red', freq: 660, dur: 30, esperado: 'aprovado' },
  { gap: 0.4 },
  { nome: 'trecho 22s', cor: 'green', freq: 880, dur: 22, esperado: 'recusado: fora da grade' },
  { gap: 0.3 },
  { nome: 'anúncio 15s', cor: 'yellow', freq: 550, dur: 15, esperado: 'aprovado' },
  { gap: 0.45 },
  { nome: 'outro do canal', cor: 'white', freq: 300, dur: 10, esperado: 'recusado: borda' },
]

console.log(`\n🎬 fabricando o compilado em ${tmp}\n`)
const partes = []
const limitesPlantados = [] // [gapStart, gapEnd] de cada gap, em tempo absoluto
let t = 0
for (const [i, item] of ROTEIRO.entries()) {
  if (item.gap) {
    limitesPlantados.push({ gapStart: t, gapEnd: t + item.gap })
    partes.push(gap(P(`p${i}.mp4`), item.gap))
    t += item.gap
  } else {
    partes.push(clipe(P(`p${i}.mp4`), item))
    t += item.dur
  }
}
const COMPILADO = P('compilado.mp4')
// forcarFiltro: re-encode limpo → timestamps exatos (é o que o teste cobra)
await concatParts(partes, COMPILADO, { forcarFiltro: true })
const DUR_ESPERADA = t
console.log(`   ${partes.length} partes → ${DUR_ESPERADA.toFixed(2)}s, ${limitesPlantados.length} limites plantados\n`)

// ── 1. o platô ─────────────────────────────────────────────────────────────
console.log('── threshold por platô ──')
const th = await achaThreshold(COMPILADO)
check('acha um platô (não rejeita um compilado bom)', th !== null)
if (th) {
  check('o platô fica ACIMA do hiss de -34dB', th.plato.min > -34,
    `platô ${th.plato.min}..${th.plato.max}dB, escolheu ${th.db}dB`)
  check('o platô é largo o bastante pra confiar', th.largura >= 4, `${th.largura}dB`)
  check('acha os N gaps plantados', th.gaps.length === limitesPlantados.length,
    `${th.gaps.length} de ${limitesPlantados.length}`)
}

// ── 2. a precisão (o medo do Gabriel) ──────────────────────────────────────
console.log('\n── precisão do corte (1 frame = 33ms) ──')
const analise = await analisaCompilado(COMPILADO, { duracao: DUR_ESPERADA })
check('não rejeita o compilado', !analise.rejeitado, analise.motivo ?? '')

if (!analise.rejeitado) {
  const zonas = analise.zonas
  check('acha exatamente os N limites', zonas.length === limitesPlantados.length,
    `${zonas.length} de ${limitesPlantados.length}`)

  // 1 frame é o PISO FÍSICO, não folga de teste: um gap de 0.45s a 30fps dá
  // 13,5 frames — o último frame é meio gap, meio conteúdo, e não existe corte
  // no meio de um frame. Cobrar mais que isso seria cobrar o impossível.
  const FRAME = 1 / 30
  const TOL = FRAME + 1e-6 // epsilon: erro de exatamente 1 frame tem que PASSAR

  let piorInvasao = 0
  for (const [i, plantado] of limitesPlantados.entries()) {
    const z = zonas[i]
    if (!z) { check(`limite ${i + 1} existe`, false); continue }
    // Sinal importa mais que magnitude, e os dois lados são assimétricos:
    //   erroIni > 0 → o anúncio A leva um tico de preto no fim  (feio, inócuo)
    //   erroIni < 0 → o anúncio A é cortado ANTES de acabar     (perde conteúdo)
    //   erroFim > 0 → o anúncio B nasce dentro do gap           (preto na cara)
    //   erroFim < 0 → o anúncio B começa tarde                  (perde conteúdo)
    // O que a zona morta promete é que o erro caia no PRETO, e que a invasão de
    // conteúdo nunca passe do piso físico.
    const erroIni = z.gapStart - plantado.gapStart
    const erroFim = plantado.gapEnd - z.gapEnd
    const invasao = Math.max(0, -erroIni, -erroFim) // só o que come conteúdo
    piorInvasao = Math.max(piorInvasao, invasao)
    check(`limite ${i + 1} não come mais que 1 frame de anúncio`, invasao <= TOL,
      `início ${erroIni >= 0 ? '+' : ''}${(erroIni * 1000).toFixed(0)}ms, fim ${erroFim >= 0 ? '+' : ''}${(erroFim * 1000).toFixed(0)}ms`)
  }
  check('pior invasão de conteúdo ≤ 1 frame (33ms)', piorInvasao <= TOL,
    `${(piorInvasao * 1000).toFixed(0)}ms`)

  // ── 3. os portões ────────────────────────────────────────────────────────
  console.log('\n── portões ──')
  const anuncios = ROTEIRO.filter((r) => !r.gap)
  check('1 candidato por anúncio do roteiro', analise.candidatos.length === anuncios.length,
    `${analise.candidatos.length} de ${anuncios.length}`)

  for (const [i, esperado] of anuncios.entries()) {
    const c = analise.candidatos[i]
    if (!c) { check(`candidato ${i} existe`, false); continue }
    const virouAprovado = esperado.esperado === 'aprovado'
    check(`"${esperado.nome}" → ${esperado.esperado}`, c.aprovado === virouAprovado,
      c.aprovado ? `${c.dur.toFixed(1)}s, slot ${c.slot}s` : c.recusa)
    if (virouAprovado) {
      check(`  ...com duração de anúncio de verdade (${esperado.dur}s)`,
        Math.abs(c.dur - esperado.dur) <= 0.1, `${c.dur.toFixed(2)}s`)
    }
  }
  const aprovados = analise.candidatos.filter((c) => c.aprovado).length
  check('descarta sem dó (aprovar menos que o total é o esperado)',
    aprovados === anuncios.filter((a) => a.esperado === 'aprovado').length,
    `${aprovados} de ${anuncios.length} candidatos aprovados`)
}

// ── 4. o compilado RUIM tem que ser rejeitado (o sistema sabe que não sabe) ──
console.log('\n── rejeição de compilado sem limites confiáveis ──')
const RUIM = P('ruim.mp4')
// Áudio contínuo, sem gap nenhum: não existe limite pra achar. O motor NÃO pode
// inventar cortes — tem que levantar a mão. (É o caso que autoriza o modo
// automático: falhar barulhento em vez de chutar em silêncio.)
execFileSync(FF, [
  '-hide_banner', '-v', 'error', '-y',
  '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=30:r=30',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30:sample_rate=44100',
  '-map', '0:v', '-map', '1:a', ...V, RUIM,
])
const ruim = await analisaCompilado(RUIM, { duracao: 30 })
check('rejeita compilado sem silêncio (em vez de inventar corte)', ruim.rejeitado === true,
  ruim.rejeitado ? ruim.motivo.slice(0, 60) + '…' : `NÃO rejeitou: ${ruim.aprovados} aprovados`)

// ── 5. a fusão em zona morta (unitário, sem ffmpeg) ────────────────────────
console.log('\n── zona morta (fusão) ──')
// preto [10.0,10.4] e silêncio [9.9,10.5]: a zona segura é a INTERSEÇÃO
// [10.0,10.4] — fora dela ainda há conteúdo (o áudio calou em 9.9, mas a
// imagem do anúncio A só apagou em 10.0).
const z = fundeZonas([{ start: 10.0, end: 10.4 }], [{ start: 9.9, end: 10.5 }], [])
check('funde preto+silêncio numa zona só', z.length === 1)
check('a zona é a INTERSEÇÃO, não a união', z[0]?.gapStart === 10.0 && z[0]?.gapEnd === 10.4,
  z[0] ? `[${z[0].gapStart}, ${z[0].gapEnd}]` : '—')
check('registra os dois sinais', z[0]?.sinais.includes('preto') && z[0]?.sinais.includes('silencio'),
  z[0]?.sinais.join('+'))
const zc = fundeZonas([{ start: 10.0, end: 10.4 }], [{ start: 9.9, end: 10.5 }], [10.2])
check('cena confirma sem estragar a zona', zc[0]?.sinais.includes('cena') && zc[0]?.gapStart === 10.0)
// o trecho vai do FIM de uma zona ao INÍCIO da próxima: o gap não é de ninguém
const segs = segmenta([{ gapStart: 10, gapEnd: 10.4, sinais: ['preto', 'silencio'] }], 20)
check('o gap não pertence a nenhum dos vizinhos',
  segs[0]?.end === 10 && segs[1]?.start === 10.4, `[0,${segs[0]?.end}] e [${segs[1]?.start},20]`)

rmSync(tmp, { recursive: true, force: true })
console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass}/${pass + fail}\n`)
process.exit(fail === 0 ? 0 : 1)
