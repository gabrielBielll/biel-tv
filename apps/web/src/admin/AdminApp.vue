<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const API = import.meta.env.VITE_API_BASE ?? ''
const TOKEN_KEY = 'bieltv_admin_token'

const token = ref(localStorage.getItem(TOKEN_KEY) ?? '')
const authed = ref(false)
const authMsg = ref('')

const jobs = ref<any[]>([])
const media = ref<any[]>([])
const channels = ref<any[]>([])
const god = ref(false)
let poll: ReturnType<typeof setInterval> | undefined

// formulário de upload
const file = ref<File | null>(null)
const meta = ref<{ duration: number; width: number; height: number } | null>(null)
const form = ref({ id: '', tipo: 'episodio', title: '', series_id: '', episode: '', tags: '', canais: [] as string[] })
const pct = ref(0)
const sending = ref(false)
const msg = ref('')

// lote (vários arquivos / pasta)
interface ItemLote {
  file: File
  rel: string
  dur: number
  tipo: string
  titulo: string
  id: string
  series: string
  ep: string
  status: string
  pct: number
  sess?: SessaoUpload
  ctrl?: AbortController
  cancelado?: boolean
}
const lote = ref<ItemLote[]>([])
const loteCanais = ref<string[]>([])
const loteEnviando = ref(false)

// uploads interrompidos (sessões ativas no servidor sem arquivo neste tab)
interface Retomada {
  sess: any
  file: File
  status: string
  pct: number
  ctrl?: AbortController
  cancelado?: boolean
}
const pendentes = ref<any[]>([])
const retomadas = ref<Retomada[]>([])
const formSess = ref('')

// chat do Diretor (Modo God)
const chatCanal = ref('')
const chatMsgs = ref<{ role: 'user' | 'diretor'; text: string; acoes?: string[] }[]>([])
const chatInput = ref('')
const chatBusy = ref(false)
const estado = ref<{ diretrizes: any[]; eventos: any[]; series: any[] }>({ diretrizes: [], eventos: [], series: [] })

const hdr = () => ({ authorization: `Bearer ${token.value}` })

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${API}/admin${path}`, { ...init, headers: { ...hdr(), ...(init.headers ?? {}) } })
  if (res.status === 401) {
    authed.value = false
    throw new Error('token inválido')
  }
  return res
}

const postJson = (path: string, body: unknown) =>
  api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

async function enter() {
  authMsg.value = ''
  try {
    const res = await api('/jobs')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    localStorage.setItem(TOKEN_KEY, token.value)
    authed.value = true
    channels.value = await (await api('/channels')).json()
    const cfg = await (await api('/config')).json()
    god.value = cfg.god_mode === '1'
    fetchCookieStatus()
    if (!chatCanal.value) chatCanal.value = channels.value[0]?.id ?? ''
    carregaChat()
    refresh()
  } catch (e) {
    authMsg.value = `não entrou: ${(e as Error).message}`
  }
}

async function refresh() {
  if (!authed.value) return
  try {
    jobs.value = await (await api('/jobs')).json()
    media.value = await (await api('/media')).json()
    pendentes.value = await (await api('/uploads')).json()
    promessas.value = await (await api('/promessas')).json()
    await carregaAnalises()
    await carregaFabrica()
  } catch {
    /* sem pânico em polling */
  }
}

// ── promessas de comerciais (fase 12) ───────────────────────────────────────
const promessas = ref<any[]>([])
const serieAlvo = ref<Record<string, string>>({})
const TIPO_PROM: Record<string, string> = {
  a_seguir: '“a seguir”', durante: '“você está vendo”', bloco_horario: 'horário fixo',
  evento: 'evento', generico: 'sem promessa',
}
const propostaDe = (p: any) => { try { return JSON.parse(p.proposta) } catch { return null } }
const condicaoDe = (p: any) => { try { return JSON.parse(p.condicao) } catch { return null } }
const tituloPromessa = (p: any) => { try { return JSON.parse(p.metadata).title ?? p.media_id } catch { return p.media_id } }
const promPendentes = computed(() => promessas.value.filter((p) => p.status === 'pendente'))
const promDecididas = computed(() => promessas.value.filter((p) => p.status === 'confirmada' || p.status === 'ignorar'))

// ── fábrica de comerciais (fala + amostra + molde) ─────────────────────────
const fabrica = ref<{ voice_clips: any[]; moldes: any[]; samples: any[]; jobs: any[]; series: any[] }>({
  voice_clips: [], moldes: [], samples: [], jobs: [], series: [],
})
const fabBusy = ref(false)
const clipFile = ref<File | null>(null)
const sampleFile = ref<File | null>(null)
const moldeFile = ref<File | null>(null)
const musicaFile = ref<File | null>(null)
const clipForm = ref({ categoria: 'frase', series_id: '', chave: '', rotulo: '' })
const sampleForm = ref({ series_id: '', rotulo: '' })
const moldeForm = ref({ nome: 'Molde Jetix — horário', canal: 'jetix' })
const buildForm = ref({
  molde_id: '',
  series_id: '',
  dias: [1, 2, 3, 4, 5] as number[],
  hora: '16:00',
  sample_id: '',
  frase_id: '',
  media_id: '',
  title: '',
})
const DIAS_FAB = [
  { n: 1, label: 'seg' }, { n: 2, label: 'ter' }, { n: 3, label: 'qua' }, { n: 4, label: 'qui' },
  { n: 5, label: 'sex' }, { n: 6, label: 'sáb' }, { n: 7, label: 'dom' },
]
const fabJobsAtivos = computed(() => fabrica.value.jobs.filter((j) => j.status === 'queued' || j.status === 'processing'))
const clipsDaSerie = computed(() => fabrica.value.voice_clips.filter((c) => c.series_id === buildForm.value.series_id))
const frasesDaSerie = computed(() => clipsDaSerie.value.filter((c) => c.categoria === 'frase'))
const samplesDaSerie = computed(() => fabrica.value.samples.filter((s) => s.series_id === buildForm.value.series_id))
const fabStatus: Record<string, string> = { queued: 'na fila', processing: 'montando', done: 'pronto', error: 'erro' }
const slugFab = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')

async function carregaFabrica() {
  try {
    fabrica.value = await (await api('/fabrica-comerciais')).json()
    if (!buildForm.value.molde_id && fabrica.value.moldes[0]) buildForm.value.molde_id = fabrica.value.moldes[0].id
  } catch { /* poll cobre */ }
}

async function uploadAsset(f: File): Promise<string> {
  const res = await api(`/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f })
  const body = await res.json()
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
  return body.staging_key
}

function onClipFile(ev: Event) { clipFile.value = ((ev.target as HTMLInputElement).files ?? [])[0] ?? null }
function onSampleFile(ev: Event) { sampleFile.value = ((ev.target as HTMLInputElement).files ?? [])[0] ?? null }
function onMoldeFile(ev: Event) { moldeFile.value = ((ev.target as HTMLInputElement).files ?? [])[0] ?? null }
function onMusicaFile(ev: Event) { musicaFile.value = ((ev.target as HTMLInputElement).files ?? [])[0] ?? null }

async function salvarClip() {
  if (!clipFile.value) { msg.value = '✖ escolha o áudio do clipe'; return }
  fabBusy.value = true
  try {
    const staging = await uploadAsset(clipFile.value)
    const res = await postJson('/fabrica-comerciais/voice-clips', {
      ...clipForm.value,
      staging_key: staging,
      original_name: clipFile.value.name,
    })
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
    msg.value = `✔ clipe salvo (${clipForm.value.categoria})`
    clipFile.value = null
    clipForm.value.rotulo = ''
    await carregaFabrica()
  } catch (e) {
    msg.value = `✖ ${(e as Error).message}`
  } finally {
    fabBusy.value = false
  }
}

async function salvarSample() {
  if (!sampleFile.value) { msg.value = '✖ escolha o vídeo da amostra'; return }
  fabBusy.value = true
  try {
    const staging = await uploadAsset(sampleFile.value)
    const res = await postJson('/fabrica-comerciais/samples', {
      ...sampleForm.value,
      staging_key: staging,
      original_name: sampleFile.value.name,
    })
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
    msg.value = '✔ amostra salva'
    sampleFile.value = null
    await carregaFabrica()
  } catch (e) {
    msg.value = `✖ ${(e as Error).message}`
  } finally {
    fabBusy.value = false
  }
}

async function salvarMolde() {
  if (!moldeFile.value) { msg.value = '✖ escolha o PNG do molde'; return }
  fabBusy.value = true
  try {
    const moldeStaging = await uploadAsset(moldeFile.value)
    const musicaStaging = musicaFile.value ? await uploadAsset(musicaFile.value) : ''
    const res = await postJson('/fabrica-comerciais/moldes', {
      ...moldeForm.value,
      molde_staging_key: moldeStaging,
      molde_original_name: moldeFile.value.name,
      musica_staging_key: musicaStaging,
      musica_original_name: musicaFile.value?.name ?? '',
    })
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
    msg.value = '✔ molde salvo'
    moldeFile.value = null
    musicaFile.value = null
    buildForm.value.molde_id = body.id
    await carregaFabrica()
  } catch (e) {
    msg.value = `✖ ${(e as Error).message}`
  } finally {
    fabBusy.value = false
  }
}

function toggleDiaFab(n: number) {
  const cur = buildForm.value.dias
  buildForm.value.dias = cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n].sort((a, b) => a - b)
}

function sugereComercialId() {
  const sid = slugFab(buildForm.value.series_id).slice(0, 20)
  const h = buildForm.value.hora.replace(':', 'h')
  if (sid && h) buildForm.value.media_id = `com_${sid}_${h}`
}

async function montarComercial() {
  if (!buildForm.value.molde_id || !buildForm.value.series_id || buildForm.value.dias.length === 0) {
    msg.value = '✖ escolha molde, programa e dias'
    return
  }
  fabBusy.value = true
  try {
    const res = await postJson('/fabrica-comerciais/jobs', {
      ...buildForm.value,
      media_id: buildForm.value.media_id.trim() || undefined,
      title: buildForm.value.title.trim() || undefined,
      sample_id: buildForm.value.sample_id || undefined,
      frase_id: buildForm.value.frase_id || undefined,
    })
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
    msg.value = `✔ comercial ${body.media_id} entrou na fábrica`
    await carregaFabrica()
    refresh()
  } catch (e) {
    msg.value = `✖ ${(e as Error).message}`
  } finally {
    fabBusy.value = false
  }
}

async function apagarFab(kind: 'voice-clips' | 'samples' | 'moldes', id: string) {
  const res = await api(`/fabrica-comerciais/${kind}/${id}`, { method: 'DELETE' })
  const body = await res.json().catch(() => ({} as { error?: string }))
  msg.value = res.ok ? '✔ removido' : `✖ ${body.error ?? res.status}`
  carregaFabrica()
}

async function retryFabJob(j: any) {
  const res = await postJson(`/fabrica-comerciais/${j.id}/retry`, {})
  const body = await res.json().catch(() => ({} as { error?: string }))
  msg.value = res.ok ? `↻ ${j.media_id} voltou para a fábrica` : `✖ ${body.error ?? res.status}`
  carregaFabrica()
}

// ── navegação por seções (painel = menu lateral, uma seção por vez) ─────────
type Aba = 'enviar' | 'playlist' | 'fabrica' | 'fila' | 'catalogo' | 'promessas' | 'diretor'
const ABA_KEY = 'bieltv_admin_aba'
const aba = ref<Aba>((localStorage.getItem(ABA_KEY) as Aba) || 'enviar')
watch(aba, (v) => localStorage.setItem(ABA_KEY, v))
// modo god desligado no meio → sai da aba do Diretor pra não ficar tela vazia
watch(god, (v) => { if (!v && aba.value === 'diretor') aba.value = 'fila' })

// fila ao vivo: só os jobs ativos ficam à vista; concluídos/erros vão pro
// histórico recolhível (senão o painel enche em minutos). Fica em v-show pra
// as linhas seguirem no DOM (a verificação e2e lê o "concluído" por textContent).
const mostraHistorico = ref(false)
const jobsAtivos = computed(() => jobs.value.filter((j) => j.status === 'queued' || j.status === 'processing'))
const jobsHistorico = computed(() => jobs.value.filter((j) => j.status !== 'queued' && j.status !== 'processing'))

// interruptor POR CANAL: fiel (fase 12 manda) ⇄ livre (rodízio cego, pra
// época de acervo ainda não editado) — o servidor replaneja o canal na hora
const trocandoFieis = ref('')
async function toggleFieisCanal(ch: any) {
  if (trocandoFieis.value) return
  trocandoFieis.value = ch.id
  try {
    const novo = ch.comerciais_fieis === 0 ? 1 : 0
    const res = await postJson(`/channels/${ch.id}`, { comerciais_fieis: novo })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    ch.comerciais_fieis = novo
    msg.value = novo === 1
      ? `🎯 ${ch.nome}: comerciais FIÉIS — só toca o que cumpre a promessa`
      : `🎲 ${ch.nome}: comerciais LIVRES — acervo cru no ar (volte ao fiel depois de editar)`
    refresh()
  } catch (e) {
    msg.value = `✖ ${(e as Error).message}`
  } finally {
    trocandoFieis.value = ''
  }
}

async function mudarTipo(m: any, tipo: string) {
  const res = await postJson(`/media/${m.id}/tipo`, { tipo })
  const body = await res.json()
  msg.value = res.ok
    ? `✔ ${m.id} agora é ${tipo} — grade reajustada`
    : `✖ ${body.error ?? res.status}`
  refresh()
}

async function reanalisar(p: any) {
  msg.value = '… pedindo outra análise da IA'
  await postJson(`/promessas/${p.media_id}/extrair`, {})
  msg.value = '✔ reanalisado'
  refresh()
}

async function decidePromessa(p: any, status: string) {
  let condicao
  if (status === 'confirmada') {
    const prop = propostaDe(p) ?? {}
    condicao = {
      tipo: prop.tipo ?? 'a_seguir',
      series_id: (serieAlvo.value[p.media_id] ?? prop.series_id ?? '').trim() || null,
      descricao: prop.descricao ?? '',
    }
  }
  const res = await postJson(`/promessas/${p.media_id}/decidir`, { status, condicao })
  const body = await res.json()
  if (!res.ok) {
    msg.value = `✖ ${body.error ?? res.status}`
    return
  }
  msg.value = status === 'confirmada'
    ? '✔ promessa confirmada — só toca quando a grade cumprir'
    : status === 'generico' ? '✔ liberado pro rodízio normal' : '✔ fora do ar'
  refresh()
}

const fetchPendentes = async () => {
  try { pendentes.value = await (await api('/uploads')).json() } catch { /* poll cobre */ }
}

// sessões que ESTE tab já está tratando não aparecem como "interrompidas"
const pendentesVisiveis = computed(() => {
  const ativos = new Set<string>()
  for (const i of lote.value) if (i.sess) ativos.add(i.sess.id)
  for (const r of retomadas.value) if (r.status !== 'na fila' && !r.status.startsWith('erro')) ativos.add(r.sess.id)
  if (formSess.value) ativos.add(formSess.value)
  return pendentes.value.filter((p) => !ativos.has(p.id))
})

// ── sugestão automática (heurística; a camada LLM entra depois) ────────────
function probeFile(f: File): Promise<{ duration: number; width: number; height: number }> {
  return new Promise((res, rej) => {
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.onloadedmetadata = () => {
      res({ duration: v.duration, width: v.videoWidth, height: v.videoHeight })
      URL.revokeObjectURL(v.src)
    }
    v.onerror = () => rej(new Error('não consegui ler os metadados do vídeo'))
    v.src = URL.createObjectURL(f)
  })
}

const slug = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')

function cleanTitle(name: string) {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/ytdown\.?com|youtube|_media_.*$|\d{3,4}p$/gi, ' ')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
}

function suggestCanais(lower: string): string[] {
  const out: string[] = []
  if (/jetix|fox\s?kids/.test(lower)) out.push('jetix')
  if (/cartoon|groovies|(^|[^a-z])cn([^a-z]|$)/.test(lower)) out.push('cartoon_network')
  if (/disney/.test(lower)) out.push('disney_channel')
  return out.filter((c) => channels.value.some((ch) => ch.id === c))
}

function suggest(f: File, m: { duration: number }) {
  const lower = f.name.toLowerCase()
  let tipo = 'episodio'
  if (/vinheta|a[ ._-]?seguir|\bid\b/i.test(lower)) tipo = 'vinheta'
  else if (/comercial|promo|an[uú]ncio/i.test(lower) || m.duration < 90) tipo = 'comercial'
  else if (m.duration > 3600) tipo = 'filme'

  const se = lower.match(/s(\d{1,2})[ ._-]?e(\d{1,3})/)
  const title = cleanTitle(f.name) || f.name
  const prefix = { episodio: 'ep', filme: 'flm', comercial: 'com', vinheta: 'vin' }[tipo]
  form.value = {
    id: `${prefix}_${slug(title).slice(0, 28)}`,
    tipo,
    title,
    series_id: se ? slug(title.split(/s\d/i)[0] ?? '') : '',
    episode: se ? String(Number(se[2])) : '',
    tags: '',
    canais: suggestCanais(lower),
  }
}

// ── cookies do YouTube (self-service) ──────────────────────────────────────
const ytCookiesTexto = ref('')
const ytCookiesStatus = ref<{ configurado: boolean } | null>(null)
const salvandoCookies = ref(false)
const mostraCookies = ref(false)
async function fetchCookieStatus() {
  try { ytCookiesStatus.value = await (await api('/yt-cookies/status')).json() } catch { /* ignora */ }
}
async function salvarCookies() {
  if (!ytCookiesTexto.value.trim() || salvandoCookies.value) return
  salvandoCookies.value = true
  try {
    const res = await postJson('/yt-cookies', { cookies: ytCookiesTexto.value })
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
    msg.value = `🍪 cookies atualizados — ${body.reenfileirados} vídeo(s) do YouTube de volta na fila`
    ytCookiesTexto.value = ''
    mostraCookies.value = false
    fetchCookieStatus()
    refresh()
  } catch (e) {
    msg.value = `✖ ${(e as Error).message}`
  } finally {
    salvandoCookies.value = false
  }
}

// ── ingestão por link (YouTube/acervos) ────────────────────────────────────
const ytUrl = ref('')
const ytBusy = ref(false)
async function buscarLink() {
  const url = ytUrl.value.trim()
  if (!url || ytBusy.value) return
  ytBusy.value = true
  msg.value = ''
  try {
    const info = await (await api(`/yt-info?url=${encodeURIComponent(url)}`)).json()
    const titulo = info.title ?? ''
    file.value = null
    meta.value = null
    lote.value = []
    // reusa a heurística de sugestão com o TÍTULO do vídeo como "nome do arquivo"
    const fakeName = `${titulo || 'video do link'}.mp4`
    const lower = fakeName.toLowerCase()
    let tipo = 'episodio'
    if (/vinheta|a[ ._-]?seguir|\bid\b/i.test(lower)) tipo = 'vinheta'
    else if (/comercial|promo|an[uú]ncio|intervalo|propaganda/i.test(lower)) tipo = 'comercial'
    const title = cleanTitle(fakeName) || 'Vídeo do link'
    const prefix = { episodio: 'ep', filme: 'flm', comercial: 'com', vinheta: 'vin' }[tipo]
    form.value = {
      id: `${prefix}_${slug(title).slice(0, 28)}`,
      tipo, title, series_id: '', episode: '', tags: '',
      canais: suggestCanais(lower),
    }
    linkPronto.value = true
    msg.value = titulo ? `🔗 "${titulo}" — confira as sugestões e envie` : '🔗 link ok — preencha título/tipo e envie'
  } catch (e) {
    msg.value = `✖ ${(e as Error).message}`
  } finally {
    ytBusy.value = false
  }
}

const linkPronto = ref(false)
async function enviarLink() {
  if (form.value.canais.length === 0) {
    msg.value = '✖ escolha pelo menos um canal'
    return
  }
  sending.value = true
  try {
    const res = await postJson('/jobs', {
      ...form.value,
      canais: form.value.canais.join(','),
      episode: form.value.episode ? Number(form.value.episode) : null,
      source_url: ytUrl.value.trim(),
      original_name: `${form.value.id}.mp4`,
    })
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
    msg.value = `✔ "${form.value.title}" entrou na fila — a fábrica baixa e processa sozinha`
    ytUrl.value = ''
    linkPronto.value = false
    refresh()
  } catch (e) {
    msg.value = `✖ ${(e as Error).message}`
  } finally {
    sending.value = false
  }
}

async function onPick(ev: Event) {
  linkPronto.value = false
  msg.value = ''
  const files = [...((ev.target as HTMLInputElement).files ?? [])].filter((f) => f.size > 0)
  if (files.length > 1) {
    file.value = null
    meta.value = null
    await montaLote(files)
    return
  }
  lote.value = []
  const f = files[0] ?? null
  file.value = f
  meta.value = null
  if (!f) return
  try {
    meta.value = await probeFile(f)
    suggest(f, meta.value)
  } catch (e) {
    msg.value = (e as Error).message
  }
}

// pasta/lote: deduz série da pasta e episódio do número do arquivo
// ("pwr rangers/001.mp4" → série pwr_rangers, ep 1)
async function montaLote(files: File[]) {
  const itens: ItemLote[] = []
  const canaisSugeridos = new Set<string>()
  for (const f of files) {
    const rel = (f as any).webkitRelativePath as string | undefined
    const pasta = rel?.includes('/') ? rel.split('/').slice(-2, -1)[0] : ''
    let dur = 0
    try { dur = (await probeFile(f)).duration } catch { /* segue sem duração */ }
    const lower = `${pasta} ${f.name}`.toLowerCase()
    suggestCanais(lower).forEach((c) => canaisSugeridos.add(c))
    const numero = f.name.match(/^(\d{1,4})\./) ?? f.name.match(/(\d{1,4})\.\w+$/)
    const ep = pasta && numero ? String(Number(numero[1])) : ''
    let tipo = 'episodio'
    if (/vinheta|a[ ._-]?seguir/.test(lower)) tipo = 'vinheta'
    else if (/comercial|promo/.test(lower)) tipo = 'comercial'
    // arquivo numerado dentro de pasta de série = episódio, independente da duração
    else if (!ep && dur > 0 && dur < 90) tipo = 'comercial'
    else if (!ep && dur > 3600) tipo = 'filme'
    const serieSlug = pasta ? slug(pasta) : ''
    const titulo = ep
      ? `${cleanTitle(pasta)} — Ep ${ep.padStart(2, '0')}`
      : cleanTitle(f.name) || f.name
    const prefix = { episodio: 'ep', filme: 'flm', comercial: 'com', vinheta: 'vin' }[tipo]
    const id = ep
      ? `ep_${serieSlug}_e${ep.padStart(2, '0')}`
      : `${prefix}_${slug(titulo).slice(0, 28)}`
    itens.push({ file: f, rel: rel ?? '', dur, tipo, titulo, id, series: serieSlug, ep, status: 'pronto', pct: 0 })
  }
  lote.value = itens
  loteCanais.value = [...canaisSugeridos]
}

// ── upload multipart retomável ──────────────────────────────────────────────
// A sessão nasce no SERVIDOR antes do primeiro byte; cada parte confirmada
// fica registrada lá (upload_parts). Reload no meio → a sessão aparece em
// "uploads interrompidos" e continua de onde parou quando o mesmo arquivo é
// reanexado (o navegador não restaura <input type="file"> sozinho).
const PART_SIZE = 10 * 1024 * 1024

interface SessaoUpload {
  id: string
  media_id: string
  part_size: number
  parts_total: number
  partes: number[]
}

const relDe = (f: File) => ((f as any).webkitRelativePath as string | undefined) ?? ''
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface MetaEnvio { id: string; tipo: string; titulo: string; series: string; ep: string; tags?: string; canais: string[] }

// cria (ou retoma, se o servidor reconhecer o fingerprint) uma sessão
async function criaSessao(m: MetaEnvio, f: File): Promise<SessaoUpload> {
  const res = await postJson('/uploads', {
    media_id: m.id, tipo: m.tipo, title: m.titulo,
    series_id: m.series || null, episode: m.ep ? Number(m.ep) : null,
    tags: m.tags ?? '', canais: m.canais.join(','), part_size: PART_SIZE,
    file: { name: f.name, rel: relDe(f), size: f.size, last_modified: f.lastModified },
  })
  const body = await res.json()
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
  return body
}

// uma parte: timeout próprio + retry com backoff (rede instável, 429, 5xx)
async function enviaParte(sess: SessaoUpload, f: File, n: number, alvo: { ctrl?: AbortController; cancelado?: boolean }) {
  const ini = (n - 1) * sess.part_size
  const blob = f.slice(ini, Math.min(ini + sess.part_size, f.size))
  for (let tent = 1; tent <= 4; tent++) {
    const ctrl = new AbortController()
    alvo.ctrl = ctrl
    const timer = setTimeout(() => ctrl.abort(), 180_000)
    let transitorio = ''
    try {
      const res = await fetch(`${API}/admin/uploads/${sess.id}/parts/${n}`, {
        method: 'PUT', headers: hdr(), body: blob, signal: ctrl.signal,
      })
      if (res.ok) return
      const body = await res.json().catch(() => ({} as { error?: string }))
      if (res.status === 429 || res.status >= 500) transitorio = body.error ?? `HTTP ${res.status}`
      else throw new Error(body.error ?? `HTTP ${res.status}`) // 4xx = definitivo
    } catch (e) {
      if (alvo.cancelado) throw new Error('cancelado')
      const err = e as Error
      if (err.name === 'AbortError') transitorio = 'timeout no envio'
      else if (err instanceof TypeError) transitorio = 'falha de rede'
      else if (!transitorio) throw err
    } finally {
      clearTimeout(timer)
    }
    if (tent === 4) throw new Error(`parte ${n}/${sess.parts_total}: ${transitorio}`)
    await espera(1000 * 3 ** (tent - 1)) // 1s, 3s, 9s
  }
}

// sobe só as partes que faltam e completa (o complete é idempotente no servidor)
async function enviaArquivo(sess: SessaoUpload, f: File, alvo: { ctrl?: AbortController; cancelado?: boolean }, onPct: (p: number) => void) {
  const feitas = new Set(sess.partes)
  const tamParte = (n: number) => (n < sess.parts_total ? sess.part_size : f.size - (sess.parts_total - 1) * sess.part_size)
  let ok = 0
  for (const n of feitas) ok += tamParte(n)
  onPct(Math.min(99, Math.round((ok / f.size) * 100)))
  for (let n = 1; n <= sess.parts_total; n++) {
    if (feitas.has(n)) continue
    if (alvo.cancelado) throw new Error('cancelado')
    await enviaParte(sess, f, n, alvo)
    ok += tamParte(n)
    onPct(Math.min(99, Math.round((ok / f.size) * 100)))
  }
  const res = await postJson(`/uploads/${sess.id}/complete`, {})
  const body = await res.json()
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
  onPct(100)
}

async function cancelaSessao(sess?: SessaoUpload) {
  if (!sess) return
  try { await api(`/uploads/${sess.id}`, { method: 'DELETE' }) } catch { /* melhor esforço */ }
}

async function enviarLote() {
  if (loteCanais.value.length === 0) {
    msg.value = '✖ escolha pelo menos um canal pro lote'
    return
  }
  loteEnviando.value = true
  const fila = lote.value.filter((i) => i.status !== 'na fila')
  // 1º: TODAS as sessões reservadas antes de qualquer byte — um reload no
  // meio não perde mais nenhum item do lote (todos ficam retomáveis)
  for (const item of fila) {
    item.cancelado = false
    try {
      item.sess = await criaSessao(
        { id: item.id, tipo: item.tipo, titulo: item.titulo, series: item.series, ep: item.ep, canais: loteCanais.value },
        item.file,
      )
      item.status = 'reservado'
    } catch (e) {
      item.status = `erro: ${(e as Error).message}`
    }
  }
  // 2º: um arquivo por vez, partes com retry, cancelável por item
  for (const item of fila) {
    if (!item.sess || item.cancelado || item.status.startsWith('erro')) continue
    try {
      await enviaArquivo(item.sess, item.file, item, (p) => {
        item.pct = p
        item.status = `enviando ${p}%`
      })
      item.status = 'na fila'
    } catch (e) {
      if ((e as Error).message === 'cancelado') {
        await cancelaSessao(item.sess)
        item.status = 'cancelado'
      } else {
        item.status = `erro: ${(e as Error).message}`
      }
    }
    refresh()
  }
  loteEnviando.value = false
  const okCount = fila.filter((i) => i.status === 'na fila').length
  msg.value = `✔ lote: ${okCount}/${fila.length} na fila — a fábrica processa um por vez`
}

function cancelarItem(item: ItemLote) {
  item.cancelado = true
  item.ctrl?.abort()
  if (item.status === 'reservado' || item.status === 'pronto') {
    cancelaSessao(item.sess)
    item.status = 'cancelado'
  }
}

async function tentarDeNovo(item: ItemLote) {
  item.cancelado = false
  item.status = 'retomando…'
  try {
    // o servidor devolve a MESMA sessão (fingerprint) com as partes já feitas
    item.sess = await criaSessao(
      { id: item.id, tipo: item.tipo, titulo: item.titulo, series: item.series, ep: item.ep, canais: loteCanais.value },
      item.file,
    )
    await enviaArquivo(item.sess, item.file, item, (p) => {
      item.pct = p
      item.status = `enviando ${p}%`
    })
    item.status = 'na fila'
    refresh()
  } catch (e) {
    item.status = `erro: ${(e as Error).message}`
  }
}

// ── retomada pós-reload: reanexar arquivos e casar com as sessões ──────────
async function reanexar(ev: Event) {
  const input = ev.target as HTMLInputElement
  const files = [...(input.files ?? [])].filter((f) => f.size > 0)
  input.value = ''
  if (files.length === 0) return
  const casadas: Retomada[] = []
  for (const p of pendentesVisiveis.value) {
    // 1º tenta o fingerprint completo (com caminho relativo — distingue
    // arquivos de mesmo nome em subpastas diferentes)…
    let f = files.find((f) =>
      relDe(f) === p.file_rel && f.name === p.file_name && f.size === p.file_size && f.lastModified === p.file_mtime)
    // …senão, aceita nome+tamanho+mtime quando o match é ÚNICO (pasta
    // reanexada como arquivos avulsos perde o caminho relativo)
    if (!f) {
      const cand = files.filter((f) => f.name === p.file_name && f.size === p.file_size && f.lastModified === p.file_mtime)
      if (cand.length === 1) f = cand[0]
    }
    if (f) casadas.push({ sess: p, file: f, status: 'aguardando…', pct: 0 })
  }
  const ignorados = files.length - casadas.length
  msg.value = casadas.length
    ? `retomando ${casadas.length} upload(s)${ignorados ? `; ${ignorados} arquivo(s) ignorados (já enviados antes ou sem upload pendente — nada sobe em dobro)` : ''}`
    : '✖ nenhum arquivo corresponde a um upload pendente (nome, tamanho e data precisam bater)'
  retomadas.value.push(...casadas)
  for (const r of casadas) await retomaUma(r)
}

async function retomaUma(r: Retomada) {
  try {
    const sess = await criaSessao(
      {
        id: r.sess.media_id, tipo: r.sess.tipo, titulo: r.sess.title,
        series: r.sess.series_id ?? '', ep: r.sess.episode ? String(r.sess.episode) : '',
        tags: r.sess.tags, canais: String(r.sess.canais ?? '').split(',').filter(Boolean),
      },
      r.file,
    )
    r.sess = { ...r.sess, ...sess }
    await enviaArquivo(sess, r.file, r, (p) => {
      r.pct = p
      r.status = `enviando ${p}%`
    })
    r.status = 'na fila'
    refresh()
  } catch (e) {
    r.status = (e as Error).message === 'cancelado' ? 'cancelado' : `erro: ${(e as Error).message}`
  }
}

function cancelarRetomada(r: Retomada) {
  r.cancelado = true
  r.ctrl?.abort()
}

async function descartar(p: any) {
  await api(`/uploads/${p.id}`, { method: 'DELETE' })
  fetchPendentes()
}

const cancelForm = ref<{ ctrl?: AbortController; cancelado?: boolean } | null>(null)
function cancelarForm() {
  if (cancelForm.value) {
    cancelForm.value.cancelado = true
    cancelForm.value.ctrl?.abort()
  }
}

async function submit() {
  if (!file.value) return
  if (form.value.canais.length === 0) {
    msg.value = '✖ escolha pelo menos um canal'
    return
  }
  sending.value = true
  msg.value = ''
  pct.value = 0
  const alvo: { ctrl?: AbortController; cancelado?: boolean } = {}
  cancelForm.value = alvo
  let sess: SessaoUpload | undefined
  try {
    sess = await criaSessao(
      {
        id: form.value.id, tipo: form.value.tipo, titulo: form.value.title,
        series: form.value.series_id, ep: form.value.episode, tags: form.value.tags,
        canais: form.value.canais,
      },
      file.value,
    )
    formSess.value = sess.id
    await enviaArquivo(sess, file.value, alvo, (n) => (pct.value = n))
    msg.value = `✔ "${form.value.title}" entrou na fila — a fábrica processa em instantes`
    file.value = null
    meta.value = null
    refresh()
  } catch (e) {
    if ((e as Error).message === 'cancelado') {
      await cancelaSessao(sess)
      msg.value = 'upload cancelado'
    } else {
      msg.value = `✖ ${(e as Error).message}`
    }
    fetchPendentes()
  } finally {
    sending.value = false
    cancelForm.value = null
    formSess.value = ''
  }
}

async function retryJob(j: any) {
  const res = await postJson(`/jobs/${j.id}/retry`, {})
  const body = await res.json().catch(() => ({} as { error?: string }))
  msg.value = res.ok ? `↻ "${j.id}" de volta na fila — a fábrica acorda sozinha` : `✖ ${body.error ?? res.status}`
  refresh()
}

async function cancelJob(j: any) {
  const proc = j.status === 'processing'
  if (!confirm(proc
    ? `Cancelar "${j.id}"? Está processando — a fábrica pode terminar o download em andamento, mas ele sai da fila.`
    : `Cancelar "${j.id}"? Sai da fila e não será processado.`)) return
  const res = await postJson(`/jobs/${j.id}/cancel`, {})
  const body = await res.json().catch(() => ({} as { error?: string }))
  msg.value = res.ok ? `✕ "${j.id}" cancelado` : `✖ ${body.error ?? res.status}`
  refresh()
}

async function toggle(m: any) {
  await postJson(`/media/${m.id}/status`, { status: m.status === 'ready' ? 'disabled' : 'ready' })
  refresh()
}

// ── zona de perigo: deleção física e irreversível ──────────────────────────
// Só aparece pra mídia já desativada; o backend re-valida tudo de novo
// (disabled + confirmação exata + fora da janela do player).
const del = ref<{ id: string; entendo: boolean; texto: string; busy: boolean; erro: string } | null>(null)
function abreDel(m: any) {
  del.value = { id: m.id, entendo: false, texto: '', busy: false, erro: '' }
}
async function confirmaDel() {
  if (!del.value) return
  del.value.busy = true
  del.value.erro = ''
  try {
    const res = await api(`/media/${del.value.id}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmacao: del.value.texto }),
    })
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
    msg.value = `✔ mídia apagada de vez (${body.segmentos_apagados} objetos removidos do R2)`
    del.value = null
    refresh()
  } catch (e) {
    if (del.value) {
      del.value.erro = (e as Error).message
      del.value.busy = false
    }
  }
}

const canaisDe = (m: any): string[] => (m.canais ? String(m.canais).split(',') : [])
const seriesOf = (m: any): string => {
  try { return JSON.parse(m.metadata).series_id ?? '' } catch { return '' }
}
async function saveSeries(m: any, val: string) {
  await postJson(`/media/${m.id}/series`, { series_id: val.trim() })
  refresh()
  fetchEstado()
}

async function toggleCanal(m: any, canalId: string) {
  const atual = canaisDe(m)
  const novos = atual.includes(canalId) ? atual.filter((c) => c !== canalId) : [...atual, canalId]
  await postJson(`/media/${m.id}/channels`, { channels: novos })
  refresh()
}

// ── área "A nomear" (fase 11c) ─────────────────────────────────────────────
const aNomear = computed(() => media.value.filter((m: any) => m.nome_ruim))
const nomeEdit = ref<Record<string, { title: string; series: string; ep: string; conf: number | null; msg?: string }>>({})
const nomearContexto = ref('')
const sugerindo = ref(false)

watch(media, () => {
  for (const m of media.value) {
    if (m.nome_ruim && !nomeEdit.value[m.id]) {
      let meta: any = {}
      try { meta = JSON.parse(m.metadata) } catch { /* segue */ }
      nomeEdit.value[m.id] = {
        title: meta.title ?? m.id,
        series: meta.series_id ?? '',
        ep: meta.episode ? String(meta.episode) : '',
        conf: null,
      }
    }
  }
})

async function sugerirNomes() {
  if (sugerindo.value || aNomear.value.length === 0) return
  sugerindo.value = true
  try {
    const res = await postJson('/media/nomear-sugestoes', {
      ids: aNomear.value.map((m: any) => m.id),
      contexto: nomearContexto.value,
    })
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
    for (const s of body.sugestoes ?? []) {
      nomeEdit.value[s.id] = {
        title: s.title,
        series: s.series_id ?? '',
        ep: s.episode ? String(s.episode) : '',
        conf: s.confianca,
      }
    }
    msg.value = `✨ ${body.sugestoes?.length ?? 0} sugestões preenchidas — revise e salve cada uma`
  } catch (e) {
    msg.value = `✖ ${(e as Error).message}`
  } finally {
    sugerindo.value = false
  }
}

async function salvarNome(m: any) {
  const e = nomeEdit.value[m.id]
  if (!e) return
  if (!e.title.trim()) {
    e.msg = '✖ título não pode ficar vazio'
    return
  }
  e.msg = 'salvando…'
  // série digitada "como gente" vira slug aqui mesmo (o servidor também aceita)
  const res = await postJson(`/media/${m.id}/renomear`, {
    title: e.title, series_id: e.series.trim() ? slug(e.series) : null, episode: e.ep ? Number(e.ep) : null,
  })
  const body = await res.json().catch(() => ({} as { error?: string }))
  if (res.ok) {
    e.msg = ''
    msg.value = `✔ "${e.title}" renomeado`
    refresh()
  } else {
    e.msg = `✖ ${body.error ?? `HTTP ${res.status}`}`
  }
}

async function nomeOk(m: any) {
  await postJson(`/media/${m.id}/nome-ok`, {})
  refresh()
}

// ── séries: canais em lote (correção "coloquei no canal errado") ──────────
const seriesCatalogo = computed(() => {
  const map = new Map<string, { sid: string; titulo: string; n: number; canais: Set<string> }>()
  for (const m of media.value) {
    const sid = seriesOf(m)
    if (!sid) continue
    const e = map.get(sid) ?? { sid, titulo: titleOf(m), n: 0, canais: new Set<string>() }
    e.n++
    for (const c of canaisDe(m)) e.canais.add(c)
    map.set(sid, e)
  }
  return [...map.values()]
})

async function toggleCanalSerie(s: { sid: string; canais: Set<string> }, canalId: string) {
  const atual = [...s.canais]
  const novos = atual.includes(canalId) ? atual.filter((c) => c !== canalId) : [...atual, canalId]
  const res = await postJson(`/series/${s.sid}/channels`, { channels: novos })
  const body = await res.json()
  msg.value = res.ok
    ? `✔ série ${s.sid}: canais aplicados a ${body.midias} episódio(s), grade reajustada`
    : `✖ ${body.error ?? res.status}`
  refresh()
}

// ── Modo God (flag discreta no rodapé) ─────────────────────────────────────
async function toggleGod() {
  god.value = !god.value
  await postJson('/config', { k: 'god_mode', v: god.value ? '1' : '0' })
}

const identSaving = ref('')
async function saveIdentidade(ch: any) {
  identSaving.value = ch.id
  await postJson(`/channels/${ch.id}`, { identidade: ch.identidade })
  identSaving.value = ''
}

// quantos episódios da mesma série o diretor emenda em sequência na grade
// (muda o pool → o backend replaneja o canal na hora)
const blocoSaving = ref('')
async function saveBloco(ch: any, valor: string) {
  const n = Number(valor)
  ch.episodios_por_bloco = n
  blocoSaving.value = ch.id
  await postJson(`/channels/${ch.id}`, { episodios_por_bloco: n })
  blocoSaving.value = ''
  msg.value = n === 1
    ? `✔ ${ch.nome}: episódios sem agrupar — grade replanejada`
    : `✔ ${ch.nome}: agrupando até ${n} episódios seguidos por série — grade replanejada`
}

async function replanejar() {
  msg.value = '… replanejando a grade de todos os canais'
  await postJson('/schedule/run', { rebuild: true })
  msg.value = '✔ grade replanejada (o bloco no ar foi preservado)'
}

// ── chat do Diretor ────────────────────────────────────────────────────────
const chatKey = () => `bieltv_god_chat_${chatCanal.value}`

function carregaChat() {
  try { chatMsgs.value = JSON.parse(localStorage.getItem(chatKey()) ?? '[]') } catch { chatMsgs.value = [] }
  fetchEstado()
}

async function fetchEstado() {
  if (!chatCanal.value) return
  try { estado.value = await (await api(`/diretor/estado?canal=${chatCanal.value}`)).json() } catch { /* poll */ }
}

async function enviarChat() {
  const texto = chatInput.value.trim()
  if (!texto || chatBusy.value) return
  chatInput.value = ''
  chatMsgs.value.push({ role: 'user', text: texto })
  chatBusy.value = true
  try {
    const res = await postJson('/diretor/chat', {
      canal: chatCanal.value,
      mensagens: chatMsgs.value.slice(-12).map((m) => ({ role: m.role, text: m.text })),
    })
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
    chatMsgs.value.push({
      role: 'diretor',
      text: body.resposta,
      acoes: [...(body.acoes_executadas ?? []), ...(body.acoes_recusadas ?? []).map((r: string) => `✖ ${r}`)],
    })
    fetchEstado()
  } catch (e) {
    chatMsgs.value.push({ role: 'diretor', text: `⚠️ ${(e as Error).message}` })
  } finally {
    chatBusy.value = false
    localStorage.setItem(chatKey(), JSON.stringify(chatMsgs.value.slice(-40)))
  }
}

// fase 10a: o diretor decide a noite agora (mesmo cérebro do cron das 03:00)
const planejando = ref(false)
async function decidirANoite() {
  if (planejando.value) return
  planejando.value = true
  chatMsgs.value.push({ role: 'user', text: `🌙 Diretor, decida a noite do canal ${nomeCanal(chatCanal.value)}.` })
  try {
    const res = await postJson('/diretor/planejar', { canal: chatCanal.value })
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
    const d = (body.decisoes ?? [])[0]
    chatMsgs.value.push({
      role: 'diretor',
      text: d?.fez
        ? `Decidido: maratona de ${d.series_id} hoje, ${d.inicio.slice(11)} → ${d.fim.slice(11)}. ${d.motivo}`
        : `Hoje não teremos maratona: ${d?.motivo ?? 'sem decisão'}`,
      acoes: d?.fez ? [`maratona de ${d.series_id}: ${d.inicio} → ${d.fim}`] : [],
    })
    fetchEstado()
  } catch (e) {
    chatMsgs.value.push({ role: 'diretor', text: `⚠️ ${(e as Error).message}` })
  } finally {
    planejando.value = false
    localStorage.setItem(chatKey(), JSON.stringify(chatMsgs.value.slice(-40)))
  }
}

async function cancelarDiretriz(id: number) {
  await postJson(`/diretor/diretriz/${id}/cancelar`, {})
  fetchEstado()
}
async function cancelarEvento(id: number) {
  await postJson(`/diretor/evento/${id}/cancelar`, {})
  fetchEstado()
}

const STATUS_PT: Record<string, string> = {
  queued: 'na fila', processing: 'processando', done: 'concluído', error: 'erro',
}
const titleOf = (m: any) => {
  try { return JSON.parse(m.metadata).title ?? m.id } catch { return m.id }
}
const fmtDur = (s: number) => `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
const nomeCanal = (id: string) => channels.value.find((c) => c.id === id)?.nome ?? id

// ── ingestão de playlist (episódios em partes) ──────────────────────────────
const plUrl = ref('')
const plSerie = ref('')
const plTemporada = ref('')
const plCanais = ref<string[]>([])
const plBusy = ref(false)
const analises = ref<any[]>([])
const plSel = ref<Record<string, number[]>>({})
const PL_STATUS: Record<string, string> = {
  listando: 'listando', analisando: 'classificando', revisar: 'revisar', confirmado: 'na fila', error: 'erro',
}
const ehPlaylist = computed(() => /[?&]list=/.test(plUrl.value))
const analisesRevisar = computed(() => analises.value.filter((a) => a.status === 'revisar').length)
const gruposDe = (pl: any) => { try { return JSON.parse(pl.grupos) } catch { return null } }
const epsOk = (pl: any) => (gruposDe(pl)?.episodios ?? []).filter((e: any) => e.ok).map((e: any) => e.episodio)

async function carregaAnalises() {
  try {
    analises.value = await (await api('/playlist')).json()
    // default: pré-seleciona todos os episódios OK das análises recém-prontas
    for (const pl of analises.value) {
      if (pl.status === 'revisar' && !plSel.value[pl.id]) plSel.value[pl.id] = epsOk(pl)
    }
  } catch { /* poll cobre */ }
}

async function analisarPlaylist() {
  if (!ehPlaylist.value) { msg.value = '✖ o link precisa ser de playlist (ter "list=")'; return }
  if (plCanais.value.length === 0) { msg.value = '✖ escolha pelo menos um canal'; return }
  plBusy.value = true
  msg.value = ''
  try {
    const res = await postJson('/playlist', {
      url: plUrl.value.trim(),
      canais: plCanais.value.join(','),
      series_id: plSerie.value.trim() || undefined,
      temporada: plTemporada.value ? Number(plTemporada.value) : undefined,
    })
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
    msg.value = '🎬 analisando — a fábrica lista os vídeos e a IA agrupa as partes (a revisão aparece abaixo em instantes)'
    plUrl.value = ''
    carregaAnalises()
  } catch (e) {
    msg.value = `✖ ${(e as Error).message}`
  } finally {
    plBusy.value = false
  }
}

const plSelDe = (id: string) => plSel.value[id] ?? []
function plToggle(id: string, ep: number) {
  const cur = plSelDe(id)
  plSel.value[id] = cur.includes(ep) ? cur.filter((n) => n !== ep) : [...cur, ep]
}
function plPrimeiros(pl: any, n: number) { plSel.value[pl.id] = epsOk(pl).slice(0, n) }
function plTodos(pl: any) { plSel.value[pl.id] = epsOk(pl) }
function plLimpar(id: string) { plSel.value[id] = [] }

function plEstimativa(pl: any): string {
  const g = gruposDe(pl)
  if (!g) return ''
  const sel = new Set(plSelDe(pl.id))
  const eps = (g.episodios ?? []).filter((e: any) => sel.has(e.episodio))
  const partes = eps.reduce((s: number, e: any) => s + e.partes.length, 0)
  const conteudoMin = Math.round(partes * 4)          // ~4min por parte
  const runnerMin = Math.max(1, Math.round(conteudoMin * 0.4)) // ~22min ep ≈ 8min runner
  return `${eps.length} episódio(s) · ${partes} partes · ~${conteudoMin}min de vídeo · ~${runnerMin}min de fábrica`
}

async function confirmarPlaylist(pl: any) {
  const episodios = plSelDe(pl.id)
  if (episodios.length === 0) { msg.value = '✖ escolha ao menos um episódio'; return }
  try {
    const res = await postJson(`/playlist/${pl.id}/confirmar`, { episodios })
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
    msg.value = `✔ ${body.criados.length} episódio(s) na fila${body.pulados?.length ? ` · ${body.pulados.length} pulado(s) (partes incompletas)` : ''} — a fábrica baixa e junta as partes`
    carregaAnalises()
    refresh()
  } catch (e) {
    msg.value = `✖ ${(e as Error).message}`
  }
}

watch(chatCanal, carregaChat)

onMounted(() => {
  if (token.value) enter()
  poll = setInterval(refresh, 4000)
})
onBeforeUnmount(() => clearInterval(poll))
</script>

<template>
  <header class="topbar">
    <div class="brand"><span class="brand-dot" />BIEL<b>TV</b> <span class="admin-tag">ADMIN</span></div>
    <a class="back" href="/">← voltar pra TV</a>
  </header>

  <main v-if="!authed" class="gate">
    <div class="card">
      <h2>Painel do canal</h2>
      <p class="dim">Cole o token de administração pra entrar.</p>
      <div class="row">
        <input v-model="token" type="password" placeholder="token" @keyup.enter="enter" />
        <button class="primary" @click="enter">entrar</button>
      </div>
      <p v-if="authMsg" class="err">{{ authMsg }}</p>
    </div>
  </main>

  <div v-else class="admin-shell">
    <nav class="sidebar">
      <button class="nav-item" :class="{ on: aba === 'enviar' }" @click="aba = 'enviar'">
        <span class="nav-ico">📤</span> Enviar
        <span v-if="pendentesVisiveis.length" class="nav-badge" title="uploads interrompidos">{{ pendentesVisiveis.length }}</span>
      </button>
      <button class="nav-item" :class="{ on: aba === 'playlist' }" @click="aba = 'playlist'">
        <span class="nav-ico">🎬</span> Playlist
        <span v-if="analisesRevisar" class="nav-badge" title="playlists aguardando revisão">{{ analisesRevisar }}</span>
      </button>
      <button class="nav-item" :class="{ on: aba === 'fabrica' }" @click="aba = 'fabrica'">
        <span class="nav-ico">🏭</span> Fábrica
        <span v-if="fabJobsAtivos.length" class="nav-badge azul" title="comerciais em montagem">{{ fabJobsAtivos.length }}</span>
      </button>
      <button class="nav-item" :class="{ on: aba === 'fila' }" @click="aba = 'fila'">
        <span class="nav-ico">⚙️</span> Fila
        <span v-if="jobsAtivos.length" class="nav-badge azul" title="processando/na fila">{{ jobsAtivos.length }}</span>
      </button>
      <button class="nav-item" :class="{ on: aba === 'catalogo' }" @click="aba = 'catalogo'">
        <span class="nav-ico">📚</span> Catálogo
        <span v-if="aNomear.length" class="nav-badge" title="a nomear">{{ aNomear.length }}</span>
      </button>
      <button class="nav-item" :class="{ on: aba === 'promessas' }" @click="aba = 'promessas'">
        <span class="nav-ico">📣</span> Promessas
        <span v-if="promPendentes.length" class="nav-badge" title="promessas pendentes">{{ promPendentes.length }}</span>
      </button>
      <button v-if="god" class="nav-item god" :class="{ on: aba === 'diretor' }" @click="aba = 'diretor'">
        <span class="nav-ico">⚡</span> Diretor
      </button>
    </nav>

    <main class="content">
      <p v-if="msg" class="global-msg" :class="msg.startsWith('✖') ? 'err' : 'ok'">{{ msg }}</p>

      <section v-show="aba === 'enviar'" class="card">
      <h2>Enviar mídia</h2>
      <input type="file" accept="video/*" multiple @change="onPick" />
      <label class="pasta-btn">
        📁 ou enviar uma pasta inteira (ex.: "pwr rangers/001.mp4, 002.mp4…")
        <input type="file" webkitdirectory multiple class="oculto" @change="onPick" />
      </label>
      <div class="row link-row">
        <input
          v-model="ytUrl"
          placeholder="🔗 ou cole um link (YouTube, archive.org…) e a fábrica baixa sozinha"
          @keyup.enter="buscarLink"
        />
        <button class="ghost" :disabled="ytBusy" @click="buscarLink">{{ ytBusy ? '…' : 'buscar' }}</button>
      </div>

      <div class="cookies-box">
        <button class="ghost small cookies-toggle" @click="mostraCookies = !mostraCookies">
          🍪 cookies do YouTube
          <span :class="ytCookiesStatus?.configurado ? 'ok' : 'dim'">
            {{ ytCookiesStatus?.configurado ? '✓ configurados' : '— não configurados' }}
          </span>
        </button>
        <div v-if="mostraCookies" class="cookies-panel">
          <p class="dim small">
            Se um vídeo do YouTube falhar com "faça login", os cookies venceram. Exporte de novo
            (extensão <b>Get cookies.txt LOCALLY</b> ou <b>Cookie-Editor</b>, num perfil/janela novos,
            e feche sem navegar), cole aqui e salve — aceita o .txt (Netscape) OU o JSON, e os vídeos
            que falharam voltam pra fila sozinhos.
          </p>
          <textarea v-model="ytCookiesTexto" rows="4" placeholder="cole o cookies.txt (Netscape) OU o JSON (Cookie-Editor) inteiro" />
          <button class="primary" :disabled="salvandoCookies" @click="salvarCookies">
            {{ salvandoCookies ? 'salvando…' : 'salvar cookies e tentar de novo' }}
          </button>
        </div>
      </div>

      <template v-if="linkPronto">
        <div class="form">
          <label>Título <input v-model="form.title" /></label>
          <label>Tipo
            <select v-model="form.tipo">
              <option value="episodio">episódio</option>
              <option value="filme">filme</option>
              <option value="comercial">comercial</option>
              <option value="vinheta">vinheta</option>
            </select>
          </label>
          <label>ID <input v-model="form.id" /></label>
          <div class="row">
            <label>Série <input v-model="form.series_id" placeholder="opcional" /></label>
            <label>Ep nº <input v-model="form.episode" placeholder="opcional" /></label>
          </div>
          <div class="canais-check">
            <span class="dim small">Canais:</span>
            <label v-for="c in channels" :key="c.id" class="check">
              <input type="checkbox" :value="c.id" v-model="form.canais" /> {{ c.nome }}
            </label>
          </div>
          <button class="primary" :disabled="sending" @click="enviarLink">
            {{ sending ? 'enviando…' : 'baixar e colocar na fila' }}
          </button>
        </div>
      </template>

      <template v-if="file && meta">
        <p class="dim">
          {{ file.name }} · {{ fmtDur(Math.round(meta.duration)) }} · {{ meta.width }}x{{ meta.height }}
          — sugestões preenchidas, ajuste se precisar:
        </p>
        <div class="form">
          <label>Título <input v-model="form.title" /></label>
          <label>Tipo
            <select v-model="form.tipo">
              <option value="episodio">episódio</option>
              <option value="filme">filme</option>
              <option value="comercial">comercial</option>
              <option value="vinheta">vinheta</option>
            </select>
          </label>
          <label>ID <input v-model="form.id" /></label>
          <div class="row">
            <label>Série <input v-model="form.series_id" placeholder="opcional" /></label>
            <label>Ep nº <input v-model="form.episode" placeholder="opcional" /></label>
          </div>
          <label>Tags <input v-model="form.tags" placeholder="acao,anos90" /></label>
          <div class="canais-check">
            <span class="dim small">Canais:</span>
            <label v-for="c in channels" :key="c.id" class="check">
              <input type="checkbox" :value="c.id" v-model="form.canais" /> {{ c.nome }}
            </label>
          </div>
          <div class="row">
            <button class="primary" :disabled="sending" @click="submit">
              {{ sending ? `enviando… ${pct}%` : 'enviar pra fila' }}
            </button>
            <button v-if="sending" class="ghost" @click="cancelarForm">cancelar</button>
          </div>
          <div v-if="sending" class="bar"><div class="bar-fill" :style="{ width: pct + '%' }" /></div>
        </div>
      </template>

      <template v-if="lote.length">
        <p class="dim">{{ lote.length }} vídeos no lote — série e episódio deduzidos da pasta; ajuste o que precisar:</p>
        <div class="canais-check">
          <span class="dim small">Canais do lote:</span>
          <label v-for="c in channels" :key="c.id" class="check">
            <input type="checkbox" :value="c.id" v-model="loteCanais" /> {{ c.nome }}
          </label>
        </div>
        <div v-for="item in lote" :key="item.rel || item.file.name" class="lote-row">
          <span class="mono">{{ item.id }}</span>
          <input v-model="item.titulo" class="lote-titulo" />
          <select v-model="item.tipo">
            <option value="episodio">ep</option>
            <option value="filme">filme</option>
            <option value="comercial">com</option>
            <option value="vinheta">vin</option>
          </select>
          <span class="chip" :class="item.status === 'na fila' ? 'st-done' : item.status.startsWith('erro') || item.status === 'cancelado' ? 'st-error' : 'st-queued'">{{ item.status }}</span>
          <button
            v-if="item.status.startsWith('enviando') || item.status === 'reservado'"
            class="ghost" title="cancelar este item" @click="cancelarItem(item)"
          >✕</button>
          <button
            v-else-if="item.status.startsWith('erro') || item.status === 'cancelado'"
            class="ghost" title="tentar de novo (continua de onde parou)" @click="tentarDeNovo(item)"
          >↻</button>
        </div>
        <button class="primary" :disabled="loteEnviando" @click="enviarLote">
          {{ loteEnviando ? 'enviando lote…' : `enviar ${lote.length} pra fila` }}
        </button>
      </template>

      <template v-if="pendentesVisiveis.length || retomadas.length">
        <h2 class="mt">Uploads interrompidos</h2>
        <p class="dim">
          O navegador não guarda o arquivo depois de um reload — reanexe o(s) mesmo(s)
          arquivo(s) (ou a pasta inteira) e o envio continua de onde parou. Pode mandar
          a pasta toda sem medo: o que já subiu é ignorado e só as partes que faltam
          são enviadas.
        </p>
        <div class="row">
          <label class="pasta-btn grow">
            📎 reanexar arquivo(s)
            <input type="file" multiple class="oculto reanexa-arquivos" @change="reanexar" />
          </label>
          <label class="pasta-btn grow">
            📁 reanexar a pasta
            <input type="file" webkitdirectory multiple class="oculto reanexa-pasta" @change="reanexar" />
          </label>
        </div>
        <div v-for="p in pendentesVisiveis" :key="p.id" class="job-row">
          <span class="mono">{{ p.media_id }}</span>
          <span class="dim grow">{{ p.title }} · {{ p.partes.length }}/{{ p.parts_total }} partes enviadas</span>
          <span class="chip st-queued">interrompido</span>
          <button class="ghost" title="abandona e limpa este upload" @click="descartar(p)">descartar</button>
        </div>
        <div v-for="r in retomadas" :key="r.sess.id" class="job-row">
          <span class="mono">{{ r.sess.media_id }}</span>
          <span class="dim grow">{{ r.sess.title }}</span>
          <span class="chip" :class="r.status === 'na fila' ? 'st-done' : r.status.startsWith('erro') || r.status === 'cancelado' ? 'st-error' : 'st-queued'">{{ r.status }}</span>
          <button
            v-if="r.status.startsWith('enviando') || r.status.startsWith('aguardando')"
            class="ghost" @click="cancelarRetomada(r)"
          >✕</button>
        </div>
      </template>
      </section>

      <section v-show="aba === 'playlist'" class="card">
        <h2>🎬 Séries em partes (playlist)</h2>
        <p class="dim small">
          Cole o link de uma playlist do YouTube onde cada episódio vem <b>partido em vários pedaços</b>.
          A fábrica lista tudo, a IA agrupa as partes de cada episódio <b>na ordem certa</b> (pelo número no
          título, nunca pela posição na lista) e você escolhe quantos episódios baixar.
        </p>
        <div class="form">
          <label>Link da playlist
            <input v-model="plUrl" placeholder="https://youtube.com/playlist?list=…" @keyup.enter="analisarPlaylist" />
          </label>
          <div class="row">
            <label>Série <input v-model="plSerie" placeholder="ex.: jake_long (opcional)" /></label>
            <label>Temporada <input v-model="plTemporada" placeholder="opcional" /></label>
          </div>
          <div class="canais-check">
            <span class="dim small">Canais:</span>
            <label v-for="c in channels" :key="c.id" class="check">
              <input type="checkbox" :value="c.id" v-model="plCanais" /> {{ c.nome }}
            </label>
          </div>
          <p v-if="plUrl && !ehPlaylist" class="err small">esse link não tem "list=" — não parece uma playlist</p>
          <button class="primary" :disabled="plBusy || !ehPlaylist" @click="analisarPlaylist">
            {{ plBusy ? 'analisando…' : 'analisar playlist' }}
          </button>
        </div>

        <p v-if="analises.length === 0" class="dim">nenhuma playlist analisada ainda</p>
        <div v-for="pl in analises" :key="pl.id" class="pl-analise">
          <div class="pl-head">
            <span class="mono small grow">{{ pl.url }}</span>
            <span class="chip" :class="`pl-${pl.status}`">{{ PL_STATUS[pl.status] ?? pl.status }}</span>
          </div>
          <p v-if="pl.status === 'listando' || pl.status === 'analisando'" class="dim small">
            ⏳ listando os vídeos e agrupando as partes…
          </p>
          <p v-if="pl.status === 'error'" class="err small">{{ pl.error }}</p>
          <p v-if="pl.status === 'confirmado'" class="ok small">✔ episódios enviados pra fila — acompanhe na aba Fila</p>

          <template v-if="pl.status === 'revisar' && gruposDe(pl)">
            <div class="pl-atalhos">
              <span class="dim small">baixar:</span>
              <button class="ghost small" @click="plPrimeiros(pl, 5)">primeiros 5</button>
              <button class="ghost small" @click="plPrimeiros(pl, 10)">primeiros 10</button>
              <button class="ghost small" @click="plTodos(pl)">temporada toda</button>
              <button class="ghost small" @click="plLimpar(pl.id)">limpar</button>
            </div>
            <p v-if="gruposDe(pl).sem_classificacao?.length" class="err small">
              ⚠️ {{ gruposDe(pl).sem_classificacao.length }} vídeo(s) sem episódio identificado — revise na origem
            </p>
            <div class="pl-eps">
              <label v-for="e in gruposDe(pl).episodios" :key="e.episodio" class="pl-ep" :class="{ ruim: !e.ok }">
                <input type="checkbox" :disabled="!e.ok" :checked="plSelDe(pl.id).includes(e.episodio)"
                  @change="plToggle(pl.id, e.episodio)" />
                <span class="mono small">{{ e.media_id || ('ep ' + e.episodio) }}</span>
                <span class="dim grow">{{ e.titulo }}</span>
                <span class="dim small">{{ e.partes.length }} partes</span>
                <span v-if="!e.ok" class="err small">⚠️ {{ e.aviso }}</span>
              </label>
            </div>
            <p class="dim small">{{ plEstimativa(pl) }}</p>
            <button class="primary" :disabled="plSelDe(pl.id).length === 0" @click="confirmarPlaylist(pl)">
              baixar {{ plSelDe(pl.id).length }} episódio(s)
            </button>
          </template>
        </div>
      </section>

      <section v-show="aba === 'fabrica'" class="card">
        <h2>Fábrica de comerciais</h2>
        <div class="fab-grid">
          <div class="fab-panel fab-main">
            <h3>Montar comercial</h3>
            <div class="form">
              <div class="row">
                <label>Molde
                  <select v-model="buildForm.molde_id">
                    <option value="">escolha</option>
                    <option v-for="m in fabrica.moldes" :key="m.id" :value="m.id">{{ m.nome }} · {{ nomeCanal(m.canal) }}</option>
                  </select>
                </label>
                <label>Programa
                  <select v-model="buildForm.series_id" @change="sugereComercialId">
                    <option value="">escolha</option>
                    <option v-for="s in fabrica.series" :key="s.sid" :value="s.sid">{{ s.titulo }} · {{ s.sid }}</option>
                  </select>
                </label>
              </div>
              <div class="row">
                <label>Hora <input v-model="buildForm.hora" type="time" @change="sugereComercialId" /></label>
                <label>ID final <input v-model="buildForm.media_id" placeholder="com_power_rangers_16h" /></label>
              </div>
              <div class="fab-days">
                <button
                  v-for="d in DIAS_FAB"
                  :key="d.n"
                  class="chip chip-btn"
                  :class="{ 'chip-on': buildForm.dias.includes(d.n) }"
                  @click="toggleDiaFab(d.n)"
                >{{ d.label }}</button>
              </div>
              <div class="row">
                <label>Amostra
                  <select v-model="buildForm.sample_id">
                    <option value="">automática</option>
                    <option v-for="s in samplesDaSerie" :key="s.id" :value="s.id">{{ s.rotulo }}</option>
                  </select>
                </label>
                <label>Frase
                  <select v-model="buildForm.frase_id">
                    <option value="">sortear/última cadastrada</option>
                    <option v-for="f in frasesDaSerie" :key="f.id" :value="f.id">{{ f.rotulo }}</option>
                  </select>
                </label>
              </div>
              <label>Título no catálogo <input v-model="buildForm.title" placeholder="opcional" /></label>
              <button class="primary" :disabled="fabBusy" @click="montarComercial">
                {{ fabBusy ? 'trabalhando…' : 'montar comercial' }}
              </button>
            </div>
          </div>

          <div class="fab-panel">
            <h3>Clipes de fala</h3>
            <div class="form">
              <div class="row">
                <label>Categoria
                  <select v-model="clipForm.categoria">
                    <option value="frase">frase</option>
                    <option value="nome">nome</option>
                    <option value="frequencia">frequência</option>
                    <option value="horario">horário</option>
                    <option value="conector">conector</option>
                  </select>
                </label>
                <label>Série <input v-model="clipForm.series_id" placeholder="só nome/frase" /></label>
              </div>
              <label>Chave <input v-model="clipForm.chave" placeholder="16:00, seg-sex, todos..." /></label>
              <label>Rótulo falado <input v-model="clipForm.rotulo" placeholder="às quatro da tarde" /></label>
              <input type="file" accept="audio/*,video/*" @change="onClipFile" />
              <button class="ghost" :disabled="fabBusy" @click="salvarClip">salvar fala</button>
            </div>
            <div class="fab-list">
              <div v-for="c in fabrica.voice_clips.slice(0, 14)" :key="c.id" class="fab-mini">
                <span class="mono">{{ c.categoria }}</span>
                <span class="dim grow">{{ c.series_id || c.chave }} · {{ c.rotulo }}</span>
                <button class="ghost" title="remover clipe" @click="apagarFab('voice-clips', c.id)">✕</button>
              </div>
            </div>
          </div>

          <div class="fab-panel">
            <h3>Amostras</h3>
            <div class="form">
              <label>Série <input v-model="sampleForm.series_id" placeholder="power_rangers_forca_animal" /></label>
              <label>Rótulo <input v-model="sampleForm.rotulo" placeholder="cortes de ação 01" /></label>
              <input type="file" accept="video/*" @change="onSampleFile" />
              <button class="ghost" :disabled="fabBusy" @click="salvarSample">salvar amostra</button>
            </div>
            <div class="fab-list">
              <div v-for="s in fabrica.samples.slice(0, 10)" :key="s.id" class="fab-mini">
                <span class="mono">{{ s.series_id }}</span>
                <span class="dim grow">{{ s.rotulo }}</span>
                <button class="ghost" title="remover amostra" @click="apagarFab('samples', s.id)">✕</button>
              </div>
            </div>
          </div>

          <div class="fab-panel">
            <h3>Moldes</h3>
            <div class="form">
              <label>Nome <input v-model="moldeForm.nome" /></label>
              <label>Canal
                <select v-model="moldeForm.canal">
                  <option v-for="c in channels" :key="c.id" :value="c.id">{{ c.nome }}</option>
                </select>
              </label>
              <input type="file" accept="image/png" @change="onMoldeFile" />
              <input type="file" accept="audio/*" @change="onMusicaFile" />
              <button class="ghost" :disabled="fabBusy" @click="salvarMolde">salvar molde</button>
            </div>
            <div class="fab-list">
              <div v-for="m in fabrica.moldes" :key="m.id" class="fab-mini">
                <span class="mono">{{ m.canal }}</span>
                <span class="dim grow">{{ m.nome }}{{ m.musica_key ? ' · música' : '' }}</span>
                <button class="ghost" title="remover molde" @click="apagarFab('moldes', m.id)">✕</button>
              </div>
            </div>
          </div>
        </div>

        <h2 class="mt">Jobs da fábrica</h2>
        <p v-if="fabrica.jobs.length === 0" class="dim">nenhum comercial montado por aqui ainda</p>
        <div v-for="j in fabrica.jobs" :key="j.id" class="job-row fab-job">
          <span class="mono">{{ j.media_id }}</span>
          <span class="dim grow">{{ j.title }}</span>
          <span v-if="j.status === 'processing' && j.progress > 0" class="mini-bar">
            <span class="mini-bar-fill" :style="{ width: j.progress + '%' }" />
          </span>
          <span class="chip" :class="`st-${j.status}`">
            {{ j.status === 'processing' && j.progress > 0 ? `montando ${j.progress}%` : (fabStatus[j.status] ?? j.status) }}
          </span>
          <button v-if="j.status === 'error'" class="ghost" title="tentar de novo" @click="retryFabJob(j)">↻</button>
          <span v-if="j.error" class="err small">{{ j.error }}</span>
        </div>
      </section>

      <section v-show="aba === 'fila'" class="card">
        <div class="fila-head">
          <h2>Fila de processamento</h2>
          <button
            class="ghost"
            title="o diretor apaga a grade futura e remonta do zero (o bloco no ar é preservado) — use depois de excluir/desativar vídeos"
            @click="replanejar"
          >🔄 diretor: reajustar a grade</button>
        </div>

        <div class="secao-sub">
          <span class="sub-label">Em andamento</span>
          <span class="dim small">{{ jobsAtivos.length }} ativo(s)</span>
        </div>
        <p v-if="jobsAtivos.length === 0" class="dim">nada processando no momento</p>
        <div v-for="j in jobsAtivos" :key="j.id" class="job-row">
          <span class="mono">{{ j.id }}</span>
          <span class="dim grow">{{ j.title }}</span>
          <span v-if="j.status === 'processing' && j.progress > 0" class="mini-bar">
            <span class="mini-bar-fill" :style="{ width: j.progress + '%' }" />
          </span>
          <span class="chip" :class="`st-${j.status}`">
            {{ j.status === 'processing' && j.progress > 0 ? `processando ${j.progress}%` : (STATUS_PT[j.status] ?? j.status) }}
          </span>
          <button class="ghost" title="cancelar (tira da fila)" @click="cancelJob(j)">✕</button>
          <span v-if="j.error" class="err small">{{ j.error }}</span>
        </div>

        <button
          v-if="jobsHistorico.length"
          class="ghost hist-toggle"
          @click="mostraHistorico = !mostraHistorico"
        >{{ mostraHistorico ? '▾' : '▸' }} Histórico ({{ jobsHistorico.length }})</button>
        <div v-show="mostraHistorico" class="hist-lista">
          <div v-for="j in jobsHistorico" :key="j.id" class="job-row">
            <span class="mono">{{ j.id }}</span>
            <span class="dim grow">{{ j.title }}</span>
            <span class="chip" :class="`st-${j.status}`">{{ STATUS_PT[j.status] ?? j.status }}</span>
            <button v-if="j.status === 'error'" class="ghost" title="tentar de novo (volta pra fila)" @click="retryJob(j)">↻</button>
            <button v-if="j.status === 'error'" class="ghost" title="cancelar (remove da lista)" @click="cancelJob(j)">✕</button>
            <span v-if="j.error" class="err small">{{ j.error }}</span>
          </div>
        </div>
      </section>

      <section v-show="aba === 'promessas'" class="card">
        <div class="fieis-row">
          <span class="dim small">comerciais por canal:</span>
          <button
            v-for="ch in channels"
            :key="ch.id"
            class="fieis-btn"
            :class="{ livre: ch.comerciais_fieis === 0 }"
            :disabled="trocandoFieis === ch.id"
            :title="ch.comerciais_fieis === 0 ? 'LIVRE: rodízio cego (acervo cru) — clique pra voltar ao fiel' : 'FIEL: promessa manda — clique pra liberar o acervo cru'"
            @click="toggleFieisCanal(ch)"
          >
            {{ trocandoFieis === ch.id ? '…' : ch.comerciais_fieis === 0 ? '🎲' : '🎯' }} {{ ch.nome }}
          </button>
          <span class="dim small">🎯 fiel · 🎲 livre</span>
        </div>

      <template v-if="promPendentes.length || promDecididas.length">
        <h2 class="mt">Promessas de comerciais</h2>
        <p class="dim">
          Comercial que promete programação ("a seguir…", horário) fica <b>fora do ar</b> até
          você decidir. Confirmado, ele só toca quando a grade cumpre a promessa.
        </p>
        <div v-for="p in promPendentes" :key="p.media_id" class="promessa">
          <div class="job-row">
            <span class="mono">{{ p.media_id }}</span>
            <span class="dim grow">{{ tituloPromessa(p) }}</span>
            <span class="chip st-queued">{{ TIPO_PROM[propostaDe(p)?.tipo] ?? 'analisando…' }}</span>
          </div>
          <p class="dim small transcript">🎙 “{{ (p.transcript ?? '').slice(0, 220) }}{{ (p.transcript ?? '').length > 220 ? '…' : '' }}”</p>
          <p v-if="propostaDe(p)?.descricao" class="small">🤖 {{ propostaDe(p).descricao }}</p>
          <div class="row">
            <input
              v-if="propostaDe(p)?.tipo === 'a_seguir' || propostaDe(p)?.tipo === 'durante'"
              v-model="serieAlvo[p.media_id]"
              class="series-input"
              :placeholder="propostaDe(p)?.series_id || 'série alvo (obrigatória)'"
            />
            <button class="primary" @click="decidePromessa(p, 'confirmada')">✔ confirmar</button>
            <button class="ghost" @click="decidePromessa(p, 'generico')">é genérico</button>
            <button class="ghost perigo" @click="decidePromessa(p, 'ignorar')">não usar</button>
            <button class="ghost" title="pede outra análise da IA (útil quando a proposta veio vazia)" @click="reanalisar(p)">🔄</button>
          </div>
        </div>
        <div v-for="p in promDecididas" :key="p.media_id" class="job-row">
          <span class="mono">{{ p.media_id }}</span>
          <span class="dim grow">{{ tituloPromessa(p) }}</span>
          <span class="chip" :class="p.status === 'confirmada' ? 'st-done' : 'st-error'">
            {{ p.status === 'confirmada'
              ? `cumprindo: ${TIPO_PROM[condicaoDe(p)?.tipo]}${condicaoDe(p)?.series_id ? ' ' + condicaoDe(p).series_id : ''}`
              : 'fora do ar' }}
          </span>
          <button class="ghost" @click="decidePromessa(p, 'pendente')">revisar</button>
        </div>
      </template>
      </section>

      <section v-show="aba === 'catalogo'" class="card">
      <template v-if="aNomear.length">
        <h2 class="mt">✏️ A nomear ({{ aNomear.length }})</h2>
        <p class="dim">
          Estes arquivos chegaram com nome ruim. Conta pra IA do que se trata o lote (ou
          renomeie na mão) — título, série e episódio de uma vez.
        </p>
        <div class="row">
          <input
            v-model="nomearContexto"
            placeholder='contexto pro lote, ex.: "são episódios dos Padrinhos Mágicos T3"'
          />
          <button class="primary" :disabled="sugerindo" @click="sugerirNomes">
            {{ sugerindo ? 'pensando…' : '✨ sugerir com IA' }}
          </button>
        </div>
        <div v-for="m in aNomear" :key="m.id" class="nomear-row">
          <span class="mono">{{ m.id }}</span>
          <template v-if="nomeEdit[m.id]">
            <input v-model="nomeEdit[m.id].title" class="nomear-titulo" placeholder="título bonito" />
            <input v-model="nomeEdit[m.id].series" class="nomear-serie" placeholder="série (slug)" />
            <input v-model="nomeEdit[m.id].ep" class="nomear-ep" placeholder="ep" />
            <span v-if="nomeEdit[m.id].conf !== null" class="chip st-queued">IA {{ Math.round((nomeEdit[m.id].conf ?? 0) * 100) }}%</span>
            <button class="ghost" @click="salvarNome(m)">salvar</button>
            <button class="ghost" title="o nome atual está bom — tira da fila" @click="nomeOk(m)">está bom</button>
            <span v-if="nomeEdit[m.id].msg" class="small" :class="nomeEdit[m.id].msg!.startsWith('✖') ? 'err' : 'dim'">{{ nomeEdit[m.id].msg }}</span>
          </template>
        </div>
      </template>

      <template v-if="seriesCatalogo.length">
        <h2 class="mt">Séries — canais em lote</h2>
        <p class="dim">Clique num canal pra colocar/tirar a série INTEIRA dele (a grade se reajusta na hora).</p>
        <div v-for="s in seriesCatalogo" :key="s.sid" class="job-row">
          <span class="mono">{{ s.sid }}</span>
          <span class="dim grow">{{ s.titulo }} · {{ s.n }} ep(s)</span>
          <span class="canal-chips">
            <button
              v-for="c in channels"
              :key="c.id"
              class="chip chip-btn"
              :class="{ 'chip-on': s.canais.has(c.id) }"
              @click="toggleCanalSerie(s, c.id)"
            >{{ c.nome }}</button>
          </span>
        </div>
      </template>

      <h2 class="mt">Catálogo</h2>
      <template v-for="m in media" :key="m.id">
        <div class="job-row wrapy">
          <span class="mono">{{ m.id }}</span>
          <span class="dim grow">{{ titleOf(m) }} · {{ fmtDur(m.duracao_seg) }}</span>
          <select class="tipo-select" :value="m.tipo" @change="mudarTipo(m, ($event.target as HTMLSelectElement).value)">
            <option value="episodio">episódio</option>
            <option value="filme">filme</option>
            <option value="comercial">comercial</option>
            <option value="vinheta">vinheta</option>
          </select>
          <span class="canal-chips">
            <button
              v-for="c in channels"
              :key="c.id"
              class="chip chip-btn"
              :class="{ 'chip-on': canaisDe(m).includes(c.id) }"
              :title="`${canaisDe(m).includes(c.id) ? 'remover de' : 'adicionar a'} ${c.nome}`"
              @click="toggleCanal(m, c.id)"
            >{{ c.nome }}</button>
          </span>
          <input
            class="series-input"
            :value="seriesOf(m)"
            placeholder="série (p/ excluir a temporada toda)"
            @change="saveSeries(m, ($event.target as HTMLInputElement).value)"
          />
          <span class="chip" :class="m.status === 'ready' ? 'st-done' : 'st-error'">{{ m.status }}</span>
          <button class="ghost" @click="toggle(m)">{{ m.status === 'ready' ? 'desativar' : 'ativar' }}</button>
          <button
            class="ghost perigo"
            title="apaga os arquivos e todos os registros — não tem volta"
            @click="abreDel(m)"
          >🗑 excluir de vez</button>
        </div>
        <div v-if="del && del.id === m.id" class="del-zone">
          <template v-if="m.status === 'ready'">
            <p class="small">
              <b>1º passo:</b> tirar do ar — o diretor remove os blocos futuros e reajusta a
              grade dos canais na hora (nada quebra pra quem está assistindo).
            </p>
            <div class="row">
              <button class="primary" @click="toggle(m)">tirar do ar e ajustar a grade</button>
              <button class="ghost" @click="del = null">voltar</button>
            </div>
          </template>
          <template v-else>
            <p class="err small">
              Isto apaga os segmentos do R2 e todos os registros desta mídia. <b>Não tem volta.</b>
              Se ela esteve no ar há instantes, aguarde ~5 min (janela do player).
            </p>
            <label class="check small dim">
              <input type="checkbox" v-model="del.entendo" /> entendo que a ação é irreversível
            </label>
            <div class="row">
              <input v-model="del.texto" :placeholder="`digite EXCLUIR ${m.id}`" spellcheck="false" />
              <button class="primary perigo-btn" :disabled="!del.entendo || del.busy" @click="confirmaDel">
                {{ del.busy ? 'apagando…' : 'apagar de vez' }}
              </button>
              <button class="ghost" @click="del = null">voltar</button>
            </div>
            <p v-if="del.erro" class="err small">{{ del.erro }}</p>
          </template>
        </div>
      </template>
      </section>

      <section v-show="god && aba === 'diretor'" class="card god-card">
      <h2>⚡ Modo God — fale com o Diretor</h2>
      <div class="chat-head">
        <select v-model="chatCanal" class="chat-canal">
          <option v-for="c in channels" :key="c.id" :value="c.id">{{ c.nome }}</option>
        </select>
        <button class="ghost" :disabled="planejando" title="o diretor olha a identidade do canal, as séries e o histórico e decide se hoje tem maratona" @click="decidirANoite">
          {{ planejando ? 'decidindo…' : '🌙 decidir a noite' }}
        </button>
        <button class="ghost" @click="replanejar">replanejar grade</button>
      </div>

      <div class="chat-box">
        <p v-if="chatMsgs.length === 0" class="dim">
          Peça o que quiser: "tira o desenho X por 2 meses", "maratona do Y sábado das 20h às 23h",
          "o que está passando hoje?"…
        </p>
        <div v-for="(m, i) in chatMsgs" :key="i" class="bolha" :class="m.role">
          <div class="bolha-texto">{{ m.text }}</div>
          <div v-if="m.acoes?.length" class="bolha-acoes">
            <span v-for="a in m.acoes" :key="a" class="chip" :class="a.startsWith('✖') ? 'st-error' : 'st-done'">{{ a }}</span>
          </div>
        </div>
        <div v-if="chatBusy" class="bolha diretor"><div class="bolha-texto dim">o diretor está pensando…</div></div>
      </div>
      <div class="chat-input">
        <input v-model="chatInput" placeholder="fala com o diretor…" @keyup.enter="enviarChat" />
        <button class="primary" :disabled="chatBusy" @click="enviarChat">enviar</button>
      </div>

      <template v-if="estado.diretrizes.length || estado.eventos.length">
        <h2 class="mt">Ordens em vigor</h2>
        <div v-for="d in estado.diretrizes" :key="'d' + d.id" class="job-row">
          <span class="chip st-error">{{ d.tipo === 'excluir_serie' ? 'exclusão (série)' : 'exclusão' }}</span>
          <span class="dim grow">{{ d.alvo }}{{ d.ate ? ` até ${d.ate}` : ' (sem prazo)' }}</span>
          <button class="ghost" @click="cancelarDiretriz(d.id)">cancelar</button>
        </div>
        <div v-for="e in estado.eventos" :key="'e' + e.id" class="job-row">
          <span class="chip st-queued">{{ e.editorial ? 'maratona 🌙' : 'maratona' }}</span>
          <span class="dim grow">{{ e.alvo ?? e.media_id }}: {{ e.inicio }} → {{ e.fim }}</span>
          <button class="ghost" @click="cancelarEvento(e.id)">cancelar</button>
        </div>
      </template>

      <template v-if="estado.series?.length">
        <h2 class="mt">Séries agrupadas neste canal</h2>
        <p class="dim">Peça no chat: "tira a temporada inteira de &lt;série&gt;".</p>
        <div v-for="s in estado.series" :key="s.series_id" class="job-row">
          <span class="mono">{{ s.series_id }}</span>
          <span class="dim grow">{{ s.titulo }} · {{ s.n }} episódio(s)</span>
        </div>
      </template>

      <h2 class="mt">Identidades editoriais</h2>
      <p class="dim">O "roteiro" que o Diretor segue em cada canal — edite à vontade.</p>
      <div v-for="ch in channels" :key="ch.id" class="ident">
        <h3 :style="{ color: ch.cor }">{{ ch.nome }}</h3>
        <textarea v-model="ch.identidade" rows="4" />
        <button class="ghost" :disabled="identSaving === ch.id" @click="saveIdentidade(ch)">
          {{ identSaving === ch.id ? 'salvando…' : 'salvar identidade' }}
        </button>
        <label class="bloco-row" title="quantos episódios da mesma série o diretor emenda em sequência antes de trocar de programa (as séries entram em rodízio)">
          <span>episódios seguidos por série:</span>
          <select :value="ch.episodios_por_bloco ?? 2" :disabled="blocoSaving === ch.id"
                  @change="saveBloco(ch, ($event.target as HTMLSelectElement).value)">
            <option :value="1">1 · sem agrupar</option>
            <option :value="2">2 seguidos</option>
            <option :value="3">3 seguidos</option>
            <option :value="4">4 seguidos</option>
          </select>
          <span v-if="blocoSaving === ch.id" class="dim">salvando…</span>
        </label>
      </div>
      </section>
    </main>
  </div>

  <footer v-if="authed" class="admin-footer">
    <button class="god-toggle" :class="{ on: god }" @click="toggleGod">
      {{ god ? '⚡ modo diretor: ligado' : 'modo diretor' }}
    </button>
  </footer>
</template>

<style scoped>
.topbar { display: flex; align-items: center; gap: 16px; padding: 10px 2px 18px; }
.brand { font-size: 22px; font-weight: 300; display: flex; align-items: center; gap: 10px; }
.brand b { font-weight: 800; }
.brand-dot { width: 12px; height: 12px; border-radius: 3px; background: var(--accent); }
.admin-tag { font-size: 11px; font-weight: 700; letter-spacing: 0.1em; color: var(--text-dim);
  border: 1px solid var(--line); border-radius: 999px; padding: 3px 10px; }
.back { margin-left: auto; color: var(--text-dim); font-size: 14px; text-decoration: none; }
.back:hover { color: var(--text); }

.gate { display: grid; place-items: center; min-height: 60vh; }
/* painel administrativo: menu lateral fixo + área de conteúdo (uma seção por vez) */
.admin-shell { display: grid; grid-template-columns: 190px minmax(0, 1fr); gap: 22px; align-items: start; }
.sidebar { display: flex; flex-direction: column; gap: 4px; position: sticky; top: 12px; }
.nav-item { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
  background: transparent; border: 1px solid transparent; border-radius: 10px; padding: 10px 12px;
  color: var(--text-dim); font: inherit; font-size: 14px; font-weight: 600; }
.nav-item:hover { color: var(--text); background: var(--panel); }
.nav-item.on { background: var(--panel); border-color: var(--line); color: var(--text); }
.nav-item.god.on { border-color: #ffb020; color: #ffb020; }
.nav-ico { font-size: 15px; }
.nav-badge { margin-left: auto; min-width: 20px; text-align: center; font-size: 11px; font-weight: 700;
  border-radius: 999px; padding: 1px 7px; background: rgba(255, 176, 32, 0.16); color: #ffb020; }
.nav-badge.azul { background: rgba(77, 163, 255, 0.16); color: #4da3ff; }

.content { min-width: 0; display: flex; flex-direction: column; gap: 16px; }
.global-msg { border: 1px solid var(--line); background: var(--panel); border-radius: 8px;
  padding: 10px 14px; font-size: 13px; }
.global-msg.err { color: #ff6b6b; border-color: rgba(255, 107, 107, 0.4); }
.global-msg.ok { color: var(--ok); border-color: rgba(56, 217, 122, 0.4); }

.secao-sub { display: flex; align-items: baseline; gap: 8px; margin: 2px 0 8px; }
.sub-label { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-dim); }
.hist-toggle { width: 100%; text-align: left; margin-top: 14px; }
.hist-lista { max-height: 340px; overflow-y: auto; margin-top: 4px; }

@media (max-width: 760px) {
  .admin-shell { grid-template-columns: 1fr; }
  .sidebar { flex-direction: row; overflow-x: auto; position: static; padding-bottom: 4px; }
  .nav-item { width: auto; white-space: nowrap; }
}

.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 18px; }
.card h2 { font-size: 13px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--text-dim); margin-bottom: 12px; }
.mt { margin-top: 22px; }
.dim { color: var(--text-dim); font-size: 13px; margin: 8px 0; }
.err { color: #ff6b6b; font-size: 13px; margin-top: 8px; }
.ok { color: var(--ok); font-size: 13px; margin-top: 8px; }
.small { font-size: 11px; }
.mono { font-family: ui-monospace, monospace; font-size: 12px; color: var(--text-dim); }
.grow { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.form { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }
.form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-dim); flex: 1; }
.row { display: flex; gap: 10px; align-items: end; }
input, select, textarea { background: var(--panel-2); border: 1px solid var(--line); color: var(--text);
  border-radius: 8px; padding: 9px 10px; font: inherit; width: 100%; }
input[type='file'] { padding: 8px; }
input[type='checkbox'] { width: auto; }

.canais-check { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.canais-check .check { flex-direction: row; align-items: center; gap: 6px; display: flex; font-size: 13px; color: var(--text); }

button.primary { background: var(--accent); color: #fff; border: 0; border-radius: 8px;
  padding: 10px 16px; font-weight: 700; }
button.primary:disabled { opacity: 0.6; }
button.ghost { background: transparent; border: 1px solid var(--line); color: var(--text-dim);
  border-radius: 8px; padding: 5px 10px; font-size: 12px; }
button.ghost:hover { color: var(--text); }

.bar { height: 5px; background: var(--panel-2); border-radius: 999px; overflow: hidden; }
.bar-fill { height: 100%; background: var(--accent); }
.mini-bar { width: 90px; height: 5px; flex: none; background: var(--panel-2);
  border-radius: 999px; overflow: hidden; }
.mini-bar-fill { display: block; height: 100%; background: #4da3ff; transition: width 0.6s; }

.job-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--line); }
.job-row:last-child { border-bottom: 0; }
.wrapy { flex-wrap: wrap; }
.chip { font-size: 11px; font-weight: 700; border-radius: 999px; padding: 3px 10px; border: 1px solid var(--line); }
.chip-btn { background: transparent; color: var(--text-dim); cursor: pointer; opacity: 0.5; }
.chip-btn.chip-on { opacity: 1; color: var(--text); border-color: var(--accent); }
.canal-chips { display: flex; gap: 4px; }
.series-input { width: 200px; flex: none; padding: 5px 8px; font-size: 12px; }
.st-queued { color: #ffb020; border-color: rgba(255, 176, 32, 0.5); }
.st-processing { color: #4da3ff; border-color: rgba(77, 163, 255, 0.5); }
.st-done { color: var(--ok); border-color: rgba(56, 217, 122, 0.5); }
.st-error { color: #ff6b6b; border-color: rgba(255, 107, 107, 0.5); }

.ident { margin-top: 14px; display: flex; flex-direction: column; gap: 6px; }
.ident h3 { font-size: 14px; }
.ident button { align-self: start; }
.bloco-row { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-dim); }
.bloco-row select { font: inherit; padding: 3px 6px; border-radius: 6px;
  border: 1px solid var(--line); background: transparent; color: var(--text); }

.link-row { margin-top: 8px; }
.link-row input { font-size: 13px; }

.cookies-box { margin-top: 8px; }
.cookies-toggle { width: 100%; text-align: left; }
.cookies-toggle .ok { color: var(--ok); }
.cookies-panel { display: flex; flex-direction: column; gap: 8px; margin-top: 8px;
  padding: 10px; border: 1px dashed var(--line); border-radius: 8px; }
.cookies-panel textarea { font-family: ui-monospace, monospace; font-size: 11px; }

.pasta-btn { display: block; margin-top: 8px; font-size: 12px; color: var(--text-dim);
  border: 1px dashed var(--line); border-radius: 8px; padding: 8px 10px; cursor: pointer; }
.pasta-btn:hover { color: var(--text); border-color: var(--text-dim); }
.oculto { display: none; }
.lote-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--line); }
.lote-row select { width: auto; padding: 5px 6px; font-size: 12px; }
.lote-titulo { flex: 1; padding: 5px 8px; font-size: 13px; }

.fila-head { display: flex; align-items: center; justify-content: space-between;
  gap: 10px; margin-bottom: 12px; }
.fila-head h2 { margin-bottom: 0; }

.fieis-row { display: flex; align-items: center; gap: 10px; margin: 14px 0 4px; flex-wrap: wrap; }
.fieis-btn { background: transparent; border: 1px solid var(--ok); color: var(--ok);
  border-radius: 999px; padding: 6px 14px; font-size: 12px; font-weight: 700; cursor: pointer; }
.fieis-btn.livre { border-color: #ffb020; color: #ffb020; }
.tipo-select { width: auto; flex: none; padding: 4px 6px; font-size: 11px; }

.nomear-row { display: flex; align-items: center; gap: 6px; padding: 6px 0;
  border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.nomear-titulo { flex: 2; min-width: 180px; padding: 6px 8px; font-size: 13px; }
.nomear-serie { width: 150px; flex: none; padding: 6px 8px; font-size: 12px; }
.nomear-ep { width: 52px; flex: none; padding: 6px 8px; font-size: 12px; }

.promessa { border-bottom: 1px solid var(--line); padding: 8px 0; display: flex;
  flex-direction: column; gap: 6px; }
.promessa .transcript { font-style: italic; margin: 0; }
.promessa .row { align-items: center; }

.perigo { color: #ff6b6b; border-color: rgba(255, 107, 107, 0.5); }
.perigo:hover { color: #ff8f8f; }
.perigo-btn { background: #c0392b; }
.del-zone { border: 1px solid rgba(255, 107, 107, 0.4); border-radius: 8px; padding: 10px 12px;
  margin: 6px 0 10px; display: flex; flex-direction: column; gap: 8px; }
.del-zone .check { display: flex; align-items: center; gap: 6px; flex-direction: row; }

.chat-head { display: flex; gap: 10px; margin-bottom: 10px; }
.chat-canal { width: auto; }
.chat-box { background: var(--panel-2); border: 1px solid var(--line); border-radius: 10px;
  padding: 12px; max-height: 340px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
.bolha { max-width: 85%; }
.bolha.user { align-self: flex-end; }
.bolha.diretor { align-self: flex-start; }
.bolha-texto { border-radius: 12px; padding: 8px 12px; font-size: 14px; white-space: pre-wrap; }
.bolha.user .bolha-texto { background: var(--accent); color: #fff; }
.bolha.diretor .bolha-texto { background: var(--panel); border: 1px solid var(--line); }
.bolha-acoes { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.chat-input { display: flex; gap: 8px; margin-top: 10px; }

.admin-footer { display: flex; justify-content: flex-end; padding: 24px 2px 4px; }
.god-toggle { background: transparent; border: 0; color: var(--text-dim); opacity: 0.35;
  font-size: 11px; letter-spacing: 0.06em; }
.god-toggle:hover { opacity: 0.9; }
.god-toggle.on { opacity: 0.9; color: #ffb020; }

/* playlist (episódios em partes) */
.pl-analise { border: 1px solid var(--line); border-radius: 10px; padding: 12px; margin-top: 12px; }
.pl-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.pl-atalhos { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 8px 0; }
.pl-eps { display: flex; flex-direction: column; margin: 6px 0; }
.pl-ep { display: flex; align-items: center; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--line); cursor: pointer; }
.pl-ep:last-child { border-bottom: 0; }
.pl-ep.ruim { opacity: 0.65; }
.pl-listando, .pl-analisando { color: #4da3ff; border-color: rgba(77, 163, 255, 0.5); }
.pl-revisar { color: #ffb020; border-color: rgba(255, 176, 32, 0.5); }
.pl-confirmado { color: var(--ok); border-color: rgba(56, 217, 122, 0.5); }
.pl-error { color: #ff6b6b; border-color: rgba(255, 107, 107, 0.5); }

/* fábrica de comerciais */
.fab-grid { display: grid; grid-template-columns: 1.2fr 1fr; gap: 12px; align-items: start; min-width: 0; }
.fab-panel { min-width: 0; border: 1px solid var(--line); border-radius: 10px; padding: 12px; background: var(--panel-2); }
.fab-main { grid-row: span 2; }
.fab-panel h3 { font-size: 12px; color: var(--text); margin-bottom: 8px; }
.fab-panel .row > label { min-width: 0; }
.fab-days { display: flex; flex-wrap: wrap; gap: 6px; }
.fab-list { margin-top: 10px; max-height: 220px; overflow: auto; }
.fab-mini { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-bottom: 1px solid var(--line); }
.fab-mini .grow { min-width: 0; }
.fab-mini:last-child { border-bottom: 0; }
@media (max-width: 980px) {
  .fab-grid { grid-template-columns: 1fr; }
  .fab-main { grid-row: auto; }
}
@media (max-width: 620px) {
  .fab-panel .row { flex-direction: column; align-items: stretch; }
  .fab-mini { flex-wrap: wrap; }
  .fab-mini .grow { white-space: normal; }
  .fab-job { flex-wrap: wrap; }
}
</style>
