#!/usr/bin/env node
// Gera vozes via ElevenLabs para os programas do catálogo e sobe para o Cloudflare R2 e D1.
// Mantém dedup por hash (sha256) idêntico à implementação do Worker (apps/stream/src/tts.ts),
// garantindo que nunca consome créditos repetidos para o mesmo texto e voz.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { AwsClient } from '../packages/pipeline/node_modules/aws4fetch/dist/aws4fetch.esm.mjs'

const execFileAsync = promisify(execFile)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// 1. Carrega chave ElevenLabs
function getElevenLabsKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY.trim()
  const p = join(process.env.HOME || '', '.claude/projects/-home-gabriel-Documents-projects-biel-tv/secrets/elevenlabs-api-key')
  if (existsSync(p)) return readFileSync(p, 'utf8').trim()
  throw new Error('Chave da ElevenLabs não encontrada (ELEVENLABS_API_KEY ou secrets)')
}

// 2. Cliente S3 para R2
function getR2Client() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET = 'biel-tv-media' } = process.env
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error('Credenciais R2 ausentes (exporte via .envrc: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)')
  }
  const aws = new AwsClient({ accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY })
  const endpoint = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}`
  return { aws, endpoint }
}

// 3. Hash determinístico R2 (idêntico a apps/stream/src/tts.ts)
function ttsKey(vozId, texto, config) {
  const c = { model_id: 'eleven_multilingual_v2', ...config }
  const payload = JSON.stringify([vozId, texto.trim(), c])
  const hash = createHash('sha256').update(payload).digest('hex')
  return `fabrica/tts/${vozId}/${hash}.mp3`
}

// 4. Mede duração de áudio usando ffprobe
async function medirDuracao(mp3Buffer) {
  const tmp = join(ROOT, 'scratch', `probe_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`)
  mkdirSync(dirname(tmp), { recursive: true })
  writeFileSync(tmp, mp3Buffer)
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', tmp,
    ])
    return Number(stdout.trim()) || 1.5
  } catch {
    return 1.5
  }
}

// 5. Chamada ElevenLabs TTS
async function sintetizaEleven(apiKey, vozId, texto, config) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(vozId)}?output_format=mp3_44100_128`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      text: texto,
      model_id: config.model_id || 'eleven_multilingual_v2',
      voice_settings: {
        stability: config.stability ?? 0.25,
        similarity_boost: config.similarity_boost ?? 0.85,
        ...(config.style != null ? { style: config.style } : {}),
        ...(config.speed != null ? { speed: config.speed } : {}),
        use_speaker_boost: config.use_speaker_boost ?? true,
      },
    }),
  })
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`ElevenLabs HTTP ${res.status}: ${err}`)
  }
  const ab = await res.arrayBuffer()
  return Buffer.from(ab)
}

// 6. Catálogo de Séries e Conectores por Canal
const CANAIS_VOZES = {
  jetix: {
    nome: 'Jetix',
    voz_id: 'TX3LPaxmHKxFdv7VOQHJ', // Liam provisório aprovado em 2026-09-22
    config: {
      model_id: 'eleven_v3',
      stability: 0.0,
      similarity_boost: 0.75,
      speed: 1.15,
      use_speaker_boost: true,
    },
    itens: [
      { categoria: 'nome', series_id: 'pucca', rotulo: 'Pucca', tts: 'Pucca!' },
      { categoria: 'nome', series_id: 'padrinhos_magicos', rotulo: 'Os Padrinhos Mágicos', tts: 'Os Padrinhos Mágicos!' },
      { categoria: 'nome', series_id: 'power_rangers_forca_animal', rotulo: 'Power Rangers Força Animal', tts: 'Power Rangers Força Animal!' },
      { categoria: 'nome', series_id: 'power_rangers_ultravelocidade', rotulo: 'Power Rangers Operação Ultraveloz', tts: 'Power Rangers Operação Ultraveloz!' },
      { categoria: 'nome', series_id: 'power_rangers_rpm', rotulo: 'Power Rangers RPM', tts: 'Power Rangers RPM!' },
      { categoria: 'nome', series_id: 'power_rangers_furia_da_selva', rotulo: 'Power Rangers Fúria da Selva', tts: 'Power Rangers Fúria da Selva!' },
      { categoria: 'nome', series_id: 'super_esquadrao_dos_macacos', rotulo: 'Super Esquadrão dos Macacos', tts: 'Super Esquadrão dos Macacos!' },
      { categoria: 'nome', series_id: 'yin_yang_yo', rotulo: 'Yin Yang Yo!', tts: 'Yin Yang Yo!' },
      { categoria: 'nome', series_id: 'tres_espias_demais', rotulo: 'Três Espiãs Demais', tts: 'Três Espiãs Demais!' },
      { categoria: 'nome', series_id: 'kid_vs_kat', rotulo: 'Kid vs. Kat', tts: 'Kid vs. Kat!' },
      { categoria: 'nome', series_id: 'zatch_bell', rotulo: 'Zatch Bell', tts: 'Zatch Bell!' },
      { categoria: 'nome', series_id: 'megas_xlr', rotulo: 'Megas XLR', tts: 'Megas XLR!' },
      { categoria: 'nome', series_id: 'witch', rotulo: 'W.I.T.C.H.', tts: 'W.I.T.C.H.!' },
      { categoria: 'conector', chave: 'encerramento', rotulo: 'só na Jetix!', tts: 'só na Jetix!' },
      { categoria: 'conector', chave: 'a_seguir', rotulo: 'a seguir', tts: 'A seguir!' },
      { categoria: 'conector', chave: 'depois', rotulo: 'e depois', tts: 'E depois!' },
      { categoria: 'conector', chave: 'mais_tarde', rotulo: 'mais tarde', tts: 'Mais tarde!' },
    ],
  },
  disney_channel: {
    nome: 'Disney Channel',
    voz_id: 'NNbmtunmMPGBeyrKu6KD', // Will — SP Capital, reserva aprovada enquanto a oficial está pausada
    config: {
      model_id: 'eleven_multilingual_v2',
      stability: 0.38,
      similarity_boost: 0.80,
      style: 0.50,
      speed: 1.08,
      use_speaker_boost: true,
    },
    itens: [
      { categoria: 'nome', series_id: 'os_feiticeiros_de_waverly_place', rotulo: 'Os Feiticeiros de Waverly Place', tts: 'Os Feiticeiros de Waverly Place!' },
      { categoria: 'nome', series_id: 'as_visoes_da_raven', rotulo: 'As Visões da Raven', tts: 'As Visões da Raven!' },
      { categoria: 'nome', series_id: 'brandy_e_sr_bigodes', rotulo: 'Brandy e Senhor Bigodes', tts: 'Brandy e Senhor Bigodes!' },
      { categoria: 'nome', series_id: 'phineas_e_ferb', rotulo: 'Phineas e Ferb', tts: 'Phineas e Ferb!' },
      { categoria: 'nome', series_id: 'cory_na_casa_branca', rotulo: 'Cory na Casa Branca', tts: 'Cory na Casa Branca!' },
      { categoria: 'nome', series_id: 'danny_phantom', rotulo: 'Danny Phantom', tts: 'Danny Phantom!' },
      { categoria: 'nome', series_id: 'jacke_long_o_dragao_ocidental', rotulo: 'Jake Long, o Dragão Ocidental', tts: 'Jake Long, o Dragão Ocidental!' },
      { categoria: 'nome', series_id: 'high_school_musical', rotulo: 'High School Musical', tts: 'High School Musical!' },
      { categoria: 'nome', series_id: 'camp_rock', rotulo: 'Camp Rock', tts: 'Camp Rock!' },
      { categoria: 'nome', series_id: 'clube_das_winx', rotulo: 'O Clube das Winx', tts: 'O Clube das Winx!' },
      { categoria: 'nome', series_id: 'padrinhos_magicos', rotulo: 'Os Padrinhos Mágicos', tts: 'Os Padrinhos Mágicos!' },
      { categoria: 'nome', series_id: 'yin_yang_yo', rotulo: 'Yin Yang Yo!', tts: 'Yin Yang Yo!' },
      { categoria: 'conector', chave: 'encerramento', rotulo: 'só no Disney Channel!', tts: 'só no Disney Channel!' },
      { categoria: 'conector', chave: 'a_seguir', rotulo: 'a seguir', tts: 'A seguir.' },
      { categoria: 'conector', chave: 'depois', rotulo: 'logo depois', tts: 'Logo depois.' },
      { categoria: 'conector', chave: 'mais_tarde', rotulo: 'mais tarde', tts: 'Mais tarde.' },
    ],
  },
  cartoon_network: {
    nome: 'Cartoon Network',
    voz_id: 'YfD2qVn2wwK9QFehYxSa', // Larissa B. (Animada, dinâmica)
    config: {
      model_id: 'eleven_multilingual_v2',
      stability: 0.26,
      similarity_boost: 0.85,
      style: 0.65,
      use_speaker_boost: true,
    },
    itens: [
      { categoria: 'nome', series_id: 'billy_e_mandy', rotulo: 'As Terríveis Aventuras de Billy e Mandy', tts: 'As Terríveis Aventuras de Billy e Mandy!' },
      { categoria: 'nome', series_id: 'laboratorio_de_dexter', rotulo: 'O Laboratório de Dexter', tts: 'O Laboratório de Dexter!' },
      { categoria: 'nome', series_id: 'as_meninas_superpoderosas', rotulo: 'As Meninas Superpoderosas', tts: 'As Meninas Superpoderosas!' },
      { categoria: 'nome', series_id: 'mansao_foster', rotulo: 'A Mansão Foster para Amigos Imaginários', tts: 'A Mansão Foster para Amigos Imaginários!' },
      { categoria: 'nome', series_id: 'coragem_o_cao_covarde', rotulo: 'Coragem, o Cão Covarde', tts: 'Coragem, o Cão Covarde!' },
      { categoria: 'nome', series_id: 'jovens_titas', rotulo: 'Os Jovens Titãs', tts: 'Os Jovens Titãs!' },
      { categoria: 'nome', series_id: 'liga_da_justica_sem_limites', rotulo: 'Liga da Justiça Sem Limites', tts: 'Liga da Justiça Sem Limites!' },
      { categoria: 'nome', series_id: 'super_choque', rotulo: 'Super Choque', tts: 'Super Choque!' },
      { categoria: 'nome', series_id: 'scooby_doo', rotulo: 'Scooby-Doo', tts: 'Scooby-Doo!' },
      { categoria: 'nome', series_id: 'knd', rotulo: 'KND: A Turma do Bairro', tts: 'KND, A Turma do Bairro!' },
      { categoria: 'nome', series_id: 'jackie_chan', rotulo: 'As Aventuras de Jackie Chan', tts: 'As Aventuras de Jackie Chan!' },
      { categoria: 'nome', series_id: 'pokemon', rotulo: 'Pokémon', tts: 'Pokémon!' },
      { categoria: 'nome', series_id: 'tom_e_jerry', rotulo: 'Tom e Jerry', tts: 'Tom e Jerry!' },
      { categoria: 'nome', series_id: 'looney_tunes', rotulo: 'Looney Tunes', tts: 'Looney Tunes!' },
      { categoria: 'conector', chave: 'encerramento', rotulo: 'só no Cartoon Network!', tts: 'só no cartoon network!' },
      { categoria: 'conector', chave: 'a_seguir', rotulo: 'a seguir', tts: 'a seguir...' },
      { categoria: 'conector', chave: 'depois', rotulo: 'logo depois', tts: 'logo depois...' },
      { categoria: 'conector', chave: 'mais_tarde', rotulo: 'mais tarde', tts: 'mais tarde...' },
    ],
  },
}

async function main() {
  console.log('=== Gerador de Vozes do Catálogo para R2 & D1 ===\n')
  const apiKey = getElevenLabsKey()
  const { aws, endpoint } = getR2Client()

  let totalProcessados = 0
  let totalSintetizados = 0
  let totalReaproveitados = 0

  const sqlD1Statements = []

  for (const [canalId, canalData] of Object.entries(CANAIS_VOZES)) {
    console.log(`\nCanal: [${canalData.nome}] (Voz: ${canalData.voz_id})`)

    // Prepara update de canais para D1
    const vozCfgJson = JSON.stringify(canalData.config).replace(/'/g, "''")
    sqlD1Statements.push(
      `UPDATE channels SET voz_id = '${canalData.voz_id}', voz_config = '${vozCfgJson}' WHERE id = '${canalId}';`
    )

    for (const item of canalData.itens) {
      totalProcessados++
      const key = ttsKey(canalData.voz_id, item.tts, canalData.config)
      const r2Url = `${endpoint}/${key}`

      // Checa se já existe no R2
      let existe = false
      try {
        const head = await aws.fetch(r2Url, { method: 'HEAD' })
        if (head.status === 200) existe = true
      } catch {
        existe = false
      }

      let duracao = 1.5
      let bufferAudio

      if (existe) {
        totalReaproveitados++
        process.stdout.write(`  [R2 CACHED] ${item.rotulo} (${key})\n`)
      } else {
        totalSintetizados++
        process.stdout.write(`  [TTS GERANDO] ${item.rotulo}... `)
        bufferAudio = await sintetizaEleven(apiKey, canalData.voz_id, item.tts, canalData.config)
        duracao = await medirDuracao(bufferAudio)

        // Upload R2
        const putRes = await aws.fetch(r2Url, {
          method: 'PUT',
          headers: { 'content-type': 'audio/mpeg' },
          body: bufferAudio,
        })
        if (!putRes.ok) {
          throw new Error(`Falha no upload R2 de ${key}: HTTP ${putRes.status}`)
        }
        process.stdout.write(`✔ Upload R2 (${duracao.toFixed(2)}s)\n`)
      }

      // Prepara comando SQL para registrar no D1
      const id = `vc_${createHash('sha256').update(key + canalId).digest('hex').slice(0, 16)}`
      const seriesVal = item.series_id ? `'${item.series_id}'` : 'NULL'
      const chaveVal = item.chave ? `'${item.chave}'` : 'NULL'
      const rotuloVal = item.rotulo.replace(/'/g, "''")

      sqlD1Statements.push(
        `INSERT OR REPLACE INTO voice_clips (id, canal, categoria, series_id, chave, rotulo, audio_key, duracao) ` +
        `VALUES ('${id}', '${canalId}', '${item.categoria}', ${seriesVal}, ${chaveVal}, '${rotuloVal}', '${key}', ${duracao.toFixed(2)});`
      )
    }
  }

  // Grava arquivo de migração/sincronização SQL D1
  const sqlFile = join(ROOT, 'scratch', 'sync_voice_clips_d1.sql')
  writeFileSync(sqlFile, sqlD1Statements.join('\n') + '\n')
  console.log(`\nScript SQL gerado: ${sqlFile}`)
  console.log(`Resumo: ${totalProcessados} clipes avaliados | ${totalSintetizados} gerados na ElevenLabs | ${totalReaproveitados} reaproveitados do R2.`)
}

main().catch((err) => {
  console.error('\n❌ Erro durante a geração de vozes:', err.message)
  process.exit(1)
})
