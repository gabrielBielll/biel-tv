// Wrappers de ffmpeg/ffprobe do pipeline.
// Porta do my-tv (normalization_worker + scene_analyzer), com o que o modelo
// "live virtual" exige a mais: perfil único, keyframes exatos a cada 10s e
// duração total padded para múltiplo de 10.
import { execFileSync, execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

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
    // parâmetros de áudio: o concatParts usa pra decidir se o `-c copy` é
    // seguro (sample rate/canais divergentes → o demuxer escorrega o áudio).
    asampleRate: a?.sample_rate ? Number(a.sample_rate) : null,
    achannels: a?.channels ? Number(a.channels) : null,
  }
}

/**
 * Duração POR STREAM (vídeo e áudio) de um arquivo — usada pra flagrar desync
 * A/V que a duração do container esconde. O concat `-c copy` de partes com
 * timebase de áudio divergente estica o áudio: o container fecha na duração
 * "certa" mas o áudio termina depois do vídeo (e o normalize NÃO conserta).
 */
async function streamDurations(file) {
  const { stdout } = await execFileAsync(FFPROBE(), [
    '-v', 'error', '-show_entries', 'stream=codec_type,duration',
    '-print_format', 'json', file,
  ], BUF)
  const streams = JSON.parse(stdout).streams ?? []
  const v = streams.find((s) => s.codec_type === 'video')
  const a = streams.find((s) => s.codec_type === 'audio')
  return { v: v ? Number(v.duration) : NaN, a: a ? Number(a.duration) : NaN }
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
 * Junta as partes de um episódio (playlist "episódios em partes") num arquivo
 * só, ANTES do pipeline — que normaliza o TODO uma vez (keyframes na grade
 * global de 10s). Ver a regra de ouro dos 10s em docs/ARQUITETURA.md: se cada
 * parte fosse normalizada separada, os keyframes reiniciariam a cada pedaço e
 * a segmentação quebraria.
 *
 * Caminho feliz: concat demuxer com `-c copy` (0 re-encode) — partes do mesmo
 * uploader quase sempre têm codec/resolução iguais. Validação: a duração do
 * juntado ≈ soma das partes? Se divergir (encodings diferentes quebram o
 * `-c copy`), cai pro concat filter (re-encoda, aguenta qualquer entrada).
 * As partes DEVEM chegar já na ordem certa (ordenadas pelo nº parseado do
 * título — nunca pela posição na playlist).
 */
export async function concatParts(partFiles, outFile, { forcarFiltro = false } = {}) {
  if (partFiles.length === 0) throw new Error('concat sem partes')
  if (partFiles.length === 1) { execFileSync('cp', [partFiles[0], outFile]); return { metodo: 'unica', partes: 1 } }
  const ff = FFMPEG()

  // duração esperada = soma das partes (a régua da validação)
  let soma = 0
  const infos = []
  for (const f of partFiles) {
    const info = await probe(f)
    infos.push(info)
    soma += info.duration
  }

  // O `-c copy` só é seguro quando as partes compartilham os parâmetros de
  // ÁUDIO. Sample rate / codec / nº de canais divergentes (comum em acervos
  // antigos, onde os pedaços foram subidos em épocas/ferramentas diferentes)
  // fazem o concat demuxer reinterpretar as amostras na timebase errada → o
  // áudio "escorrega" do vídeo, um desync que SOBREVIVE ao normalize. Quando
  // diverge, vamos direto pro filter (que reamostra tudo pra 48k antes de
  // juntar). Resolução/SAR de vídeo diferentes NÃO são problema aqui: o
  // normalize reescala e absorve — por isso só o áudio pesa nesta decisão.
  const audioUniforme = infos.every((i) =>
    i.acodec === infos[0].acodec &&
    i.asampleRate === infos[0].asampleRate &&
    i.achannels === infos[0].achannels)

  // caminho feliz: junção CRUA sem re-encode (forcarFiltro pula direto pro
  // plano B — só usado nos testes, pra exercitar o re-encode sem depender de
  // um arquivo patológico que faça o -c copy divergir)
  if (!forcarFiltro && audioUniforme) {
    const listPath = `${outFile}.concat.txt`
    const listBody = partFiles.map((f) => `file '${resolve(f).replace(/'/g, "'\\''")}'`).join('\n') + '\n'
    writeFileSync(listPath, listBody)
    let copiaOk = false
    try {
      await execFileAsync(ff, ['-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outFile], BUF)
      const out = await probe(outFile)
      const tol = Math.max(2, soma * 0.02)
      const durOk = Math.abs(out.duration - soma) <= tol
      // além da duração total: exige sincronia A/V por stream. A checagem de
      // parâmetros acima pega a causa mais comum ANTES de tentar; esta é a
      // rede de segurança pra qualquer desync que passe (edit lists, priming,
      // timebase de vídeo torta). skew grande → rejeita a cópia, cai pro filter.
      const { v: vDur, a: aDur } = await streamDurations(outFile)
      const skewOk = !Number.isFinite(vDur) || !Number.isFinite(aDur) || Math.abs(vDur - aDur) <= 0.5
      if (durOk && skewOk) copiaOk = true
    } catch {
      /* o -c copy falhou de vez → plano B abaixo */
    } finally {
      rmSync(listPath, { force: true })
    }
    if (copiaOk) return { metodo: 'copy', partes: partFiles.length, soma }
  }

  // plano B: concat filter (re-encoda). Escala cada parte pro perfil do canal
  // (1280x720) — resolve resolução/codec/SAR diferentes; o pipeline normaliza
  // de novo depois, mas isto garante um arquivo contínuo e válido primeiro.
  if (infos.some((i) => !i.hasAudio)) {
    throw new Error('parte sem áudio na junção por filtro — revise as partes (todas precisam ter áudio pro plano B)')
  }
  const inputs = partFiles.flatMap((f) => ['-i', f])
  const cadeia = partFiles.map((_, i) =>
    `[${i}:v:0]scale=1280:720:force_original_aspect_ratio=decrease,` +
    `pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}];` +
    `[${i}:a:0]aresample=48000[a${i}]`,
  ).join(';')
  const mapa = partFiles.map((_, i) => `[v${i}][a${i}]`).join('')
  const fc = `${cadeia};${mapa}concat=n=${partFiles.length}:v=1:a=1[v][a]`
  await execFileAsync(ff, ['-y', '-hide_banner', '-loglevel', 'error',
    ...inputs, '-filter_complex', fc, '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', outFile], BUF)
  return { metodo: 'filter', partes: partFiles.length, soma }
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

// ── detecção pro cortador de comerciais ────────────────────────────────────
// Ver docs/features/cortador-comerciais.md. O que estes helpers medem, o
// cortador.mjs funde. Regra da casa: aqui é só medição — nenhum julgamento.

/**
 * Trechos de silêncio. O sinal MAIS confiável pra achar limite entre anúncios.
 *
 * ⚠️ `noise` NÃO tem default de propósito: o valor certo depende do chiado do
 * arquivo e é MEDIDO pelo `achaThreshold()` do cortador.mjs. Medição real: num
 * arquivo com hiss a -34dB, -30dB acha os gaps com erro de ~15ms e -40dB acha
 * ZERO. Chutar o floor é o jeito nº 1 de essa feature não achar nada.
 */
export async function detectSilence(file, { noise, d = 0.3 } = {}) {
  if (typeof noise !== 'number') throw new Error('detectSilence: noise (dB) é obrigatório — meça com achaThreshold()')
  const { stderr } = await execFileAsync(FFMPEG(), [
    '-hide_banner', '-i', file,
    '-af', `silencedetect=n=${noise}dB:d=${d}`,
    '-vn', '-f', 'null', '-',
  ], BUF)
  const out = []
  // silence_end vem numa linha depois do start; parsear em pares mantém a
  // ordem sem depender de regex multi-linha frágil.
  const starts = [...stderr.matchAll(/silence_start:\s*([\d.-]+)/g)].map((m) => Number(m[1]))
  const ends = [...stderr.matchAll(/silence_end:\s*([\d.-]+)/g)].map((m) => Number(m[1]))
  for (let i = 0; i < starts.length; i++) {
    // silêncio que vai até o fim do arquivo não ganha silence_end
    if (ends[i] === undefined) continue
    out.push({ start: starts[i], end: ends[i] })
  }
  return out
}

/** Cortes SECOS (sem preto nem silêncio) — o sinal de reserva. */
export async function detectScene(file, { th = 0.4 } = {}) {
  const { stderr } = await execFileAsync(FFMPEG(), [
    '-hide_banner', '-i', file,
    '-vf', `select='gt(scene,${th})',metadata=print`,
    '-an', '-f', 'null', '-',
  ], BUF)
  return [...stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]))
}

/**
 * Extrai [start,end] pra um arquivo próprio.
 *
 * ⚠️ `-ss` DEPOIS do `-i` + re-encode: seek preciso, frame-accurate. Com
 * `-c copy` o corte gruda no keyframe e VAZA pedaço do anúncio vizinho — que é
 * exatamente o erro que a feature inteira existe pra não cometer. O pipeline
 * re-encoda cada trecho de novo mais tarde, então precisão > velocidade aqui.
 */
export async function extraiTrecho(file, start, end, outFile) {
  await execFileAsync(FFMPEG(), [
    '-hide_banner', '-y', '-i', file,
    '-ss', String(start), '-to', String(end),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'aac', '-b:a', '128k',
    outFile,
  ], BUF)
  return outFile
}

/** 1 frame em `t` (serve pro portão de borda e pro portão visual do Gemini). */
export async function frameEm(file, t, outFile, { largura = 320 } = {}) {
  await execFileAsync(FFMPEG(), [
    '-hide_banner', '-y', '-ss', String(t), '-i', file,
    '-frames:v', '1', '-vf', `scale=${largura}:-1`, outFile,
  ], BUF)
  return outFile
}

/**
 * Volume médio de um trecho, em dB. `-91` = silêncio digital.
 * (O portão de borda usa isto pra saber se o clipe COMEÇA no conteúdo.)
 */
export async function volumeMedio(file, start, dur) {
  const { stderr } = await execFileAsync(FFMPEG(), [
    '-hide_banner', '-ss', String(start), '-t', String(dur), '-i', file,
    '-af', 'volumedetect', '-vn', '-f', 'null', '-',
  ], BUF)
  const m = stderr.match(/mean_volume:\s*([\d.-]+) dB/)
  return m ? Number(m[1]) : -91
}
