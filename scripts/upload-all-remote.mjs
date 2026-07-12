// Sobe TODOS os segmentos de .ingest-work/*/segments/ pro R2 real (S3/aws4fetch),
// pulando a mídia de teste. Usado uma vez no deploy inicial.
import { readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { uploadRemote } from '../packages/pipeline/src/upload.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(ROOT, '.ingest-work')
const PULAR = new Set(['_src', '_staging', 'filme_test', 'com_refrigerante_retro'])

const dirs = readdirSync(work).filter(
  (d) => !PULAR.has(d) && existsSync(join(work, d, 'segments')),
)
console.log(`subindo ${dirs.length} mídias pro R2 remoto...`)
let totalSegs = 0
for (const id of dirs) {
  const segDir = join(work, id, 'segments')
  const n = await uploadRemote(segDir, id, (done, total) => {
    process.stdout.write(`\r  ${id}: ${done}/${total}    `)
  })
  totalSegs += n
  process.stdout.write(`\r  ✔ ${id}: ${n} segmentos\n`)
}
console.log(`pronto: ${totalSegs} segmentos no R2 (bucket ${process.env.R2_BUCKET})`)
