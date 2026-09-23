// Propõe as fronteiras de um rip com VÁRIAS vinhetas emendadas (não corta nada).
//
// ⚠️ Isto NÃO contradiz a v4 do docs/features/cortador-comerciais.md ("o
// automático perdeu; quem corta é o Gabriel"). É outra CLASSE de material:
//   compilado de intervalo 2004 → anúncio EMENDA DIRETO, sem marca pra achar.
//   rip de vinheta de canal      → 3 peças de grade (10s+5s+5s) coladas por quem
//                                  ripou, e a grade É o sinal.
//
// ── O QUE FOI MEDIDO (23 vinhetas do Disney Channel BR 2012/2013, 46 fronteiras)
//
//   | portão                            | acerta |
//   |-----------------------------------|--------|
//   | corte de cena na posição da grade | 45/46  |
//   | "nenhuma fala atravessa"          | 35/46  |
//
// **A GRADE É O MOTOR; a cena só refina.** Não há corte de cena perto de 5s em
// NENHUM dos 23 arquivos — é o que mata a falsa fronteira que a primeira versão
// disto inventava no meio do "a seguir".
//
// 🔴 E o portão da fala foi REBAIXADO **NESTE MATERIAL** depois de medido:
// exigir que nenhum segmento falado atravesse a fronteira REPROVA 11 das 46
// fronteiras boas (24%).
//
// ⚠️ O critério NÃO morre pro compilado de intervalo — lá ele continua valendo,
// e é onde o doc o mediu (13/13 no julgamento do DeepSeek). A diferença é
// física: no compilado de 2004 as peças foram ao ar SEPARADAS, com respiro de
// trilha entre elas, então a fala realmente para na fronteira. Num rip de
// vinheta as peças foram COLADAS NA EDIÇÃO, sem respiro — o locutor emenda por
// cima do corte. Regra: **o portão da fala vale pra material com respiro, não
// pra rip colado.**
// O whisper junta num segmento só o fim de uma peça e o começo da seguinte,
// porque o locutor emenda — em "Volta já! / Hannah Montana, no Disney Channel"
// o "Volta já!" começa 0.4s ANTES do corte. Fala aqui serve pra NOMEAR a peça e
// carregar a frase, não pra decidir onde cortar. (Calibrei o contrário nos dois
// primeiros arquivos, onde por acaso não emendava — a mesma armadilha que o doc
// já tinha pago duas vezes: calibrar num arquivo e generalizar.)
//
// A fala só volta a decidir onde a cena falhou (1 de 46: "Hannah Montana",
// que não tem corte visual em 15s) e aí exige as duas coisas: nada atravessando
// a fronteira E a peça nova começando a falar logo depois.
//
// Ainda assim isto é PROPOSTA: imprime a tabela e o JSON no formato de
// `cortes_marcados.pecas` pro editor /r/cortar. Quem aprova é o Gabriel (v4).
//
// Uso:
//   node scripts/analisa-vinheta.mjs <url|id|arquivo.mp4> [...]
//   node scripts/analisa-vinheta.mjs --json <...>          → só o JSON das peças
//   node scripts/analisa-vinheta.mjs --dump <dir> <...>    → salva os sinais crus
//   node scripts/analisa-vinheta.mjs --de-dump <dir>       → re-deriva dos sinais
//                                     salvos, SEM rede (afinar não custa 4G)
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { detectScene } from '../packages/pipeline/src/ffmpeg.mjs'

// O transcritor do Gabriel (Northflank/FastAPI, Whisper no Groq): ~2s por peça.
const TRANSCRITOR = 'https://b--transcritor-backend--rjwnmzf6pscr.code.run/transcrever'

const CENA = 0.08    // limiar de cena. Baixo de propósito: a grade filtra depois.
const PASSO = 5      // a grade de venda. Vinheta de canal é 5/10/15/20s.
const TOL = 0.6      // quanto o corte real pode se afastar da grade nominal
const RABO = 1.5     // grade a menos disto do fim do arquivo não é peça

const args = process.argv.slice(2)
const FLAGS = new Set(args.filter((a) => a.startsWith('--')))
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null }
const DUMP = val('--dump'), DEDUMP = val('--de-dump')
// Só estes dois flags levam valor — `--keep`/`--json` são booleanos. Tratar
// todo flag como se consumisse o próximo argumento fazia `--keep a.mp4 b.mp4`
// engolir o a.mp4 EM SILÊNCIO (processava só o b, sem reclamar de nada).
const COM_VALOR = new Set(['--dump', '--de-dump'])
const ALVOS = args.filter((a, i) => !a.startsWith('--') && !COM_VALOR.has(args[i - 1]))
if (!ALVOS.length && !DEDUMP) {
  console.error('uso: analisa-vinheta.mjs [--json] [--dump <dir>] [--de-dump <dir>] <url|id|arquivo> [...]')
  process.exit(2)
}
const WORK = join(tmpdir(), 'analisa-vinheta')
mkdirSync(WORK, { recursive: true })
if (DUMP) mkdirSync(DUMP, { recursive: true })

const ff = (a) => spawnSync('ffmpeg', a, { encoding: 'utf8', maxBuffer: 32 << 20 }).stderr ?? ''

function fonte(alvo) {
  if (existsSync(alvo)) return { arq: alvo, titulo: alvo.replace(/.*\//, ''), baixado: false }
  const url = /^https?:/.test(alvo) ? alvo : `https://www.youtube.com/watch?v=${alvo}`
  const titulo = execFileSync('yt-dlp', ['--no-playlist', '--print', '%(title)s', url],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  const arq = join(WORK, `${Date.now()}.mp4`)
  // --no-playlist é obrigatório: estes links vêm COM &list= e sem isso o yt-dlp
  // baixaria a playlist inteira (24 vídeos) sem avisar — e o Gabriel está no 4G.
  execFileSync('yt-dlp', ['--no-playlist', '-f', 'bv*+ba/b', '--merge-output-format', 'mp4',
    '-o', arq, url], { stdio: 'ignore' })
  return { arq, titulo, baixado: true }
}

function sonda(arq) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=r_frame_rate,width,height', '-show_entries', 'format=duration',
    '-of', 'default=nw=1', arq], { encoding: 'utf8' })
  const g = (k) => out.match(new RegExp(`^${k}=(.+)$`, 'm'))?.[1]
  const [n, d] = (g('r_frame_rate') ?? '30000/1001').split('/').map(Number)
  return { fps: n / d, w: +g('width'), h: +g('height'), dur: +g('duration') }
}

// Usa o detectScene do projeto (packages/pipeline/src/ffmpeg.mjs) em vez de
// remontar o filtro aqui.
//
// ⚠️ A VERSÃO CASEIRA DISTO TINHA UM BUG, e vale registrar porque é silencioso:
// eu escrevia `metadata=print:file=-`, e o `file=-` MOVE a saída do filtro pro
// STDOUT — medido por spawnSync (que é como este script roda): sem `file=`,
// stdout=0/stderr=17; com `file=-`, stdout=17/stderr=0. Como o leitor lia só o
// stderr, o resultado era ZERO corte de cena, sem erro nenhum: o script "roda",
// acha uma peça só e parece que o vídeo não tem fronteira.
// O `detectScene` do projeto não passa `file=` e lê o stderr — está certo.
const cenas = (arq) => detectScene(arq, { th: CENA })

async function transcreve(arq) {
  const mp3 = arq.replace(/\.[^.]+$/, '.mp3')
  ff(['-v', 'error', '-y', '-i', arq, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', mp3])
  const fd = new FormData()
  fd.append('file', new Blob([readFileSync(mp3)]), 'a.mp3')
  const r = await fetch(TRANSCRITOR, { method: 'POST', body: fd })
  if (!r.ok) throw new Error(`transcritor HTTP ${r.status}`)
  rmSync(mp3, { force: true })
  // O whisper ALUCINA crédito de legendagem no silêncio do fim ("Legenda por
  // <nome>") em peça que não tem legenda — 8 em 70 medidos pelo chat irmão.
  return ((await r.json()).segmentos ?? [])
    .filter((s) => !/legenda(d[oa])? (por|p\/)|legendas? *:|amara\.org|subtitl/i.test(s.text))
}

/**
 * A GRADE propõe, a CENA confirma, a FALA é o último recurso.
 *
 * Os números que decidiram esta ordem estão no cabeçalho do arquivo: cena na
 * grade acerta 45/46; "nenhuma fala atravessa" só 35/46. Grade sozinha nunca
 * corta — 5s tem posição de grade em todos os 23 arquivos e fronteira em
 * nenhum, e é a cena ausente que diz isso.
 */
function fronteiras(cortes, segs, dur, fps) {
  const grade = []
  for (let t = PASSO; t < dur - RABO; t += PASSO) grade.push(t)
  const fr = (t) => Math.round(t * fps)

  const achadas = []
  for (const g of grade) {
    const c = cortes.filter((x) => Math.abs(x - g) < TOL).sort((a, b) => a - b)[0]
    if (c !== undefined) achadas.push({ g, t: c, por: 'cena' })
  }
  // O encode do YouTube desloca o arquivo inteiro em 0..2 frames (os rips 2012
  // caem em f300/f450, os 2013 em f301/f451). O deslocamento é do ARQUIVO, então
  // a mediana das fronteiras confirmadas serve pra projetar a que faltou.
  const offs = achadas.map(({ g, t }) => fr(t) - fr(g)).sort((a, b) => a - b)
  const off = offs.length ? offs[offs.length >> 1] : 0

  // 🔴 O fallback só vale DEPOIS da primeira fronteira confirmada por cena.
  // Sem isso ele inventa fronteira em 5s no meio do "a seguir" (mediado: pegou
  // "A Nova Escola do Imperador"), porque a locução do abre respira e a peça
  // "recomeça a falar". Mas 5s NÃO é fronteira em nenhum dos 23 arquivos: a
  // peça de abertura é sempre a longa (10s). Posição de grade antes da primeira
  // cena confirmada está DENTRO do abre, não entre peças.
  const primeira = achadas.length ? Math.min(...achadas.map((a) => a.g)) : Infinity
  for (const g of grade) {
    if (g < primeira || achadas.some((a) => a.g === g)) continue
    const t = (fr(g) + off) / fps
    // sem cena, exige as DUAS evidências de fala: ninguém atravessando, e a peça
    // nova começando a falar logo depois.
    const atravessa = segs.some((s) => s.start < t - 0.02 && s.end > t + 0.02)
    const comeca = segs.some((s) => s.start >= t - 0.02 && s.start < t + 0.8)
    if (!atravessa && comeca) achadas.push({ g, t, por: 'fala' })
  }
  return achadas.sort((a, b) => a.t - b.t).map((a) => ({ t: fr(a.t) / fps, por: a.por }))
}

/**
 * Frase da peça por MAIOR SOBREPOSIÇÃO, não por onde o segmento começa.
 * "Volta já!" começa 0.43s ANTES do corte e pertence à peça de DEPOIS — filtrar
 * por `start` daria a frase da peça 2 pra peça 1.
 */
function frase(segs, ini, fim) {
  const out = []
  for (const s of segs) {
    if (s.end <= ini || s.start >= fim) continue
    const dur = s.end - s.start
    const partes = s.text.trim().split(/(?<=[.!?…])\s+/).filter(Boolean)
    if (partes.length < 2) {
      // indivisível: vai pra peça que cobre a maior parte dele
      if (Math.min(s.end, fim) - Math.max(s.start, ini) >= dur / 2) out.push(s.text.trim())
      continue
    }
    // Segmento que atravessa a fronteira reparte POR SENTENÇA, com o tempo
    // rateado pelo tamanho de cada uma. Sem isto, um segmento longo do whisper
    // ("A seguir… Os Padrinhos Mágicos! … Volta já! Os Padrinhos Mágicos!")
    // leva a frase INTEIRA pra peça 1 e deixa a peça 2 muda — aconteceu em 1
    // das 70 peças, e nas outras 2 do mesmo arquivo a frase saía trocada.
    const total = partes.reduce((a, x) => a + x.length, 0)
    let t = s.start
    for (const x of partes) {
      const d = dur * (x.length / total)
      if (t + d / 2 >= ini && t + d / 2 < fim) out.push(x)
      t += d
    }
  }
  return out.join(' ')
}

/** Nome vem do que a peça FALA — vinheta de canal se anuncia sozinha. */
function batiza(texto, titulo) {
  const serie = titulo.split(/ *[-–—] */)[0].replace(/ *\b(vinheta|promo|bumper)\b.*/i, '').trim()
  const t = texto.toLowerCase()
  const tipo = /a seguir/.test(t) ? 'a seguir'
    : /volta j[áa]/.test(t) ? 'volta já'
    : /est[áa] de volta/.test(t) ? 'está de volta'
    : /voc[êe] est[áa] vendo|continuem? vendo/.test(t) ? 'você está vendo'
    : null
  return tipo ? `${serie} · ${tipo}` : serie
}

const ms = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(3).padStart(6, '0')}`

function analisa(d) {
  const marcos = fronteiras(d.cortes, d.segs, d.dur, d.fps)
  const fim = Math.round(d.dur * d.fps) / d.fps
  const lim = [0, ...marcos.map((m) => m.t), fim]
  return lim.slice(0, -1).map((ini, i) => {
    const f = lim[i + 1], txt = frase(d.segs, ini, f)
    // Último recurso de NOME (nunca de corte): quando o rip rende as 3 peças de
    // sempre e o texto daquela peça não se identifica — o whisper levou o
    // "Volta já!" pro vizinho —, a POSIÇÃO diz o que é. Medido: 23 de 23 rips
    // são a mesma sequência, nesta ordem. Vale só pro rótulo, que é editável
    // no /r/cortar; o corte continua vindo de cena+grade.
    const porPosicao = lim.length === 4 ? ['a seguir', 'volta já', 'está de volta'][i] : null
    const serie = d.titulo.split(/ *[-–—] */)[0].replace(/ *\b(vinheta|promo|bumper)\b.*/i, '').trim()
    return {
      ini: +ini.toFixed(3), fim: +f.toFixed(3), dur: +(f - ini).toFixed(3),
      nome: batiza(txt, d.titulo) === serie && porPosicao ? `${serie} · ${porPosicao}` : batiza(txt, d.titulo),
      frase: txt, por: marcos[i - 1]?.por ?? 'início',
    }
  })
}

const saida = [], falhas = []
const itens = []
if (DEDUMP) {
  for (const f of readdirSync(DEDUMP).filter((x) => x.endsWith('.json')))
    itens.push(JSON.parse(readFileSync(join(DEDUMP, f), 'utf8')))
} else {
  for (const alvo of ALVOS) {
    try {
      const { arq, titulo, baixado } = fonte(alvo)
      const d = { alvo, titulo, ...sonda(arq), segs: await transcreve(arq), cortes: await cenas(arq) }
      if (DUMP) writeFileSync(join(DUMP, `${alvo.replace(/[^\w-]/g, '_')}.json`), JSON.stringify(d, null, 1))
      if (baixado && !FLAGS.has('--keep')) rmSync(arq, { force: true })
      itens.push(d)
    } catch (e) {
      // Um alvo que falha (vídeo removido, hiccup do yt-dlp, 502 do transcritor)
      // NÃO pode derrubar o lote: numa playlist de 24 isso jogaria fora 23
      // downloads já pagos — e o Gabriel está no 4G.
      falhas.push(alvo); console.error(`  ✖ ${alvo}: ${String(e.message).split('\n')[0]}`)
    }
  }
}

for (const d of itens) {
  const pecas = analisa(d)
  if (!FLAGS.has('--json')) {
    const ar = Math.abs(d.w / d.h - 16 / 9) < 0.02 ? '16:9'
      : Math.abs(d.w / d.h - 4 / 3) < 0.02 ? '4:3' : `${d.w}x${d.h}`
    console.log(`\n═══ ${d.titulo}`)
    console.log(`    ${d.w}x${d.h} (${ar}) · ${d.fps.toFixed(3)}fps · ${d.dur.toFixed(3)}s`)
    for (const p of pecas) {
      console.log(`  ${ms(p.ini)} → ${ms(p.fim)}  (${p.dur.toFixed(3)}s) [${p.por}]  ${p.nome}`)
      console.log(`      "${p.frase}"`)
    }
  }
  saida.push({ fonte: d.alvo, titulo: d.titulo, pecas: pecas.map(({ ini, fim, nome }) => ({ ini, fim, nome })) })
}
if (falhas.length) console.error(`\n⚠ ${falhas.length} falharam: ${falhas.join(' ')}`)
if (FLAGS.has('--json')) console.log(JSON.stringify(saida, null, 2))
else console.log(`\n── ${saida.reduce((a, s) => a + s.pecas.length, 0)} peças · pecas p/ cortes_marcados ──\n${JSON.stringify(saida.map((s) => s.pecas))}`)
