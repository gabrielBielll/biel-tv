// Cortes de intervalo para um FILME que já está no R2 e entrou sem cue point.
//
// Sem cue point o filme toca direto, sem intervalo nenhum, e as vinhetas de
// contexto ("volta já" / "está de volta") nunca entram. Este script:
//   1. baixa os segmentos do R2 (rota /admin/staging do Worker), sem D1;
//   2. monta um proxy leve (320 px) só pra análise;
//   3. divide o filme em partes iguais de ~N minutos e, perto de cada divisa,
//      procura o melhor corte: tela preta > silêncio > troca de cena;
//   4. grava o SQL dos cue points num arquivo (aplicar quando a cota do D1
//      permitir). Não escreve no banco.
//
// uso: node scripts/cues-filme.mjs <media_id> [--intervalo 20] [--janela 240] [--sql <arquivo>] [--segs <n>]
// Serve também pra episódio: --intervalo 7.5 --janela 120 dá 2 cortes num episódio de 22 min.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FFMPEG, detectBlack, detectScene, detectSilence } from '../packages/pipeline/src/ffmpeg.mjs'

const HOME = process.env.HOME
for (const l of readFileSync(`${HOME}/bieltv-cred.env`, 'utf8').split('\n')) {
  const m = /^\s*(?:export\s+)?([A-Z_0-9]+)=(.*)$/.exec(l)
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '')
}
const BASE = 'https://biel-tv-stream.biel-cesa95.workers.dev'
const DB_ID = 'c7790950-7ee9-4169-8d0c-40e7ce8672d9'
const SEG = 10
const id = process.argv[2]
const arg = (k, d) => (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1] : d)
const INTERVALO = Number(arg('intervalo', 20)) * 60
const JANELA = Number(arg('janela', 240)) // procura o corte até N s antes/depois da divisa (4 min)
const BORDA = 300 // nada nos primeiros/últimos 5 min
if (!/^[a-z0-9_]{3,60}$/.test(id ?? '')) { console.error('uso: cues-filme.mjs <media_id>'); process.exit(2) }
const DIR = `${HOME}/.cache/bieltv-filmes/${id}`
mkdirSync(DIR, { recursive: true })
const SQL = arg('sql', `${HOME}/.cache/bieltv-filmes/${id}.cues.sql`)
const log = (s) => console.log(`${new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })} ${s}`)

async function d1(sql, params = []) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${DB_ID}/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  }).then((x) => x.json())
  if (!r.success) throw new Error(JSON.stringify(r.errors))
  return r.result[0].results
}

// --segs <n>: filme que já está no R2 (media/<id>) mas ainda sem registro no D1
// (registro adiado pela cota). Dispensa o catálogo, pra ter os cortes prontos
// antes do registro e não depois do replan.
const SEGS = Number(arg('segs', 0))
const [m] = SEGS > 0
  ? [{ segment_count: SEGS, duracao_seg: SEGS * SEG, path_prefix: `media/${id}` }]
  : await d1('SELECT segment_count, duracao_seg, path_prefix FROM media_items WHERE id = ?', [id])
if (!m) throw new Error(`${id} não está no catálogo (se só está no R2, passe --segs <n>)`)
const dur = m.duracao_seg

// 1. divisas do filme em partes iguais de ~INTERVALO. Só a JANELA em volta de
// cada divisa é baixada: o filme inteiro dá ~2 GB (3,3 MB por segmento de 10 s),
// a janela dá ~40% disso.
const partes = Math.max(2, Math.round(dur / INTERVALO))
const alvos = Array.from({ length: partes - 1 }, (_, k) => (dur * (k + 1)) / partes)
log(`${id}: ${Math.round(dur / 60)} min em ${partes} partes; divisas em ${alvos.map((a) => Math.round(a / 60)).join(', ')} min`)

async function baixa(nome) {
  const dest = join(DIR, nome)
  if (existsSync(dest) && statSync(dest).size > 0) return dest
  for (let t = 1; t <= 4; t++) {
    try {
      const r = await fetch(`${BASE}/admin/staging/${m.path_prefix}/${nome}`, {
        headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN}` }, signal: AbortSignal.timeout(60_000),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      writeFileSync(dest, Buffer.from(await r.arrayBuffer()))
      return dest
    } catch (e) {
      if (t === 4) throw new Error(`${nome}: ${e.message}`)
      await new Promise((ok) => setTimeout(ok, 2000 * t))
    }
  }
}

const cues = []
for (const [k, alvo] of alvos.entries()) {
  const i0 = Math.max(0, Math.floor((alvo - JANELA) / SEG))
  const i1 = Math.min(m.segment_count - 1, Math.ceil((alvo + JANELA) / SEG))
  const nomes = Array.from({ length: i1 - i0 + 1 }, (_, i) => `seg${String(i0 + i).padStart(5, '0')}.ts`)
  const fila = [...nomes]
  await Promise.all(Array.from({ length: 6 }, async () => { for (let n = fila.shift(); n; n = fila.shift()) await baixa(n) }))
  // 2. proxy leve só da janela (a imagem só precisa servir pra achar preto/cena)
  const proxy = join(DIR, `janela_${k + 1}.mp4`)
  if (!existsSync(proxy)) {
    writeFileSync(join(DIR, `lista_${k + 1}.txt`), nomes.map((n) => `file '${join(DIR, n)}'`).join('\n'))
    execFileSync(FFMPEG(), ['-nostdin', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(DIR, `lista_${k + 1}.txt`),
      '-vf', 'scale=320:-2', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-c:a', 'aac', '-b:a', '64k', proxy])
  }
  // 3. candidatos (tempos da janela + deslocamento = tempo do filme)
  const off = i0 * SEG
  const cand = [
    ...(await detectBlack(proxy)).map((b) => ({ t: off + b.start, kind: 'black', peso: 0 })),
    ...(await Promise.all([-50, -45, -40].map((db) => detectSilence(proxy, { noise: db, d: 1.0 }))))
      .flat().map((g) => ({ t: off + (g.start + g.end) / 2, kind: 'silencio', peso: 1 })),
    ...(await detectScene(proxy, { th: 0.4 })).map((t) => ({ t: off + t, kind: 'cena', peso: 2 })),
  ].filter((c) => Number.isFinite(c.t) && Math.abs(c.t - alvo) <= JANELA && c.t >= BORDA && c.t <= dur - BORDA)
  if (cand.length === 0) { log(`  divisa ${Math.round(alvo / 60)} min: nenhum corte bom na janela, pulada`); continue }
  // 4. prioridade: preto > silêncio > cena; no empate, o mais perto da divisa
  const melhor = cand.sort((a, b) => a.peso - b.peso || Math.abs(a.t - alvo) - Math.abs(b.t - alvo))[0]
  const t = Math.round(melhor.t / SEG) * SEG // o intervalo só pode começar na borda de um segmento
  if (cues.some((c) => Math.abs(c.t - t) < 300)) continue
  cues.push({ t, kind: melhor.kind, bruto: melhor.t, alvo })
  log(`  divisa ${k + 1}/${alvos.length}: ${cand.length} candidato(s)`)
}
for (const c of cues) {
  log(`  corte em ${Math.floor(c.t / 60)}:${String(c.t % 60).padStart(2, '0')} (${c.kind}, bruto ${c.bruto.toFixed(1)}s, divisa ${Math.round(c.alvo / 60)} min)`)
}
const esc = (s) => String(s).replaceAll("'", "''")
writeFileSync(SQL, `DELETE FROM media_cue_points WHERE media_id = '${esc(id)}';\n` +
  (cues.length ? `INSERT INTO media_cue_points (media_id, time_seg, kind) VALUES ${cues.map((c) => `('${esc(id)}',${c.t},'${c.kind}')`).join(',')};\n` : ''))
writeFileSync(join(DIR, 'cues.json'), JSON.stringify(cues, null, 2))
log(`✔ ${cues.length} corte(s) → ${SQL}`)
