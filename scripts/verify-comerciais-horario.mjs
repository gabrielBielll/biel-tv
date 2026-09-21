// AUDITORIA dos comerciais de horário: o que a VOZ promete bate com a GRADE?
//
// Motivo (Gabriel, 21/09/2026): "os comerciais que estão em produção já notei
// alguns deles falando de horário… queria conseguir transcrever para poder
// analisar". Não precisou de software externo: o pipeline já transcreve
// comercial (`media_promises.transcript`), então dá pra cruzar três lados.
//
// A regra da casa que isto protege (ARQUITETURA.md): "Comerciais 100%
// fidedignos — promo só vai ao ar se a promessa é cumprida". Um comercial que
// anuncia 17:00 quando a faixa mudou pra 16:00 virou mentira SOZINHO, sem
// ninguém mexer nele. Por isso rode isto sempre que mexer em `channel_slots`.
//
// Cruza, por comercial no ar:
//   1. hora FALADA na transcrição  ("às cinco da tarde" → 17:00)
//   2. hora no ID                  (com_looney_tunes_show_17h00_635a → 17:00)
//   3. o que a GRADE tem naquele canal/hora (`channel_slots`)
// e ainda: o canal citado na fala bate com os canais em que a peça está?
//
// Uso:  node scripts/verify-comerciais-horario.mjs        (credenciais do cofre)
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID
const TOKEN = process.env.CLOUDFLARE_API_TOKEN
const DB = process.env.D1_DATABASE_ID ?? 'c7790950-7ee9-4169-8d0c-40e7ce8672d9'
if (!ACCOUNT || !TOKEN) {
  console.error('faltam credenciais: set -a; . ~/bieltv-cred.env; set +a')
  process.exit(2)
}
async function d1(sql, params = []) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB}/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  })
  const j = await r.json()
  if (!j.success) throw new Error(JSON.stringify(j.errors))
  return j.result[0].results
}

const norm = (s) => (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const NUM = { uma: 1, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12 }

// "às três e meia da tarde" → "15:30".
//
// ⚠️ O QUALIFICADOR DE PERÍODO É OBRIGATÓRIO, e não é firula: sem ele o regex
// casa "as TRÊS espiãs" e reprova o comercial de Três Espiãs Demais como se
// ele anunciasse 03:00 (falso positivo real, achado na primeira rodada). Todo
// comercial gerado pela fábrica diz o período — "às dez da manhã", "às cinco
// da tarde" — então exigir isso não perde nenhum verdadeiro.
export function horaFalada(txt) {
  const t = norm(txt)
  if (/meia[- ]noite/.test(t)) return '00:00'
  if (/meio[- ]dia/.test(t)) return '12:00'
  const m = t.match(
    /\ba?s\s+(uma|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze)\s*(e meia\s*)?(?:da\s+(manha|tarde|noite|madrugada)|horas?\b|em ponto\b)/,
  )
  if (!m) return null
  let h = NUM[m[1]]
  const per = m[3] ?? ''
  if ((per === 'tarde' || per === 'noite') && h < 12) h += 12
  if ((per === 'manha' || per === 'madrugada') && h === 12) h = 0
  return `${String(h % 24).padStart(2, '0')}:${m[2] ? '30' : '00'}`
}
export const horaDoId = (id) => { const m = id.match(/_(\d{2})h(\d{2})/); return m ? `${m[1]}:${m[2]}` : null }
export const canalFalado = (t) =>
  /cartoon\s*network/i.test(t) ? 'cartoon_network' : /jetix/i.test(t) ? 'jetix' : /disney/i.test(t) ? 'disney_channel' : null
// do id `com_looney_tunes_show_17h00_635a` tira `looney_tunes_show`
export const serieDoId = (id) => id.replace(/^com_/, '').replace(/_\d{2}h\d{2}.*$/, '').replace(/_[0-9a-f]{4,}$/, '')

if (import.meta.url === `file://${process.argv[1]}`) {
  const coms = await d1(
    `SELECT p.media_id, p.transcript,
            (SELECT GROUP_CONCAT(channel_id) FROM media_channels WHERE media_id = p.media_id) canais
       FROM media_promises p JOIN media_items m ON m.id = p.media_id
      WHERE m.tipo = ?1 AND m.status = ?2 AND p.transcript IS NOT NULL`,
    ['comercial', 'ready'],
  )
  const slots = await d1('SELECT canal, series_id, dias, hora FROM channel_slots WHERE status = ?1', ['ativa'])
  const semTransc = (await d1(
    `SELECT COUNT(*) n FROM media_items m
      WHERE m.tipo = ?1 AND m.status = ?2 AND NOT EXISTS (SELECT 1 FROM media_promises p WHERE p.media_id = m.id)`,
    ['comercial', 'ready'],
  ))[0].n

  const mente = [], vazamento = [], vozId = [], naoVerificavel = []
  for (const c of coms) {
    const tx = c.transcript ?? ''
    const canais = (c.canais ?? '').split(',').filter(Boolean)
    const hv = horaFalada(tx), hid = horaDoId(c.media_id), cf = canalFalado(tx)
    if (hv && hid && hv !== hid) vozId.push({ id: c.media_id, fala: hv, id_diz: hid })
    if (cf && canais.length && !canais.includes(cf)) vazamento.push({ id: c.media_id, fala: cf, esta_em: c.canais })
    // peça que está em mais canais do que o que ela cita = vaza pros outros
    if (cf && canais.length > 1) vazamento.push({ id: c.media_id, fala: cf, esta_em: c.canais })
    // SÓ a peça de horário fixo da fábrica (`com_<serie>_HHhMM_<hash>`) pode ser
    // conferida contra `channel_slots`. Duas famílias ficam de fora de propósito:
    //  - `com_ev_<serie>_<hash>`: comercial de EVENTO ("nesta quarta, maratona
    //    às sete da noite"). Evento é agendado pelo editorial, não por âncora —
    //    cobrá-lo da grade fixa reprova 60+ peças legítimas (medido em 21/09).
    //  - peça feita à mão, sem hora no id: não há o que cruzar.
    if (!hid) { naoVerificavel.push(c.media_id); continue }
    const hora = hid
    if (!canais.length) continue
    const serie = serieDoId(c.media_id)
    for (const canal of canais) {
      const no = slots.filter((s) => s.canal === canal && s.hora === hora)
      if (!no.length) { mente.push({ id: c.media_id, canal, hora, problema: 'não há faixa nenhuma nesse horário' }); continue }
      const bate = no.some((s) => s.series_id === serie || s.series_id.startsWith(serie) || serie.startsWith(s.series_id))
      if (!bate) {
        const onde = slots.filter((s) => s.canal === canal && (s.series_id === serie || s.series_id.startsWith(serie))).map((s) => s.hora)
        mente.push({ id: c.media_id, canal, hora, no_ar: no.map((s) => s.series_id).join('/'), serie_esta_em: onde.join(', ') || '(nenhum slot)' })
      }
    }
  }
  const uniq = (a) => [...new Map(a.map((x) => [x.id + (x.canal ?? ''), x])).values()]
  console.log(`comerciais NO AR com transcrição: ${coms.length}   |   ponto cego (sem transcrição): ${semTransc}\n`)
  const bloco = (titulo, lista) => {
    console.log(`${lista.length ? '🔴' : '✅'} ${titulo}: ${lista.length}`)
    for (const e of lista.slice(0, 25)) console.log('    ' + JSON.stringify(e))
    if (lista.length > 25) console.log(`    … e mais ${lista.length - 25}`)
  }
  bloco('comerciais MENTINDO (anunciam horário onde passa outra coisa)', uniq(mente))
  bloco('voz fala horário diferente do id da peça', vozId)
  bloco('vazamento de canal (peça cita um canal e está em outros)', uniq(vazamento))
  console.log(`\nℹ️  não verificável automaticamente: ${naoVerificavel.length} (eventos/maratonas e peças feitas à mão — o horário delas não vive em channel_slots)`)
  process.exit(uniq(mente).length || vozId.length ? 1 : 0)
}
