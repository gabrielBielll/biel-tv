// Revisão do PAPEL de cada comercial do rodízio (casa × anúncio), com os dados
// reais de produção e sem gravar nada. Serve pra conferir a regra de
// apps/stream/src/papel-comercial.ts antes de ela mandar nos intervalos, e pra
// achar peça "da casa" que promete coisa específica (agora X / depois Y) e
// não pode tocar solta.
//
//   node --import ./scripts/_ts-registra.mjs scripts/papel-revisao.mjs [--canal X]
import { readFileSync } from 'node:fs'
import { anunciaDe, papelDe } from '../apps/stream/src/papel-comercial.ts'

for (const l of readFileSync(`${process.env.HOME}/bieltv-cred.env`, 'utf8').split('\n')) {
  const m = /^\s*(?:export\s+)?([A-Z_0-9]+)=(.*)$/.exec(l)
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '')
}
const arg = (k, d) => (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1] : d)
const CANAIS = arg('canal', null) ? [arg('canal')] : ['jetix', 'cartoon_network', 'disney_channel']
async function d1(sql, params = []) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/d1/database/c7790950-7ee9-4169-8d0c-40e7ce8672d9/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  }).then((x) => x.json())
  if (!r.success) throw new Error(JSON.stringify(r.errors))
  return r.result[0].results
}

for (const canal of CANAIS) {
  const pecas = await d1(
    `SELECT m.id, m.duracao_seg dur, json_extract(m.metadata,'$.series_id') series_id, json_extract(m.metadata,'$.papel') papel,
            json_extract(m.metadata,'$.anuncia') anuncia, json_extract(m.metadata,'$.title') title, p.status pst, p.condicao
     FROM media_items m JOIN media_channels mc ON mc.media_id = m.id LEFT JOIN media_promises p ON p.media_id = m.id
     WHERE mc.channel_id = ? AND m.status = 'ready' AND m.tipo = 'comercial' AND m.id NOT LIKE 'com_lineup_%' ORDER BY m.id`, [canal])
  const series = (await d1(
    `SELECT DISTINCT json_extract(m.metadata,'$.series_id') s FROM media_items m JOIN media_channels mc ON mc.media_id = m.id
     WHERE mc.channel_id = ? AND m.status = 'ready' AND m.tipo IN ('episodio','filme') AND json_extract(m.metadata,'$.series_id') IS NOT NULL`, [canal])).map((r) => r.s)
  const grupos = {}
  for (const p of pecas) {
    // o que o scheduler deixa no rodízio (aproximado): sem promessa, genérico,
    // horário confirmado (destrava com a faixa) ou maratona confirmada
    const cond = p.condicao ? JSON.parse(p.condicao) : null
    const noRodizio = !p.pst || p.pst === 'generico' || (p.pst === 'confirmada' && ['bloco_horario', 'evento'].includes(cond?.tipo))
    if (!noRodizio) continue
    const anuncia = anunciaDe(p, cond, series)
    const papel = papelDe(p, cond, anuncia)
    const suspeita = /depois|programacao_|agora_/.test(p.id) ? '  ⚠ promete sequência?' : ''
    ;(grupos[papel] ??= []).push(`${p.id.slice(0, 70).padEnd(70)} ${String(p.dur).padStart(4)}s ${(p.pst ?? '-').padEnd(10)} ${anuncia ? `→ ${anuncia}` : ''}${suspeita}`)
  }
  console.log(`\n══ ${canal} · ${pecas.length} comerciais prontos`)
  for (const [papel, linhas] of Object.entries(grupos)) {
    console.log(`\n  ── ${papel} (${linhas.length})`)
    for (const l of linhas) console.log(`    ${l}`)
  }
}
