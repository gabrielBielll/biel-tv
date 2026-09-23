// Liga a CONDIÇÃO das vinhetas de contexto: "a seguir X", "voltamos já com X",
// "X está de volta". Sem isso a peça entra no rodízio cego e toca fora de
// contexto — o Gabriel viu no ar o Feiticeiros indo pro intervalo sem vinheta
// de saída enquanto a vinheta do Feiticeiros tocava no meio de outro desenho.
//
// ⚠️ REGRA DA CASA: vinheta no lugar errado é pior que vinheta nenhuma. Então
// aqui NÃO existe casamento aproximado. A série alvo sai do id por regra
// explícita e precisa bater EXATO com um slug do catálogo (ou com um apelido
// registrado na tabela abaixo, cada um com o motivo). O que não bater vira
// relatório pra decisão humana — nunca um palpite gravado.
//
// Seco por padrão. `--aplicar` grava via POST /admin/promessas/lote (uma
// chamada, um replan por canal — ver o comentário do endpoint sobre a cota).
import fs from 'node:fs'

const BASE = process.env.API_BASE ?? 'https://biel-tv-stream.biel-cesa95.workers.dev'
const TOKEN = process.env.ADMIN_TOKEN
const APLICAR = process.argv.includes('--aplicar')
const A = process.env.CLOUDFLARE_ACCOUNT_ID, T = process.env.CLOUDFLARE_API_TOKEN
const DB = 'c7790950-7ee9-4169-8d0c-40e7ce8672d9'

const d1 = async (sql) => {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${A}/d1/database/${DB}/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${T}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql }) }).then((x) => x.json())
  if (!r.success) throw new Error(JSON.stringify(r.errors))
  return r.result[0].results
}

// ── as famílias, na ordem em que são testadas ───────────────────────────────
// A ordem importa: 'esta_de_volta' contém 'volta', e 'volta_ja' também.
const FAMILIAS = [
  { marca: 'voce_esta_vendo', tipo: 'durante', momento: 'ambos', fala: 'você está vendo X' },
  { marca: 'esta_de_volta', tipo: 'durante', momento: 'volta', fala: 'X está de volta' },
  { marca: 'volta_ja', tipo: 'durante', momento: 'saida', fala: 'voltamos já com X' },
  { marca: 'a_seguir', tipo: 'a_seguir', momento: null, fala: 'a seguir, X' },
  { marca: 'vem_ai', tipo: 'a_seguir', momento: null, fala: 'vem aí, X' },
]

// Ruído em volta do nome da série nos ids. Prefixo = canal/rótulo; sufixo =
// versão do rip ou duração do corte.
const PREFIXOS = ['cn_', 'disney_', 'jetix_', 'vinheta_', 'bumper_']
const SUFIXOS = [/_v\d+$/, /_\d{4}_?hq$/, /_\d{4}$/, /_hq$/, /_\d+s(_[a-z])?$/, /_+$/]

// Apelidos: catálogo e vinheta escreveram o mesmo desenho de jeitos diferentes.
// Cada linha tem de dizer POR QUE, senão vira porta dos fundos pro palpite.
const APELIDOS = {
  // o catálogo grafa "jacke" (erro de digitação que ficou no slug, e slug é PK
  // de fato); a vinheta usa a grafia correta do personagem. 12 peças dependem
  // desta linha — sem ela o Jake Long inteiro ficava de fora.
  jake_long_o_dragao_ocidental: 'jacke_long_o_dragao_ocidental',
  // a vinheta diz o nome COM artigo, o catálogo sem
  os_padrinhos_magicos: 'padrinhos_magicos',
  // a vinheta corta o nome da temporada; no catálogo só existe um
  // `power_rangers_forca*`, então não há a quem confundir
  power_rangers_forca: 'power_rangers_forca_animal',
}

const limpa = (s) => {
  let t = s
  for (const p of PREFIXOS) if (t.startsWith(p)) t = t.slice(p.length)
  let mudou = true
  while (mudou) { mudou = false; for (const re of SUFIXOS) { const n = t.replace(re, ''); if (n !== t) { t = n; mudou = true } } }
  return t.replace(/^_+|_+$/g, '')
}

/** Devolve {familia, serie} ou {motivo} quando o id não é de uma peça de contexto. */
export function leId(id) {
  const corpo = id.replace(/^vin_/, '')
  for (const f of FAMILIAS) {
    const i = corpo.indexOf(f.marca)
    if (i < 0) continue
    // a série pode vir ANTES ("raven_a_seguir_2007hq") ou DEPOIS
    // ("a_seguir_power_rangers_forca"): fica com o lado que sobrar preenchido
    const antes = limpa(corpo.slice(0, i))
    const depois = limpa(corpo.slice(i + f.marca.length))
    const serie = antes.length >= depois.length ? antes : depois
    if (!serie) return { motivo: `família "${f.marca}" sem nome de série no id` }
    return { familia: f, serie }
  }
  return { motivo: 'sem marcador de família (a seguir / volta já / está de volta / vem aí)' }
}

// ── levantamento ────────────────────────────────────────────────────────────
const pecas = await d1(`SELECT m.id, COALESCE(p.status,'') st
  FROM media_items m LEFT JOIN media_promises p ON p.media_id = m.id
  WHERE m.tipo='vinheta' AND m.status='ready' AND p.condicao IS NULL ORDER BY m.id`)
const comEp = new Set((await d1(`SELECT DISTINCT json_extract(metadata,'$.series_id') s FROM media_items
  WHERE status='ready' AND tipo IN ('episodio','filme') AND json_extract(metadata,'$.series_id') IS NOT NULL`)).map((r) => r.s))
const comAncora = new Set((await d1('SELECT DISTINCT series_id FROM channel_slots')).map((r) => r.series_id))

const aplicar = []
const recusadas = { 'sem marcador de família': [], 'série não existe no catálogo': [], 'série sem episódio pronto': [] }
for (const p of pecas) {
  const r = leId(p.id)
  if (r.motivo) { recusadas['sem marcador de família'].push(`${p.id}  — ${r.motivo}`); continue }
  const slug = APELIDOS[r.serie] ?? r.serie
  if (!comEp.has(slug)) {
    const balde = [...comEp].some((s) => s.includes(r.serie) || r.serie.includes(s))
      ? 'série não existe no catálogo' : 'série sem episódio pronto'
    recusadas[balde].push(`${p.id}  → "${slug}"${APELIDOS[r.serie] ? ` (apelido de ${r.serie})` : ''}`)
    continue
  }
  aplicar.push({
    media_id: p.id, status: 'confirmada',
    condicao: { tipo: r.familia.tipo, series_id: slug, descricao: r.familia.fala.replace('X', slug), momento: r.familia.momento },
  })
}

// ── relatório ───────────────────────────────────────────────────────────────
const conta = (f) => aplicar.filter(f).length
console.log(`\n${pecas.length} vinhetas prontas sem condição\n`)
console.log(`✅ ${aplicar.length} com alvo seguro:`)
console.log(`     ${conta((x) => x.condicao.tipo === 'a_seguir')}  a seguir / vem aí`)
console.log(`     ${conta((x) => x.condicao.momento === 'saida')}  voltamos já com  (abre o intervalo)`)
console.log(`     ${conta((x) => x.condicao.momento === 'volta')}  está de volta    (fecha o intervalo)`)
console.log(`     ${conta((x) => x.condicao.momento === 'ambos')}  você está vendo  (os dois)`)
console.log(`     cobrindo ${new Set(aplicar.map((x) => x.condicao.series_id)).size} séries`)

for (const [motivo, lista] of Object.entries(recusadas)) {
  if (lista.length === 0) continue
  console.log(`\n⏸️  ${lista.length} fora — ${motivo}:`)
  for (const l of lista) console.log(`     ${l}`)
}

// Confirmar TIRA a peça do rodízio cego (scheduler: foraDoRodizio) e põe no pool
// da série. Série sem âncora na grade quase não toca ⇒ a vinheta emudece junto.
const orfas = [...new Set(aplicar.map((x) => x.condicao.series_id))].filter((s) => !comAncora.has(s))
if (orfas.length > 0) {
  console.log(`\n⚠️  ${orfas.length} séries alvo NÃO têm faixa na grade — confirmar tira essas vinhetas`)
  console.log(`    do rodízio cego e elas passam a quase não tocar (o certo, mas saiba):`)
  console.log(`     ${orfas.join(', ')}`)
}

fs.writeFileSync(process.argv[2] ?? '/tmp/condicoes-lote.json', JSON.stringify({ decisoes: aplicar }, null, 1))
if (!APLICAR) { console.log(`\n(seco — nada gravado. Payload salvo. Use --aplicar pra valer.)`); process.exit(0) }

for (let i = 0; i < aplicar.length; i += 300) {
  const lote = aplicar.slice(i, i + 300)
  const r = await fetch(`${BASE}/admin/promessas/lote`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ decisoes: lote }) })
  const txt = await r.text()
  console.log(`\nlote ${i / 300 + 1}: HTTP ${r.status} ${txt.slice(0, 300)}`)
  if (!r.ok) process.exit(1)
}
