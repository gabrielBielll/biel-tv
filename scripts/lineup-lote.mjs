// FÁBRICA LOCAL DE LINEUPS: gera, no celular, os lineups de três janelas das
// sequências X→Y→Z que se REPETEM na grade, e sobe pro R2. Não escreve no D1:
// o registro sai num SQL à parte, aplicado depois por scripts/lineup-registra.mjs
// (a cota de escrita diária do D1 é o recurso escasso).
//
// Decisão do Gabriel (23/09/2026): subir já com a grade provisória. Quando a
// grade mudar, é só rodar de novo:
//   1. node --import ./scripts/_ts-registra.mjs scripts/lineup-dryrun.mjs --posicao ultimo --horas 168
//   2. node scripts/lineup-lote.mjs            (gera só as sequências que ainda não têm peça)
//   3. node scripts/lineup-registra.mjs        (depois das 21h, se a cota do dia estourou)
// A locução fica em cache pela frase (mesma sequência = mesmo áudio), então
// refazer o vídeo não gasta ElevenLabs de novo.
//
// Uso: node scripts/lineup-lote.mjs [--min 2] [--canal X] [--limite N] [--seco]
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const HOME = process.env.HOME
for (const l of readFileSync(`${HOME}/bieltv-cred.env`, 'utf8').split('\n')) {
  const m = /^\s*(?:export\s+)?([A-Z_0-9]+)=(.*)$/.exec(l)
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '')
}
const REPO = join(import.meta.dirname, '..')
const BASE = 'https://biel-tv-stream.biel-cesa95.workers.dev'
const TRANSCRITOR = 'https://b--transcritor-backend--rjwnmzf6pscr.code.run/transcrever'
const DB_ID = 'c7790950-7ee9-4169-8d0c-40e7ce8672d9'
const CACHE = `${HOME}/.cache/bieltv-lineup`
const AMOSTRAS = `${CACHE}/amostras`
const VOZES = `${CACHE}/vozes`
const REGISTROS = `${CACHE}/registros`
const MANIFESTO = `${CACHE}/lote/manifesto.jsonl`
const VIDEOS = `${HOME}/storage/downloads/lineup-lote`
for (const d of [AMOSTRAS, VOZES, REGISTROS, `${CACHE}/lote`, `${CACHE}/segs`, VIDEOS]) mkdirSync(d, { recursive: true })

const arg = (k, d) => (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1] : d)
const MIN = Number(arg('min', 2))
const LIMITE = Number(arg('limite', Infinity))
const SECO = process.argv.includes('--seco')
const CANAIS = arg('canal', null) ? [arg('canal')] : ['disney_channel', 'jetix', 'cartoon_network']
const VERSAO = 'lote-local-2026-09-23-v1'

const log = (s) => console.log(`${new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })} ${s}`)

// ── nomes falados e comentários ─────────────────────────────────────────────
// Nome como a voz deve DIZER (grafia pensada pro TTS: "Witch", "Kid versus
// Kat", "Senhor"). Veio dos voice_clips 'nome' de cada canal, com ajustes.
const NOMES = {
  a_vida_e_aventuras_de_juniper_lee: 'Juniper Lee', as_meninas_superpoderosas: 'As Meninas Superpoderosas',
  billy_e_mandy: 'As Terríveis Aventuras de Billy e Mandy', clube_das_winx: 'O Clube das Winx',
  coragem_o_cao_covarde: 'Coragem, o Cão Covarde', corrida_maluca: 'A Corrida Maluca', flintstones: 'Os Flintstones',
  jackie_chan: 'As Aventuras de Jackie Chan', jovens_titas: 'Os Jovens Titãs', knd: 'A Turma do Bairro',
  laboratorio_de_dexter: 'O Laboratório de Dexter', liga_da_justica_sem_limites: 'Liga da Justiça Sem Limites',
  looney_tunes: 'Looney Tunes', looney_tunes_show: 'O Show dos Looney Tunes', manda_chuva: 'Manda-Chuva',
  martin_mystery: 'Martin Mystery', megas_xlr: 'Megas XLR', scooby_doo: 'Scooby-Doo', super_choque: 'Super Choque',
  tom_e_jerry: 'Tom e Jerry', pokemon: 'Pokémon',
  as_visoes_da_raven: 'As Visões da Raven', brandy_e_sr_bigodes: 'Brandy e Senhor Bigodes',
  cory_na_casa_branca: 'Cory na Casa Branca', danny_phantom: 'Danny Phantom', familia_dinossauros: 'Família Dinossauros',
  jacke_long_o_dragao_ocidental: 'Jake Long, o Dragão Ocidental', os_feiticeiros_de_waverly_place: 'Os Feiticeiros de Waverly Place',
  padrinhos_magicos: 'Os Padrinhos Mágicos', phineas_e_ferb: 'Phineas e Ferb', timao_e_pumba: 'Timão e Pumba',
  yin_yang_yo: 'Yin Yang Yo',
  kid_vs_kat: 'Kid versus Kat', power_rangers_forca_animal: 'Power Rangers Força Animal', power_rangers_rpm: 'Power Rangers RPM',
  power_rangers_furia_da_selva: 'Power Rangers Fúria da Selva', power_rangers_spd: 'Power Rangers S.P.D.',
  power_rangers_ultravelocidade: 'Power Rangers Operação Ultravelocidade', pucca: 'Pucca',
  super_esquadrao_dos_macacos: 'Super Esquadrão dos Macacos', tres_espias_demais: 'Três Espiãs Demais', witch: 'Witch',
  zatch_bell: 'Zatch Bell',
}
// Uma frase curta por série (Jetix e Disney; o Cartoon aprovado não tem).
// As marcadas "aprovada" vieram das peças que o Gabriel aprovou em 22–23/09.
const COMENTARIOS = {
  pucca: 'Determinada e divertida, ela não desiste nunca', // aprovada
  padrinhos_magicos: 'Desejos malucos e muita confusão', // aprovada (exemplo)
  power_rangers_forca_animal: 'Heróis selvagens em ação', // aprovada
  tres_espias_demais: 'Ação e estilo em cada missão',
  witch: 'Cinco guardiãs com o poder dos elementos', // aprovada (exemplo)
  kid_vs_kat: 'Um garoto contra um gato alienígena',
  martin_mystery: 'Mistérios sobrenaturais pra resolver',
  power_rangers_rpm: 'Velocidade máxima contra as máquinas',
  power_rangers_furia_da_selva: 'O poder das feras despertou',
  power_rangers_spd: 'A patrulha do futuro em ação',
  power_rangers_ultravelocidade: 'Uma corrida contra o tempo',
  super_esquadrao_dos_macacos: 'Macacos robôs salvando o universo',
  yin_yang_yo: 'Coelhos ninjas e muito kung fu',
  zatch_bell: 'A batalha dos mamodos começou',
  os_feiticeiros_de_waverly_place: 'Magia, aventura e muita confusão', // aprovada
  as_visoes_da_raven: 'O futuro nunca foi tão divertido', // aprovada
  brandy_e_sr_bigodes: 'Essa dupla vai aprontar de novo', // aprovada
  danny_phantom: 'Meio garoto, meio fantasma, cem por cento herói', // aprovada (exemplo)
  cory_na_casa_branca: 'Confusão no endereço mais famoso do país', // aprovada (exemplo)
  familia_dinossauros: 'A família mais pré-histórica da TV',
  jacke_long_o_dragao_ocidental: 'Um dragão protegendo a cidade',
  phineas_e_ferb: 'Cada dia de férias, uma nova invenção',
  timao_e_pumba: 'Hakuna Matata e muita aventura',
}

// Texto da locução por canal, em níveis: se a voz passa do teto, desce um
// nível (menos comentário) em vez de deixar o motor cortar a fala.
// Formatos = os das peças aprovadas (transcritas em 23/09).
function texto(canal, [X, Y, Z], nivel) {
  const n = (s) => NOMES[s] ?? s.replaceAll('_', ' ')
  // Z = X (a série volta depois de Y): o comentário dela já foi dito no começo
  const c = (s, pos) => (pos === 'Z' && s === X ? undefined : COMENTARIOS[s])
  if (canal === 'cartoon_network') {
    return `Você está assistindo ${n(X)}. Logo depois vem ${n(Y)}. E fica super ligado que mais tarde tem ${n(Z)}. Tudo isso só no Cartoon Network.`
  }
  if (canal === 'disney_channel') {
    const cx = nivel <= 1 && c(X) ? ` ${c(X)}.` : ''
    const cy = nivel === 0 && c(Y) ? ` ${c(Y)}.` : ''
    const cz = nivel <= 1 && c(Z, 'Z') ? ` ${c(Z, 'Z')}.` : ''
    return `Você está assistindo ${n(X)}.${cx} Depois, ${n(Y)}.${cy} Mais tarde, ${n(Z)}.${cz} Tudo isso no Disney Channel.`
  }
  // Jetix: sem "Jetix" na fala (a assinatura já está no fechamento). Só 3 tags
  // v3: o /voz/preview corta em 300 caracteres e as 12 aprovadas ocupam 190.
  const cx = nivel <= 1 && c(X) ? ` ${c(X)}!` : ''
  const cz = nivel === 0 && c(Z, 'Z') ? ` ${c(Z, 'Z')}!` : ''
  return `[excited] [confident announcer] [fast pace] Você está assistindo ${n(X)}!${cx} A seguir, ${n(Y)}! E depois, ${n(Z)}!${cz}`
}
// janela útil da voz = do delay do canal até antes do fechamento/assinatura
const TETO_VOZ = { jetix: 16.2, disney_channel: 17.6, cartoon_network: 17.5 }
const DUR_ALVO = { jetix: 20, disney_channel: 19, cartoon_network: 20 }

// ── utilidades ───────────────────────────────────────────────────────────────
const sha = (s) => createHash('sha1').update(s).digest('hex')
const dur = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString())
const semAcento = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  }
  return d[a.length][b.length]
}
// a palavra mais característica do nome foi OUVIDA? (tolera grafia do transcritor)
function ouviu(nome, ouvido) {
  const ws = semAcento(ouvido).split(/[^a-z0-9]+/).filter(Boolean)
  const chave = semAcento(nome).split(/[^a-z0-9]+/).filter((w) => w.length >= 4).sort((a, b) => b.length - a.length)[0]
  if (!chave) return true
  return ws.some((w) => w === chave || lev(w, chave) <= Math.max(1, Math.floor(chave.length / 4)))
}

async function d1(sql, params = []) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${DB_ID}/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  }).then((x) => x.json())
  if (!r.success) throw new Error(JSON.stringify(r.errors))
  return r.result[0].results
}
async function baixaR2(key, dest) {
  const r = await fetch(`${BASE}/admin/staging/${key}`, { headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN}` } })
  if (!r.ok) throw new Error(`R2 ${key} HTTP ${r.status}`)
  writeFileSync(dest, Buffer.from(await r.arrayBuffer()))
}

// Amostra da série: a do catálogo (program_samples) se estiver no R2; senão 40 s
// do meio do 1º episódio pronto (segmentos 15–18). Abertura tem crédito na tela.
async function garanteAmostra(serie) {
  const dest = join(AMOSTRAS, `${serie}.mp4`)
  if (existsSync(dest)) return dest
  const [ps] = await d1("SELECT video_key FROM program_samples WHERE series_id = ? AND COALESCE(video_key,'') <> '' LIMIT 1", [serie])
  if (ps) { await baixaR2(ps.video_key, dest); log(`  amostra ${serie}: program_samples`); return dest }
  const [ep] = await d1("SELECT MIN(id) id FROM media_items WHERE tipo='episodio' AND status='ready' AND json_extract(metadata,'$.series_id') = ?", [serie])
  if (!ep?.id) throw new Error(`série ${serie} sem amostra nem episódio pronto`)
  const lista = join(CACHE, 'segs', `${serie}.txt`)
  const linhas = []
  for (const n of ['00015', '00016', '00017', '00018']) {
    const seg = join(CACHE, 'segs', `${serie}_${n}.ts`)
    await baixaR2(`media/${ep.id}/seg${n}.ts`, seg)
    linhas.push(`file '${seg}'`)
  }
  writeFileSync(lista, linhas.join('\n'))
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', lista, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', dest])
  log(`  amostra ${serie}: ${ep.id} (segmentos 15–18)`)
  return dest
}

async function transcreve(f) {
  const fd = new FormData()
  fd.append('file', new Blob([readFileSync(f)]), 'v.mp3')
  const r = await fetch(TRANSCRITOR, { method: 'POST', body: fd, signal: AbortSignal.timeout(180_000) })
  return (await r.json()).texto ?? ''
}

// Locução: cache pela FRASE + voz + ajustes. Confere ouvindo de volta (a
// síntese não é determinística) e desce de nível se passar do teto.
async function locucao(canal, seq) {
  const cfg = JSON.parse(readFileSync(join(REPO, 'assets/comerciais', canal, 'lineup.config.json'), 'utf8')).narrador
  const voz_config = { model_id: cfg.model_id, ...cfg.settings }
  let melhor = null
  for (let nivel = 0; nivel <= 2; nivel++) {
    const t = texto(canal, seq, nivel)
    if (t.length > 300) continue
    const arq = join(VOZES, canal, `${sha(JSON.stringify([cfg.voz_id, voz_config, t]))}.mp3`)
    mkdirSync(join(VOZES, canal), { recursive: true })
    for (let tent = 1; tent <= 2; tent++) {
      if (!existsSync(arq) || tent > 1) {
        const r = await fetch(`${BASE}/admin/fabrica-comerciais/voz/preview`, {
          method: 'POST',
          headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({ canal, voz_id: cfg.voz_id, voz_config, texto: t }),
          signal: AbortSignal.timeout(120_000),
        })
        if (r.status === 503) throw new Error(`TTS indisponível: ${(await r.text()).slice(0, 200)}`)
        if (!r.ok) throw new Error(`TTS HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
        writeFileSync(arq, Buffer.from(await r.arrayBuffer()))
      }
      const d = dur(arq)
      if (d > TETO_VOZ[canal]) { log(`  voz ${d.toFixed(1)}s > teto ${TETO_VOZ[canal]}s no nível ${nivel}: encurta`); break }
      const ouvido = await transcreve(arq)
      const faltam = seq.filter((s) => !ouviu(NOMES[s] ?? s, ouvido))
      melhor = { arq, texto: t, nivel, dur: d, ouvido, faltam }
      if (faltam.length === 0) return melhor
      log(`  nome não ouvido (${faltam.join(', ')}) na tentativa ${tent}: "${ouvido.slice(0, 120)}"`)
    }
    if (melhor) return melhor // nomes duvidosos mas cabe: segue e fica marcado pra ouvir
  }
  if (melhor) return melhor
  throw new Error('locução não coube no teto nem no nível mais curto')
}

// Disney tem 19 s: o segundo que falta entra no COMEÇO (quadro congelado +
// áudio atrasado), pra resolução musical cair no instante 20. Mesma receita do
// preparaMasterEntregaLineup (scripts/factory-local.mjs).
function master20(src, dest) {
  const d = dur(src)
  const pre = 20 - d
  if (pre <= 0.01) return src
  const ms = Math.round(pre * 1000)
  execFileSync('ffmpeg', ['-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-filter_complex',
    `[0:v]tpad=start_mode=clone:start_duration=${pre.toFixed(3)},trim=duration=20.000,setpts=PTS-STARTPTS[v];` +
    `[0:a]adelay=${ms}:all=1,atrim=duration=20.000,asetpts=PTS-STARTPTS[a]`,
    '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-sc_threshold', '0',
    '-force_key_frames', 'expr:gte(t,n_forced*10)', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-t', '20.000', dest])
  return dest
}

// ── seleção: sequências que se repetem na semana (do dry-run) ─────────────────
const fila = []
for (const canal of CANAIS) {
  const arq = `${CACHE}/dryrun/${canal}-ultimo.json`
  if (!existsSync(arq)) { log(`⚠ ${canal}: rode antes o lineup-dryrun.mjs --horas 168`); continue }
  const j = JSON.parse(readFileSync(arq, 'utf8'))
  const n = new Map()
  for (const e of j.encaixes) n.set(e.seq, (n.get(e.seq) ?? 0) + 1)
  for (const [s, k] of [...n.entries()].sort((a, b) => b[1] - a[1])) {
    if (k < MIN) continue
    const seq = s.split('>')
    const id = `com_lineup_${sha(`${canal}|${s}|${VERSAO}`).slice(0, 12)}`
    fila.push({ canal, seq, id, porSemana: k })
  }
}
const feitos = new Set([...readdirSync(REGISTROS).filter((f) => f.endsWith('.sql')).map((f) => f.replace(/\.sql$/, '')),
  ...(existsSync(`${REGISTROS}/aplicados`) ? readdirSync(`${REGISTROS}/aplicados`).map((f) => f.replace(/\.sql$/, '')) : [])])
const pendentes = fila.filter((x) => !feitos.has(x.id))
const faltam = pendentes.slice(0, LIMITE)
log(`${fila.length} sequências com ≥${MIN} exibições/semana · ${fila.length - pendentes.length} já feitas · ${faltam.length} a fazer agora`)
if (SECO) {
  for (const x of faltam) console.log(`  ${x.canal.padEnd(16)} ${x.porSemana}x  ${x.seq.join(' → ')}\n      "${texto(x.canal, x.seq, 0)}"`)
  process.exit(0)
}

let ok = 0
const falhas = []
for (const [i, x] of faltam.entries()) {
  const rot = `[${i + 1}/${faltam.length}] ${x.canal} ${x.seq.join('→')}`
  try {
    const vids = []
    for (const s of x.seq) vids.push(await garanteAmostra(s))
    const voz = await locucao(x.canal, x.seq)
    const mp4 = join(VIDEOS, `${x.canal}__${x.seq.join('__')}.mp4`)
    let renderizou = false
    for (let tent = 1; tent <= 3 && !renderizou; tent++) {
      // render morto por tempo grava MP4 SEM o fechamento: nunca aproveitar
      const r = spawnSync('timeout', ['120', 'node', 'scripts/monta-lineup-cli.mjs', '--canal', x.canal, '--voz', voz.arq,
        '--v0', vids[0], '--v1', vids[1], '--v2', vids[2], '--out', mp4], { cwd: REPO, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' })
      renderizou = r.status === 0 && Math.abs(dur(mp4) - DUR_ALVO[x.canal]) < 0.06
      if (!renderizou) log(`  render falhou (tentativa ${tent}, exit ${r.status})`)
    }
    if (!renderizou) throw new Error('render falhou 3 vezes')
    const entrega = master20(mp4, join(CACHE, 'lote', `${x.id}-20s.mp4`))
    const titulo = `Lineup: ${x.seq.map((s) => NOMES[s] ?? s).join(' → ')}`
    const r = spawnSync('node', ['--dns-result-order=ipv4first', 'packages/pipeline/src/cli.mjs', 'ingest', entrega,
      '--id', x.id, '--tipo', 'comercial', '--title', titulo, '--canais', x.canal, '--no-cues',
      '--target', 'remote', '--base-url', '', '--adiar-registro'],
    { cwd: REPO, env: { ...process.env, REGISTROS_PENDENTES: REGISTROS }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`ingest: ${(r.stderr || r.stdout).trim().split('\n').at(-1)}`)
    appendFileSync(MANIFESTO, JSON.stringify({
      id: x.id, canal: x.canal, seq: x.seq, por_semana: x.porSemana, versao: VERSAO,
      texto: voz.texto.replace(/^(\[[^\]]+\]\s*)+/, ''), nivel: voz.nivel, voz_seg: +voz.dur.toFixed(1),
      ouvido: voz.ouvido, conferir: voz.faltam, video: mp4,
    }) + '\n')
    ok++
    log(`✔ ${rot} (voz ${voz.dur.toFixed(1)}s, nível ${voz.nivel}${voz.faltam.length ? `, OUVIR: ${voz.faltam.join(',')}` : ''})`)
  } catch (e) {
    falhas.push(x.id)
    log(`✖ ${rot}: ${String(e.message ?? e).slice(0, 200)}`)
    if (/TTS indisponível/.test(String(e.message))) { log('TTS indisponível (cota/assinatura): parando o lote'); break }
  }
}
log(`FIM: ${ok} prontas · ${falhas.length} falharam${falhas.length ? ` (${falhas.join(' ')})` : ''} · registro pendente em ${REGISTROS}`)
