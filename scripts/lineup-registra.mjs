// Registra no D1 os lineups que o scripts/lineup-lote.mjs gerou e subiu pro R2.
// Numa ida só (em fatias): mídia + canal (o SQL do ingest --adiar-registro),
// promessa `lineup_grade` confirmada com a sequência X→Y→Z e, por último, a
// chave `lineup_grade:<canal>` que liga o encaixe na posição 'ultimo' (decisão
// do Gabriel, 23/09/2026).
//
// NÃO replaneja a grade: quem encaixa as peças é o próximo replan do canal.
// Rodado antes das 21:02 de 23/09, o replan da rotina das 21h
// (~/.cache/bieltv-21h) já as pega de carona, sem gastar cota a mais.
//
// Uso: node scripts/lineup-registra.mjs [--seco] [--posicao ultimo|meio]
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const HOME = process.env.HOME
for (const l of readFileSync(`${HOME}/bieltv-cred.env`, 'utf8').split('\n')) {
  const m = /^\s*(?:export\s+)?([A-Z_0-9]+)=(.*)$/.exec(l)
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '')
}
const CACHE = `${HOME}/.cache/bieltv-lineup`
const REGISTROS = `${CACHE}/registros`
const MANIFESTO = `${CACHE}/lote/manifesto.jsonl`
const DB_ID = 'c7790950-7ee9-4169-8d0c-40e7ce8672d9'
const SECO = process.argv.includes('--seco')
const POSICAO = process.argv.includes('--posicao') ? process.argv[process.argv.indexOf('--posicao') + 1] : 'ultimo'
if (!['ultimo', 'meio'].includes(POSICAO)) throw new Error(`posição inválida: ${POSICAO}`)
const FATIA = 25

const esc = (s) => String(s).replaceAll("'", "''")
async function d1(sql) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${DB_ID}/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql }), signal: AbortSignal.timeout(90_000),
  }).then((x) => x.json())
  if (!r.success) throw new Error(JSON.stringify(r.errors).slice(0, 300))
  return r.result
}

const manifesto = new Map()
if (existsSync(MANIFESTO)) {
  for (const l of readFileSync(MANIFESTO, 'utf8').split('\n').filter(Boolean)) {
    const e = JSON.parse(l)
    manifesto.set(e.id, e) // a última linha de um id vale (lote refeito)
  }
}
const pendentes = readdirSync(REGISTROS).filter((f) => f.endsWith('.sql')).map((f) => f.replace(/\.sql$/, ''))
  .filter((id) => manifesto.has(id))
const orfaos = readdirSync(REGISTROS).filter((f) => f.endsWith('.sql')).length - pendentes.length
console.log(`${pendentes.length} lineup(s) a registrar${orfaos ? ` · ${orfaos} SQL sem manifesto (ignorados)` : ''}`)
if (pendentes.length === 0) process.exit(0)

const porCanal = {}
for (const id of pendentes) porCanal[manifesto.get(id).canal] = (porCanal[manifesto.get(id).canal] ?? 0) + 1
console.log('  por canal:', JSON.stringify(porCanal))
if (SECO) process.exit(0)

mkdirSync(join(REGISTROS, 'aplicados'), { recursive: true })
let feitos = 0
for (let i = 0; i < pendentes.length; i += FATIA) {
  const ids = pendentes.slice(i, i + FATIA)
  const partes = []
  for (const id of ids) {
    const e = manifesto.get(id)
    partes.push(readFileSync(join(REGISTROS, `${id}.sql`), 'utf8').trim().replace(/;?\s*$/, ';'))
    const cond = JSON.stringify({
      tipo: 'lineup_grade', canal: e.canal, seq: e.seq,
      template_version: e.versao, origem: 'scripts/lineup-lote.mjs',
    })
    partes.push(`INSERT INTO media_promises (media_id, transcript, proposta, condicao, status)
VALUES ('${esc(id)}','${esc(e.texto)}','${esc(cond)}','${esc(cond)}','confirmada')
ON CONFLICT(media_id) DO UPDATE SET transcript=excluded.transcript, proposta=excluded.proposta,
  condicao=excluded.condicao, status='confirmada', updated_at=unixepoch();`)
  }
  await d1(partes.join('\n'))
  for (const id of ids) renameSync(join(REGISTROS, `${id}.sql`), join(REGISTROS, 'aplicados', `${id}.sql`))
  feitos += ids.length
  console.log(`  ✔ ${feitos}/${pendentes.length}`)
}
// a chave que LIGA o encaixe vem por último: só depois das peças existirem
const chaves = Object.keys(porCanal).map((c) =>
  `INSERT INTO config (k, v) VALUES ('lineup_grade:${esc(c)}', '${POSICAO}') ON CONFLICT(k) DO UPDATE SET v = excluded.v;`)
await d1(chaves.join('\n'))
console.log(`✔ encaixe ligado (${POSICAO}) em: ${Object.keys(porCanal).join(', ')}`)
