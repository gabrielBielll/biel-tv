// Registro da mídia no D1 (local ou remoto) via wrangler.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { runWrangler, wranglerDetalhe } from './wrangler.mjs'

const esc = (s) => String(s).replaceAll("'", "''")

/**
 * @param status 'ready' = entra no rodízio na hora · 'disabled' = fica no
 *   catálogo esperando aprovação.
 *
 * ⚠️ O DEFAULT CONTINUA 'ready' de propósito: episódio, filme e upload manual
 * são coisas que o Gabriel escolheu subir — já são a aprovação dele. Quem passa
 * 'disabled' é o CORTADOR, porque peça recortada é palpite da máquina até ele
 * ver (regra dele, 2026-07-15: "melhor não mandar pro ar, deixar sempre primeiro
 * ir pra essa parte pra eu polir os cortes; quando eu clicar em salvar, aí sim
 * está aprovado").
 *
 * Custou 12h aprender: as 24 peças da madrugada entraram 'ready' e foram ao ar
 * antes de qualquer revisão — ele reprovou 23. Toda vez que algo quebrou hoje,
 * a causa foi a mesma: coisa no ar antes de ele ver.
 */
export function buildRegisterSql({ id, tipo, paddedDur, segmentCount, baseUrl, metadata, cues, canais = [], transcript = null, status = 'ready' }) {
  if (status !== 'ready' && status !== 'disabled') throw new Error(`status inválido: ${status}`)
  const lines = [
    `INSERT OR REPLACE INTO media_items
  (id, tipo, status, duracao_seg, segment_count, base_url, path_prefix, metadata)
VALUES
  ('${esc(id)}','${esc(tipo)}','${esc(status)}',${paddedDur},${segmentCount},'${esc(baseUrl)}','media/${esc(id)}','${esc(JSON.stringify(metadata))}');`,
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
  if (transcript) {
    // preserva a decisão do operador em re-ingestão: só o texto é atualizado
    lines.push(`INSERT INTO media_promises (media_id, transcript) VALUES ('${esc(id)}','${esc(transcript.slice(0, 8000))}')
ON CONFLICT(media_id) DO UPDATE SET transcript = excluded.transcript, updated_at = unixepoch();`)
  }
  return lines.join('\n\n')
}

/** Executa SQL no D1 via wrangler (cwd = apps/stream, onde está o wrangler.toml). */
export function runD1(rootDir, sql, { local = true, label = 'registro' } = {}) {
  const dir = join(rootDir, '.ingest-work')
  mkdirSync(dir, { recursive: true })
  const sqlPath = join(dir, `_${label}.sql`)
  writeFileSync(sqlPath, sql)
  // D1_HTTP=1: registra pela API HTTP do D1 em vez do wrangler — pra fábrica
  // no Termux/Android, onde o wrangler morre calado (workerd não tem build
  // bionic). Só vale pro remoto: o simulado local não tem endpoint HTTP.
  if (!local && process.env.D1_HTTP === '1') return runD1Http(rootDir, sql, label)
  const r = runWrangler(rootDir, ['d1', 'execute', 'biel-tv-db', local ? '--local' : '--remote', '--file', sqlPath])
  if (r.status !== 0) {
    const detalhe = wranglerDetalhe(r)
    throw new Error(`wrangler d1 execute falhou (${label})${detalhe ? `: ${detalhe}` : ''}`)
  }
}

/** O mesmo registro, via POST /d1/database/:id/query (aceita múltiplos statements). */
function runD1Http(rootDir, sql, label) {
  const { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN } = process.env
  if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
    throw new Error('D1_HTTP=1 exige CLOUDFLARE_ACCOUNT_ID e CLOUDFLARE_API_TOKEN no ambiente')
  }
  const dbId = process.env.D1_DATABASE_ID
    ?? readFileSync(join(rootDir, 'apps', 'stream', 'wrangler.toml'), 'utf8').match(/database_id\s*=\s*"([^"]+)"/)?.[1]
  if (!dbId) throw new Error('database_id não encontrado no wrangler.toml (ou defina D1_DATABASE_ID)')
  // corpo via arquivo: SQL de registro carrega metadata/transcript — longe do
  // limite de argv e sem escaping de shell
  const bodyPath = join(rootDir, '.ingest-work', `_${label}.json`)
  writeFileSync(bodyPath, JSON.stringify({ sql }))
  const r = spawnSync('curl', ['-s', '-m', '90',
    `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/${dbId}/query`,
    '-H', `Authorization: Bearer ${CLOUDFLARE_API_TOKEN}`,
    '-H', 'content-type: application/json',
    '--data', `@${bodyPath}`,
  ], { encoding: 'utf8' })
  let out = null
  try { out = JSON.parse(r.stdout) } catch { /* resposta não-JSON cai no throw abaixo */ }
  if (r.status !== 0 || !out?.success) {
    const detalhe = out?.errors?.map((e) => e.message).join('; ')
      || String(r.stderr || r.stdout || r.error?.message || '').trim().slice(0, 300)
    throw new Error(`registro via API D1 falhou (${label})${detalhe ? `: ${detalhe}` : ''}`)
  }
}
