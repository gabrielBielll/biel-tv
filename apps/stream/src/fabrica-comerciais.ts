import { Hono } from 'hono'
import { dispatchFabrica } from './fabrica'
import { scheduleChannel } from './scheduler'
import { sintetizaClip, sintetizaBytes, TtsIndisponivel, type VozConfig } from './tts'

type Bindings = {
  DB: D1Database
  MEDIA: R2Bucket
  ELEVENLABS_API_KEY?: string
  GH_DISPATCH_TOKEN?: string
  GH_REPO?: string
}

type ClipRow = {
  id: string
  canal: string
  categoria: string
  series_id: string | null
  chave: string | null
  rotulo: string
  audio_key: string
  duracao: number | null
  created_at: number
}

type MoldeRow = {
  id: string
  nome: string
  canal: string
  molde_key: string
  musica_key: string | null
  buraco: string | null
  texto_box: string | null
  created_at: number
}

type SampleRow = {
  id: string
  series_id: string
  rotulo: string
  video_key: string
  source_url: string | null
  created_at: number
}

type BuildJobRow = {
  id: string
  media_id: string
  title: string
  status: string
  error: string | null
  progress: number
  molde_id: string
  series_id: string
  slot_dias: string
  slot_hora: string
  frase_id: string | null
  sample_id: string | null
  payload: string | null
  event_id: number | null
  created_at: number
  updated_at: number
}

export const fabricaComerciais = new Hono<{ Bindings: Bindings }>()

const ID_RE = /^[a-z0-9_]{3,40}$/
const SLUG = /^[a-z0-9_]{2,40}$/
const CATEGORIAS = ['horario', 'frequencia', 'nome', 'frase', 'conector']
const DIAS = [
  { n: 1, key: 'seg', tela: 'SEG' },
  { n: 2, key: 'ter', tela: 'TER' },
  { n: 3, key: 'qua', tela: 'QUA' },
  { n: 4, key: 'qui', tela: 'QUI' },
  { n: 5, key: 'sex', tela: 'SEX' },
  { n: 6, key: 'sab', tela: 'SAB' },
  { n: 7, key: 'dom', tela: 'DOM' },
]

function slugify(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)
}

function hex(n = 10): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, n)
}

function safeName(s: string): string {
  return (s || 'asset.bin').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-90)
}

function limpaHora(s: unknown): string | null {
  const raw = String(s ?? '').trim()
  const m = raw.match(/^([01]\d|2[0-3]):([0-5]\d)$/)
  return m ? `${m[1]}:${m[2]}` : null
}

function diasCanon(raw: unknown): number[] {
  const arr = Array.isArray(raw) ? raw : []
  const dias = [...new Set(arr.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7))]
    .sort((a, b) => a - b)
  return dias
}

function freqKey(dias: number[]): string {
  const s = dias.join(',')
  if (s === '1,2,3,4,5,6,7') return 'todos'
  if (s === '1,2,3,4,5') return 'seg-sex'
  if (s === '6,7') return 'fimsemana'
  if (dias.length === 1) return DIAS.find((d) => d.n === dias[0])!.key
  const keys = dias.map((n) => DIAS.find((d) => d.n === n)!.key)
  const sequencial = dias.every((n, i) => i === 0 || n === dias[i - 1] + 1)
  return sequencial ? `${keys[0]}-${keys.at(-1)}` : keys.join('-')
}

function freqTela(dias: number[]): string {
  const s = dias.join(',')
  if (s === '1,2,3,4,5,6,7') return 'TODOS OS DIAS'
  if (s === '1,2,3,4,5') return 'SEG A SEX'
  if (s === '6,7') return 'SAB E DOM'
  const telas = dias.map((n) => DIAS.find((d) => d.n === n)!.tela)
  const sequencial = dias.every((n, i) => i === 0 || n === dias[i - 1] + 1)
  return sequencial && telas.length > 1 ? `${telas[0]} A ${telas.at(-1)}` : telas.join(' · ')
}

function horaTela(hora: string): string {
  const [h, m] = hora.split(':')
  return m === '00' ? `${Number(h)}H` : `${Number(h)}H${m}`
}

function textoTela(dias: number[], hora: string): string {
  return `${freqTela(dias)} · ${horaTela(hora)}`
}

// Verbalização pt-BR: o rótulo FALADO de cada fragmento reutilizável, pra "assar"
// a biblioteca base do canal. A `chave` gerada é a MESMA que o resolvePayload casa
// (horário=HH:MM, frequência=freqKey, assinatura=encerramento).
const NUM_HORA = ['zero', 'uma', 'duas', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze']

function horaFala(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  const min = m === 15 ? ' e quinze' : m === 30 ? ' e meia' : m === 45 ? ' e quarenta e cinco' : ''
  if (h === 0) return m === 0 ? 'à meia-noite' : `à meia-noite${min}`
  if (h === 12) return m === 0 ? 'ao meio-dia' : `ao meio-dia${min}`
  const periodo = h < 12 ? 'da manhã' : h < 18 ? 'da tarde' : 'da noite'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12 === 1 ? 'à' : 'às'} ${NUM_HORA[h12]}${min} ${periodo}`
}

const DIA_PLURAL: Record<number, string> = { 1: 'às segundas', 2: 'às terças', 3: 'às quartas', 4: 'às quintas', 5: 'às sextas', 6: 'aos sábados', 7: 'aos domingos' }
const DIA_NOME: Record<number, string> = { 1: 'segunda', 2: 'terça', 3: 'quarta', 4: 'quinta', 5: 'sexta', 6: 'sábado', 7: 'domingo' }

function freqFala(dias: number[]): string {
  const s = dias.join(',')
  if (s === '1,2,3,4,5,6,7') return 'todos os dias'
  if (s === '1,2,3,4,5') return 'de segunda a sexta'
  if (s === '6,7') return 'aos sábados e domingos'
  if (dias.length === 1) return DIA_PLURAL[dias[0]]
  const seq = dias.every((n, i) => i === 0 || n === dias[i - 1] + 1)
  if (seq) return `de ${DIA_NOME[dias[0]]} a ${DIA_NOME[dias.at(-1)!]}`
  return dias.map((n) => DIA_NOME[n]).join(', ')
}

// Assinatura falada por canal: `rotulo` é o texto limpo (transcript/painel);
// `tts` é o que vai pro ElevenLabs — pode ter tag/pausa/grafia especial pra soar
// certo. Jetix/Disney: pausa antes limpa a pronúncia do nome. Cartoon: o nome em
// inglês só flui bem em MINÚSCULAS e SEM pausa (validado com o Gabriel — com pausa
// ou maiúscula o "no" separa ou o nome sai corrido).
function assinaturaCanal(canal: string): { rotulo: string; tts: string } | null {
  if (canal === 'jetix') return { rotulo: 'na Jetix', tts: '[short pause] na Jetix' }
  if (canal === 'disney_channel') return { rotulo: 'no Disney Channel', tts: '[short pause] no Disney Channel' }
  if (canal === 'cartoon_network') return { rotulo: 'no Cartoon Network', tts: 'no cartoon network' }
  return null
}

type BibItem = { categoria: string; chave: string; rotulo: string; tts: string }

function bibliotecaBase(canal: string): BibItem[] {
  const itens: BibItem[] = []
  // horários: 06:00 → 23:45 a cada 15 min + meia-noite
  for (let h = 6; h <= 23; h++) {
    for (const m of [0, 15, 30, 45]) {
      const chave = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
      const rotulo = horaFala(chave)
      itens.push({ categoria: 'horario', chave, rotulo, tts: rotulo })
    }
  }
  itens.push({ categoria: 'horario', chave: '00:00', rotulo: horaFala('00:00'), tts: horaFala('00:00') })
  // frequências padrão
  for (const dias of [[1, 2, 3, 4, 5, 6, 7], [1, 2, 3, 4, 5], [6, 7], [1], [2], [3], [4], [5], [6], [7]]) {
    const rotulo = freqFala(dias)
    itens.push({ categoria: 'frequencia', chave: freqKey(dias), rotulo, tts: rotulo })
  }
  // assinatura do canal (texto falado ajustado por canal — ver assinaturaCanal)
  const ass = assinaturaCanal(canal)
  if (ass) itens.push({ categoria: 'conector', chave: 'encerramento', rotulo: ass.rotulo, tts: ass.tts })
  // conectores da vinheta "a seguir" (fase 2) — finitos, já deixam prontos
  itens.push({ categoria: 'conector', chave: 'a_seguir', rotulo: 'a seguir', tts: 'a seguir...' })
  itens.push({ categoria: 'conector', chave: 'abertura', rotulo: 'você está vendo', tts: 'você está vendo' })
  itens.push({ categoria: 'conector', chave: 'depois', rotulo: 'e depois', tts: 'e depois...' })
  // aberturas de EVENTO pontual: "Neste [dia]," — uma por dia da semana, usadas
  // só na promo de MARATONA (evento único). Ali a frequência recorrente ("aos
  // domingos") seria mentira, então a promo fala do dia único. Fragmentos
  // finitos e reutilizáveis, assados uma vez como o resto da biblioteca.
  for (const [n, nome] of Object.entries(DIA_NOME)) {
    const artigo = n === '6' || n === '7' ? 'Neste' : 'Nesta' // sábado/domingo masc.
    itens.push({ categoria: 'conector', chave: `evento_dia_${n}`, rotulo: `${artigo.toLowerCase()} ${nome}`, tts: `${artigo} ${nome},` })
  }
  // conector da promo de maratona: "maratona de [programa]"
  itens.push({ categoria: 'conector', chave: 'maratona', rotulo: 'maratona de', tts: 'maratona de' })
  return itens
}

function assetKey(kind: string, id: string, original: string): string {
  return `fabrica/${kind}/${id}/${safeName(original)}`
}

function youtubeUrl(raw: unknown): string | null {
  const value = String(raw ?? '').trim()
  if (!value) return null
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase().replace(/^www\./, '')
    if (url.protocol !== 'https:' || !['youtube.com', 'm.youtube.com', 'youtu.be'].includes(host)) return null
    return url.toString()
  } catch {
    return null
  }
}

async function copiaAsset(env: Bindings, stagingKey: unknown, destKey: string): Promise<void> {
  const key = String(stagingKey ?? '').trim()
  if (!key) throw new Error('staging_key é obrigatório')
  const obj = await env.MEDIA.get(key)
  if (!obj) throw new Error(`asset não encontrado no R2: ${key}`)
  await env.MEDIA.put(destKey, obj.body)
  if (key !== destKey) await env.MEDIA.delete(key)
}

async function canalExiste(db: D1Database, id: string): Promise<boolean> {
  return Boolean(await db.prepare('SELECT id FROM channels WHERE id = ?1').bind(id).first())
}

async function canalVoz(db: D1Database, canal: string): Promise<{ vozId: string | null; config: VozConfig }> {
  const row = await db.prepare('SELECT voz_id, voz_config FROM channels WHERE id = ?1')
    .bind(canal).first<{ voz_id: string | null; voz_config: string | null }>()
  let config: VozConfig = {}
  if (row?.voz_config) {
    try { config = JSON.parse(row.voz_config) } catch { /* config quebrada = usa defaults */ }
  }
  return { vozId: row?.voz_id ?? null, config }
}

async function serieTitulo(db: D1Database, sid: string): Promise<string> {
  const row = await db.prepare(
    `SELECT MIN(json_extract(metadata, '$.title')) titulo
     FROM media_items
     WHERE json_extract(metadata, '$.series_id') = ?1`,
  ).bind(sid).first<{ titulo: string | null }>()
  return row?.titulo ?? sid
}

async function clip(db: D1Database, where: string, ...binds: unknown[]): Promise<ClipRow | null> {
  return db.prepare(`SELECT * FROM voice_clips WHERE ${where} ORDER BY created_at DESC LIMIT 1`)
    .bind(...binds).first<ClipRow>()
}

async function resolvePayload(env: Bindings, job: BuildJobRow) {
  const dias = diasCanon(JSON.parse(job.slot_dias))
  const hora = limpaHora(job.slot_hora)
  if (dias.length === 0 || !hora) throw new Error('slot inválido no job')
  const fk = freqKey(dias)
  const molde = await env.DB.prepare('SELECT * FROM moldes WHERE id = ?1')
    .bind(job.molde_id).first<MoldeRow>()
  if (!molde) throw new Error(`molde não encontrado: ${job.molde_id}`)

  const sample = job.sample_id
    ? await env.DB.prepare('SELECT * FROM program_samples WHERE id = ?1 AND series_id = ?2')
      .bind(job.sample_id, job.series_id).first<SampleRow>()
    : await env.DB.prepare('SELECT * FROM program_samples WHERE series_id = ?1 ORDER BY created_at DESC LIMIT 1')
      .bind(job.series_id).first<SampleRow>()
  if (!sample) throw new Error(`cadastre uma amostra de vídeo ou link do YouTube para ${job.series_id}`)

  // clipes comuns aos dois tipos de comercial (grade fixa e maratona)
  const nome = await clip(env.DB, "categoria = 'nome' AND series_id = ?1 AND canal = ?2", job.series_id, molde.canal)
  const horario = await clip(env.DB, "categoria = 'horario' AND chave = ?1 AND canal = ?2", hora, molde.canal)
  const assinatura = await clip(env.DB, "categoria = 'conector' AND chave = 'encerramento' AND canal = ?1", molde.canal)

  // A locução é uma LISTA de 5 fragmentos concatenados (o montador exige 5 e usa
  // o clipe de papel 'frase' pra cronometrar a cartela). Duas montagens:
  //  - EVENTO (maratona pontual): "Neste [dia], maratona de [nome], [horário],
  //    [assinatura]" — fala do dia ÚNICO (não "aos domingos", que numa maratona
  //    de um domingo só seria mentira) e anuncia MARATONA.
  //  - GRADE (horário fixo): "[frase] [nome] [frequência] [horário] [assinatura]".
  const evento = job.event_id != null
  let clips: Array<{ papel: string } & ClipRow>
  let transcriptParts: Array<ClipRow | null>

  if (evento) {
    const diaN = dias[0] // o slot do evento tem um único dia (o do start da maratona)
    const nesteDia = await clip(env.DB, "categoria = 'conector' AND chave = ?1 AND canal = ?2", `evento_dia_${diaN}`, molde.canal)
    const maratona = await clip(env.DB, "categoria = 'conector' AND chave = 'maratona' AND canal = ?1", molde.canal)
    const faltando = [
      !nesteDia && `abertura de evento "neste ${DIA_NOME[diaN]}" (${molde.canal})`,
      !maratona && `conector "maratona de" (${molde.canal})`,
      !nome && `nome de ${job.series_id} (${molde.canal})`,
      !horario && `horário ${hora} (${molde.canal})`,
      !assinatura && `assinatura final (${molde.canal})`,
    ].filter(Boolean)
    if (faltando.length) throw new Error(`faltam clipes de fala: ${faltando.join(', ')}`)
    clips = [
      { papel: 'frase', ...nesteDia! }, // 'frase' = âncora da cartela; aqui é a abertura do dia
      { papel: 'maratona', ...maratona! },
      { papel: 'nome', ...nome! },
      { papel: 'horario', ...horario! },
      { papel: 'assinatura', ...assinatura! },
    ]
    transcriptParts = [nesteDia, maratona, nome, horario, assinatura]
  } else {
    const frase = job.frase_id
      ? await env.DB.prepare("SELECT * FROM voice_clips WHERE id = ?1 AND categoria = 'frase' AND series_id = ?2 AND canal = ?3")
        .bind(job.frase_id, job.series_id, molde.canal).first<ClipRow>()
      : await env.DB.prepare("SELECT * FROM voice_clips WHERE categoria = 'frase' AND series_id = ?1 AND canal = ?2 ORDER BY RANDOM() LIMIT 1")
        .bind(job.series_id, molde.canal).first<ClipRow>()
    const frequencia = await clip(env.DB, "categoria = 'frequencia' AND chave = ?1 AND canal = ?2", fk, molde.canal)
    const faltando = [
      !frase && `frase de ${job.series_id} (${molde.canal})`,
      !nome && `nome de ${job.series_id} (${molde.canal})`,
      !frequencia && `frequência ${fk} (${molde.canal})`,
      !horario && `horário ${hora} (${molde.canal})`,
      !assinatura && `assinatura final (${molde.canal})`,
    ].filter(Boolean)
    if (faltando.length) throw new Error(`faltam clipes de fala: ${faltando.join(', ')}`)
    clips = [
      { papel: 'frase', ...frase! },
      { papel: 'nome', ...nome! },
      { papel: 'frequencia', ...frequencia! },
      { papel: 'horario', ...horario! },
      { papel: 'assinatura', ...assinatura! },
    ]
    transcriptParts = [frase, nome, frequencia, horario, assinatura]
  }

  const transcript = transcriptParts.map((c) => c!.rotulo).join(' ').replace(/\s+/g, ' ').trim()
  return {
    id: job.id,
    media_id: job.media_id,
    title: job.title,
    canal: molde.canal,
    series_id: job.series_id,
    evento,
    slot: {
      dias,
      hora,
      frequencia_chave: fk,
      titulo_tela: nome!.rotulo.replace(/[.!?]+$/, '').trim(),
      texto_tela: textoTela(dias, hora),
    },
    transcript,
    molde,
    sample,
    clips,
  }
}

fabricaComerciais.get('/', async (c) => {
  const [voice, moldes, samples, jobs, series, canais] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM voice_clips ORDER BY canal, categoria, series_id, chave, created_at DESC').all(),
    c.env.DB.prepare('SELECT * FROM moldes ORDER BY created_at DESC').all(),
    c.env.DB.prepare('SELECT * FROM program_samples ORDER BY series_id, created_at DESC').all(),
    c.env.DB.prepare('SELECT * FROM commercial_build_jobs ORDER BY created_at DESC LIMIT 50').all(),
    c.env.DB.prepare(
      `SELECT json_extract(metadata, '$.series_id') sid,
              MIN(json_extract(metadata, '$.title')) titulo,
              COUNT(*) n
       FROM media_items
       WHERE json_extract(metadata, '$.series_id') IS NOT NULL
         AND tipo IN ('episodio','filme')
       GROUP BY sid
       ORDER BY titulo`,
    ).all(),
    c.env.DB.prepare('SELECT id, nome, voz_id, voz_config FROM channels ORDER BY ordem').all(),
  ])
  // âncoras de grade (slots fixos). Guardado: se a migration 0024 ainda não rodou,
  // o painel abre normal e a lista vem vazia (não quebra o carregamento).
  let ancoras: unknown[] = []
  try {
    ancoras = (await c.env.DB.prepare('SELECT * FROM channel_slots ORDER BY canal, hora, created_at DESC').all()).results
  } catch { /* channel_slots ausente: sem âncoras */ }
  return c.json({
    voice_clips: voice.results,
    moldes: moldes.results,
    samples: samples.results,
    jobs: jobs.results,
    series: series.results.filter((s: any) => s.sid),
    canais: canais.results,
    ancoras,
    tts_disponivel: Boolean(c.env.ELEVENLABS_API_KEY),
  })
})

// ── âncoras de grade (slots fixos) ──────────────────────────────────────────
// CRUD dos horários fixos que o scheduler honra. Criar uma âncora torna VERDADE
// um comercial "programa X toda [dias] às [hora]" — por isso o botão de gerar o
// comercial de horário vive aqui, ao lado do slot que ele anuncia.
fabricaComerciais.post('/slots', async (c) => {
  const b = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!b) return c.json({ error: 'JSON inválido' }, 400)
  const canal = slugify(String(b.canal ?? ''))
  if (!SLUG.test(canal) || !(await canalExiste(c.env.DB, canal))) return c.json({ error: 'canal desconhecido' }, 400)
  const seriesId = slugify(String(b.series_id ?? ''))
  if (!SLUG.test(seriesId)) return c.json({ error: 'série inválida' }, 400)
  const dias = diasCanon(b.dias)
  if (dias.length === 0) return c.json({ error: 'escolha ao menos um dia' }, 400)
  const hora = limpaHora(b.hora)
  if (!hora) return c.json({ error: 'hora deve ser HH:MM' }, 400)
  const episodios = Math.max(1, Math.min(20, Math.floor(Number(b.episodios ?? 1)) || 1))
  const id = `sl_${hex()}`
  await c.env.DB.prepare(
    `INSERT INTO channel_slots (id, canal, series_id, dias, hora, episodios)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).bind(id, canal, seriesId, JSON.stringify(dias), hora, episodios).run()
  // replaneja a grade do canal pra âncora já valer (append-only, preserva o no ar)
  await scheduleChannel(c.env, canal, 48, true)
  return c.json({ ok: true, id }, 201)
})

fabricaComerciais.delete('/slots/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT canal FROM channel_slots WHERE id = ?1')
    .bind(c.req.param('id')).first<{ canal: string }>()
  if (!row) return c.json({ error: 'âncora não encontrada' }, 404)
  await c.env.DB.prepare('DELETE FROM channel_slots WHERE id = ?1').bind(c.req.param('id')).run()
  await scheduleChannel(c.env, row.canal, 48, true) // remove o slot da grade
  return c.json({ ok: true })
})

// Gera o comercial de horário (bloco_horario, genérico) que anuncia este slot.
// Enfileira um job normal da fábrica com os dados da âncora + um molde do canal.
fabricaComerciais.post('/slots/:id/gerar', async (c) => {
  const slot = await c.env.DB.prepare('SELECT * FROM channel_slots WHERE id = ?1')
    .bind(c.req.param('id')).first<{ canal: string; series_id: string; dias: string; hora: string }>()
  if (!slot) return c.json({ error: 'âncora não encontrada' }, 404)
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const moldeId = String(b.molde_id ?? '').trim()
  const molde = moldeId
    ? await c.env.DB.prepare('SELECT * FROM moldes WHERE id = ?1 AND canal = ?2').bind(moldeId, slot.canal).first<MoldeRow>()
    : await c.env.DB.prepare('SELECT * FROM moldes WHERE canal = ?1 ORDER BY created_at DESC LIMIT 1').bind(slot.canal).first<MoldeRow>()
  if (!molde) return c.json({ error: `canal ${slot.canal} está sem molde` }, 400)

  const dias = diasCanon(JSON.parse(slot.dias))
  const hora = limpaHora(slot.hora) ?? slot.hora
  const tituloSerie = await serieTitulo(c.env.DB, slot.series_id)
  const mediaId = `com_${slot.series_id.slice(0, 20)}_${hora.replace(':', 'h')}_${hex(4)}`.slice(0, 40)
  const dup = await c.env.DB.prepare(
    `SELECT id FROM media_items WHERE id = ?1
     UNION SELECT media_id FROM commercial_build_jobs WHERE media_id = ?1`,
  ).bind(mediaId).first()
  if (dup) return c.json({ error: `id "${mediaId}" já existe — tente de novo` }, 409)

  const id = `cb_${hex()}`
  const title = `${tituloSerie} — ${textoTela(dias, hora)}`
  await c.env.DB.prepare(
    `INSERT INTO commercial_build_jobs
       (id, media_id, title, molde_id, series_id, slot_dias, slot_hora)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).bind(id, mediaId, title, molde.id, slot.series_id, JSON.stringify(dias), hora).run()
  c.executionCtx.waitUntil(dispatchFabrica(c.env))
  return c.json({ ok: true, id, media_id: mediaId }, 201)
})

fabricaComerciais.post('/voice-clips', async (c) => {
  const b = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!b) return c.json({ error: 'JSON inválido' }, 400)
  const categoria = String(b.categoria ?? '')
  if (!CATEGORIAS.includes(categoria)) return c.json({ error: 'categoria inválida' }, 400)
  const canal = slugify(String(b.canal ?? ''))
  if (!SLUG.test(canal) || !(await canalExiste(c.env.DB, canal))) return c.json({ error: 'canal desconhecido' }, 400)
  const seriesId = b.series_id ? slugify(String(b.series_id)) : ''
  if ((categoria === 'nome' || categoria === 'frase') && !SLUG.test(seriesId)) {
    return c.json({ error: 'nome/frase exigem uma série válida' }, 400)
  }
  const chave = String(b.chave ?? '').trim()
  if ((categoria === 'horario' || categoria === 'frequencia' || categoria === 'conector') && !chave) {
    return c.json({ error: 'esta categoria exige chave' }, 400)
  }
  if (categoria === 'horario' && !limpaHora(chave)) return c.json({ error: 'chave de horário deve ser HH:MM' }, 400)
  const rotulo = String(b.rotulo ?? '').trim().slice(0, 300)
  if (!rotulo) return c.json({ error: 'rotulo é obrigatório' }, 400)

  const id = `vc_${hex()}`
  let audioKey: string
  if (b.sintetizar) {
    // Voz automática (ElevenLabs): o próprio `rotulo` é o texto falado. Usa a voz
    // do canal, ou um override no corpo (ex.: a voz jovem da Jetix num clipe só).
    const override = String(b.voz_id ?? '').trim()
    const { vozId, config } = await canalVoz(c.env.DB, canal)
    const voz = override || vozId
    if (!voz) return c.json({ error: `canal ${canal} está sem voz configurada` }, 400)
    try {
      // O texto sintetizado pode trazer tags de emoção/pausa do v3 (`tts_text`),
      // mantendo o `rotulo` limpo pro transcript/painel. Sem tts_text, usa o rótulo.
      const texto = String(b.tts_text ?? '').trim() || rotulo
      audioKey = await sintetizaClip(c.env, voz, texto, config)
    } catch (e) {
      // 503 = indisponível (sem chave/cota): o painel avisa e o clipe não nasce
      // pela metade. Erro de conteúdo cai como 400.
      if (e instanceof TtsIndisponivel) return c.json({ error: (e as Error).message }, 503)
      return c.json({ error: (e as Error).message }, 400)
    }
  } else {
    audioKey = assetKey('voice_clips', id, String(b.original_name ?? 'fala.wav'))
    try {
      await copiaAsset(c.env, b.staging_key, audioKey)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  }
  const clipSeries = categoria === 'nome' || categoria === 'frase' ? seriesId : null
  await c.env.DB.prepare(
    `INSERT INTO voice_clips (id, canal, categoria, series_id, chave, rotulo, audio_key)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).bind(id, canal, categoria, clipSeries, chave || null, rotulo, audioKey).run()
  return c.json({ ok: true, id, canal, audio_key: audioKey }, 201)
})

fabricaComerciais.delete('/voice-clips/:id', async (c) => {
  const id = c.req.param('id')
  const row = await c.env.DB.prepare('SELECT audio_key FROM voice_clips WHERE id = ?1')
    .bind(id).first<{ audio_key: string }>()
  if (!row) return c.json({ error: 'clipe não encontrado' }, 404)
  await c.env.DB.prepare('DELETE FROM voice_clips WHERE id = ?1').bind(id).run()
  // Áudio sintetizado é compartilhado por hash (texto+voz) entre clipes iguais —
  // só apaga do R2 se nenhum outro clipe ainda aponta pra mesma chave.
  const compartilhado = await c.env.DB.prepare('SELECT 1 FROM voice_clips WHERE audio_key = ?1 LIMIT 1')
    .bind(row.audio_key).first()
  if (!compartilhado) await c.env.MEDIA.delete(row.audio_key)
  return c.json({ ok: true })
})

// Toca o áudio de um clipe salvo (botão ▶ da lista). O prefixo fabrica/ não é
// servido pela rota pública /media/*, então o áudio sai por aqui, com token.
fabricaComerciais.get('/voice-clips/:id/audio', async (c) => {
  const row = await c.env.DB.prepare('SELECT audio_key FROM voice_clips WHERE id = ?1')
    .bind(c.req.param('id')).first<{ audio_key: string }>()
  if (!row) return c.json({ error: 'clipe não encontrado' }, 404)
  const obj = await c.env.MEDIA.get(row.audio_key)
  if (!obj) return c.json({ error: 'áudio não encontrado no R2' }, 404)
  const ct = row.audio_key.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg'
  return c.body(obj.body, 200, { 'content-type': ct, 'cache-control': 'no-store' })
})

// Voz do canal: liga o canal ao voice_id do ElevenLabs + ajustes de timbre/emoção.
fabricaComerciais.put('/canais/:id/voz', async (c) => {
  const id = slugify(c.req.param('id'))
  if (!(await canalExiste(c.env.DB, id))) return c.json({ error: 'canal desconhecido' }, 400)
  const b = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!b) return c.json({ error: 'JSON inválido' }, 400)
  const vozId = String(b.voz_id ?? '').trim() || null
  let vozConfig: string | null = null
  if (b.voz_config != null && b.voz_config !== '') {
    try {
      const obj = typeof b.voz_config === 'string' ? JSON.parse(b.voz_config) : b.voz_config
      vozConfig = JSON.stringify(obj)
    } catch {
      return c.json({ error: 'voz_config deve ser JSON válido' }, 400)
    }
  }
  await c.env.DB.prepare('UPDATE channels SET voz_id = ?2, voz_config = ?3 WHERE id = ?1')
    .bind(id, vozId, vozConfig).run()
  return c.json({ ok: true, id, voz_id: vozId })
})

// Botão de teste do painel: sintetiza um texto e devolve o áudio pra tocar na
// hora (validar se a voz do canal está correta). Cacheia no R2 como qualquer TTS.
fabricaComerciais.post('/voz/preview', async (c) => {
  const b = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!b) return c.json({ error: 'JSON inválido' }, 400)
  const texto = String(b.texto ?? '').trim().slice(0, 300)
  if (!texto) return c.json({ error: 'texto é obrigatório' }, 400)

  let voz = String(b.voz_id ?? '').trim()
  let config: VozConfig = {}
  if (!voz) {
    const canal = slugify(String(b.canal ?? ''))
    const v = await canalVoz(c.env.DB, canal)
    if (!v.vozId) return c.json({ error: `canal ${canal} está sem voz configurada` }, 400)
    voz = v.vozId
    config = v.config
  }
  // Ajustes vindos do painel sobrescrevem a config do canal (testar timbre/emoção).
  if (typeof b.voz_config === 'object' && b.voz_config) config = b.voz_config as VozConfig
  try {
    const audio = await sintetizaBytes(c.env, voz, texto, config)
    return c.body(audio, 200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' })
  } catch (e) {
    if (e instanceof TtsIndisponivel) return c.json({ error: (e as Error).message }, 503)
    return c.json({ error: (e as Error).message }, 400)
  }
})

// Gera a "biblioteca base" do canal: sintetiza de uma vez os fragmentos FINITOS e
// reutilizáveis (horários 15 em 15 min, frequências, assinatura, conectores), pra
// aproveitar a assinatura do ElevenLabs e deixá-los permanentes no R2. Idempotente
// (pula o que já existe) e em lotes — o front chama em loop e mostra o progresso.
// `dry_run` devolve só a lista de textos (sem sintetizar, sem gastar crédito).
fabricaComerciais.post('/canais/:id/biblioteca-base', async (c) => {
  const canal = slugify(c.req.param('id'))
  if (!(await canalExiste(c.env.DB, canal))) return c.json({ error: 'canal desconhecido' }, 400)
  const b = await c.req.json<{ dry_run?: boolean; limit?: number }>().catch(() => ({} as { dry_run?: boolean; limit?: number }))
  const itens = bibliotecaBase(canal)

  const existentes = await c.env.DB.prepare(
    'SELECT categoria, chave FROM voice_clips WHERE canal = ?1 AND series_id IS NULL',
  ).bind(canal).all()
  const tem = new Set((existentes.results as { categoria: string; chave: string | null }[]).map((r) => `${r.categoria}|${r.chave}`))
  const faltando = itens.filter((it) => !tem.has(`${it.categoria}|${it.chave}`))

  if (b.dry_run) {
    return c.json({
      total: itens.length,
      faltando: faltando.length,
      itens: itens.map(({ categoria, chave, rotulo }) => ({ categoria, chave, rotulo })),
    })
  }

  const { vozId, config } = await canalVoz(c.env.DB, canal)
  if (!vozId) return c.json({ error: `canal ${canal} está sem voz configurada` }, 400)
  const limit = Math.max(1, Math.min(40, Number(b.limit ?? 20)))
  let gerados = 0
  for (const it of faltando.slice(0, limit)) {
    try {
      const audioKey = await sintetizaClip(c.env, vozId, it.tts, config)
      await c.env.DB.prepare(
        `INSERT INTO voice_clips (id, canal, categoria, series_id, chave, rotulo, audio_key)
         VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6)`,
      ).bind(`vc_${hex()}`, canal, it.categoria, it.chave, it.rotulo, audioKey).run()
      gerados++
    } catch (e) {
      // Sem chave/cota: para e informa quantos faltam — o resto espera a assinatura.
      if (e instanceof TtsIndisponivel) {
        return c.json({ gerados, restantes: faltando.length - gerados, total: itens.length, parou: (e as Error).message }, 503)
      }
      throw e
    }
  }
  return c.json({ gerados, restantes: faltando.length - gerados, total: itens.length })
})

fabricaComerciais.post('/samples', async (c) => {
  const b = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!b) return c.json({ error: 'JSON inválido' }, 400)
  const seriesId = slugify(String(b.series_id ?? ''))
  if (!SLUG.test(seriesId)) return c.json({ error: 'série inválida' }, 400)
  const rotulo = String(b.rotulo ?? '').trim().slice(0, 160) || `amostra ${seriesId}`
  const stagingKey = String(b.staging_key ?? '').trim()
  const rawUrl = String(b.source_url ?? '').trim()
  const sourceUrl = youtubeUrl(rawUrl)
  if (!stagingKey && !rawUrl) return c.json({ error: 'envie um vídeo ou cole um link do YouTube' }, 400)
  if (stagingKey && rawUrl) return c.json({ error: 'escolha vídeo enviado ou link do YouTube, não os dois' }, 400)
  if (rawUrl && !sourceUrl) return c.json({ error: 'link do YouTube inválido' }, 400)

  const id = `ps_${hex()}`
  let videoKey = ''
  if (stagingKey) {
    videoKey = assetKey('samples', id, String(b.original_name ?? 'amostra.mp4'))
    try {
      await copiaAsset(c.env, stagingKey, videoKey)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  }
  await c.env.DB.prepare(
    'INSERT INTO program_samples (id, series_id, rotulo, video_key, source_url) VALUES (?1, ?2, ?3, ?4, ?5)',
  ).bind(id, seriesId, rotulo, videoKey, sourceUrl).run()
  return c.json({ ok: true, id, video_key: videoKey, source_url: sourceUrl }, 201)
})

fabricaComerciais.delete('/samples/:id', async (c) => {
  const id = c.req.param('id')
  const row = await c.env.DB.prepare('SELECT video_key FROM program_samples WHERE id = ?1')
    .bind(id).first<{ video_key: string }>()
  if (!row) return c.json({ error: 'amostra não encontrada' }, 404)
  if (row.video_key) await c.env.MEDIA.delete(row.video_key)
  await c.env.DB.prepare('DELETE FROM program_samples WHERE id = ?1').bind(id).run()
  return c.json({ ok: true })
})

fabricaComerciais.post('/moldes', async (c) => {
  const b = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!b) return c.json({ error: 'JSON inválido' }, 400)
  const nome = String(b.nome ?? '').trim().slice(0, 120)
  if (!nome) return c.json({ error: 'nome é obrigatório' }, 400)
  const canal = slugify(String(b.canal ?? ''))
  if (!SLUG.test(canal) || !(await canalExiste(c.env.DB, canal))) return c.json({ error: 'canal desconhecido' }, 400)

  const id = `md_${hex()}`
  const moldeKey = assetKey('moldes', id, String(b.molde_original_name ?? 'molde.png'))
  let musicaKey: string | null = null
  try {
    await copiaAsset(c.env, b.molde_staging_key, moldeKey)
    if (b.musica_staging_key) {
      musicaKey = assetKey('moldes', `${id}_music`, String(b.musica_original_name ?? 'musica.mp3'))
      await copiaAsset(c.env, b.musica_staging_key, musicaKey)
    }
  } catch (e) {
    await c.env.MEDIA.delete(moldeKey)
    if (musicaKey) await c.env.MEDIA.delete(musicaKey)
    return c.json({ error: (e as Error).message }, 400)
  }
  await c.env.DB.prepare(
    `INSERT INTO moldes (id, nome, canal, molde_key, musica_key, texto_box)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).bind(id, nome, canal, moldeKey, musicaKey, b.texto_box ? String(b.texto_box) : null).run()
  return c.json({ ok: true, id, molde_key: moldeKey, musica_key: musicaKey }, 201)
})

fabricaComerciais.delete('/moldes/:id', async (c) => {
  const id = c.req.param('id')
  const row = await c.env.DB.prepare('SELECT molde_key, musica_key FROM moldes WHERE id = ?1')
    .bind(id).first<{ molde_key: string; musica_key: string | null }>()
  if (!row) return c.json({ error: 'molde não encontrado' }, 404)
  await c.env.MEDIA.delete(row.molde_key)
  if (row.musica_key) await c.env.MEDIA.delete(row.musica_key)
  await c.env.DB.prepare('DELETE FROM moldes WHERE id = ?1').bind(id).run()
  return c.json({ ok: true })
})

fabricaComerciais.post('/jobs', async (c) => {
  const b = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!b) return c.json({ error: 'JSON inválido' }, 400)
  const moldeId = String(b.molde_id ?? '')
  const molde = await c.env.DB.prepare('SELECT * FROM moldes WHERE id = ?1').bind(moldeId).first<MoldeRow>()
  if (!molde) return c.json({ error: 'molde não encontrado' }, 400)

  const seriesId = slugify(String(b.series_id ?? ''))
  if (!SLUG.test(seriesId)) return c.json({ error: 'série inválida' }, 400)
  const dias = diasCanon(b.dias)
  if (dias.length === 0) return c.json({ error: 'escolha ao menos um dia' }, 400)
  const hora = limpaHora(b.hora)
  if (!hora) return c.json({ error: 'hora deve ser HH:MM' }, 400)

  const sampleId = String(b.sample_id ?? '').trim() || null
  const fraseId = String(b.frase_id ?? '').trim() || null
  const tituloSerie = await serieTitulo(c.env.DB, seriesId)
  const mediaIdRaw = String(b.media_id ?? '').trim()
  const mediaId = mediaIdRaw || `com_${seriesId.slice(0, 20)}_${hora.replace(':', 'h')}_${hex(4)}`
  if (!ID_RE.test(mediaId)) return c.json({ error: 'media_id inválido (minúsculas/dígitos/_, 3–40)' }, 400)
  const dup = await c.env.DB.prepare(
    `SELECT id FROM media_items WHERE id = ?1
     UNION SELECT media_id FROM commercial_build_jobs WHERE media_id = ?1`,
  ).bind(mediaId).first()
  if (dup) return c.json({ error: `id "${mediaId}" já existe no catálogo ou na fábrica` }, 409)

  const id = `cb_${hex()}`
  const title = String(b.title ?? '').trim().slice(0, 140) || `${tituloSerie} — ${textoTela(dias, hora)}`
  await c.env.DB.prepare(
    `INSERT INTO commercial_build_jobs
       (id, media_id, title, molde_id, series_id, slot_dias, slot_hora, frase_id, sample_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  ).bind(id, mediaId, title, moldeId, seriesId, JSON.stringify(dias), hora, fraseId, sampleId).run()
  c.executionCtx.waitUntil(dispatchFabrica(c.env))
  return c.json({ ok: true, id, media_id: mediaId }, 201)
})

fabricaComerciais.post('/claim', async (c) => {
  let job: BuildJobRow | null = null
  try {
    await c.env.DB.prepare(
      `UPDATE commercial_build_jobs SET status='queued', error=NULL, progress=0, updated_at=unixepoch()
       WHERE status='processing' AND updated_at < unixepoch() - 7200`,
    ).run()
    job = await c.env.DB.prepare(
      `UPDATE commercial_build_jobs SET status='processing', progress=0, updated_at=unixepoch()
       WHERE id = (SELECT id FROM commercial_build_jobs WHERE status='queued' ORDER BY created_at LIMIT 1)
       RETURNING *`,
    ).first<BuildJobRow>()
    if (!job) return c.body(null, 204)
    const payload = await resolvePayload(c.env, job)
    await c.env.DB.prepare('UPDATE commercial_build_jobs SET payload = ?2 WHERE id = ?1')
      .bind(job.id, JSON.stringify(payload)).run()
    return c.json(payload)
  } catch (e) {
    if (/no such table/i.test(String((e as Error).message ?? e))) return c.body(null, 204)
    if (!job) throw e
    await c.env.DB.prepare(
      "UPDATE commercial_build_jobs SET status='error', error=?2, progress=0, updated_at=unixepoch() WHERE id = ?1",
    ).bind(job.id, String((e as Error).message ?? e).slice(0, 500)).run()
    return c.body(null, 204)
  }
})

fabricaComerciais.post('/:id/progress', async (c) => {
  const { pct } = await c.req.json<{ pct?: number }>().catch(() => ({ pct: -1 }))
  const n = Math.max(0, Math.min(99, Math.floor(Number(pct ?? -1))))
  if (!Number.isFinite(n)) return c.json({ error: 'pct inválido' }, 400)
  await c.env.DB.prepare(
    "UPDATE commercial_build_jobs SET progress=?2, updated_at=unixepoch() WHERE id=?1 AND status='processing'",
  ).bind(c.req.param('id'), n).run()
  return c.json({ ok: true })
})

fabricaComerciais.post('/:id/retry', async (c) => {
  const r = await c.env.DB.prepare(
    "UPDATE commercial_build_jobs SET status='queued', error=NULL, progress=0, updated_at=unixepoch() WHERE id=?1 AND status='error'",
  ).bind(c.req.param('id')).run()
  if ((r.meta.changes ?? 0) === 0) return c.json({ error: 'job não está em erro' }, 404)
  c.executionCtx.waitUntil(dispatchFabrica(c.env))
  return c.json({ ok: true })
})

// Cancela um job da fábrica (✕ no painel): tira da fila o que ainda não começou
// e descarta o que falhou. 'done' já virou mídia no catálogo — remove-se por lá.
//
// 'processing' também é RECUSADO, e o motivo não é óbvio: o runner registra a
// mídia (media_items + media_channels + segmentos no R2) ANTES de chamar o
// /done, e é o /done que grava a promessa em media_promises. Apagar a linha no
// meio faz o /done bater num 404 e a peça nascer no catálogo SEM promessa —
// entrando no rodízio cego. Uma promo de maratona sem promessa toca todo dia,
// inclusive depois do evento ter passado, que é justamente o que a promessa
// 'evento' existe pra impedir. Runner morto não trava a fila: o /claim devolve
// pra 'queued' o que passa de 2h em 'processing'.
fabricaComerciais.delete('/jobs/:id', async (c) => {
  const id = c.req.param('id')
  const job = await c.env.DB.prepare('SELECT status FROM commercial_build_jobs WHERE id = ?1')
    .bind(id).first<{ status: string }>()
  if (!job) return c.json({ error: 'job não encontrado' }, 404)
  if (job.status === 'done') return c.json({ error: 'comercial já montado — remova pelo catálogo' }, 409)
  if (job.status === 'processing') {
    return c.json({
      error: 'a montagem já começou — espere terminar e remova pelo catálogo (job travado volta pra fila sozinho em 2h)',
    }, 409)
  }
  await c.env.DB.prepare('DELETE FROM commercial_build_jobs WHERE id = ?1').bind(id).run()
  return c.json({ ok: true, era: job.status })
})

// Limpeza em massa dos jobs da fábrica — mesma regra da fila de ingestão: só
// 'error' e 'done', e sempre pelos ids que o painel mostrou (a listagem é
// limitada, apagar por status varreria também o que o operador não viu).
fabricaComerciais.post('/jobs/limpar', async (c) => {
  const b = await c.req.json<{ status?: string; ids?: unknown }>().catch(() => ({} as { status?: string; ids?: unknown }))
  const status = String(b.status ?? '')
  if (!['error', 'done'].includes(status)) {
    return c.json({ error: "status inválido — use 'error' ou 'done'" }, 400)
  }
  const ids = (Array.isArray(b.ids) ? b.ids : [])
    .filter((i): i is string => typeof i === 'string' && /^cb_[a-f0-9]{4,32}$/.test(i))
    .slice(0, 500)
  if (ids.length === 0) return c.json({ error: 'informe os ids a limpar' }, 400)
  const marcas = ids.map((_, i) => `?${i + 2}`).join(',')
  const r = await c.env.DB.prepare(
    `DELETE FROM commercial_build_jobs WHERE status = ?1 AND id IN (${marcas})`,
  ).bind(status, ...ids).run()
  return c.json({ ok: true, removidos: r.meta.changes ?? 0 })
})

fabricaComerciais.post('/:id/done', async (c) => {
  const id = c.req.param('id')
  const b = await c.req.json<{ media_id?: string; transcript?: string; proposta?: unknown; render?: unknown }>()
    .catch(() => ({} as { media_id?: string; transcript?: string; proposta?: unknown; render?: unknown }))
  const job = await c.env.DB.prepare('SELECT * FROM commercial_build_jobs WHERE id = ?1')
    .bind(id).first<BuildJobRow>()
  if (!job) return c.json({ error: 'job não encontrado' }, 404)
  const mediaId = String(b.media_id ?? job.media_id)
  const dias = diasCanon(JSON.parse(job.slot_dias))
  const hora = limpaHora(job.slot_hora) ?? job.slot_hora
  const jobDone = c.env.DB.prepare(
    "UPDATE commercial_build_jobs SET status='done', error=NULL, progress=100, updated_at=unixepoch() WHERE id=?1",
  ).bind(id)

  let promiseStmt
  if (job.event_id != null) {
    // Fase B: comercial de MARATONA → promessa 'evento' já CONFIRMADA, amarrada à
    // SÉRIE do evento. O scheduler liga por series_id ao channel_events agendado e
    // toca só na janela agora→start_at, sumindo quando a maratona começa ou é
    // cancelada. Decidido no SERVIDOR pelo event_id do job — o builder externo
    // crava proposta:'bloco_horario' no corpo, então b.proposta não é confiável.
    const cond = JSON.stringify({
      tipo: 'evento',
      series_id: job.series_id,
      descricao: `${job.title} (maratona ${textoTela(dias, hora)})`,
    })
    promiseStmt = c.env.DB.prepare(
      `INSERT INTO media_promises (media_id, transcript, proposta, condicao, status)
       VALUES (?1, ?2, ?3, ?3, 'confirmada')
       ON CONFLICT(media_id) DO UPDATE SET
         transcript=excluded.transcript, proposta=excluded.proposta,
         condicao=excluded.condicao, status='confirmada', updated_at=unixepoch()`,
    ).bind(mediaId, String(b.transcript ?? '').slice(0, 8000), cond)
  } else {
    // Comercial comum de grade → nasce 'generico' (recado que roda o dia todo,
    // "passa com os outros"). A proposta guarda o bloco_horario + slot na descrição.
    // Confirmação manual prévia é respeitada (não rebaixa uma 'confirmada').
    const proposta = b.proposta ?? {
      tipo: 'bloco_horario', series_id: job.series_id,
      descricao: `${job.title} (${textoTela(dias, hora)})`, confianca: 1,
    }
    promiseStmt = c.env.DB.prepare(
      `INSERT INTO media_promises (media_id, transcript, proposta, status)
       VALUES (?1, ?2, ?3, 'generico')
       ON CONFLICT(media_id) DO UPDATE SET
         transcript=excluded.transcript, proposta=excluded.proposta,
         status=CASE WHEN media_promises.status='confirmada' THEN media_promises.status ELSE 'generico' END,
         updated_at=unixepoch()`,
    ).bind(mediaId, String(b.transcript ?? '').slice(0, 8000), JSON.stringify(proposta))
  }
  await c.env.DB.batch([jobDone, promiseStmt])
  const molde = await c.env.DB.prepare('SELECT canal FROM moldes WHERE id = ?1')
    .bind(job.molde_id).first<{ canal: string }>()
  if (molde?.canal) await scheduleChannel(c.env, molde.canal, 48, true)
  return c.json({ ok: true })
})

fabricaComerciais.post('/:id/error', async (c) => {
  const { error } = await c.req.json<{ error?: string }>().catch(() => ({ error: 'falha na montagem' }))
  const r = await c.env.DB.prepare(
    "UPDATE commercial_build_jobs SET status='error', error=?2, progress=0, updated_at=unixepoch() WHERE id=?1",
  ).bind(c.req.param('id'), String(error ?? 'falha na montagem').slice(0, 500)).run()
  if ((r.meta.changes ?? 0) === 0) return c.json({ error: 'job não encontrado' }, 404)
  return c.json({ ok: true })
})
