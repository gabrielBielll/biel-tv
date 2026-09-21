// Teste das TRÊS fontes de cue point (preto → silêncio → troca de cena).
//
// Motivo (Gabriel, 21/09/2026): "meu medo de sair criando cortes onde não tem é
// errar e cortar em um momento ruim". Medido antes disto: 45–57% do acervo não
// tem cue point NENHUM (rip de YouTube perde o fade-to-black), e sem ponto de
// corte os ~8min de vão de um slot de 30min desabam num bloco sólido de
// comercial. A resposta NÃO é cortar pelo relógio — é cascatear por fontes que
// são evidência de verdade, e não cortar quando nenhuma delas oferece nada.
//
// Números reais do EP03 de Power Rangers S.P.D. (22:37), usados como fixture:
//   preto:    6 trechos → 1 cue (06:10)
//   silêncio: só em 00:00 e 22:34 (fora da janela) — o áudio é trilha contínua
//   cena:     490 trocas; as mais próximas dos ideais ficaram a 2s/0s/4s/6s
import { cuesDeCena, cuesDeSilencio, escolhePiso, fundeCues, snapCuePoints } from '../packages/pipeline/src/cuepoints.mjs'

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`✅ ${name}${extra ? `  (${extra})` : ''}`) }
  else { fail++; console.log(`❌ ${name}${extra ? `  (${extra})` : ''}`) }
}
const D = 1357 // duração do EP03

// ── silêncio ───────────────────────────────────────────────────────────────
const gapsReais = [{ start: 0, end: 2.1 }, { start: 1354, end: 1356.3 }]
check('silêncio: pausa no começo/fim não vira corte (minEdge)',
  cuesDeSilencio(gapsReais, { duration: D }).length === 0)
check('silêncio: corta no MEIO da pausa, na grade de 10s',
  cuesDeSilencio([{ start: 597, end: 603 }], { duration: D }).join() === '600')
check('silêncio: pausa curta demais é ignorada',
  cuesDeSilencio([{ start: 600, end: 600.5 }], { duration: D, minGap: 1.5 }).length === 0)
check('silêncio: escolhe o mais longo e respeita o espaçamento',
  cuesDeSilencio([{ start: 600, end: 602 }, { start: 700, end: 704 }], { duration: D }).join() === '700',
  'o de 4s vence e o de 2s cai por estar a <300s')

// ── piso de dB ─────────────────────────────────────────────────────────────
check('piso: prefere o mais FUNDO que já dá o alvo',
  escolhePiso([{ db: -50, gaps: [1, 2, 3, 4] }, { db: -35, gaps: [1, 2, 3, 4, 5, 6] }], { alvo: 4 }).db === -50,
  'fundo = mais silencioso = mais seguro')
check('piso: nunca passa do teto (perto de fala não conta)',
  escolhePiso([{ db: -20, gaps: [1, 2, 3, 4, 5] }], { alvo: 4 }) === null)
check('piso: sem silêncio nenhum devolve null (não inventa)',
  escolhePiso([{ db: -50, gaps: [] }, { db: -40, gaps: [] }], { alvo: 4 }) === null)

// ── troca de cena ──────────────────────────────────────────────────────────
const cenas = Array.from({ length: 490 }, (_, i) => Math.round(i * (D / 490) * 100) / 100)
const cc = cuesDeCena(cenas, { duration: D, alvo: 4 })
check('cena: dá os 4 cortes espaçados', cc.length === 4, cc.join(' '))
check('cena: todos na grade de 10s', cc.every((t) => t % 10 === 0), cc.join(' '))
check('cena: todos dentro da janela válida', cc.every((t) => t >= 60 && t <= D - 60))
check('cena: nenhum par mais junto que 300s',
  cc.every((t, i) => i === 0 || t - cc[i - 1] >= 290), cc.join(' '))
check('cena: sem troca perto do ideal, NÃO corta (tolerância)',
  cuesDeCena([70, 80, 90], { duration: D, alvo: 4 }).length === 0,
  'melhor um intervalo a menos que um no lugar errado')

// ── cascata ────────────────────────────────────────────────────────────────
const f = fundeCues([370], [], [300, 600, 900, 1210], { alvo: 4 })
check('cascata: preto entra primeiro e mantém o kind',
  f[0].t === 370 && f[0].kind === 'black')
check('cascata: cena vizinha demais do preto é descartada',
  !f.some((c) => c.t === 300 || c.t === 600),
  'ambas a <300s de 370 — o scheduler as ignoraria de qualquer jeito')
check('cascata: o que sobra vira corte de cena', f.filter((c) => c.kind === 'cena').length === 2, f.map((c) => `${c.t}:${c.kind}`).join(' '))
const muitos = fundeCues([100, 400, 700, 1000, 1300], [], [200], { alvo: 4 })
check('cascata: fade-to-black real nunca é descartado por cota',
  muitos.length === 5 && muitos.every((c) => c.kind === 'black'),
  'o episódio disse onde é o intervalo; quem limita é o scheduler')
check('cascata: fonte DERIVADA respeita o alvo',
  fundeCues([100], [], [500, 900, 1300, 1700, 2100], { alvo: 4 }).filter((c) => c.kind === 'cena').length === 3,
  'alvo 4 menos 1 preto = 3 derivados')
check('cascata: sem fonte nenhuma, nenhum corte (o ponto do exercício)',
  fundeCues([], [], [], { alvo: 4 }).length === 0)

console.log(`\n${fail === 0 ? '🎉' : '⚠️'} ${pass}/${pass + fail} checagens passaram`)
process.exit(fail === 0 ? 0 : 1)
