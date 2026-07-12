// Wrappers de ffmpeg/ffprobe do pipeline.
// Porta do my-tv (normalization_worker + scene_analyzer), com o que o modelo
// "live virtual" exige a mais: perfil único, keyframes exatos a cada 10s e
// duração total padded para múltiplo de 10.
import { execFileSync, execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)

// 1 MiB (padrão do execFile) estoura fácil: ffmpeg despeja avisos POR FRAME
// em fontes com timestamps tortos (rips antigos = a regra aqui), e o processo
// morre com "maxBuffer exceeded" depois de minutos de trabalho. 64 MiB acomoda
// qualquer verborragia real sem risco de memória.
const BUF = { maxBuffer: 64 * 1024 * 1024 }

export const SEG = 10

function findBin(name, envVar) {
  const candidates = [process.env[envVar], name, join(homedir(), '.local/bin', name)].filter(Boolean)
  for (const c of candidates) {
    try {
      execFileSync(c, ['-version'], { stdio: 'ignore' })
      return c
    } catch {
      /* tenta o próximo */
    }
  }
  throw new Error(`${name} não encontrado (instale ou exporte ${envVar}=/caminho)`)
}

export const FFMPEG = () => findBin('ffmpeg', 'FFMPEG')
export const FFPROBE = () => findBin('ffprobe', 'FFPROBE')

export async function probe(input) {
  const { stdout } = await execFileAsync(FFPROBE(), [
    '-v', 'error', '-print_format', 'json',
    '-show_format', '-show_streams', input,
  ], BUF)
  const info = JSON.parse(stdout)
  const v = info.streams.find((s) => s.codec_type === 'video')
  const a = info.streams.find((s) => s.codec_type === 'audio')
  if (!v) throw new Error('arquivo sem stream de vídeo')
  return {
    duration: Number(info.format.duration),
    width: v.width,
    height: v.height,
    vcodec: v.codec_name,
    acodec: a?.codec_name ?? null,
    hasAudio: Boolean(a),
  }
}

/**
 * Passo 1 — normaliza para o perfil único do canal:
 * 1280x720 letterbox, 30fps, H.264 high (CRF configurável, padrão 23 como no
 * my-tv), AAC 128k 48kHz stereo (silêncio injetado se a fonte não tem áudio),
 * keyframes forçados em t=0,10,20,... e final padded com preto/silêncio até
 * fechar múltiplo de 10s.
 */
export async function normalize(input, outFile, { paddedDur, pad, hasAudio, crf = 23, fps = 30, onProgress }) {
  const vf = [
    'scale=1280:720:force_original_aspect_ratio=decrease',
    'pad=1280:720:(ow-iw)/2:(oh-ih)/2',
    `fps=${fps}`,
    'format=yuv420p',
    ...(pad > 0.01 ? [`tpad=stop_mode=add:stop_duration=${pad.toFixed(3)}`] : []),
  ].join(',')

  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', input]
  if (!hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000')

  args.push(
    ...(hasAudio ? [] : ['-map', '0:v:0', '-map', '1:a:0']),
    '-t', paddedDur.toFixed(3),
    '-vf', vf,
    '-af', 'aresample=48000,apad',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf),
    '-profile:v', 'high', '-sc_threshold', '0',
    '-force_key_frames', `expr:gte(t,n_forced*${SEG})`,
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    outFile,
  )

  // Sem onProgress mantém o caminho antigo (simples e à prova de regressão).
  if (!onProgress) {
    await execFileAsync(FFMPEG(), args, BUF)
    return
  }

  // Com onProgress: `-progress pipe:1` faz o ffmpeg cuspir blocos key=value
  // no stdout (out_time_us=…) — % real = tempo processado ÷ duração alvo.
  await new Promise((resolvePromise, reject) => {
    const p = spawn(FFMPEG(), ['-nostats', '-progress', 'pipe:1', ...args])
    let buf = ''
    let errTail = ''
    p.stdout.on('data', (d) => {
      buf += d
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const m = line.match(/^out_time_us=(\d+)/) ?? line.match(/^out_time_ms=(\d+)/)
        if (m) {
          // out_time_ms historicamente também vem em µs — tratamos ambos como µs
          const pct = Math.min(99, Math.floor(Number(m[1]) / 1e6 / paddedDur * 100))
          onProgress(pct)
        }
      }
    })
    p.stderr.on('data', (d) => { errTail = (errTail + d).slice(-2000) })
    p.on('error', reject)
    p.on('close', (code) => {
      if (code === 0) resolvePromise(undefined)
      else reject(new Error(errTail.trim().split('\n').at(-1) || `ffmpeg saiu com código ${code}`))
    })
  })
}

/** Passo 2 — corta o normalizado em .ts de 10s exatos, sem re-encodar. */
export async function segment(normalized, outDir) {
  await execFileAsync(FFMPEG(), [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', normalized, '-c', 'copy',
    '-f', 'hls', '-hls_time', String(SEG), '-hls_list_size', '0',
    '-hls_flags', 'independent_segments',
    '-hls_segment_filename', join(outDir, 'seg%05d.ts'),
    join(outDir, '_index.m3u8'),
  ], BUF)
}

/**
 * Passo 3 — detecta trechos de tela preta (candidatos a intervalo comercial).
 * Thresholds idênticos ao scene_analyzer do my-tv.
 */
export async function detectBlack(file, { d = 1.0, picTh = 0.98, pixTh = 0.1 } = {}) {
  const { stderr } = await execFileAsync(FFMPEG(), [
    '-hide_banner', '-i', file,
    '-vf', `blackdetect=d=${d}:pic_th=${picTh}:pix_th=${pixTh}`,
    '-an', '-f', 'null', '-',
  ], BUF)
  const blacks = []
  for (const m of stderr.matchAll(/black_start:([\d.]+).*?black_end:([\d.]+)/g)) {
    blacks.push({ start: Number(m[1]), end: Number(m[2]) })
  }
  return blacks
}
