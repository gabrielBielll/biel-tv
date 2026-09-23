// Síntese de fala via ElevenLabs, com cache PERMANENTE no R2.
//
// Princípio central (decisão do Gabriel): o R2 é permanente, o ElevenLabs é
// EFÊMERO — a assinatura não é renovada todo mês. Então cada fala sintetizada
// vira um objeto no R2 e NUNCA é re-sintetizada: a chave do objeto é o hash de
// (texto + voz + config), de modo que o mesmo texto na mesma voz sempre resolve
// pro mesmo arquivo. Isso dá o "reaproveitar" de graça e não queima crédito à
// toa. Quando a chave falta ou a cota acaba, quem chama recebe `TtsIndisponivel`
// e o job deve ESPERAR na fila (não virar erro) até a assinatura voltar.
//
// Os objetos ficam sob o prefixo `fabrica/tts/…`, que NÃO é servido pela rota
// pública `/media/*` (essa só serve `media/…`) — o áudio é lido pela fábrica via
// credencial S3, como os demais assets da fábrica de comerciais.

type Env = {
  MEDIA: R2Bucket
  ELEVENLABS_API_KEY?: string
}

const MODEL_PADRAO = 'eleven_multilingual_v2'
const OUTPUT_FORMAT = 'mp3_44100_128'

export type VozConfig = {
  model_id?: string
  stability?: number
  similarity_boost?: number
  style?: number
  speed?: number
  use_speaker_boost?: boolean
}

// Sem chave OU cota esgotada/erro transitório: o trabalho deve esperar, não morrer.
export class TtsIndisponivel extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TtsIndisponivel'
  }
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function normalizaConfig(cfg: VozConfig): Required<Pick<VozConfig, 'model_id'>> & VozConfig {
  return { ...cfg, model_id: cfg.model_id || MODEL_PADRAO }
}

// Chave R2 determinística: mesmo (voz, texto, config) → mesmo arquivo → dedup real.
export async function ttsKey(vozId: string, texto: string, cfg: VozConfig = {}): Promise<string> {
  const c = normalizaConfig(cfg)
  const hash = await sha256Hex(JSON.stringify([vozId, texto.trim(), c]))
  return `fabrica/tts/${vozId}/${hash}.mp3`
}

// Só o corpo da chamada ao ElevenLabs (sem cache). Devolve o mp3 cru.
async function chamaEleven(env: Env, vozId: string, texto: string, cfg: VozConfig): Promise<ArrayBuffer> {
  if (!env.ELEVENLABS_API_KEY) throw new TtsIndisponivel('ElevenLabs sem chave (ELEVENLABS_API_KEY)')
  const c = normalizaConfig(cfg)
  const voice_settings: Record<string, unknown> = {
    stability: c.stability ?? 0.5,
    similarity_boost: c.similarity_boost ?? 0.75,
  }
  if (c.style != null) voice_settings.style = c.style
  if (c.speed != null) voice_settings.speed = c.speed
  if (c.use_speaker_boost != null) voice_settings.use_speaker_boost = c.use_speaker_boost

  let res: Response
  try {
    res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(vozId)}?output_format=${OUTPUT_FORMAT}`,
      {
        method: 'POST',
        headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ text: texto, model_id: c.model_id, voice_settings }),
      },
    )
  } catch (e) {
    // rede/timeout: transitório → esperar na fila
    throw new TtsIndisponivel(`ElevenLabs inacessível: ${String((e as Error).message ?? e).slice(0, 200)}`)
  }
  if (!res.ok) {
    const detalhe = (await res.text().catch(() => '')).slice(0, 300)
    // Caso específico e recorrente (15/09/2026): a assinatura do ElevenLabs
    // caiu e o plano atual não deixa mais USAR voz clonada (IVC) pela API — as
    // vozes dos três canais são clonadas. A chave continua válida e com
    // crédito; voz do catálogo público funciona normalmente. A saída enquanto
    // não houver assinatura é passar `voz_id` de uma voz pública na criação do
    // clipe (ver docs/features/fabrica-comerciais.md → "Voz provisória").
    if (res.status === 401 && detalhe.includes('ivc_not_permitted')) {
      throw new TtsIndisponivel(
        `ElevenLabs: o plano atual não permite usar voz CLONADA (${vozId}). ` +
        'A chave está válida — gere com uma voz do catálogo público passando ' +
        '`voz_id` (docs/features/fabrica-comerciais.md → "Voz provisória").',
      )
    }
    // 401 (chave escopada/expirada), 429 (cota) e 5xx são "indisponível": o job
    // ESPERA a assinatura voltar. 400/422 são erro de conteúdo — falha de verdade.
    if (res.status === 401 || res.status === 429 || res.status >= 500) {
      throw new TtsIndisponivel(`ElevenLabs ${res.status}: ${detalhe}`)
    }
    throw new Error(`ElevenLabs ${res.status}: ${detalhe}`)
  }
  return res.arrayBuffer()
}

// Sintetiza `texto` na voz `vozId`, cacheando no R2, e devolve a CHAVE R2 do mp3.
// Se o áudio já existe no R2, NÃO chama a API (reaproveita — nunca paga 2×).
export async function sintetizaClip(env: Env, vozId: string, texto: string, cfg: VozConfig = {}): Promise<string> {
  const key = await ttsKey(vozId, texto, cfg)
  if (await env.MEDIA.head(key)) return key
  const audio = await chamaEleven(env, vozId, texto, cfg)
  await env.MEDIA.put(key, audio, { httpMetadata: { contentType: 'audio/mpeg' } })
  return key
}

// Igual à `sintetizaClip`, mas devolve os BYTES (pro botão de teste do painel
// tocar o áudio na hora). Também cacheia no R2 — testar já vai assando a base.
export async function sintetizaBytes(env: Env, vozId: string, texto: string, cfg: VozConfig = {}): Promise<ArrayBuffer> {
  const key = await ttsKey(vozId, texto, cfg)
  const existente = await env.MEDIA.get(key)
  if (existente) return existente.arrayBuffer()
  const audio = await chamaEleven(env, vozId, texto, cfg)
  await env.MEDIA.put(key, audio, { httpMetadata: { contentType: 'audio/mpeg' } })
  return audio
}
