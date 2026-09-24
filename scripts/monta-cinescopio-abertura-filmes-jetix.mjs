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
const ABERTURA = MANIFEST.abertura_filmes_20260923

async function main() {
  const fonte = resolve(ROOT, ABERTURA.fonte.path)
  const outDir = join(ROOT, 'videos_prontos/cinescopio_jetix')
  const out = join(outDir, ABERTURA.arquivo)
  const velocidade = Number(ABERTURA.velocidade)
  const duracao = Number(ABERTURA.duracao_saida_seg)

  if (!existsSync(fonte)) throw new Error(`arquivo não encontrado: ${fonte}`)
  if (velocidade !== 2) throw new Error('esta montagem foi validada para velocidade 2×')
  mkdirSync(outDir, { recursive: true })

  const filtros = [
    `[0:v]trim=duration=${ABERTURA.fonte.duracao_seg},setpts=(PTS-STARTPTS)/${velocidade},scale=1280:720:flags=lanczos,setsar=1,fps=30,format=yuv420p[vout]`,
    `[0:a]atrim=duration=${ABERTURA.fonte.duracao_seg},asetpts=PTS-STARTPTS,atempo=${velocidade},aresample=48000,loudnorm=I=-16:TP=-1.5:LRA=9,volume=-1.2dB,alimiter=limit=0.95,apad=whole_dur=${duracao},atrim=duration=${duracao}[aout]`,
  ].join(';')

  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', fonte,
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
  const video = probe.streams.find((stream) => stream.codec_type === 'video')
  const audio = probe.streams.find((stream) => stream.codec_type === 'audio')
  const duracaoReal = Number(probe.format.duration)

  if (!video || video.codec_name !== 'h264' || video.width !== 1280 || video.height !== 720 || video.pix_fmt !== 'yuv420p') {
    throw new Error('vídeo de saída fora do padrão')
  }
  if (!audio || audio.codec_name !== 'aac' || Number(audio.sample_rate) !== 48000 || audio.channels !== 2) {
    throw new Error('áudio de saída fora do padrão')
  }
  if (Math.abs(duracaoReal - duracao) > 0.03) {
    throw new Error(`duração inesperada: ${duracaoReal.toFixed(3)} s`)
  }

  console.log(JSON.stringify({
    status: ABERTURA.status,
    arquivo: out,
    velocidade,
    duracao: duracaoReal,
    publicacao_automatica: ABERTURA.publicacao_automatica,
  }, null, 2))
}

main().catch((error) => {
  console.error(`[monta-cinescopio-abertura-filmes-jetix] ${error.message}`)
  process.exit(1)
})
