// Montador da fábrica de comerciais:
// amostra em tela cheia -> encolhe para o buraco do molde -> ficha com horário.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import { SEG, FFMPEG, FFPROBE, probe } from './ffmpeg.mjs'

const execFileAsync = promisify(execFile)
const BUF = { maxBuffer: 64 * 1024 * 1024 }
const W = 1280
const H = 720
const MAX_PRELUDE = 2.5
const TITLE_FONT = fileURLToPath(new URL('../assets/LiberationSansNarrow-Bold.ttf', import.meta.url))
const DISNEY_FONT = fileURLToPath(new URL('../assets/UbuntuSans.ttf', import.meta.url))

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

function textStyle(canal) {
  if (canal === 'disney_channel') {
    return {
      box: { x: 820, y: 54, w: 390, h: 105 },
      font: DISNEY_FONT,
      family: 'Ubuntu Sans',
      anchor: 'end',
      titleSize: 31,
      subtitleSize: 25,
      titleY: 88,
      subtitleY: 38,
      titleFill: '#ffffff',
      titleStroke: '#3a0b67',
      titleShadow: '#200036',
      subtitleFill: '#ffe85b',
      subtitleStroke: '#6c188f',
      subtitleShadow: '#2c0649',
    }
  }
  return {
    box: { x: 84, y: 501, w: 700, h: 110 },
    font: TITLE_FONT,
    family: 'Liberation Sans Narrow',
    anchor: 'start',
    titleSize: 43,
    subtitleSize: 34,
    titleY: 43,
    subtitleY: 93,
    titleFill: '#ffffff',
    titleStroke: '#193861',
    titleShadow: '#07152b',
    subtitleFill: '#e53b43',
    subtitleStroke: '#7a0b24',
    subtitleShadow: '#350310',
  }
}

function escSvg(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function svgFit(text, size, maxWidth) {
  // A largura aproximada evita que títulos longos avancem sobre a janela do vídeo.
  return [...String(text)].length * size * 0.5 > maxWidth
    ? ` textLength="${Math.round(maxWidth)}" lengthAdjust="spacingAndGlyphs"`
    : ''
}

function makeSvgTextOverlay(titulo, subtitulo, textoBox, canal, outFile) {
  const style = textStyle(canal)
  const box = parseBox(textoBox) ?? style.box
  const title = escSvg(titulo)
  const subtitle = escSvg(String(subtitulo).toUpperCase())
  const titleX = Math.round(style.anchor === 'end' ? box.x + box.w : box.x)
  const titleY = Math.round(box.y + style.titleY)
  const subtitleY = Math.round(box.y + style.subtitleY)
  const titleFit = svgFit(titulo, style.titleSize, box.w)
  const subtitleFit = svgFit(subtitulo, style.subtitleSize, box.w)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <text x="${titleX + 2}" y="${titleY + 3}" text-anchor="${style.anchor}" font-family="${style.family}" font-size="${style.titleSize}" font-weight="700" letter-spacing="0" fill="${style.titleShadow}"${titleFit}>${title}</text>
  <text x="${titleX}" y="${titleY}" text-anchor="${style.anchor}" font-family="${style.family}" font-size="${style.titleSize}" font-weight="700" letter-spacing="0" fill="${style.titleFill}" stroke="${style.titleStroke}" stroke-width="1.2" paint-order="stroke"${titleFit}>${title}</text>
  <text x="${titleX + 2}" y="${subtitleY + 3}" text-anchor="${style.anchor}" font-family="${style.family}" font-size="${style.subtitleSize}" font-weight="700" letter-spacing="0" fill="${style.subtitleShadow}"${subtitleFit}>${subtitle}</text>
  <text x="${titleX}" y="${subtitleY}" text-anchor="${style.anchor}" font-family="${style.family}" font-size="${style.subtitleSize}" font-weight="700" letter-spacing="0" fill="${style.subtitleFill}" stroke="${style.subtitleStroke}" stroke-width="1.2" paint-order="stroke"${subtitleFit}>${subtitle}</text>
</svg>`
  const png = new Resvg(svg, {
    font: { fontFiles: [style.font], loadSystemFonts: false },
  }).render().asPng()
  writeFileSync(outFile, png)
  return outFile
}

function overlayTextImageFilter(input, output, textInputIndex, enableAt) {
  return `[${textInputIndex}:v]format=rgba[txt];` +
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

function audioGraph({ total, locucaoDuration, prelude, musicaOrigem }) {
  const t = total.toFixed(3)
  const delayMs = Math.round(prelude * 1000)
  const voice = `[2:a]aresample=48000,atrim=duration=${locucaoDuration.toFixed(3)},` +
    `asetpts=PTS-STARTPTS,volume=1.6,alimiter=limit=0.96` +
    `${delayMs > 0 ? `,adelay=${delayMs}:all=1` : ''}[voice]`
  if (!musicaOrigem) return `${voice};[voice]apad=whole_dur=${t},atrim=duration=${t}[aout]`

  const musicInput = musicaOrigem === 'external' ? 3 : 0
  return [
    voice,
    `[${musicInput}:a]aresample=48000,atrim=duration=${t},asetpts=PTS-STARTPTS,volume=0.28[music]`,
    `[voice][music]amix=inputs=2:duration=longest:normalize=0,atrim=duration=${t},alimiter=limit=0.96[aout]`,
  ].join(';')
}

function videoBase(total) {
  const t = total.toFixed(3)
  return [
    `color=c=black:s=${W}x${H}:d=${t}[base]`,
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=30,trim=duration=${t},setpts=PTS-STARTPTS[src]`,
  ]
}

function animatedVideoGraph({ total, tFaseB, trans, hole, tituloTela, textoTela, textoBox, textInputIndex }) {
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
    overlayTextImageFilter('v1', 'vout', textInputIndex, tFaseB),
  ]
  return parts.join(';')
}

function staticVideoGraph({ total, tFaseB, hole, tituloTela, textoTela, textoBox, textInputIndex }) {
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
    overlayTextImageFilter('v2', 'vout', textInputIndex, tFaseB),
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
  canal = '',
  tituloTela = '',
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
  const sample = await probe(sampleVideo)
  const total = Math.ceil((loc.total - 1e-6) / SEG) * SEG
  const sobra = total - loc.total
  // Abre com a cama musical antes do locutor e segura a ficha no final. Isso
  // ocupa o múltiplo de 10 sem delegar ao pipeline um bloco preto perceptível.
  const prelude = Math.min(MAX_PRELUDE, sobra)
  const encerramento = sobra - prelude
  const frase = loc.offsets.find((o) => o.papel === 'frase')
  const inicioFicha = frase ? frase.start + frase.duration : loc.offsets[1]?.start ?? Math.min(3, loc.total)
  const tFaseB = prelude + inicioFicha
  const trans = Math.min(0.5, Math.max(0.2, total - tFaseB > 0.3 ? 0.5 : 0.2))

  const moldeAlpha = join(workdir, 'molde-alpha.png')
  await preparaMolde(moldePng, moldeAlpha)
  const hole = await detectaBuraco(moldeAlpha)
  const textOverlay = makeSvgTextOverlay(tituloTela || textoTela, textoTela, textoBox, canal, join(workdir, 'texto.png'))
  const textInputIndex = musicaFile ? 4 : 3
  // Uma cama enviada com o molde substitui a trilha da amostra. Sem cama, a
  // abertura do próprio programa acompanha o comercial em volume baixo.
  const musicaOrigem = musicaFile ? 'external' : sample.hasAudio ? 'video' : null
  const aGraph = audioGraph({ total, locucaoDuration: loc.total, prelude, musicaOrigem })
  const animated = `${animatedVideoGraph({ total, tFaseB, trans, hole, tituloTela: tituloTela || textoTela, textoTela, textoBox, textInputIndex })};${aGraph}`
  let fallback = false
  try {
    await render({ sampleVideo, moldeAlphaPng: moldeAlpha, locucaoWav: locucao, musicaFile, textOverlayFile: textOverlay, filter: animated, total, outFile })
  } catch (e) {
    fallback = true
    const stat = `${staticVideoGraph({ total, tFaseB, hole, tituloTela: tituloTela || textoTela, textoTela, textoBox, textInputIndex })};${aGraph}`
    await render({ sampleVideo, moldeAlphaPng: moldeAlpha, locucaoWav: locucao, musicaFile, textOverlayFile: textOverlay, filter: stat, total, outFile })
  }

  return {
    duration: total,
    locucao_duration: loc.total,
    prelude,
    encerramento,
    t_fase_b: tFaseB,
    transition: fallback ? 'static-fallback' : 'shrink',
    text_renderer: 'svg-overlay',
    music_source: musicaOrigem ?? 'none',
    hole,
    offsets: loc.offsets,
  }
}
