// Tira do ar (sem apagar) todo comercial cuja promessa a grade NÃO cumpre.
//
// Pedido do Gabriel (21/09/2026): "deixa no ar só comerciais que temos
// programação para passar; o que não tivermos, deixa fora do ar até conseguirmos
// a programação, mas deixa salvo com os metadados de horário pra quando tivermos
// o programa esse comercial poder ser usado".
//
// Não inventa mecanismo: usa a feature comerciais-condicionais (fase 12). A
// promessa vira `confirmada` + `bloco_horario` com série/hora/dias, e o
// scheduler devolve a peça ao rodízio SOZINHA quando existir um channel_slot
// que cumpra o anunciado. Áudio, transcrição e horário ficam no banco.
//
// ⚠️ RODE DEPOIS DE QUALQUER MUDANÇA DE GRADE, nunca antes: mexer numa faixa
//    cria mentira nova. Medido em 21/09 — mover Yin Yang Yo de 18:30 para 07:00
//    transforma `com_yin_yang_yo_18h30_79df` ("de segunda a sexta às seis e
//    meia da noite") em promessa falsa no mesmo instante.
//
// Uso:  node scripts/retem-comerciais-sem-grade.mjs            (dry-run)
//       node scripts/retem-comerciais-sem-grade.mjs --aplicar
import { horaDoId, horaFalada, serieDoId } from './verify-comerciais-horario.mjs'

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

// Peça de ACERVO ORIGINAL: a série não sai do id (o id é o nome do arquivo),
// então vem da arqueologia das transcrições feita em 21/09. `serie: null` =
// chamada de BLOCO/especial — o scheduler só destrava por série, então essas
// ficam retidas como 'ignorar' até virarem grade e alguém decidir.
const ACERVO = {
  com_cn_colecao_referencia_cn_chamada_tom_e_jerry: { serie: 'tom_e_jerry', hora: '07:30', dias: [1, 2, 3, 4, 5] },
  com_cn_colecao_referencia_cn_chamada_meninas_superpoderosas: { serie: 'meninas_superpoderosas', hora: '19:30', dias: [5] },
  com_cn_colecao_referencia_cn_chamada_mansao_foster_01: { serie: 'mansao_foster', hora: '19:30', dias: [5] },
  com_cn_invasao_referencia_cn_chamada_meu_amigo_escola_macaco: { serie: 'meu_amigo_macaco', hora: '19:30', dias: [5] },
  com_cn_colecao_referencia_cn_chamada_cartoon_cartoons_dexter: { serie: 'laboratorio_de_dexter', hora: '20:00', dias: [5] },
  com_jetix_power_rangers_tempestade_ninja: { serie: 'power_rangers_tempestade_ninja', hora: '16:30', dias: [1, 2, 3, 4, 5, 6, 7] },
  com_jetix_beyblade: { serie: 'beyblade', hora: '18:00', dias: [1, 2, 3, 4, 5, 6, 7] },
  com_jetix_medabots_2: { serie: 'medabots', hora: '18:30', dias: [1, 2, 3, 4, 5, 6, 7] },
  com_cn_colecao_referencia_cn_bloco_teatro_cartoon: { serie: null, hora: '19:00', dias: [1, 2, 3, 4] },
  com_cn_invasao_referencia_cn_bloco_teatro_cartoon_viagem_dexter: { serie: null, hora: '14:00', dias: [7] },
  com_cn_invasao_referencia_cn_bloco_cartoons_tres_vezes_dia: { serie: null, hora: '18:00', dias: [1, 2, 3, 4, 5] },
  com_cartoon_network_votatoon_201: { serie: null, hora: '18:00', dias: [6] },
  com_oshwdscbdep02gjhgj: { serie: null, hora: '18:00', dias: [6] },
  com_cn_colecao_referencia_cn_especial_ultima_gargalhada: { serie: null, hora: '05:00', dias: [6] },
  com_cn_colecao_referencia_cn_chamada_especial_invasao_01: { serie: null, hora: '10:00', dias: null },
}
const DIAS_TXT = [
  [/de segunda a sexta/, [1, 2, 3, 4, 5]], [/de segunda a quinta/, [1, 2, 3, 4]],
  [/todos os dias/, [1, 2, 3, 4, 5, 6, 7]], [/s[áa]bados? e domingos?/, [6, 7]],
  [/\bsextas?\b/, [5]], [/\bs[áa]bados?\b/, [6]], [/\bdomingos?\b/, [7]],
]
const norm = (s) => (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

const coms = await d1(
  `SELECT p.media_id, p.transcript, p.status,
          (SELECT GROUP_CONCAT(channel_id) FROM media_channels WHERE media_id = p.media_id) canais
     FROM media_promises p JOIN media_items m ON m.id = p.media_id
    WHERE m.tipo = ?1 AND m.status = ?2 AND p.transcript IS NOT NULL`,
  ['comercial', 'ready'],
)
const slots = await d1('SELECT canal, series_id, dias, hora FROM channel_slots WHERE status = ?1', ['ativa'])
const cumpreGrade = (canais, serie, hora, dias) => canais.some((canal) => slots.some((s) => {
  if (s.canal !== canal || s.hora !== hora) return false
  if (serie && s.series_id !== serie && !s.series_id.startsWith(serie) && !serie.startsWith(s.series_id)) return false
  if (Array.isArray(dias)) { const d = JSON.parse(s.dias); if (!dias.every((n) => d.includes(n))) return false }
  return true
}))

const reter = []
for (const c of coms) {
  if (/^com_ev_/.test(c.media_id)) continue // evento: destrava por maratona agendada, outro caminho
  const canais = (c.canais ?? '').split(',').filter(Boolean)
  if (!canais.length) continue
  const acv = ACERVO[c.media_id]
  const hora = acv?.hora ?? horaDoId(c.media_id) ?? (acv === undefined ? null : horaFalada(c.transcript))
  if (!hora) continue
  const serie = acv ? acv.serie : serieDoId(c.media_id)
  let dias = acv?.dias ?? null
  if (!dias) { const t = norm(c.transcript); for (const [re, v] of DIAS_TXT) if (re.test(t)) { dias = v; break } }
  if (cumpreGrade(canais, serie, hora, dias)) continue
  reter.push({ id: c.media_id, serie, hora, dias, canais: c.canais, jaRetido: c.status === 'ignorar' || c.status === 'confirmada' })
}

console.log(`comerciais no ar conferidos: ${coms.length}`)
console.log(`A RETIRAR DO AR: ${reter.length}  (${reter.filter((r) => r.serie).length} voltam sozinhos · ${reter.filter((r) => !r.serie).length} bloco/especial, decisão manual)\n`)
for (const r of reter) console.log(`  ${r.hora}  ${String(r.dias ?? '—').padEnd(15)} ${String(r.serie ?? '(bloco)').padEnd(32)} ${r.id.slice(0, 46)}`)
if (!APLICAR) { console.log('\n(dry-run — rode com --aplicar para gravar)'); process.exit(0) }
if (!ADMIN) { console.error('\nfalta ADMIN_TOKEN para aplicar'); process.exit(2) }

let ok = 0, erro = 0
for (const r of reter) {
  const body = r.serie
    ? { status: 'confirmada', condicao: { tipo: 'bloco_horario', series_id: r.serie, hora: r.hora, dias: r.dias, descricao: `retido: a grade não cumpre ${r.hora}` } }
    : { status: 'ignorar' }
  const res = await fetch(`${BASE}/admin/promessas/${r.id}/decidir`, {
    method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.ok) ok++
  else { erro++; console.log(`  ✖ ${r.id} HTTP ${res.status} ${(await res.text()).slice(0, 90)}`) }
}
console.log(`\nretidos: ${ok} | erros: ${erro}`)
process.exit(erro ? 1 : 0)
