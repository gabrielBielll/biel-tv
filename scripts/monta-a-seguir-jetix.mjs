#!/usr/bin/env node
// Monta chamadas curtas da Jetix (10 s): "a seguir", "você está assistindo"
// e "estamos de volta". O áudio e a animação vêm do template chroma; a nova
// locução deve terminar antes da assinatura final do canal.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUF = { maxBuffer: 64 * 1024 * 1024 }
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'assets/comerciais/jetix/lineup.config.json'), 'utf8'))
const FONTE = join(ROOT, 'packages/pipeline/assets/LiberationSansNarrow-Bold.ttf')

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    args[argv[i].slice(2)] = argv[i + 1]
    i++
  }
  return args
}

async function duracao(file) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file,
  ], BUF)
  return Number(stdout.trim())
}

function caminho(raw) {
  return resolve(ROOT, raw)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.video || !args.voz || !args.titulo || !args.out) {
    throw new Error('uso: node scripts/monta-a-seguir-jetix.mjs --video <mp4> --voz <mp3> --titulo <texto> --out <mp4> [--tipo <a_seguir_curto|voce_esta_assistindo|estamos_de_volta>] [--inicio <seg>]')
  }

  const tipo = args.tipo ?? 'a_seguir_curto'
  const variante = CONFIG.audio.variantes[tipo]
  if (!variante) throw new Error(`tipo desconhecido: ${tipo}`)
  const video = caminho(args.video)
  const voz = caminho(args.voz)
  const out = caminho(args.out)
  const template = join(ROOT, variante.template_video_path)
  const inicio = Number(args.inicio ?? 0)
  for (const file of [video, voz, template, FONTE]) {
    if (!existsSync(file)) throw new Error(`arquivo não encontrado: ${file}`)
  }
  if (!Number.isFinite(inicio) || inicio < 0) throw new Error('--inicio deve ser um número >= 0')

  const durVoz = await duracao(voz)
  const atraso = variante.delay_voz_ms / 1000
  const limiteVoz = variante.locucao_termina_ate_seg - atraso
  if (durVoz > limiteVoz + 0.01) {
    throw new Error(`locução longa demais: ${durVoz.toFixed(2)} s; máximo ${limiteVoz.toFixed(2)} s para não cobrir a assinatura Jetix`)
  }

  const workdir = join(ROOT, 'scratch', `a-seguir-jetix-${Date.now()}`)
  mkdirSync(workdir, { recursive: true })
  mkdirSync(dirname(out), { recursive: true })
  const overlay = join(workdir, 'texto.png')
  const rotulo = variante.rotulo ?? 'A SEGUIR'
  const rotuloSize = rotulo.length > 15 ? 42 : 48

  await execFileAsync('magick', [
    '-size', '1280x720', 'xc:none',
    '-font', FONTE, '-gravity', 'Northwest',
    '-fill', 'rgba(7,21,43,0.95)', '-stroke', 'rgba(7,21,43,0.95)', '-strokewidth', '6',
    '-pointsize', '52', '-annotate', '+51+502', args.titulo.toUpperCase(),
    '-fill', 'white', '-stroke', '#193861', '-strokewidth', '2',
    '-annotate', '+48+499', args.titulo.toUpperCase(),
    '-fill', 'rgba(53,3,16,0.95)', '-stroke', 'rgba(53,3,16,0.95)', '-strokewidth', '6',
    '-pointsize', String(rotuloSize), '-annotate', '+51+573', rotulo,
    '-fill', '#e53b43', '-stroke', '#7a0b24', '-strokewidth', '2',
    '-annotate', '+48+570', rotulo,
    overlay,
  ], BUF)

  const total = Number(variante.duracao_saida_seg)
  const delayMs = Number(variante.delay_voz_ms)
  const templateInicio = Number(variante.template_inicio_seg)
  const templateFim = Number(variante.template_fim_seg)
  const templateDur = templateFim - templateInicio
  const videoSpeed = total / templateDur
  const audioTempo = templateDur / total
  const outputGainDb = Number(variante.output_gain_db ?? 0)
  const filter = [
    `[0:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1,fps=30,trim=duration=${total},setpts=PTS-STARTPTS[show]`,
    `[1:v]trim=start=${templateInicio}:end=${templateFim},setpts=(PTS-STARTPTS)*${videoSpeed.toFixed(10)},scale=1280:850,crop=1280:720:0:40,setsar=1,fps=30,format=rgba,chromakey=0x00ff00:0.12:0.01,despill=type=green:mix=0.7[tmpl]`,
    '[2:v]format=rgba,fade=t=in:st=0.8:d=0.2:alpha=1,fade=t=out:st=6.7:d=0.25:alpha=1[txt]',
    '[show][tmpl]overlay=0:0[v1]',
    `[v1][txt]overlay=0:0,fade=t=out:st=${(total - 0.3).toFixed(1)}:d=0.3[vout]`,
    `[3:a]loudnorm=I=-16:TP=-3:LRA=11,aresample=48000,adelay=${delayMs}:all=1,volume=0.95,apad=whole_dur=${total},atrim=duration=${total}[voice]`,
    `[1:a]atrim=start=${templateInicio}:end=${templateFim},asetpts=PTS-STARTPTS,atempo=${audioTempo.toFixed(6)},aresample=48000,volume=0.70,apad=whole_dur=${total},atrim=duration=${total}[bed]`,
    `[bed][voice]amix=inputs=2:duration=longest:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11,volume=${outputGainDb}dB,alimiter=limit=0.95,atrim=duration=${total}[aout]`,
  ].join(';')

  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-stream_loop', '-1', '-ss', String(inicio), '-i', video,
    '-i', template,
    '-loop', '1', '-i', overlay,
    '-i', voz,
    '-filter_complex', filter,
    '-map', '[vout]', '-map', '[aout]', '-t', String(total),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart',
    out,
  ], BUF)

  console.log(JSON.stringify({
    out,
    duracao: total,
    locucao: durVoz,
    tipo,
    rotulo,
    assinatura: variante.assinatura_embutida,
    template: variante.template_video_path,
    audio: variante.audio_source,
  }, null, 2))
}

main().catch((err) => {
  console.error(`[monta-a-seguir-jetix] ${err.message}`)
  process.exit(1)
})
