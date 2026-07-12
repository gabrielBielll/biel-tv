// Upload dos segmentos para o R2 — local (simulado do wrangler) ou remoto (S3 API).
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { AwsClient } from 'aws4fetch'

export function listSegments(dir) {
  return readdirSync(dir).filter((f) => /^seg\d{5}\.ts$/.test(f)).sort()
}

/** Dev: sobe para o R2 simulado (.wrangler/state) — 1 processo wrangler por objeto, lento mas fiel. */
export function uploadLocal(rootDir, dir, mediaId, onProgress) {
  const files = listSegments(dir)
  for (const [i, f] of files.entries()) {
    const key = `media/${mediaId}/${f}`
    const r = spawnSync('npx', ['wrangler', 'r2', 'object', 'put', `biel-tv-media/${key}`, '--file', join(dir, f), '--local'], {
      cwd: join(rootDir, 'apps', 'stream'),
      stdio: 'ignore',
    })
    if (r.status !== 0) throw new Error(`falha no upload local de ${key}`)
    onProgress?.(i + 1, files.length, key)
  }
  return files.length
}

/**
 * Produção: sobe direto pro R2 via API S3 (paralelo).
 * Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.
 * (Pronto, mas só testável quando o bucket real existir.)
 */
export async function uploadRemote(dir, mediaId, onProgress, concurrency = 8) {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET = 'biel-tv-media' } = process.env
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error('para --target remote exporte R2_ACCOUNT_ID, R2_ACCESS_KEY_ID e R2_SECRET_ACCESS_KEY')
  }
  const aws = new AwsClient({ accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY })
  const endpoint = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}`

  const files = listSegments(dir)
  let done = 0
  for (let i = 0; i < files.length; i += concurrency) {
    await Promise.all(
      files.slice(i, i + concurrency).map(async (f) => {
        const key = `media/${mediaId}/${f}`
        const res = await aws.fetch(`${endpoint}/${key}`, {
          method: 'PUT',
          body: readFileSync(join(dir, f)),
          headers: { 'content-type': 'video/mp2t' },
        })
        if (!res.ok) throw new Error(`PUT ${key} → HTTP ${res.status}`)
        onProgress?.(++done, files.length, key)
      }),
    )
  }
  return files.length
}
