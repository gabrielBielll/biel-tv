#!/usr/bin/env node
// CLI para montagem modular de lineups da Biel TV (20s)
// Uso:
//   node scripts/monta-lineup-cli.mjs --canal jetix --voz scratch/voz.mp3 --v0 p1.mp4 --v1 p2.mp4 --v2 p3.mp4 --out saida.mp4

import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { montarLineup3Janelas, carregarConfigCanal } from '../packages/pipeline/src/construtor-lineup.mjs'

function parseArgs() {
  const args = process.argv.slice(2)
  const map = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const k = args[i].slice(2)
      map[k] = args[i + 1]
      i++
    }
  }
  return map
}

async function main() {
  const params = parseArgs()
  const canal = params.canal || 'jetix'
  const out = params.out || `scratch/lineup_${canal}_${Date.now()}.mp4`

  console.log(`[monta-lineup-cli] Iniciando montagem para o canal: ${canal}`)

  const cfg = carregarConfigCanal(canal)
  console.log(`[monta-lineup-cli] Molde: ${cfg.visual.molde_path}`)
  console.log(`[monta-lineup-cli] Narrador: ${cfg.narrador.nome} (${cfg.narrador.voz_id})`)

  let videos = []
  if (params.v0 && params.v1 && params.v2) {
    videos = [params.v0, params.v1, params.v2]
  } else {
    // Fallback padrão se não passar vídeos explícitos
    if (canal === 'jetix') {
      videos = [
        'scratch/comercial-pucca.mp4',
        'assets/comerciais/jetix/amostras/Padrinho Mágicos Remix - com audio de Os padrinhos mágicos abertura.mp4',
        'assets/comerciais/jetix/amostras/POWER RANGERS FORÇA ANIMAL ABERTURA (Traduzida) [41t36-S98aY] - 16x9 com audio.mp4',
      ]
    } else if (canal === 'disney_channel') {
      videos = [
        'scratch/comercial-feiticeiros.mp4',
        'scratch/comercial-raven.mp4',
        'comerciais_16x9/brandy_e_sr_bigodes/01_a_maldicao_do_vampiro.mp4',
      ]
    } else {
      videos = [
        'comerciais_16x9/cartoon_network_colecao_2001_2005/19_comercial_referencia_cn_chamada_billy_e_mandy.mp4',
        'comerciais_16x9/cartoon_network_colecao_2001_2005/11_comercial_referencia_cn_chamada_cartoon_cartoons_dexter.mp4',
        'comerciais_16x9/cartoon_network_colecao_2001_2005/12_comercial_referencia_cn_chamada_meninas_superpoderosas.mp4',
      ]
    }
  }

  const voz = params.voz || cfg.narrador.reference_audio_path || (
    canal === 'disney_channel' ? 'scratch/disney_hyped_camilla.mp3' :
    'scratch/cartoon_hyped_larissa.mp3'
  )

  console.log(`[monta-lineup-cli] Voz: ${voz}`)
  console.log(`[monta-lineup-cli] Janelas: \n  1: ${videos[0]}\n  2: ${videos[1]}\n  3: ${videos[2]}`)

  const result = await montarLineup3Janelas({
    canal,
    videos,
    vozAudio: voz,
    outFile: out,
  })

  console.log(`[monta-lineup-cli] ✅ Vídeo gerado com sucesso (${result.duracao}s): ${result.outFile}`)
}

main().catch((err) => {
  // ffmpeg MORTO por sinal (no celular, o Android mata o processo que mais usa
  // memória quando falta RAM) sai sem mensagem de erro nenhuma: sem mostrar o
  // sinal, o log só mostra o começo do ffmpeg e parece bug do filtro.
  if (err.signal || err.killed) console.error(`[monta-lineup-cli] ❌ ffmpeg morto por sinal ${err.signal ?? '?'}`)
  console.error(`[monta-lineup-cli] ❌ Erro:`, err.message)
  process.exit(1)
})
