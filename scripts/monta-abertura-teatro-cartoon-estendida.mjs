#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUF = { maxBuffer: 64 * 1024 * 1024 }
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'assets/comerciais/cartoon_network/teatro/manifesto.json'), 'utf8'))
const VERSAO = MANIFEST.versao_estendida

function fonte(nome) {
  return resolve(ROOT, MANIFEST.fontes[nome].path)
}

function velocidade(take) {
  return take.duracao / (take.fim - take.inicio)
}

async function main() {
  const fachadaHolofotes = fonte('fachada_holofotes')
  const fachadaSaguao = fonte('fachada_saguao')
  const travessiaAuditorio = fonte('travessia_auditorio')
  const bilheteria = resolve(ROOT, MANIFEST.referencia_bilheteria.path)
  const font = resolve(ROOT, MANIFEST.font_path)
  const outDir = join(ROOT, 'videos_prontos/cartoon_network/teatro')
  const out = join(outDir, VERSAO.arquivo)
  const workDir = join(ROOT, 'scratch', `teatro-cartoon-estendido-${Date.now()}`)
  const tituloOverlay = join(workDir, 'titulo-teatro-cartoon.png')
  const takes = VERSAO.montagem
  const transicao = Number(VERSAO.crossfade_seg)
  const duracaoTotal = Number(VERSAO.duracao_saida_seg)

  for (const arquivo of [fachadaHolofotes, fachadaSaguao, travessiaAuditorio, bilheteria, font]) {
    if (!existsSync(arquivo)) throw new Error(`arquivo não encontrado: ${arquivo}`)
  }
  mkdirSync(outDir, { recursive: true })
  mkdirSync(workDir, { recursive: true })

  await execFileAsync('magick', [
    '-size', '1280x720', 'xc:none',
    '-font', font,
    '-gravity', 'North',
    '-fill', 'black', '-pointsize', '44', '-annotate', '+0+232', 'TEATRO',
    '-gravity', 'NorthWest', '-fill', 'rgba(0,0,0,0.96)', '-draw', 'rectangle 485,290 795,366',
    '-gravity', 'North', '-fill', 'white', '-pointsize', '54', '-annotate', '+0+289', 'CARTOON',
    '-gravity', 'NorthWest', '-fill', '#60e5c2', '-draw', 'rectangle 500,369 780,374',
    tituloOverlay,
  ], BUF)

  const filtros = [
    `[0:v]trim=start=${takes[0].inicio}:end=${takes[0].fim},setpts=(PTS-STARTPTS)*${velocidade(takes[0]).toFixed(10)},scale=1280:720:flags=lanczos,setsar=1,fps=30,format=yuv420p[v0]`,
    `[1:v]trim=start=${takes[1].inicio}:end=${takes[1].fim},setpts=(PTS-STARTPTS)*${velocidade(takes[1]).toFixed(10)},scale=1280:720:flags=lanczos,setsar=1,fps=30,format=yuv420p[v1]`,
    `[3:v]trim=start=${takes[2].inicio}:end=${takes[2].fim},setpts=(PTS-STARTPTS)*${velocidade(takes[2]).toFixed(10)},scale=1280:850:flags=lanczos,crop=1280:720:0:40,setsar=1,fps=30,format=yuv420p[v2]`,
    `[1:v]trim=start=${takes[3].inicio}:end=${takes[3].fim},setpts=(PTS-STARTPTS)*${velocidade(takes[3]).toFixed(10)},scale=1280:720:flags=lanczos,setsar=1,fps=30,format=yuv420p[v3]`,
    `[3:v]trim=start=${takes[4].inicio}:end=${takes[4].fim},setpts=(PTS-STARTPTS)*${velocidade(takes[4]).toFixed(10)},scale=1280:850:flags=lanczos,crop=1280:720:0:40,setsar=1,fps=30,format=yuv420p[v4]`,
    `[2:v]trim=start=${takes[5].inicio}:end=${takes[5].fim},setpts=(PTS-STARTPTS)*${velocidade(takes[5]).toFixed(10)},scale=1280:720:flags=lanczos,setsar=1,fps=30,format=yuv420p[v5base]`,
    `[4:v]format=rgba,fade=t=in:st=0.60:d=0.40:alpha=1[titulo]`,
    `[v5base][titulo]overlay=0:0:shortest=1[v5]`,
    `[v0][v1]xfade=transition=fade:duration=${transicao}:offset=3.20[x1]`,
    `[x1][v2]xfade=transition=fade:duration=${transicao}:offset=6.80[x2]`,
    `[x2][v3]xfade=transition=fade:duration=${transicao}:offset=10.10[x3]`,
    `[x3][v4]xfade=transition=fade:duration=${transicao}:offset=13.50[x4]`,
    `[x4][v5]xfade=transition=fade:duration=${transicao}:offset=17.00,trim=duration=${duracaoTotal},format=yuv420p[vout]`,
    `[3:a]atrim=duration=10,asetpts=PTS-STARTPTS,asplit=2[a0][a1]`,
    `[a0][a1]acrossfade=d=0.25:c1=tri:c2=tri,atempo=0.9875,aresample=48000,loudnorm=I=-16:TP=-1.5:LRA=9,alimiter=limit=0.95,apad=whole_dur=${duracaoTotal},atrim=duration=${duracaoTotal}[aout]`,
  ].join(';')

  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', fachadaHolofotes,
    '-i', fachadaSaguao,
    '-i', travessiaAuditorio,
    '-i', bilheteria,
    '-loop', '1', '-i', tituloOverlay,
    '-filter_complex', filtros,
    '-map', '[vout]', '-map', '[aout]', '-t', String(duracaoTotal),
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
  const video = probe.streams.find((stream) => stream.codec_type === 'video')
  const audio = probe.streams.find((stream) => stream.codec_type === 'audio')
  const duracao = Number(probe.format.duration)

  if (!video || video.codec_name !== 'h264' || video.width !== 1280 || video.height !== 720 || video.pix_fmt !== 'yuv420p') {
    throw new Error('vídeo de saída fora do padrão')
  }
  if (!audio || audio.codec_name !== 'aac' || Number(audio.sample_rate) !== 48000 || audio.channels !== 2) {
    throw new Error('áudio de saída fora do padrão')
  }
  if (Math.abs(duracao - duracaoTotal) > 0.03) {
    throw new Error(`duração inesperada: ${duracao.toFixed(3)} s`)
  }

  console.log(JSON.stringify({ status: MANIFEST.status, arquivo: out, duracao }, null, 2))
}

main().catch((error) => {
  console.error(`[monta-abertura-teatro-cartoon-estendida] ${error.message}`)
  process.exit(1)
})
