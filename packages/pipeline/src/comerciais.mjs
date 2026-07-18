// Montador da fábrica de comerciais:
// amostra em tela cheia -> encolhe para o buraco do molde -> ficha com horário.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { FFMPEG, FFPROBE } from './ffmpeg.mjs'

const execFileAsync = promisify(execFile)
const BUF = { maxBuffer: 64 * 1024 * 1024 }
const W = 1280
const H = 720
let drawtextCache = null

async function run(bin, args) {
  await execFileAsync(bin, args, BUF)
}

async function runFfmpeg(args) {
  await run(FFMPEG(), ['-y', '-hide_banner', '-loglevel', 'error', ...args])
}

async function duration(file) {
  const { stdout } = await execFileAsync(FFPROBE(), [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file,
  ], BUF)
  const n = Number(stdout.trim())
  if (!Number.isFinite(n) || n <= 0) throw new Error(`não consegui medir duração de ${file}`)
  return n
}

function escConcatPath(file) {
  return resolve(file).replace(/'/g, "'\\''")
}

function escDrawText(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g, '\\,')
}

function escFilterPath(file) {
  return String(file).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

async function hasDrawtext() {
  if (drawtextCache !== null) return drawtextCache
  const { stdout } = await execFileAsync(FFMPEG(), ['-hide_banner', '-filters'], BUF)
  drawtextCache = /^\s*T?\.?\s+drawtext\s+/m.test(stdout)
  return drawtextCache
}

function even(n) {
  return Math.max(2, Math.round(n / 2) * 2)
}

function parseBox(raw) {
  if (!raw) return null
  try {
    const b = typeof raw === 'string' ? JSON.parse(raw) : raw
    const x = Number(b.x), y = Number(b.y), w = Number(b.w), h = Number(b.h)
    if ([x, y, w, h].every(Number.isFinite) && w > 10 && h > 10) return { x, y, w, h }
  } catch {
    /* segue sem box */
  }
  return null
}

function defaultTextBox() {
  return { x: 70, y: 590, w: 1140, h: 86 }
}

function drawTextFilter(input, output, text, textoBox, enableAt) {
  const box = parseBox(textoBox) ?? defaultTextBox()
  const fontFile = process.env.COMERCIAL_FONT || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
  const font = existsSync(fontFile)
    ? `fontfile='${escFilterPath(fontFile)}'`
    : "font='Sans'"
  const fontSize = Math.max(30, Math.min(48, Math.floor((box.w / Math.max(16, text.length)) * 1.55)))
  const x = `${Math.round(box.x)}+(${Math.round(box.w)}-text_w)/2`
  const y = `${Math.round(box.y)}+(${Math.round(box.h)}-text_h)/2`
  return `[${input}]drawtext=${font}:text='${escDrawText(text)}':fontcolor=white:fontsize=${fontSize}:` +
    `borderw=2:bordercolor=black@0.7:shadowx=2:shadowy=2:shadowcolor=black@0.55:` +
    `x=${x}:y=${y}:enable='gte(t,${enableAt.toFixed(3)})'[${output}]`
}

const GLYPHS = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10011', '10001', '10001', '01110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  6: ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
}

function makeTextOverlay(text, textoBox, outFile) {
  const box = parseBox(textoBox) ?? defaultTextBox()
  const normalized = String(text).toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/·/g, '-')
  const chars = [...normalized].filter((ch) => ch === ' ' || ch === '-' || GLYPHS[ch])
  const units = chars.reduce((sum, ch) => sum + (ch === ' ' ? 3 : ch === '-' ? 3 : 6), -1)
  const scale = Math.max(4, Math.min(14, Math.floor(Math.min(box.w / Math.max(1, units), box.h / 9))))
  // O fallback roda nas imagens de produção sem drawtext/libfreetype. Mantemos
  // os glifos locais, mas com inclinação e camadas coloridas de chamada de TV.
  const italic = Math.max(1, Math.round(scale * 0.24))
  const textW = units * scale + italic * 6
  const textH = 7 * scale
  let x = Math.round(box.x + (box.w - textW) / 2)
  const y = Math.round(box.y + (box.h - textH) / 2)
  const buf = Buffer.alloc(W * H * 3, 0)
  const put = (px, py, color) => {
    if (px < 0 || px >= W || py < 0 || py >= H) return
    const i = (py * W + px) * 3
    buf[i] = color[0]; buf[i + 1] = color[1]; buf[i + 2] = color[2]
  }
  const rect = (rx, ry, rw, rh, color) => {
    for (let yy = ry; yy < ry + rh; yy++) for (let xx = rx; xx < rx + rw; xx++) put(xx, yy, color)
  }
  const drawGlyph = (glyph, gx, gy, color, pad = 0) => {
    for (let row = 0; row < glyph.length; row++) {
      for (let col = 0; col < glyph[row].length; col++) {
        if (glyph[row][col] !== '1') continue
        const slant = (glyph.length - 1 - row) * italic
        rect(gx + col * scale + slant - pad, gy + row * scale - pad, scale + pad * 2, scale + pad * 2, color)
      }
    }
  }
  for (const ch of chars) {
    if (ch === ' ') { x += 3 * scale; continue }
    if (ch === '-') {
      const hyphenX = x + 3 * italic
      rect(hyphenX + 5, y + 3 * scale + 5, 3 * scale + 6, scale + 6, [36, 8, 78])
      rect(hyphenX, y + 3 * scale, 3 * scale + 4, scale + 4, [0, 132, 255])
      rect(hyphenX + 2, y + 3 * scale + 2, 3 * scale, scale, [255, 218, 25])
      x += 4 * scale
      continue
    }
    const glyph = GLYPHS[ch]
    drawGlyph(glyph, x + 6, y + 7, [38, 7, 82], Math.max(2, Math.floor(scale / 3)))
    drawGlyph(glyph, x, y, [0, 128, 255], Math.max(1, Math.floor(scale / 4)))
    drawGlyph(glyph, x, y, [255, 218, 25])
    x += 6 * scale
  }
  writeFileSync(outFile, Buffer.concat([Buffer.from(`P6\n${W} ${H}\n255\n`), buf]))
  return outFile
}

function overlayTextImageFilter(input, output, textInputIndex, enableAt) {
  return `[${textInputIndex}:v]format=rgb24,colorkey=0x000000:0.01:0.0[txt];` +
    `[${input}][txt]overlay=0:0:enable='gte(t,${enableAt.toFixed(3)})'[${output}]`
}

async function normalizaFala(input, output) {
  await runFfmpeg([
    '-i', input,
    '-vn',
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo',
    '-c:a', 'pcm_s16le',
    output,
  ])
  return duration(output)
}

async function concatenaLocucao(clips, workdir, outFile) {
  const offsets = []
  let cursor = 0
  const wavs = []
  for (const [i, c] of clips.entries()) {
    const wav = join(workdir, `fala_${String(i).padStart(2, '0')}.wav`)
    const dur = await normalizaFala(c.file, wav)
    offsets.push({ papel: c.papel, id: c.id, rotulo: c.rotulo, start: cursor, duration: dur })
    cursor += dur
    wavs.push(wav)
  }
  const listPath = join(workdir, 'locucao.concat.txt')
  writeFileSync(listPath, wavs.map((f) => `file '${escConcatPath(f)}'`).join('\n') + '\n')
  await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outFile])
  return { offsets, total: cursor }
}

async function preparaMolde(moldePng, outPng) {
  await runFfmpeg([
    '-i', moldePng,
    '-vf', `scale=${W}:${H},format=rgba,colorkey=0x000000:0.05:0.02`,
    '-frames:v', '1',
    outPng,
  ])
}

async function detectaBuraco(moldeAlphaPng) {
  try {
    const { stdout } = await execFileAsync(FFMPEG(), [
      '-v', 'error', '-i', moldeAlphaPng,
      '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgba',
      'pipe:1',
    ], { ...BUF, encoding: 'buffer' })
    const raw = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout)
    const total = W * H
    const seen = new Uint8Array(total)
    const stack = new Int32Array(total)
    let best = null
    for (let i = 0; i < total; i++) {
      if (seen[i] || raw[i * 4 + 3] >= 16) continue
      let top = 0, area = 0
      let minX = W, minY = H, maxX = 0, maxY = 0
      stack[top++] = i
      seen[i] = 1
      while (top > 0) {
        const p = stack[--top]
        const x = p % W
        const y = Math.floor(p / W)
        area++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        const ns = [p - 1, p + 1, p - W, p + W]
        for (const n of ns) {
          if (n < 0 || n >= total || seen[n] || raw[n * 4 + 3] >= 16) continue
          const nx = n % W
          if ((n === p - 1 && nx !== x - 1) || (n === p + 1 && nx !== x + 1)) continue
          seen[n] = 1
          stack[top++] = n
        }
      }
      if (!best || area > best.area) best = { area, x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
    }
    if (best && best.area > 1000) return { x: best.x, y: best.y, w: best.w, h: best.h, fallback: false }
  } catch {
    /* fallback abaixo */
  }
  return { x: 418, y: 0, w: 862, h: 480, fallback: true }
}

function audioGraph(total, musicaOrigem) {
  const t = total.toFixed(3)
  if (!musicaOrigem) {
    return `[2:a]aresample=48000,atrim=duration=${t},asetpts=PTS-STARTPTS,volume=1.6,alimiter=limit=0.96[aout]`
  }
  const musicaIn = musicaOrigem === 'sample' ? '0:a' : '3:a'
  const volumeMusica = musicaOrigem === 'sample' ? 0.025 : 0.08
  return [
    `[2:a]aresample=48000,atrim=duration=${t},asetpts=PTS-STARTPTS,volume=2.0,alimiter=limit=0.96[voice0]`,
    '[voice0]asplit=2[voice_sc][voice_mix]',
    `[${musicaIn}]aresample=48000,atrim=duration=${t},asetpts=PTS-STARTPTS,volume=${volumeMusica}[music0]`,
    '[music0][voice_sc]sidechaincompress=threshold=0.018:ratio=20:attack=4:release=220[musicduck]',
    '[voice_mix][musicduck]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.96[aout]',
  ].join(';')
}

function videoBase(total) {
  const t = total.toFixed(3)
  return [
    `color=c=black:s=${W}x${H}:d=${t}[base]`,
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=30,trim=duration=${t},setpts=PTS-STARTPTS[src]`,
  ]
}

function animatedVideoGraph({ total, tFaseB, trans, hole, textoTela, textoBox, textInputIndex }) {
  const animStart = Math.max(0, tFaseB - trans)
  const p = `clip((t-${animStart.toFixed(3)})/${trans.toFixed(3)},0,1)`
  const w = even(hole.w)
  const h = even(hole.h)
  const parts = [
    ...videoBase(total),
    `[src]scale=w='trunc((${W}+(${w}-${W})*${p})/2)*2':h='trunc((${H}+(${h}-${H})*${p})/2)*2':eval=frame[anim]`,
    `[base][anim]overlay=x='${Math.round(hole.x)}*${p}':y='${Math.round(hole.y)}*${p}'[v0]`,
    `[1:v]format=rgba,fade=t=in:st=${animStart.toFixed(3)}:d=${trans.toFixed(3)}:alpha=1,setpts=PTS-STARTPTS[molde]`,
    `[v0][molde]overlay=0:0:enable='gte(t,${animStart.toFixed(3)})'[v1]`,
    textInputIndex == null
      ? drawTextFilter('v1', 'vout', textoTela, textoBox, tFaseB)
      : overlayTextImageFilter('v1', 'vout', textInputIndex, tFaseB),
  ]
  return parts.join(';')
}

function staticVideoGraph({ total, tFaseB, hole, textoTela, textoBox, textInputIndex }) {
  const w = even(hole.w)
  const h = even(hole.h)
  const parts = [
    ...videoBase(total),
    `[src]split[full][mini0]`,
    `[mini0]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1[mini]`,
    `[base][full]overlay=0:0:enable='lt(t,${tFaseB.toFixed(3)})'[v0]`,
    `[v0][mini]overlay=${Math.round(hole.x)}:${Math.round(hole.y)}:enable='gte(t,${tFaseB.toFixed(3)})'[v1]`,
    `[1:v]format=rgba,setpts=PTS-STARTPTS[molde]`,
    `[v1][molde]overlay=0:0:enable='gte(t,${tFaseB.toFixed(3)})'[v2]`,
    textInputIndex == null
      ? drawTextFilter('v2', 'vout', textoTela, textoBox, tFaseB)
      : overlayTextImageFilter('v2', 'vout', textInputIndex, tFaseB),
  ]
  return parts.join(';')
}

async function render({ sampleVideo, moldeAlphaPng, locucaoWav, musicaFile, textOverlayFile, filter, total, outFile }) {
  const args = [
    '-stream_loop', '-1', '-i', sampleVideo,
    '-loop', '1', '-i', moldeAlphaPng,
    '-i', locucaoWav,
  ]
  if (musicaFile) args.push('-stream_loop', '-1', '-i', musicaFile)
  if (textOverlayFile) args.push('-loop', '1', '-i', textOverlayFile)
  args.push(
    '-t', total.toFixed(3),
    '-filter_complex', filter,
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    '-movflags', '+faststart',
    '-shortest',
    outFile,
  )
  await runFfmpeg(args)
}

export async function montaComercialPrograma({
  sampleVideo,
  moldePng,
  musicaFile = null,
  clips,
  textoTela,
  textoBox = null,
  outFile,
  workdir,
}) {
  mkdirSync(workdir, { recursive: true })
  if (!Array.isArray(clips) || clips.length !== 5) {
    throw new Error('montaComercialPrograma exige 5 clipes: frase, nome, frequência, horário, assinatura')
  }

  const locucao = join(workdir, 'locucao.wav')
  const loc = await concatenaLocucao(clips, workdir, locucao)
  const frase = loc.offsets.find((o) => o.papel === 'frase')
  const tFaseB = frase ? frase.start + frase.duration : loc.offsets[1]?.start ?? Math.min(3, loc.total)
  const trans = Math.min(0.5, Math.max(0.2, loc.total - tFaseB > 0.3 ? 0.5 : 0.2))

  const moldeAlpha = join(workdir, 'molde-alpha.png')
  await preparaMolde(moldePng, moldeAlpha)
  const hole = await detectaBuraco(moldeAlpha)
  const textOverlay = await hasDrawtext() ? null : makeTextOverlay(textoTela, textoBox, join(workdir, 'texto.ppm'))
  const textInputIndex = textOverlay ? (musicaFile ? 4 : 3) : null
  // A amostra define as imagens do programa. Sua faixa original pode ter fala
  // ou abertura muito alta, então só uma trilha cadastrada no molde entra no
  // mix. Assim a locução da fábrica sempre chega limpa ao comercial final.
  const musicaOrigem = musicaFile ? 'external' : null
  const aGraph = audioGraph(loc.total, musicaOrigem)
  const animated = `${animatedVideoGraph({ total: loc.total, tFaseB, trans, hole, textoTela, textoBox, textInputIndex })};${aGraph}`
  let fallback = false
  try {
    await render({ sampleVideo, moldeAlphaPng: moldeAlpha, locucaoWav: locucao, musicaFile, textOverlayFile: textOverlay, filter: animated, total: loc.total, outFile })
  } catch (e) {
    fallback = true
    const stat = `${staticVideoGraph({ total: loc.total, tFaseB, hole, textoTela, textoBox, textInputIndex })};${aGraph}`
    await render({ sampleVideo, moldeAlphaPng: moldeAlpha, locucaoWav: locucao, musicaFile, textOverlayFile: textOverlay, filter: stat, total: loc.total, outFile })
  }

  return {
    duration: loc.total,
    t_fase_b: tFaseB,
    transition: fallback ? 'static-fallback' : 'shrink',
    text_renderer: textOverlay ? 'bitmap-overlay' : 'drawtext',
    music_source: musicaOrigem ?? 'none',
    hole,
    offsets: loc.offsets,
  }
}
