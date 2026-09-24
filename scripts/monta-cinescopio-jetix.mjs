#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUF = { maxBuffer: 64 * 1024 * 1024 }
const MANIFEST_PATH = join(ROOT, 'assets/comerciais/jetix/cinescopio/manifesto.json')
const MANIFEST = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    args[argv[i].slice(2)] = argv[i + 1]
    i++
  }
  return args
}

function caminho(relativo) {
  return resolve(ROOT, relativo)
}

async function renderizar(peca, outDir) {
  const visual = caminho(MANIFEST.fonte_visual.path)
  const template = caminho(MANIFEST.template_mascote.path)
  const audio = caminho(MANIFEST.referencia_audio.path)
  const out = join(outDir, peca.arquivo)
  const edicao = MANIFEST.edicao
  const duracao = Number(edicao.duracao_seg)
  const duracaoCine = Number(edicao.duracao_cinescopio_seg)
  const duracaoMascote = Number(edicao.duracao_mascote_seg)
  const velocidadeCine = duracaoCine / Number(MANIFEST.fonte_visual.duracao_seg)
  const mascoteInicio = Number(MANIFEST.template_mascote.inicio_seg)
  const mascoteFim = Number(MANIFEST.template_mascote.fim_seg)
  const mascoteFonteDuracao = mascoteFim - mascoteInicio
  const holdMascote = duracaoMascote - mascoteFonteDuracao
  const portalFrame = Number(edicao.portal_frame_seg)
  const fundo = `0x${edicao.fundo_chroma}`

  if (edicao.transicao !== 'corte_seco') {
    throw new Error(`transição não suportada: ${edicao.transicao}`)
  }
  if (holdMascote < 0) {
    throw new Error('a duração do mascote não pode acelerar ou comprimir a animação Jetix')
  }

  const filtros = [
    `color=c=${fundo}:s=1280x720:d=${duracaoCine}:r=30[portal_bg]`,
    `[1:v]trim=start=${portalFrame}:end=${portalFrame + 0.04},setpts=PTS-STARTPTS,scale=1280:850:flags=lanczos,crop=1280:720:0:40,setsar=1,fps=30,format=rgba,chromakey=0x00ff00:0.12:0.01,despill=type=green:mix=0.7[portal_fg]`,
    `[portal_bg][portal_fg]overlay=0:0:eof_action=repeat,format=yuv420p[portal]`,
    `[0:v]trim=duration=${MANIFEST.fonte_visual.duracao_seg},setpts=(PTS-STARTPTS)*${velocidadeCine.toFixed(10)},scale=1280:720:flags=lanczos,setsar=1,fps=30,format=rgba,chromakey=0x00ff00:0.15:0.04,despill=type=green:mix=0.75[cine_fg]`,
    `[portal][cine_fg]overlay=0:0:shortest=1,format=yuv420p[cine]`,
    `color=c=${fundo}:s=1280x720:d=${mascoteFonteDuracao}:r=30[mascote_bg]`,
    `[1:v]trim=start=${mascoteInicio}:end=${mascoteFim},setpts=PTS-STARTPTS,scale=1280:850:flags=lanczos,crop=1280:720:0:40,setsar=1,fps=30,format=rgba,chromakey=0x00ff00:0.12:0.01,despill=type=green:mix=0.7[mascote_fg]`,
    `[mascote_bg][mascote_fg]overlay=0:0:shortest=1,format=yuv420p,tpad=stop_mode=clone:stop_duration=${holdMascote},trim=duration=${duracaoMascote}[mascote]`,
    `[cine][mascote]concat=n=2:v=1:a=0,trim=duration=${duracao},format=yuv420p[vout]`,
    `[2:a]atrim=start=${peca.audio_inicio_seg}:end=${peca.audio_fim_seg},asetpts=PTS-STARTPTS,loudnorm=I=-16:TP=-2:LRA=7,aresample=48000,apad=whole_dur=${duracao},atrim=duration=${duracao}[aout]`,
  ].join(';')

  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', visual,
    '-i', template,
    '-i', audio,
    '-filter_complex', filtros,
    '-map', '[vout]', '-map', '[aout]', '-t', String(duracao),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart',
    out,
  ], BUF)

  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,pix_fmt,sample_rate,channels',
    '-of', 'json', out,
  ], BUF)
  const probe = JSON.parse(stdout)
  const videoStream = probe.streams.find((stream) => stream.codec_type === 'video')
  const audioStream = probe.streams.find((stream) => stream.codec_type === 'audio')
  const duracaoReal = Number(probe.format.duration)

  if (
    !videoStream || videoStream.codec_name !== 'h264' || videoStream.width !== 1280 ||
    videoStream.height !== 720 || videoStream.pix_fmt !== 'yuv420p'
  ) {
    throw new Error(`vídeo fora do padrão em ${out}`)
  }
  if (
    !audioStream || audioStream.codec_name !== 'aac' ||
    Number(audioStream.sample_rate) !== 48000 || audioStream.channels !== 2
  ) {
    throw new Error(`áudio fora do padrão em ${out}`)
  }
  if (Math.abs(duracaoReal - duracao) > 0.03) {
    throw new Error(`duração inesperada em ${out}: ${duracaoReal.toFixed(3)} s`)
  }

  return {
    tipo: peca.tipo,
    arquivo: out,
    duracao: duracaoReal,
    audio: `${peca.audio_inicio_seg}-${peca.audio_fim_seg} s`,
    video: `${videoStream.codec_name} ${videoStream.width}x${videoStream.height} ${videoStream.pix_fmt}`,
    som: `${audioStream.codec_name} ${audioStream.sample_rate} Hz ${audioStream.channels} canais`,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const outDir = resolve(ROOT, args['out-dir'] ?? 'videos_prontos/cinescopio_jetix')
  const fontes = [
    caminho(MANIFEST.fonte_visual.path),
    caminho(MANIFEST.template_mascote.path),
    caminho(MANIFEST.referencia_audio.path),
  ]

  for (const fonte of fontes) {
    if (!existsSync(fonte)) throw new Error(`arquivo não encontrado: ${fonte}`)
  }
  mkdirSync(outDir, { recursive: true })

  const resultados = []
  for (const peca of MANIFEST.pecas) {
    resultados.push(await renderizar(peca, outDir))
  }

  console.log(JSON.stringify({
    status: MANIFEST.status,
    manifesto: MANIFEST_PATH,
    publicacao_automatica: MANIFEST.publicacao_automatica,
    resultados,
  }, null, 2))
}

main().catch((error) => {
  console.error(`[monta-cinescopio-jetix] ${error.message}`)
  process.exit(1)
})
