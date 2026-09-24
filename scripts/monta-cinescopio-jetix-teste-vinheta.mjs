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
const TESTE = MANIFEST.teste_nova_vinheta_20260923

function caminho(relativo) {
  return resolve(ROOT, relativo)
}

async function renderizar(peca, outDir) {
  const aproximacao = caminho(TESTE.fonte_aproximacao.path)
  const vinheta = caminho(TESTE.vinheta_jetix.path)
  const referenciaAudio = caminho(MANIFEST.referencia_audio.path)
  const out = join(outDir, peca.arquivo)
  const duracaoAproximacao = TESTE.fonte_aproximacao.fim_seg - TESTE.fonte_aproximacao.inicio_seg
  const duracaoVinheta = Number(TESTE.vinheta_jetix.duracao_seg)
  const duracaoTotal = Number(TESTE.duracao_saida_seg)
  const holdVinheta = duracaoTotal - duracaoAproximacao - duracaoVinheta

  if (holdVinheta < 0) {
    throw new Error('a aproximação e a vinheta ultrapassam a duração total')
  }

  const filtros = [
    `[0:v]trim=start=${TESTE.fonte_aproximacao.inicio_seg}:end=${TESTE.fonte_aproximacao.fim_seg},setpts=PTS-STARTPTS,scale=1280:720:flags=lanczos,setsar=1,fps=30,format=yuv420p[aproximacao]`,
    `[1:v]trim=duration=${duracaoVinheta},setpts=PTS-STARTPTS,scale=1280:850:flags=lanczos,crop=1280:720:0:40,setsar=1,fps=30,format=yuv420p,tpad=stop_mode=clone:stop_duration=${holdVinheta},trim=duration=${duracaoVinheta + holdVinheta}[vinheta]`,
    `[aproximacao][vinheta]concat=n=2:v=1:a=0,trim=duration=${duracaoTotal}[vout]`,
    `[2:a]atrim=start=${peca.audio_inicio_seg}:end=${peca.audio_fim_seg},asetpts=PTS-STARTPTS,aresample=48000,loudnorm=I=-16:TP=-1.5:LRA=9,volume=-1dB,alimiter=limit=0.95,apad=whole_dur=${duracaoTotal},atrim=duration=${duracaoTotal}[aout]`,
  ].join(';')

  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', aproximacao,
    '-i', vinheta,
    '-i', referenciaAudio,
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
    throw new Error(`vídeo fora do padrão em ${out}`)
  }
  if (!audio || audio.codec_name !== 'aac' || Number(audio.sample_rate) !== 48000 || audio.channels !== 2) {
    throw new Error(`áudio fora do padrão em ${out}`)
  }
  if (Math.abs(duracao - duracaoTotal) > 0.03) {
    throw new Error(`duração inesperada em ${out}: ${duracao.toFixed(3)} s`)
  }

  return { tipo: peca.tipo, arquivo: out, duracao }
}

async function main() {
  const outDir = join(ROOT, 'videos_prontos/cinescopio_jetix')
  const fontes = [
    caminho(TESTE.fonte_aproximacao.path),
    caminho(TESTE.vinheta_jetix.path),
    caminho(MANIFEST.referencia_audio.path),
  ]

  for (const fonte of fontes) {
    if (!existsSync(fonte)) throw new Error(`arquivo não encontrado: ${fonte}`)
  }
  mkdirSync(outDir, { recursive: true })

  const resultados = []
  for (const peca of TESTE.pecas) resultados.push(await renderizar(peca, outDir))
  console.log(JSON.stringify({ status: TESTE.status, resultados }, null, 2))
}

main().catch((error) => {
  console.error(`[monta-cinescopio-jetix-teste-vinheta] ${error.message}`)
  process.exit(1)
})
