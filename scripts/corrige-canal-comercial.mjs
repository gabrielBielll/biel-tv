// Desmarca o canal ERRADO de um comercial que assina outro.
//
// Caso que motivou (Gabriel, 21/09/2026): `com_padrinhos_magicos_15h00_5454`
// diz "…de segunda a sexta às três da tarde NA JETIX" e estava marcado em
// `disney_channel,jetix`. Na Jetix é verdade (tem Padrinhos às 15:00); na
// Disney é mentira — lá às 15:00 passa As Visões da Raven.
//
// Por que NÃO é caso de reter a peça (`retem-comerciais-sem-grade.mjs`): a
// promessa é válida, só está tocando onde não vale. Retê-la apagaria uma promo
// correta da Jetix. Aqui o conserto é o vínculo de canal, não a promessa.
//
// A ASSINATURA exige preposição — "na Jetix", "no Cartoon Network", "no Disney
// Channel". Sem isso, comercial de PRODUTO cairia na rede: "bonecas da Disney",
// "Disney DVD e Blu-ray" e "lojas americanas… DVDs da Disney" citam a marca sem
// prometer canal nenhum (3 peças reais, medidas hoje).
//
// Uso:  node scripts/corrige-canal-comercial.mjs            (dry-run)
//       node scripts/corrige-canal-comercial.mjs --aplicar
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID
const TOKEN = process.env.CLOUDFLARE_API_TOKEN
const ADMIN = process.env.ADMIN_TOKEN
const DB = process.env.D1_DATABASE_ID ?? 'c7790950-7ee9-4169-8d0c-40e7ce8672d9'
const BASE = process.env.BASE ?? 'https://biel-tv-stream.biel-cesa95.workers.dev'
const APLICAR = process.argv.includes('--aplicar')
if (!ACCOUNT || !TOKEN) { console.error('faltam credenciais: set -a; . ~/bieltv-cred.env; set +a'); process.exit(2) }

async function d1(sql, params = []) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB}/query`, {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  })
  const j = await r.json()
  if (!j.success) throw new Error(JSON.stringify(j.errors))
  return j.result[0].results
}
const ASSINATURA = [
  [/n[oa]s?\s+cartoon\s*network/i, 'cartoon_network'],
  [/s[óo]\s+n[oa]s?\s+cartoon\s*network/i, 'cartoon_network'],
  [/n[oa]s?\s+jetix/i, 'jetix'],
  [/n[oa]s?\s+disney\s*channel/i, 'disney_channel'],
]

const coms = await d1(
  `SELECT p.media_id, p.transcript,
          (SELECT GROUP_CONCAT(channel_id) FROM media_channels WHERE media_id = p.media_id) canais
     FROM media_promises p JOIN media_items m ON m.id = p.media_id
    WHERE m.tipo = ?1 AND m.status = ?2 AND p.transcript IS NOT NULL`,
  ['comercial', 'ready'],
)
const vaz = []
for (const c of coms) {
  const assina = [...new Set(ASSINATURA.filter(([re]) => re.test(c.transcript)).map(([, ch]) => ch))]
  if (!assina.length) continue
  const tem = (c.canais ?? '').split(',').filter(Boolean)
  const sobra = tem.filter((ch) => !assina.includes(ch))
  // só corrige se SOBROU canal; peça que assina um canal em que nem está é
  // outro problema (peça órfã) e não se resolve tirando vínculo.
  if (sobra.length && assina.some((ch) => tem.includes(ch))) {
    vaz.push({ id: c.media_id, assina, de: tem, para: tem.filter((ch) => assina.includes(ch)), tirar: sobra })
  }
}
console.log(`comerciais conferidos: ${coms.length}`)
console.log(`VAZAMENTO DE CANAL: ${vaz.length}\n`)
for (const v of vaz) console.log(`  ${v.id}\n     assina ${v.assina.join('+')} · está em ${v.de.join(',')} → fica ${v.para.join(',')} (tira ${v.tirar.join(',')})`)
if (!vaz.length) process.exit(0)
if (!APLICAR) { console.log('\n(dry-run — rode com --aplicar para gravar)'); process.exit(0) }
if (!ADMIN) { console.error('\nfalta ADMIN_TOKEN para aplicar'); process.exit(2) }

let ok = 0, erro = 0
for (const v of vaz) {
  const res = await fetch(`${BASE}/admin/media/${v.id}/channels`, {
    method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ channels: v.para }),
  })
  if (res.ok) ok++
  else { erro++; console.log(`  ✖ ${v.id} HTTP ${res.status} ${(await res.text()).slice(0, 90)}`) }
}
console.log(`\ncorrigidos: ${ok} | erros: ${erro}`)
process.exit(erro ? 1 : 0)
