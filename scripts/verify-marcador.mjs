// Verificação da tela de marcar cortes (/r/cortar) num Chromium de verdade.
//
// POR QUE ESTA SUÍTE EXISTE, E POR QUE ELA ABRE UM NAVEGADOR:
// os bugs que o Gabriel reportou aqui NÃO são visíveis lendo o código nem
// batendo na API — todos moram na interação real com o browser:
//   · seta ← depois de clicar no player andava −7.19s em vez de −1s (o controle
//     nativo do Chrome pega a tecla no shadow DOM ANTES do nosso
//     preventDefault, e os dois seeks somam)
//   · seta com o <select> focado trocava de compilado e APAGAVA as marcas, sem
//     aviso e sem desfazer — era isto que comia o trabalho dele, e é por isso
//     que a tabela cortes_marcados estava vazia em produção
//   · espaço com o player focado não fazia nada (nós play, o nativo pause)
// E dois que só apareceram aqui, DEPOIS de reescrever a tela:
//   · o I e o F viravam letra dentro do campo de nome ("Tempestade Ninjaif") e
//     a marcação seguinte silenciosamente não acontecia
//   · o bloco da peça aberta nunca desenhava (style.display='' caía no
//     display:none do CSS) — modelo certo, tela muda
// Ou seja: 3 dos 5 são invisíveis pra teste de API. Por isso, navegador.
//
// Pré-requisito: um worker no ar com D1/R2 de verdade (o vídeo precisa carregar
// pra currentTime andar). Default = produção; BASE=... pra apontar pra outro.
//   node scripts/verify-marcador.mjs
//   BASE=http://127.0.0.1:8789 node scripts/verify-marcador.mjs   (wrangler dev --remote)
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE ?? 'https://biel-tv-stream.biel-cesa95.workers.dev'

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`✅ ${name}${extra ? `  (${extra})` : ''}`) }
  else { fail++; console.log(`❌ ${name}${extra ? `  (${extra})` : ''}`) }
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1000, height: 1180 } })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)))

// domcontentloaded, e não networkidle: o hls.js fica baixando segmento o tempo
// todo, então "rede parada" nunca chega de forma confiável e o goto virava roleta
await page.goto(`${BASE}/r/cortar`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => typeof cur !== 'undefined' && cur, null, { timeout: 45000 })
// espera o vídeo ter metadata: até ele saber a própria proporção, o <video> não
// tem altura, e TUDO abaixo (a régua inclusive) escorrega quando ele carrega —
// medir a régua antes disso dá coordenada velha e o clique erra o alvo
await page.waitForFunction(() => $('#v').readyState >= 1, null, { timeout: 45000 })
await page.waitForTimeout(600)
const dur = await page.evaluate(() => cur.duracao_seg)
// rascunho de rodadas anteriores falsearia tudo que vem abaixo
await page.evaluate(() => { localStorage.removeItem('rasc:' + cur.id); pecas = []; aberta = null; pinta() })
console.log(`compilado: ${await page.evaluate(() => cur.id)} · ${dur}s\n`)

const t = () => page.evaluate(() => $('#v').currentTime)
const parar = () => page.evaluate(() => $('#v').pause())
const vai = async (s) => { await page.evaluate((x) => { $('#v').pause(); $('#v').currentTime = x }, s); await page.waitForTimeout(500) }

// ── 1. a régua própria escolhe o momento ───────────────────────────────────
// É a "forma diferente de escolher o momento" que ele pediu — e a razão de o
// player estar sem `controls`: sem controle nativo não há foco pra roubar.
// a régua é remedida a cada gesto: o layout ainda pode escorregar (buffering,
// fonte) e coordenada velha faz o teste falhar por motivo errado
const regua = () => page.locator('#tl').boundingBox()
let box = await regua()
await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2)
await page.waitForTimeout(900)
check('régua: clicar em 50% busca o meio', Math.abs((await t()) - dur * 0.5) < dur * 0.03, `${(await t()).toFixed(1)}s de ${dur}s`)
box = await regua()
await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2)
await page.mouse.down()
await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2, { steps: 5 })
await page.mouse.up()
await page.waitForTimeout(700)
check('régua: arrastar busca junto', Math.abs((await t()) - dur * 0.3) < dur * 0.04, `${(await t()).toFixed(1)}s`)

// ── 2. o player não rouba mais o teclado (era −7.19s) ──────────────────────
await page.locator('#v').click({ position: { x: 50, y: 50 } })
await vai(100)
const t1 = await t()
await page.keyboard.press('ArrowLeft')
await page.waitForTimeout(500)
check('seta ← anda −1s mesmo depois de clicar no player', Math.abs((await t()) - t1 + 1) < 0.05, `${((await t()) - t1).toFixed(2)}s`)
check('foco não fica no player', (await page.evaluate(() => document.activeElement.tagName)) !== 'VIDEO',
  await page.evaluate(() => document.activeElement.tagName))
await parar()
await page.keyboard.press(' ')
await page.waitForTimeout(700)
check('espaço dá play depois de clicar no player', await page.evaluate(() => !$('#v').paused))

// ── 3. marcar: I abre, F fecha ─────────────────────────────────────────────
await vai(100)
await page.keyboard.press('i')
check('I abre a peça', await page.evaluate(() => aberta !== null), `ini=${await page.evaluate(() => aberta)}`)
check('avisa que tem peça aberta', (await page.locator('#abre').textContent()).includes('peça aberta'))
const ab = await page.evaluate(() => {
  const e = $('#ab')
  return { d: getComputedStyle(e).display, px: Math.round(e.getBoundingClientRect().width) }
})
await vai(130)
// o bloco tracejado é o que responde "quando começa e quando termina" — se ele
// não desenha, a tela voltou a ser o que confundia
check('bloco da peça aberta aparece na régua', ab.d !== 'none', `display=${ab.d}`)
await page.keyboard.press('f')
await page.waitForTimeout(300)
let pc = await page.evaluate(() => JSON.parse(JSON.stringify(pecas)))
check('F fecha e cria a peça', pc.length === 1 && Math.abs(pc[0].ini - 100) < 0.6 && Math.abs(pc[0].fim - 130) < 0.6, JSON.stringify(pc[0]))
check('avisa a duração e a grade', (await page.locator('#msg').textContent()).includes('30'), await page.locator('#msg').textContent())
check('desenha o bloco da peça na régua', (await page.locator('.pc').count()) === 1)

// ── 4. as recusas explicam ─────────────────────────────────────────────────
await page.keyboard.press('f')
await page.waitForTimeout(200)
check('F sem I recusa e explica', (await page.locator('#msg').textContent()).includes('INÍCIO'), await page.locator('#msg').textContent())
await page.keyboard.press('i')
await page.keyboard.press('Escape')
await page.waitForTimeout(200)
check('Esc cancela a peça aberta', await page.evaluate(() => aberta === null))
await page.keyboard.press('m')
await page.waitForTimeout(200)
check('M (hábito antigo) ensina o I/F', (await page.locator('#msg').textContent()).includes('I marca'), await page.locator('#msg').textContent())

// ── 5. nomear — e o teclado voltar depois ──────────────────────────────────
const NOME = 'Power Rangers: Tempestade Ninja'
await page.locator('input.nm').first().fill(NOME)
await page.waitForTimeout(300)
check('nome entra no modelo', (await page.evaluate(() => pecas[0].nome)) === NOME)
check('digitar não tira o foco do campo', (await page.evaluate(() => document.activeElement.className)) === 'nm')
check('nome aparece na régua', (await page.locator('.pc b').first().textContent()).includes('Tempestade'))
await page.keyboard.press('Enter')
await page.waitForTimeout(200)
check('Enter devolve o teclado pra tela', (await page.evaluate(() => document.activeElement.tagName)) !== 'INPUT')
// o bug do "Ninjaif": marcar DEPOIS de nomear tem que funcionar
await vai(200)
await page.keyboard.press('i')
await vai(260)
await page.keyboard.press('f')
await page.waitForTimeout(300)
pc = await page.evaluate(() => JSON.parse(JSON.stringify(pecas)))
check('dá pra marcar depois de nomear', pc.length === 2, JSON.stringify(pc.map((x) => `${x.ini}-${x.fim}`)))
check('o nome não vira lixeira de atalho', (await page.evaluate(() => pecas[0].nome)) === NOME, await page.evaluate(() => pecas[0].nome))

// ── 6. o buraco: o "lixo" que ele manda descartar ──────────────────────────
const bur = await page.locator('tr.bur').allTextContents()
check('mostra o que está sendo descartado', bur.some((x) => /(69|70)\./.test(x)), JSON.stringify(bur.map((x) => x.trim())))

// ── 7. O BUG QUE COMIA O TRABALHO ──────────────────────────────────────────
// A seta com o <select> focado ainda troca de compilado (é o comportamento
// nativo do elemento), mas agora isso não custa mais nada: o rascunho local
// devolve tudo ao voltar.
const antes = await page.evaluate(() => JSON.parse(JSON.stringify(pecas)))
await page.locator('#sel').focus()
await page.keyboard.press('ArrowDown')
await page.waitForTimeout(1500)
await page.selectOption('#sel', '0')
await page.waitForTimeout(1500)
check('trocar de compilado não perde o trabalho',
  JSON.stringify(await page.evaluate(() => JSON.parse(JSON.stringify(pecas)))) === JSON.stringify(antes),
  `${antes.length} peças voltaram`)

await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => typeof cur !== 'undefined' && cur, null, { timeout: 45000 })
await page.waitForTimeout(800)
check('rascunho sobrevive a recarregar a página',
  JSON.stringify(await page.evaluate(() => JSON.parse(JSON.stringify(pecas)))) === JSON.stringify(antes))
check('avisa que restaurou rascunho', await page.locator('#rasc').isVisible())

// ── 8. sobreposição sinalizada ─────────────────────────────────────────────
await page.evaluate(() => { pecas.push({ ini: 110, fim: 140, nome: 'sobrepoe' }); pinta() })
await page.waitForTimeout(300)
check('sobreposição sinalizada na linha', (await page.locator('tr.ovl').count()) >= 1)
check('sobreposição sinalizada no resumo', (await page.locator('#resumo').textContent()).includes('sobreposta'))

// ── 9. salvar exige token ──────────────────────────────────────────────────
const semToken = await page.evaluate(async () => {
  const r = await fetch('/revisao/' + encodeURIComponent(cur.id) + '/pecas', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pecas: [{ ini: 1, fim: 30, nome: 'x' }] }),
  })
  return r.status
})
check('salvar sem token = 401', semToken === 401, `HTTP ${semToken}`)

// ── 10. descartar o rascunho ───────────────────────────────────────────────
await page.locator('#bRasc').click()
await page.waitForTimeout(1200)
check('descartar rascunho volta ao que está salvo', (await page.evaluate(() => pecas.length)) === 0)

check('sem exceções JS na página', pageErrors.length === 0, pageErrors[0] ?? '')

mkdirSync(join(ROOT, '.ingest-work'), { recursive: true })
const shot = join(ROOT, '.ingest-work', 'marcador-screenshot.png')
await page.evaluate(() => { localStorage.removeItem('rasc:' + cur.id) })
await page.screenshot({ path: shot, fullPage: true })
console.log(`📸 screenshot: ${shot}`)

await browser.close()
console.log(`\n${fail === 0 ? '🎉' : '💥'} ${pass}/${pass + fail} checagens passaram`)
process.exit(fail === 0 ? 0 : 1)
