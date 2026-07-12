// Registro da mídia no D1 (local ou remoto) via wrangler.
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const esc = (s) => String(s).replaceAll("'", "''")

export function buildRegisterSql({ id, tipo, paddedDur, segmentCount, baseUrl, metadata, cues, canais = [] }) {
  const lines = [
    `INSERT OR REPLACE INTO media_items
  (id, tipo, status, duracao_seg, segment_count, base_url, path_prefix, metadata)
VALUES
  ('${esc(id)}','${esc(tipo)}','ready',${paddedDur},${segmentCount},'${esc(baseUrl)}','media/${esc(id)}','${esc(JSON.stringify(metadata))}');`,
    `DELETE FROM media_cue_points WHERE media_id = '${esc(id)}';`,
  ]
  if (cues.length > 0) {
    const values = cues.map((c) => `('${esc(id)}',${c},'black')`).join(',')
    lines.push(`INSERT INTO media_cue_points (media_id, time_seg, kind) VALUES ${values};`)
  }
  if (canais.length > 0) {
    lines.push(`DELETE FROM media_channels WHERE media_id = '${esc(id)}';`)
    const values = canais.map((c) => `('${esc(id)}','${esc(c)}')`).join(',')
    lines.push(`INSERT OR IGNORE INTO media_channels (media_id, channel_id) VALUES ${values};`)
  }
  return lines.join('\n\n')
}

/** Executa SQL no D1 via wrangler (cwd = apps/stream, onde está o wrangler.toml). */
export function runD1(rootDir, sql, { local = true, label = 'registro' } = {}) {
  const dir = join(rootDir, '.ingest-work')
  mkdirSync(dir, { recursive: true })
  const sqlPath = join(dir, `_${label}.sql`)
  writeFileSync(sqlPath, sql)
  const r = spawnSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'biel-tv-db', local ? '--local' : '--remote', '--file', sqlPath],
    { cwd: join(rootDir, 'apps', 'stream'), stdio: ['ignore', 'ignore', 'inherit'] },
  )
  if (r.status !== 0) throw new Error(`wrangler d1 execute falhou (${label})`)
}
