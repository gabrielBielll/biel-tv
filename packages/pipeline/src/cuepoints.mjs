import { SEG } from './ffmpeg.mjs'

/**
 * Converte trechos de preto em cue points na grade de 10s.
 * No modelo "live virtual", comercial só entra em fronteira de segmento —
 * então o black_start é arredondado para o múltiplo de 10 mais próximo
 * (erro máximo de ±5s, invisível na prática).
 * minEdge descarta cortes cedo/tarde demais na mídia.
 */
export function snapCuePoints(blacks, { duration, minEdge = 60 }) {
  const cues = new Set()
  for (const b of blacks) {
    const cue = Math.round(b.start / SEG) * SEG
    if (cue >= minEdge && cue <= duration - minEdge) cues.add(cue)
  }
  return [...cues].sort((a, b) => a - b)
}
