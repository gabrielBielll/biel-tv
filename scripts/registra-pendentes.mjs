// Aplica no D1 os registros que ficaram pendentes do `ingest --adiar-registro`.
//
// Existe porque o pesado da ingestão (baixar, transcodificar, subir pro R2) NÃO
// depende do banco, mas o registro sim — e a cota de leitura diária do D1 free
// derruba até consulta pequena quando estoura. Então: processa a leva quando dá,
// e registra tudo de uma vez quando a cota virar (00:00 UTC / 21h de Brasília).
//
// uso:  node scripts/registra-pendentes.mjs [--dir <pasta>] [--dry-run]
//       (precisa de CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN e D1_HTTP=1
//        no Termux — ver docs/GOTCHAS.md)
import { readdirSync, readFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { runD1 } from '../packages/pipeline/src/registry.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { values: opt } = parseArgs({
  options: { dir: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
})
const fila = opt.dir ?? process.env.REGISTROS_PENDENTES ?? join(ROOT, '.registros-pendentes')
if (!existsSync(fila)) {
  console.log(`nada pendente (${fila} não existe)`)
  process.exit(0)
}
const arquivos = readdirSync(fila).filter((f) => f.endsWith('.sql')).sort()
if (arquivos.length === 0) {
  console.log('nada pendente')
  process.exit(0)
}
console.log(`${arquivos.length} registro(s) pendente(s) em ${fila}`)
if (opt['dry-run']) {
  for (const f of arquivos) console.log('  ·', f)
  process.exit(0)
}
const feitos = join(fila, 'aplicados')
mkdirSync(feitos, { recursive: true })
let ok = 0
const falhas = []
for (const f of arquivos) {
  const id = f.replace(/\.sql$/, '')
  try {
    runD1(ROOT, readFileSync(join(fila, f), 'utf8'), { local: false, label: `register-${id}` })
    // move em vez de apagar: se algo der errado depois, o SQL ainda existe
    renameSync(join(fila, f), join(feitos, f))
    ok++
    console.log(`✅ ${id}`)
  } catch (e) {
    falhas.push([id, String(e.message ?? e).split('\n')[0].slice(0, 140)])
    console.log(`❌ ${id}: ${falhas.at(-1)[1]}`)
  }
}
console.log(`\n${ok} registrado(s), ${falhas.length} falhou/falharam`)
if (falhas.length > 0) {
  console.log('os que falharam continuam na fila — rode de novo quando o banco responder')
  process.exit(1)
}
