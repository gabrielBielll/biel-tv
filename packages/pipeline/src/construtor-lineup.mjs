// Motor modular de montagem de vinhetas e comerciais de lineup em 3 janelas para Biel TV.
// Lê as configurações declarativas por canal (assets/comerciais/<canal>/lineup.config.json)
// e executa a renderização determinística em FFmpeg dentro do limite de 20s.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FFMPEG, FFPROBE } from './ffmpeg.mjs'

const execFileAsync = promisify(execFile)
const BUF = { maxBuffer: 64 * 1024 * 1024 }
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
let imageMagickBin = process.env.IMAGEMAGICK_BIN || null

async function runImageMagick(args) {
  if (imageMagickBin) return execFileAsync(imageMagickBin, args, BUF)
  try {
    const result = await execFileAsync('magick', args, BUF)
    imageMagickBin = 'magick'
    return result
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    imageMagickBin = 'convert'
    return execFileAsync(imageMagickBin, args, BUF)
  }
}

// Os configs apontam as fontes do sistema do Ubuntu (/usr/share/fonts/...),
// caminho que não existe no Termux — lá o ImageMagick recusa o overlay
// ("unable to read font"). Fora do Ubuntu, procura o MESMO arquivo, pelo nome,
// nas pastas de fonte locais. Sem alternativa, devolve o caminho original e o
// erro continua sendo o do ImageMagick, como antes.
const PASTAS_FONTE = [
  process.env.LINEUP_FONTS_DIR,
  process.env.HOME && join(process.env.HOME, '.fonts'),
  process.env.PREFIX && join(process.env.PREFIX, 'share/fonts/TTF'),
].filter(Boolean)

function resolveFonte(caminho) {
  if (!caminho || existsSync(caminho)) return caminho
  const alt = PASTAS_FONTE.map((dir) => join(dir, basename(caminho))).find((p) => existsSync(p))
  return alt ?? caminho
}

/**
 * Lê a configuração de lineup de um canal específico.
 * @param {string} canal - 'jetix' | 'disney_channel' | 'cartoon_network'
 */
export function carregarConfigCanal(canal) {
  const cfgPath = join(ROOT, 'assets/comerciais', canal, 'lineup.config.json')
  if (!existsSync(cfgPath)) {
    throw new Error(`Configuração de lineup não encontrada para o canal: ${canal} (${cfgPath})`)
  }
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  const tipografia = cfg.visual?.tipografia
  if (tipografia?.font_path) tipografia.font_path = resolveFonte(tipografia.font_path)
  return cfg
}

/**
 * Gera overlay PNG com a tipografia do canal.
 * @param {object} config - Configuração do canal
 * @param {string} destPng - Caminho do PNG transparente de saída
 * @param {string[]} [rotulosCustom] - Rótulos opcionais para sobrescrever ["A SEGUIR", "DEPOIS", "MAIS TARDE"]
 */
export async function gerarOverlayTipografia(config, destPng, rotulosCustom = []) {
  const tipo = config.visual.tipografia.tipo
  mkdirSync(dirname(destPng), { recursive: true })

  if (tipo === 'white_thick_text') {
    // Jetix: Letras brancas, bem grossas, contorno e sombra nítida diretamente sobre o fundo
    const t = config.visual.tipografia
    const p1 = t.posicoes[0]
    const p2 = t.posicoes[1]
    const p3 = t.posicoes[2]

    const txt1 = rotulosCustom[0] ?? p1.texto
    const txt2 = rotulosCustom[1] ?? p2.texto
    const txt3 = rotulosCustom[2] ?? p3.texto
    const alinhadoDireita = t.align === 'right' && Number.isFinite(Number(t.right_x))
    const gravidade = alinhadoDireita ? 'NorthEast' : 'Northwest'
    const geometria = (p, dx = 0, dy = 0) => alinhadoDireita
      ? `+${1280 - Number(t.right_x) - dx}+${p.y + dy}`
      : `+${p.x + dx}+${p.y + dy}`

    const args = [
      '-size', '1280x720', 'xc:none',
      '-font', t.font_path, '-pointsize', String(t.pointsize),
      '-gravity', gravidade,
      // Camada 1: Sombra suave deslocada
      '-stroke', t.shadow_color, '-strokewidth', String(t.shadow_stroke_width - 1), '-fill', t.shadow_color,
      '-annotate', geometria(p1, 3, 3), txt1,
      '-annotate', geometria(p2, 3, 3), txt2,
      '-annotate', geometria(p3, 3, 3), txt3,
      // Camada 2: Contorno 360 escuro
      '-stroke', t.shadow_color, '-strokewidth', String(t.shadow_stroke_width), '-fill', t.shadow_color,
      '-annotate', geometria(p1), txt1,
      '-annotate', geometria(p2), txt2,
      '-annotate', geometria(p3), txt3,
      // Camada 3: Letra branca pura reforçada (grossa)
      '-stroke', t.fill, '-strokewidth', String(t.stroke_width), '-fill', t.fill,
      '-annotate', geometria(p1), txt1,
      '-annotate', geometria(p2), txt2,
      '-annotate', geometria(p3), txt3,
      destPng,
    ]
    await runImageMagick(args)
    return destPng
  }

  if (tipo === 'neon_badges') {
    // Disney Channel: Badges arredondados em neon azul
    const t = config.visual.tipografia
    const p1 = t.posicoes[0]
    const p2 = t.posicoes[1]
    const p3 = t.posicoes[2]
    const txt1 = rotulosCustom[0] ?? p1.texto
    const txt2 = rotulosCustom[1] ?? p2.texto
    const txt3 = rotulosCustom[2] ?? p3.texto

    const badge1 = join(dirname(destPng), `_badge_1_${Date.now()}.png`)
    const badge2 = join(dirname(destPng), `_badge_2_${Date.now()}.png`)
    const badge3 = join(dirname(destPng), `_badge_3_${Date.now()}.png`)

    const makeBadge = async (txt, pos, out) => {
      const width = Number(pos.width ?? t.badge_w)
      const height = Number(pos.height ?? t.badge_h)
      const pointsize = Number(pos.pointsize ?? (txt.length > 17 ? t.long_pointsize ?? t.pointsize : t.pointsize))
      await runImageMagick([
        '-size', `${width}x${height}`, 'xc:none',
        '-fill', t.badge_bg,
        '-stroke', t.badge_border, '-strokewidth', String(t.badge_border_width),
        '-draw', `roundrectangle 1,1 ${width - 2},${height - 2} ${t.badge_radius},${t.badge_radius}`,
        '-fill', t.fill, '-stroke', 'none',
        '-font', t.font_path, '-pointsize', String(pointsize),
        '-gravity', 'center', '-annotate', '+0+0', txt,
        out,
      ])
    }

    await Promise.all([
      makeBadge(txt1, p1, badge1),
      makeBadge(txt2, p2, badge2),
      makeBadge(txt3, p3, badge3),
    ])

    await runImageMagick([
      '-size', '1280x720', 'xc:none',
      badge1, '-geometry', `+${p1.x}+${p1.y}`, '-composite',
      badge2, '-geometry', `+${p2.x}+${p2.y}`, '-composite',
      badge3, '-geometry', `+${p3.x}+${p3.y}`, '-composite',
      destPng,
    ])

    return destPng
  }

  if (tipo === 'horizontal_badges') {
    // Cartoon Network: barras pretas compactas, contorno branco e filete nas
    // cores do respectivo quadro. Mantém o texto fora das cenas.
    const t = config.visual.tipografia
    const badges = []
    for (let i = 0; i < t.posicoes.length; i++) {
      const p = t.posicoes[i]
      const txt = rotulosCustom[i] ?? p.texto
      const width = Number(p.width ?? t.badge_w ?? 295)
      const height = Number(p.height ?? t.badge_h ?? 38)
      const pointsize = txt.length > 17
        ? Number(t.long_pointsize ?? 16)
        : Number(t.pointsize ?? 20)
      const accent = (t.accent_colors ?? ['#12bce8', '#ffd900', '#12bce8'])[i] ?? '#12bce8'
      const badge = join(dirname(destPng), `_cn_badge_${i + 1}_${Date.now()}.png`)
      await runImageMagick([
        '-size', `${width}x${height}`, 'xc:none',
        '-fill', t.badge_bg ?? '#050505',
        '-stroke', t.badge_border ?? '#ffffff', '-strokewidth', String(t.badge_border_width ?? 2),
        '-draw', `rectangle 1,1 ${width - 2},${height - 2}`,
        '-fill', accent, '-stroke', 'none',
        '-draw', `rectangle 2,${height - 6} ${width - 3},${height - 3}`,
        '-fill', t.fill ?? '#ffffff', '-stroke', 'none',
        '-font', t.font_path, '-pointsize', String(pointsize),
        '-gravity', 'center', '-annotate', '+0-2', txt,
        badge,
      ])
      badges.push({ badge, p })
    }

    const args = ['-size', '1280x720', 'xc:none']
    for (const { badge, p } of badges) {
      args.push(badge, '-geometry', `+${p.x}+${p.y}`, '-composite')
    }
    args.push(destPng)
    await runImageMagick(args)
    return destPng
  }

  // Fallback padrão: badges horizontais simples
  await runImageMagick([
    '-size', '1280x720', 'xc:none',
    destPng,
  ])
  return destPng
}

/**
 * Monta um comercial de até 20s em 3 janelas.
 * 
 * @param {object} params
 * @param {string} params.canal - 'jetix' | 'disney_channel' | 'cartoon_network'
 * @param {string[]} params.videos - Array de 3 caminhos de vídeo para as janelas [v1, v2, v3]
 * @param {string} params.vozAudio - Caminho do arquivo de áudio da locução (wav/mp3)
 * @param {string} params.outFile - Caminho do MP4 de saída
 * @param {string[]} [params.rotulos] - Rótulos opcionais das 3 janelas
 * @param {string} [params.trilhaAudio] - Caminho opcional para sobrescrever a trilha padrão
 */
export async function montarLineup3Janelas({
  canal,
  videos,
  vozAudio,
  outFile,
  rotulos = [],
  trilhaAudio = null,
}) {
  if (!videos || videos.length < 3) {
    throw new Error(`Montagem de 3 janelas requer 3 vídeos (recebeu ${videos ? videos.length : 0})`)
  }
  if (!vozAudio || !existsSync(vozAudio)) {
    throw new Error(`Arquivo de voz da locução não encontrado: ${vozAudio}`)
  }

  const config = carregarConfigCanal(canal)
  const workDir = join(ROOT, 'scratch', `lineup_${canal}_${Date.now()}`)
  mkdirSync(workDir, { recursive: true })

  // 1. Gera o overlay de tipografia
  const overlayTipografia = join(workDir, 'tipografia_overlay.png')
  await gerarOverlayTipografia(config, overlayTipografia, rotulos)

  // 2. Prepara caminhos dos insumos
  const v0 = resolve(ROOT, videos[0])
  const v1 = resolve(ROOT, videos[1])
  const v2 = resolve(ROOT, videos[2])
  const molde = resolve(ROOT, config.visual.molde_path)
  const trilha = resolve(ROOT, trilhaAudio ?? config.audio.trilha_path)
  const voz = resolve(ROOT, vozAudio)
  const encerramento = config.visual.encerramento ?? null
  const encerramentoVideo = encerramento ? resolve(ROOT, encerramento.video_path) : null

  for (const file of [v0, v1, v2, molde, trilha, voz, encerramentoVideo].filter(Boolean)) {
    if (!existsSync(file)) throw new Error(`Insumo do lineup não encontrado: ${file}`)
  }

  const j0 = config.visual.janelas[0]
  const j1 = config.visual.janelas[1]
  const j2 = config.visual.janelas[2]

  const dur = config.visual.duracao_seg || 20.0
  if (!Number.isFinite(Number(dur)) || Number(dur) <= 0 || Number(dur) > 20) {
    throw new Error(`Duração do lineup fora do limite de 20s: ${dur}`)
  }
  const volVoz = config.audio.volume_voz || 1.8
  const volTrilha = config.audio.volume_trilha || 0.30
  const delayMs = config.audio.delay_voz_ms || 1000
  const fadeOutSt = Number(config.audio.fade_out_st ?? (dur - 1.0))
  const fadeOutD = Number(config.audio.fade_out_d ?? 1.0)
  const backgroundFadeFilter = fadeOutD > 0
    ? `,afade=t=out:st=${fadeOutSt}:d=${fadeOutD}`
    : ''
  const fimDur = encerramento ? Number(encerramento.duracao_seg) : 0
  const corpoDur = dur - fimDur
  const audioCrossfade = encerramento ? Number(encerramento.audio_crossfade_seg ?? 0.2) : 0

  if (encerramento && (!Number.isFinite(fimDur) || fimDur <= 0 || corpoDur <= 0)) {
    throw new Error(`Duração de encerramento inválida: ${encerramento.duracao_seg}`)
  }
  if (encerramento && (!Number.isFinite(audioCrossfade) || audioCrossfade < 0 || audioCrossfade >= fimDur)) {
    throw new Error(`Crossfade de áudio inválido: ${encerramento.audio_crossfade_seg}`)
  }
  if (!Number.isFinite(fadeOutSt) || !Number.isFinite(fadeOutD) || fadeOutSt < 0 || fadeOutD < 0 || fadeOutSt + fadeOutD > dur) {
    throw new Error(`Fade de áudio inválido: início ${config.audio.fade_out_st}, duração ${config.audio.fade_out_d}`)
  }

  // 3. Monta o filtro complexo do FFmpeg
  const filtrosBase = [
    `color=c=black:s=1280x720:d=${dur}:r=30[base]`,
    `[0:v]fps=30,scale=${j0.scale}:flags=lanczos,crop=${j0.crop}[v0]`,
    `[1:v]fps=30,scale=${j1.scale}:flags=lanczos,crop=${j1.crop}[v1]`,
    `[2:v]fps=30,scale=${j2.scale}:flags=lanczos,crop=${j2.crop}[v2]`,
    `[3:v]scale=1280:720:flags=lanczos,format=rgba,colorkey=${config.visual.colorkey}[tmpl]`,
    `[base][v0]overlay=${j0.overlay}[b1]`,
    `[b1][v1]overlay=${j1.overlay}[b2]`,
    `[b2][v2]overlay=${j2.overlay}[b3]`,
    `[b3][tmpl]overlay=0:0[b4]`,
    `[b4][4:v]overlay=0:0[layout]`,
  ]

  const filtrosSaida = encerramento ? [
    `[layout]trim=duration=${corpoDur},setpts=PTS-STARTPTS[corpo]`,
    `color=c=${encerramento.fundo ?? '#0b477f'}:s=1280x720:d=${fimDur}:r=30[fim_base]`,
    `[7:v]trim=start=${Number(encerramento.inicio_seg)}:end=${Number(encerramento.inicio_seg) + fimDur},setpts=PTS-STARTPTS,${encerramento.video_filter ?? 'scale=1280:850,crop=1280:720:0:40,setsar=1'},fps=30,format=rgba,chromakey=${encerramento.chromakey ?? '0x00ff00:0.12:0.01'},despill=type=green:mix=${Number(encerramento.despill_mix ?? 0.7)}[fim_fg]`,
    `[fim_base][fim_fg]overlay=0:0,fade=t=out:st=${Math.max(0, fimDur - 0.25)}:d=0.25[fim]`,
    `[corpo][fim]concat=n=2:v=1:a=0[vout]`,
    `[5:a]adelay=${delayMs}|${delayMs},volume=${volVoz},apad=whole_dur=${corpoDur},atrim=duration=${corpoDur}[a_voice]`,
    `[6:a]atrim=0:${corpoDur},apad=whole_dur=${corpoDur},atrim=duration=${corpoDur},volume=${volTrilha},afade=t=out:st=${corpoDur - audioCrossfade}:d=${audioCrossfade}[a_bg]`,
    `[a_bg][a_voice]amix=inputs=2:duration=first:dropout_transition=0[a_corpo]`,
    `[7:a]atrim=start=${Number(encerramento.inicio_seg) - audioCrossfade}:end=${Number(encerramento.inicio_seg) + fimDur},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${audioCrossfade},adelay=${Math.round((corpoDur - audioCrossfade) * 1000)}|${Math.round((corpoDur - audioCrossfade) * 1000)}[a_fim]`,
    `[a_corpo][a_fim]amix=inputs=2:duration=longest:normalize=0:dropout_transition=0,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[aout]`,
  ] : [
    `[layout]fade=t=out:st=${dur - 0.5}:d=0.5[vout]`,
    `[5:a]adelay=${delayMs}|${delayMs},volume=${volVoz}[a_voice]`,
    `[6:a]atrim=0:${dur},volume=${volTrilha}${backgroundFadeFilter}[a_bg]`,
    `[a_bg][a_voice]amix=inputs=2:duration=first:dropout_transition=2,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[aout]`,
  ]

  const filterComplex = [...filtrosBase, ...filtrosSaida].join(';\n')

  const ffmpegArgs = [
    '-y',
    '-stream_loop', '-1', '-ss', '3', '-t', String(dur), '-i', v0,
    '-stream_loop', '-1', '-ss', '3', '-t', String(dur), '-i', v1,
    '-stream_loop', '-1', '-ss', '5', '-t', String(dur), '-i', v2,
    '-i', molde,
    '-i', overlayTipografia,
    '-i', voz,
    ...(encerramento ? ['-i', trilha] : ['-stream_loop', '-1', '-i', trilha]),
    ...(encerramento ? ['-i', encerramentoVideo] : []),
    '-filter_complex', filterComplex,
    '-map', '[vout]',
    '-map', '[aout]',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-t', String(dur),
    outFile,
  ]

  await execFileAsync(FFMPEG(), ffmpegArgs, BUF)
  return { outFile, duracao: dur }
}
