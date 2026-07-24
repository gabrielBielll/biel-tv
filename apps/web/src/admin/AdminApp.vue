<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Ajuda from './Ajuda.vue'

const API = import.meta.env.VITE_API_BASE ?? ''
const TOKEN_KEY = 'bieltv_admin_token'

const token = ref(localStorage.getItem(TOKEN_KEY) ?? '')
const authed = ref(false)
const authMsg = ref('')

const jobs = ref<any[]>([])
const media = ref<any[]>([])
const channels = ref<any[]>([])
const god = ref(false)
// primeira carga ainda em andamento: lista vazia e lista que não chegou são
// coisas diferentes, e antes o painel mostrava as duas do mesmo jeito
const carregando = ref(true)
let poll: ReturnType<typeof setInterval> | undefined

// formulário de upload
const file = ref<File | null>(null)
const meta = ref<{ duration: number; width: number; height: number } | null>(null)
const form = ref({ id: '', tipo: 'episodio', title: '', series_id: '', episode: '', tags: '', canais: [] as string[] })
const pct = ref(0)
const sending = ref(false)
const msg = ref('')

// A mensagem do topo some sozinha quando é boa notícia (12s) e fica na tela
// quando é erro — erro que some antes de ser lido não serve pra nada. O ✕ ao
// lado fecha qualquer uma das duas.
let msgTimer: ReturnType<typeof setTimeout> | undefined
watch(msg, (v) => {
  clearTimeout(msgTimer)
  if (!v || v.startsWith('✖')) return
  msgTimer = setTimeout(() => { if (msg.value === v) msg.value = '' }, 12_000)
})

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
const loteFeitos = computed(() => lote.value.filter((i) => i.status === 'na fila').length)

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
  } finally {
    carregando.value = false
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
const fabrica = ref<{ voice_clips: any[]; moldes: any[]; samples: any[]; jobs: any[]; series: any[]; canais: any[]; ancoras: any[]; tts_disponivel: boolean }>({
  voice_clips: [], moldes: [], samples: [], jobs: [], series: [], canais: [], ancoras: [], tts_disponivel: false,
})
const fabBusy = ref(false)
const clipFile = ref<File | null>(null)
const sampleFile = ref<File | null>(null)
const moldeFile = ref<File | null>(null)
const musicaFile = ref<File | null>(null)
const clipForm = ref({ canal: 'jetix', categoria: 'frase', series_id: '', chave: '', rotulo: '', sintetizar: true, voz_id: '' })
const sampleForm = ref({ series_id: '', rotulo: '', source_url: '' })
const moldeForm = ref({ nome: 'Molde Jetix — horário', canal: 'jetix' })
// voz por canal (ElevenLabs) — Fase A
const vozEdit = ref<Record<string, string>>({})
const vozModelo = ref<Record<string, string>>({})
const vozTexto = ref('[excited] Prepare-se! [short pause] Uma nova aventura vem aí... [short pause] a seguir, na Jetix!')
const vozTestando = ref('')
let vozAudioEl: HTMLAudioElement | null = null
const vozDoCanal = (canal: string): string =>
  fabrica.value.canais?.find((c: any) => c.id === canal)?.voz_id ?? ''
const clipFiltroCanal = ref('')
const clipFiltroCat = ref('')
// a biblioteca base assa ~95 clipes por canal: sem busca, achar um é garimpo
const clipBusca = ref('')
const clipLimite = ref(60)
const clipesFiltrados = computed(() => {
  const q = clipBusca.value.trim().toLowerCase()
  return fabrica.value.voice_clips.filter((c: any) =>
    (!clipFiltroCanal.value || c.canal === clipFiltroCanal.value)
    && (!clipFiltroCat.value || c.categoria === clipFiltroCat.value)
    && (!q || `${c.rotulo ?? ''} ${c.chave ?? ''} ${c.series_id ?? ''}`.toLowerCase().includes(q)))
})
const clipesVisiveis = computed(() => clipesFiltrados.value.slice(0, clipLimite.value))
watch([clipBusca, clipFiltroCanal, clipFiltroCat], () => { clipLimite.value = 60 })
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
// âncoras de grade (slots fixos): série X num horário fixo que o scheduler honra
const ancoraForm = ref({ canal: 'jetix', series_id: '', dias: [1, 2, 3, 4, 5] as number[], hora: '16:00', episodios: 1 })
function diasFabLabel(dias: number[]): string {
  return DIAS_FAB.filter((d) => dias.includes(d.n)).map((d) => d.label).join(' ')
}
function tituloSerieFab(sid: string): string {
  return fabrica.value.series.find((s: any) => s.sid === sid)?.titulo ?? sid
}
function ancoraDias(a: any): number[] {
  try { return JSON.parse(a.dias) } catch { return [] }
}
const fabJobsAtivos = computed(() => fabrica.value.jobs.filter((j) => j.status === 'queued' || j.status === 'processing'))

// ── fábrica: painéis recolhíveis ───────────────────────────────────────────
// Seis painéis num grid apertado davam até seis barras de rolagem na mesma
// tela. "Montar comercial" passa a ocupar a largura toda e o resto abre sob
// demanda, com o que ficou aberto lembrado entre visitas.
const FAB_ABERTOS_KEY = 'bieltv_admin_fab_abertos'
const fabAbertos = ref<Record<string, boolean>>((() => {
  try { return JSON.parse(localStorage.getItem(FAB_ABERTOS_KEY) ?? '{}') } catch { return {} }
})())
function alternaFab(chave: string, aberto: boolean) {
  fabAbertos.value[chave] = aberto
  localStorage.setItem(FAB_ABERTOS_KEY, JSON.stringify(fabAbertos.value))
}
const canalDoMolde = computed(() =>
  fabrica.value.moldes.find((m) => m.id === buildForm.value.molde_id)?.canal ?? '',
)
const clipsDaSerie = computed(() => fabrica.value.voice_clips.filter((c) =>
  c.canal === canalDoMolde.value && c.series_id === buildForm.value.series_id,
))
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
    if (!channels.value.some((c) => c.id === clipForm.value.canal)) clipForm.value.canal = channels.value[0]?.id ?? ''
    // sem chave do ElevenLabs, cai pro upload manual de áudio
    if (!fabrica.value.tts_disponivel) clipForm.value.sintetizar = false
    for (const cn of fabrica.value.canais ?? []) {
      if (vozEdit.value[cn.id] === undefined) vozEdit.value[cn.id] = cn.voz_id ?? ''
      if (vozModelo.value[cn.id] === undefined) {
        let m = 'eleven_v3'
        try { m = JSON.parse(cn.voz_config || '{}').model_id || 'eleven_v3' } catch { /* usa v3 */ }
        vozModelo.value[cn.id] = m
      }
    }
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
  fabBusy.value = true
  try {
    let staging: string | undefined
    if (!clipForm.value.sintetizar) {
      if (!clipFile.value) { msg.value = '✖ escolha o áudio do clipe (ou marque "sintetizar")'; return }
      staging = await uploadAsset(clipFile.value)
    }
    const res = await postJson('/fabrica-comerciais/voice-clips', {
      ...clipForm.value,
      staging_key: staging,
      original_name: clipFile.value?.name ?? '',
    })
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
    msg.value = clipForm.value.sintetizar
      ? `✔ clipe sintetizado (${clipForm.value.categoria})`
      : `✔ clipe salvo (${clipForm.value.categoria})`
    clipFile.value = null
    clipForm.value.rotulo = ''
    await carregaFabrica()
  } catch (e) {
    msg.value = `✖ ${(e as Error).message}`
  } finally {
    fabBusy.value = false
  }
}

async function salvarVozCanal(canal: string) {
  fabBusy.value = true
  try {
    const res = await api(`/fabrica-comerciais/canais/${canal}/voz`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        voz_id: (vozEdit.value[canal] ?? '').trim(),
        voz_config: { model_id: vozModelo.value[canal] || 'eleven_v3' },
      }),
    })
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
    msg.value = `✔ voz do ${canal} salva`
    await carregaFabrica()
  } catch (e) {
    msg.value = `✖ ${(e as Error).message}`
  } finally {
    fabBusy.value = false
  }
}

async function testarVoz(canal: string) {
  const texto = vozTexto.value.trim()
  if (!texto) { msg.value = '✖ escreva um texto de teste'; return }
  vozTestando.value = canal
  try {
    const res = await api('/fabrica-comerciais/voz/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ canal, texto }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({} as { error?: string }))
      throw new Error(body.error ?? `HTTP ${res.status}`)
    }
    const url = URL.createObjectURL(await res.blob())
    vozAudioEl?.pause()
    vozAudioEl = new Audio(url)
    vozAudioEl.onended = () => URL.revokeObjectURL(url)
    await vozAudioEl.play()
    msg.value = `▶ voz do ${canal}`
  } catch (e) {
    msg.value = `✖ ${(e as Error).message}`
  } finally {
    vozTestando.value = ''
  }
}

async function gerarBiblioteca(canal: string) {
  if (!confirm(`Gerar a biblioteca base de "${canal}"? Sintetiza horários (15/15min), frequências, assinatura e conectores — gasta créditos do ElevenLabs (pula o que já existe).`)) return
  fabBusy.value = true
  try {
    let restantes = 1
    let total = 0
    for (let i = 0; i < 60 && restantes > 0; i++) {
      const res = await api(`/fabrica-comerciais/canais/${canal}/biblioteca-base`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ limit: 12 }),
      })
      const body = await res.json()
      if (!res.ok && res.status !== 503) throw new Error(body.error ?? `HTTP ${res.status}`)
      total = body.total ?? total
      restantes = body.restantes ?? 0
      msg.value = `🎙️ biblioteca ${canal}: ${total - restantes}/${total}`
      if (res.status === 503) { msg.value = `⏸ pausou (${body.parou}) — faltam ${restantes}`; break }
      if ((body.gerados ?? 0) === 0) break
    }
    await carregaFabrica()
    if (restantes === 0) msg.value = `✔ biblioteca base de ${canal} pronta (${total} clipes)`
  } catch (e) {
    msg.value = `✖ ${(e as Error).message}`
  } finally {
    fabBusy.value = false
  }
}

const clipTocando = ref('')
async function tocarClip(id: string) {
  clipTocando.value = id
  try {
    const res = await api(`/fabrica-comerciais/voice-clips/${id}/audio`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const url = URL.createObjectURL(await res.blob())
    vozAudioEl?.pause()
    vozAudioEl = new Audio(url)
    vozAudioEl.onended = () => URL.revokeObjectURL(url)
    await vozAudioEl.play()
  } catch (e) {
    msg.value = `✖ ${(e as Error).message}`
  } finally {
    clipTocando.value = ''
  }
}

async function salvarSample() {
  const sourceUrl = sampleForm.value.source_url.trim()
  if (!sampleFile.value && !sourceUrl) { msg.value = '✖ escolha o vídeo ou cole um link do YouTube'; return }
  fabBusy.value = true
  try {
    const staging = sampleFile.value ? await uploadAsset(sampleFile.value) : ''
    const res = await postJson('/fabrica-comerciais/samples', {
      ...sampleForm.value,
      staging_key: staging || undefined,
      source_url: sourceUrl || undefined,
      original_name: sampleFile.value?.name ?? '',
    })
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
    msg.value = '✔ amostra salva'
    sampleFile.value = null
    sampleForm.value.source_url = ''
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

// Exclusões da fábrica apagavam no clique, sem perguntar nada — e cada uma
// derruba montagens FUTURAS que dependem da peça (comercial já montado segue
// no ar). O aviso diz exatamente isso, por tipo.
const AVISO_FAB: Record<string, string> = {
  'voice-clips': 'Apagar a fala "%s"? Comerciais já montados continuam iguais, mas qualquer montagem futura que precise dessa fala passa a falhar. Não tem volta.',
  samples: 'Apagar a amostra "%s"? Se ela veio de arquivo, o vídeo é apagado junto. Comerciais já montados seguem no ar; quebram as montagens futuras que dependiam dela. Não tem volta.',
  moldes: 'Apagar o molde "%s"? A arte e a música são apagadas junto, e jobs que ainda não montaram com ele passam a falhar com "molde não encontrado". Não tem volta.',
}

async function apagarFab(kind: 'voice-clips' | 'samples' | 'moldes', id: string, rotulo = '') {
  if (!confirm(AVISO_FAB[kind].replace('%s', rotulo || id))) return
  const res = await api(`/fabrica-comerciais/${kind}/${id}`, { method: 'DELETE' })
  const body = await res.json().catch(() => ({} as { error?: string }))
  msg.value = res.ok ? '✔ removido' : `✖ ${body.error ?? res.status}`
  carregaFabrica()
}

function toggleDiaAncora(n: number) {
  const cur = ancoraForm.value.dias
  ancoraForm.value.dias = cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n].sort((a, b) => a - b)
}

async function salvarAncora() {
  if (!ancoraForm.value.series_id || ancoraForm.value.dias.length === 0) {
    msg.value = '✖ escolha programa e dias'
    return
  }
  fabBusy.value = true
  try {
    const res = await postJson('/fabrica-comerciais/slots', { ...ancoraForm.value })
    const body = await res.json().catch(() => ({} as { error?: string }))
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
    msg.value = '✔ âncora criada — grade replanejada'
    await carregaFabrica()
    refresh()
  } catch (e) {
    msg.value = `✖ ${(e as Error).message}`
  } finally {
    fabBusy.value = false
  }
}

async function apagarAncora(a: any) {
  if (!confirm(`Remover o horário fixo de "${tituloSerieFab(a.series_id)}" (${diasFabLabel(ancoraDias(a))} às ${a.hora})? Aquele horário volta a ser rodízio livre e a grade é replanejada na hora.\n\nAtenção: o comercial que anuncia esse horário NÃO é removido e continua no ar prometendo algo que não acontece mais — desative ele no Catálogo.`)) return
  const res = await api(`/fabrica-comerciais/slots/${a.id}`, { method: 'DELETE' })
  const body = await res.json().catch(() => ({} as { error?: string }))
  msg.value = res.ok ? '✔ âncora removida — grade replanejada' : `✖ ${body.error ?? res.status}`
  await carregaFabrica()
  refresh()
}

async function gerarComercialAncora(a: any) {
  const res = await postJson(`/fabrica-comerciais/slots/${a.id}/gerar`, {})
  const body = await res.json().catch(() => ({} as { error?: string; media_id?: string }))
  msg.value = res.ok ? `✔ comercial ${body.media_id} entrou na fábrica` : `✖ ${body.error ?? res.status}`
  await carregaFabrica()
}

async function retryFabJob(j: any) {
  const res = await postJson(`/fabrica-comerciais/${j.id}/retry`, {})
  const body = await res.json().catch(() => ({} as { error?: string }))
  msg.value = res.ok ? `↻ ${j.media_id} voltou para a fábrica` : `✖ ${body.error ?? res.status}`
  carregaFabrica()
}

async function cancelarFabJob(j: any) {
  const proc = j.status === 'processing'
  if (!confirm(proc
    ? `Cancelar "${j.media_id}"? Está sendo montado — sai da fila mesmo assim, e a montagem em andamento é descartada.`
    : `Cancelar "${j.media_id}"? Sai da fila da fábrica e o comercial não será montado.`)) return
  const res = await api(`/fabrica-comerciais/jobs/${j.id}`, { method: 'DELETE' })
  const body = await res.json().catch(() => ({} as { error?: string }))
  msg.value = res.ok ? `✕ "${j.media_id}" cancelado` : `✖ ${body.error ?? res.status}`
  carregaFabrica()
}

const fabErro = computed(() => fabrica.value.jobs.filter((j) => j.status === 'error'))
const fabFeitos = computed(() => fabrica.value.jobs.filter((j) => j.status === 'done'))

async function limparFabJobs(status: 'error' | 'done') {
  const n = (status === 'error' ? fabErro : fabFeitos).value.length
  if (n === 0 || fabBusy.value) return
  const aviso = status === 'error'
    ? `Limpar ${n} montagem(ns) que deram erro?`
    : `Limpar ${n} montagem(ns) concluída(s)? Os comerciais continuam no catálogo — some só o registro da fábrica.`
  if (!confirm(aviso)) return
  fabBusy.value = true
  try {
    const res = await postJson('/fabrica-comerciais/jobs/limpar', { status })
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
    msg.value = `🧹 ${body.removidos} montagem(ns) fora da lista`
    await carregaFabrica()
  } catch (e) {
    msg.value = `✖ ${(e as Error).message}`
  } finally {
    fabBusy.value = false
  }
}

// ── navegação por seções (painel = menu lateral, uma seção por vez) ─────────
type Aba = 'enviar' | 'playlist' | 'fabrica' | 'fila' | 'catalogo' | 'promessas' | 'diretor'
const ABA_KEY = 'bieltv_admin_aba'
const aba = ref<Aba>((localStorage.getItem(ABA_KEY) as Aba) || 'enviar')
watch(aba, (v) => localStorage.setItem(ABA_KEY, v))
watch(() => buildForm.value.molde_id, () => { buildForm.value.frase_id = '' })
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

const loteAbortado = ref(false)

async function enviarLote() {
  if (loteCanais.value.length === 0) {
    msg.value = '✖ escolha pelo menos um canal pro lote'
    return
  }
  loteEnviando.value = true
  loteAbortado.value = false
  // item cancelado não ressuscita: sem excluí-lo daqui, reenviar o lote subia
  // justamente o vídeo que tinha sido cancelado
  const fila = lote.value.filter((i) => i.status !== 'na fila' && i.status !== 'cancelado')
  // 1º: TODAS as sessões reservadas antes de qualquer byte — um reload no
  // meio não perde mais nenhum item do lote (todos ficam retomáveis)
  for (const item of fila) {
    if (loteAbortado.value) break
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
    if (loteAbortado.value) break
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
  msg.value = loteAbortado.value
    ? `✕ lote interrompido — ${okCount}/${fila.length} chegaram na fila antes de você parar`
    : `✔ lote: ${okCount}/${fila.length} na fila — a fábrica processa um por vez`
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

// ── desfazer a escolha / desistir do envio ─────────────────────────────────
// O <input type="file"> não se esvazia sozinho, e sem trocar a :key escolher o
// MESMO arquivo de novo depois de limpar não dispara evento nenhum.
const chaveInput = ref(0)
function limparEscolha() {
  for (const i of lote.value) {
    if (i.status.startsWith('enviando') || i.status === 'reservado') cancelarItem(i)
    else if (i.sess) cancelaSessao(i.sess)
  }
  file.value = null
  meta.value = null
  lote.value = []
  linkPronto.value = false
  ytUrl.value = ''
  pct.value = 0
  chaveInput.value++
  msg.value = ''
}

function removeDoLote(item: ItemLote) {
  if (item.status.startsWith('enviando') || item.status === 'reservado') cancelarItem(item)
  else if (item.sess) cancelaSessao(item.sess)
  lote.value = lote.value.filter((i) => i !== item)
}

const loteComProblema = computed(() =>
  lote.value.filter((i) => i.status.startsWith('erro') || i.status === 'cancelado'))

function limparLoteComProblema() {
  for (const i of loteComProblema.value) if (i.sess) cancelaSessao(i.sess)
  lote.value = lote.value.filter((i) => !i.status.startsWith('erro') && i.status !== 'cancelado')
}

// para o lote no meio: o item em voo é abortado e os que ainda não começaram
// nem chegam a reservar sessão
function cancelarLoteInteiro() {
  loteAbortado.value = true
  for (const i of lote.value) {
    if (i.status.startsWith('enviando') || i.status === 'reservado') cancelarItem(i)
  }
}

const descartandoTudo = ref(false)
async function descartarTodos() {
  const lista = [...pendentesVisiveis.value]
  if (lista.length === 0 || descartandoTudo.value) return
  if (!confirm(`Descartar ${lista.length} upload(s) interrompido(s)? As partes já enviadas são apagadas — reenviar depois começa do zero.`)) return
  descartandoTudo.value = true
  try {
    for (const p of lista) await api(`/uploads/${p.id}`, { method: 'DELETE' }).catch(() => null)
    msg.value = `🧹 ${lista.length} upload(s) interrompido(s) descartado(s)`
  } finally {
    descartandoTudo.value = false
    fetchPendentes()
  }
}

// tira da lista só o que já terminou (na fila / erro / cancelado)
function limparRetomadas() {
  retomadas.value = retomadas.value.filter(
    (r) => !(r.status === 'na fila' || r.status.startsWith('erro') || r.status === 'cancelado'))
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
  if (!confirm(`Descartar o upload de "${p.title}"? As ${p.partes.length} de ${p.parts_total} partes já enviadas são apagadas — reenviar depois recomeça do zero.\n\nEm compensação o id "${p.media_id}" volta a ficar livre.`)) return
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

// ── limpeza em massa da fila ────────────────────────────────────────────────
// O histórico enche em minutos e cada linha só sai uma a uma. Aqui some tudo
// de um status de uma vez; o servidor só aceita 'error' e 'done' (o que ainda
// pode rodar continua saindo item a item, com o aviso do que está em andamento).
const jobsErro = computed(() => jobs.value.filter((j) => j.status === 'error'))
const jobsFeitos = computed(() => jobs.value.filter((j) => j.status === 'done'))
const limpandoFila = ref('')

async function limparFila(status: 'error' | 'done') {
  const n = (status === 'error' ? jobsErro : jobsFeitos).value.length
  if (n === 0 || limpandoFila.value) return
  const aviso = status === 'error'
    ? `Limpar ${n} item(ns) que deram erro? Eles somem da fila e não serão processados.`
    : `Limpar ${n} item(ns) concluído(s) do histórico? Os vídeos continuam no catálogo — some só o registro da fila.`
  if (!confirm(aviso)) return
  limpandoFila.value = status
  try {
    const res = await postJson('/jobs/limpar', { status })
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
    msg.value = `🧹 ${body.removidos} item(ns) fora da fila`
    refresh()
  } catch (e) {
    msg.value = `✖ ${(e as Error).message}`
  } finally {
    limpandoFila.value = ''
  }
}

async function retryTodos() {
  if (jobsErro.value.length === 0 || limpandoFila.value) return
  limpandoFila.value = 'retry'
  try {
    const res = await postJson('/jobs/retry-todos', {})
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
    msg.value = `↻ ${body.reenfileirados} item(ns) de volta na fila — a fábrica acorda sozinha`
    refresh()
  } catch (e) {
    msg.value = `✖ ${(e as Error).message}`
  } finally {
    limpandoFila.value = ''
  }
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

// ── catálogo: busca, filtros e "mostrar mais" ──────────────────────────────
// O servidor manda as 200 mídias mais recentes e o painel despejava todas de
// uma vez — centenas de controles no DOM e nenhum jeito de achar um título.
// O recorte é todo aqui no cliente; a API não muda.
const catBusca = ref('')
const catTipo = ref('')
const catCanal = ref('')
const catStatus = ref('')
const catLimite = ref(50)
const MEDIA_STATUS: Record<string, string> = { ready: 'no ar', disabled: 'fora do ar' }

const catalogoFiltrado = computed(() => {
  const q = catBusca.value.trim().toLowerCase()
  return media.value.filter((m: any) => {
    if (catTipo.value && m.tipo !== catTipo.value) return false
    if (catStatus.value && m.status !== catStatus.value) return false
    if (catCanal.value && !canaisDe(m).includes(catCanal.value)) return false
    if (!q) return true
    return `${m.id} ${titleOf(m)} ${seriesOf(m)}`.toLowerCase().includes(q)
  })
})
const catalogoVisivel = computed(() => catalogoFiltrado.value.slice(0, catLimite.value))
const catFiltrando = computed(() =>
  Boolean(catBusca.value.trim() || catTipo.value || catCanal.value || catStatus.value))
function limparFiltrosCat() {
  catBusca.value = ''
  catTipo.value = ''
  catCanal.value = ''
  catStatus.value = ''
}
// filtro novo volta a lista pro começo (senão "mostrar mais" fica preso lá embaixo)
watch([catBusca, catTipo, catCanal, catStatus], () => { catLimite.value = 50 })

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

// ── faixa "o que precisa de mim" ───────────────────────────────────────────
// Os contadores já existiam espalhados nos badges do menu; juntos no topo eles
// viram a lista de pendências e dizem em que aba está cada uma.
const resumo = computed(() => [
  { n: pendentesVisiveis.value.length, um: 'upload interrompido', varios: 'uploads interrompidos', destino: 'enviar' as Aba },
  { n: analisesRevisar.value, um: 'playlist pra revisar', varios: 'playlists pra revisar', destino: 'playlist' as Aba },
  { n: jobsAtivos.value.length, um: 'vídeo processando', varios: 'vídeos processando', destino: 'fila' as Aba },
  { n: jobsErro.value.length, um: 'erro na fila', varios: 'erros na fila', destino: 'fila' as Aba },
  { n: fabJobsAtivos.value.length, um: 'comercial em montagem', varios: 'comerciais em montagem', destino: 'fabrica' as Aba },
  { n: aNomear.value.length, um: 'vídeo a nomear', varios: 'vídeos a nomear', destino: 'catalogo' as Aba },
  { n: promPendentes.value.length, um: 'promessa pra decidir', varios: 'promessas pra decidir', destino: 'promessas' as Aba },
].filter((r) => r.n > 0))
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

async function descartarAnalise(pl: any) {
  if (!confirm('Descartar esta análise de playlist? Episódios que você já confirmou continuam na fila — some só a análise.')) return
  const res = await api(`/playlist/${pl.id}`, { method: 'DELETE' })
  const body = await res.json().catch(() => ({} as { error?: string }))
  msg.value = res.ok ? '✕ análise descartada' : `✖ ${body.error ?? res.status}`
  carregaAnalises()
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
      <button class="nav-item" :class="{ on: aba === 'enviar' }" :aria-current="aba === 'enviar'" @click="aba = 'enviar'">
        <span class="nav-ico" aria-hidden="true">📤</span> Enviar
        <span v-if="pendentesVisiveis.length" class="nav-badge" title="uploads interrompidos">{{ pendentesVisiveis.length }}</span>
      </button>
      <button class="nav-item" :class="{ on: aba === 'playlist' }" :aria-current="aba === 'playlist'" @click="aba = 'playlist'">
        <span class="nav-ico" aria-hidden="true">🎬</span> Playlist
        <span v-if="analisesRevisar" class="nav-badge" title="playlists aguardando revisão">{{ analisesRevisar }}</span>
      </button>
      <button class="nav-item" :class="{ on: aba === 'fabrica' }" :aria-current="aba === 'fabrica'" @click="aba = 'fabrica'">
        <span class="nav-ico" aria-hidden="true">🏭</span> Fábrica
        <span v-if="fabJobsAtivos.length" class="nav-badge azul" title="comerciais em montagem">{{ fabJobsAtivos.length }}</span>
      </button>
      <button class="nav-item" :class="{ on: aba === 'fila' }" :aria-current="aba === 'fila'" @click="aba = 'fila'">
        <span class="nav-ico" aria-hidden="true">⚙️</span> Fila
        <span v-if="jobsAtivos.length" class="nav-badge azul" title="processando/na fila">{{ jobsAtivos.length }}</span>
        <span v-else-if="jobsErro.length" class="nav-badge vermelho" title="itens com erro">{{ jobsErro.length }}</span>
      </button>
      <button class="nav-item" :class="{ on: aba === 'catalogo' }" :aria-current="aba === 'catalogo'" @click="aba = 'catalogo'">
        <span class="nav-ico" aria-hidden="true">📚</span> Catálogo
        <span v-if="aNomear.length" class="nav-badge" title="a nomear">{{ aNomear.length }}</span>
      </button>
      <button class="nav-item" :class="{ on: aba === 'promessas' }" :aria-current="aba === 'promessas'" @click="aba = 'promessas'">
        <span class="nav-ico" aria-hidden="true">📣</span> Promessas
        <span v-if="promPendentes.length" class="nav-badge" title="promessas pendentes">{{ promPendentes.length }}</span>
      </button>
      <button v-if="god" class="nav-item god" :class="{ on: aba === 'diretor' }" :aria-current="aba === 'diretor'" @click="aba = 'diretor'">
        <span class="nav-ico" aria-hidden="true">⚡</span> Diretor
      </button>
    </nav>

    <main class="content">
      <!-- faixa de pendências: cada pílula leva direto pra aba que resolve -->
      <div v-if="resumo.length" class="resumo">
        <span class="resumo-label">precisa de você:</span>
        <button
          v-for="r in resumo"
          :key="r.destino + r.um"
          class="resumo-pill"
          @click="aba = r.destino"
        >{{ r.n }} {{ r.n === 1 ? r.um : r.varios }}</button>
      </div>
      <p v-else-if="!carregando" class="resumo-ok">✓ tudo em dia — nada esperando por você</p>

      <p
        v-if="msg"
        class="global-msg"
        :class="msg.startsWith('✖') ? 'err' : 'ok'"
        role="status"
        aria-live="polite"
      >
        <span class="grow">{{ msg }}</span>
        <button class="msg-x" aria-label="fechar aviso" @click="msg = ''">✕</button>
      </p>

      <section v-show="aba === 'enviar'" class="card">
      <h2>Enviar mídia
        <Ajuda
          titulo="As três formas de trazer vídeo"
          texto="Arquivo do computador, pasta inteira (vira um lote) ou link que a fábrica baixa sozinha. Em qualquer uma delas o vídeo entra na FILA — quem transcodifica e publica é a fábrica, alguns minutos depois."
        />
      </h2>

      <div class="fonte">
        <span class="fonte-num" aria-hidden="true">1</span>
        <div class="fonte-corpo">
          <span class="fonte-tit">Arquivo(s) do computador
            <Ajuda
              titulo="Escolher vídeo(s)"
              texto="Escolher 1 arquivo abre o formulário com título, id, tipo e canais já sugeridos; escolher 2 ou mais abre o modo lote, com uma linha por vídeo. Escolher não envia nada: o arquivo só começa a subir quando você clica em 'enviar pra fila'."
              atencao="Arquivo de 0 byte é ignorado em silêncio."
            />
          </span>
          <input :key="chaveInput" type="file" accept="video/*" multiple @change="onPick" />
        </div>
      </div>

      <div class="fonte">
        <span class="fonte-num" aria-hidden="true">2</span>
        <div class="fonte-corpo">
          <span class="fonte-tit">Uma pasta inteira
            <Ajuda
              titulo="Enviar uma pasta inteira"
              texto="Manda a pasta toda de uma vez: o nome da pasta vira a série e o número do arquivo vira o episódio ('pwr rangers/003.mp4' → série pwr_rangers, ep 3). Cada vídeo vira uma linha, e dá pra corrigir antes de enviar."
              atencao="Arquivo numerado dentro da pasta é sempre 'episódio', não importa a duração. Sem número detectado o tipo vem da duração: menos de 90s vira comercial, mais de 1h vira filme — confira linha a linha."
            />
          </span>
          <label class="pasta-btn">
            📁 escolher uma pasta (ex.: "pwr rangers/001.mp4, 002.mp4…")
            <input :key="chaveInput" type="file" webkitdirectory multiple class="oculto" @change="onPick" />
          </label>
        </div>
      </div>

      <div class="fonte">
        <span class="fonte-num" aria-hidden="true">3</span>
        <div class="fonte-corpo">
          <span class="fonte-tit">Um link
            <Ajuda
              titulo="Colar link em vez de arquivo"
              texto="Você cola o endereço do vídeo e quem baixa é a fábrica, não o seu navegador. Funciona com YouTube, archive.org e links diretos de .mp4."
              atencao="Link do YouTube costuma exigir cookies válidos: a máquina da fábrica é de datacenter e leva bloqueio de robô sem eles."
            />
          </span>
          <div class="row link-row">
            <input
              v-model="ytUrl"
              placeholder="🔗 cole o link (YouTube, archive.org…) e a fábrica baixa sozinha"
              @keyup.enter="buscarLink"
            />
            <button class="ghost" :disabled="ytBusy" @click="buscarLink">{{ ytBusy ? '…' : 'buscar' }}</button>
            <Ajuda
              titulo="Buscar só lê o título"
              texto="Só consulta o título do vídeo pra preencher as sugestões do formulário — não baixa nada e não cria job. Quem coloca na fila é o botão 'baixar e colocar na fila', depois que você conferir os campos."
              atencao="Buscar descarta o arquivo ou o lote que estivesse escolhido. Link de fora do YouTube volta sem título — digite na mão."
            />
          </div>
        </div>
      </div>

      <div class="cookies-box">
        <button class="ghost small cookies-toggle" @click="mostraCookies = !mostraCookies">
          🍪 cookies do YouTube
          <span :class="ytCookiesStatus?.configurado ? 'ok' : 'dim'">
            {{ ytCookiesStatus?.configurado ? '✓ configurados' : '— não configurados' }}
          </span>
        </button>
        <Ajuda
          titulo="Cookies do YouTube"
          texto="É o que faz a fábrica se apresentar ao YouTube como um navegador logado. O selo ao lado só diz se existe algum cookie salvo — o conteúdo nunca é mostrado de volta."
          atencao="'✓ configurados' não quer dizer válidos: cookie vencido continua marcado como configurado e o download falha com 'faça login'."
        />
        <div v-if="mostraCookies" class="cookies-panel">
          <p class="dim small">
            Se um vídeo do YouTube falhar com "faça login", os cookies venceram. Exporte de novo
            (extensão <b>Get cookies.txt LOCALLY</b> ou <b>Cookie-Editor</b>, num perfil/janela novos,
            e feche sem navegar), cole aqui e salve — aceita o .txt (Netscape) OU o JSON, e os vídeos
            que falharam voltam pra fila sozinhos.
          </p>
          <textarea v-model="ytCookiesTexto" rows="4" placeholder="cole o cookies.txt (Netscape) OU o JSON (Cookie-Editor) inteiro" />
          <div class="row">
            <button class="primary" :disabled="salvandoCookies" @click="salvarCookies">
              {{ salvandoCookies ? 'salvando…' : 'salvar cookies e tentar de novo' }}
            </button>
            <Ajuda
              titulo="Salvar cookies e refazer os erros"
              texto="Salva os cookies e devolve pra fila TODOS os jobs de link que estavam em erro, acordando a fábrica em seguida. A mensagem no topo diz quantos voltaram."
              atencao="Volta pra fila até job que falhou por outro motivo (link morto, vídeo removido) — ele vai tentar e falhar de novo."
            />
          </div>
        </div>
      </div>

      <template v-if="linkPronto">
        <div class="escolhido">
          <span class="grow">🔗 link pronto — confira os campos e envie</span>
          <button class="ghost" @click="limparEscolha">✕ cancelar link</button>
        </div>
        <div class="form">
          <label>Título <input v-model="form.title" /></label>
          <label>Tipo
            <Ajuda
              titulo="Tipo da mídia"
              texto="Define o papel na grade: episódio e filme entram na rotação de programas; comercial e vinheta entram no pool de intervalo."
              atencao="Nos canais em modo fiel, comercial ou vinheta cuja fala promete programação fica FORA do rodízio até você decidir na aba Promessas."
            />
            <select v-model="form.tipo">
              <option value="episodio">episódio</option>
              <option value="filme">filme</option>
              <option value="comercial">comercial</option>
              <option value="vinheta">vinheta</option>
            </select>
          </label>
          <label>ID
            <Ajuda
              titulo="ID da mídia"
              texto="É o identificador único e vira a pasta do vídeo no armazenamento. Aceita só minúsculas, números e _ (3 a 40) e não pode repetir id que já exista no catálogo, na fila ou num upload em andamento."
              atencao="O id não é editável depois. Como os episódios de uma série são ordenados pelo id, manter o padrão ep_serie_e03 é o que garante a ordem certa na grade."
            />
            <input v-model="form.id" />
          </label>
          <div class="row">
            <label>Série
              <Ajuda
                titulo="Série (slug)"
                texto="É o apelido que agrupa os episódios; sem ele o vídeo é peça avulsa. A série é o que liga blocos de episódios seguidos, âncoras de horário fixo, maratonas e as promessas do tipo 'a seguir'."
                atencao="O que você digitar é gravado como está — use minúsculas com _ (ex.: power_rangers). Com espaço ou acento não casa com âncora nem com a troca de canais em lote."
              />
              <input v-model="form.series_id" placeholder="opcional" />
            </label>
            <label>Ep nº <input v-model="form.episode" placeholder="opcional" /></label>
          </div>
          <div class="canais-check">
            <span class="dim small">Canais:
              <Ajuda
                titulo="Canais"
                texto="Escolhe em quais canais o vídeo entra no rodízio da grade; pelo menos um é obrigatório. Dá pra trocar depois no Catálogo — ao trocar, os canais afetados são replanejados na hora."
              />
            </span>
            <label v-for="c in channels" :key="c.id" class="check">
              <input type="checkbox" :value="c.id" v-model="form.canais" /> {{ c.nome }}
            </label>
          </div>
          <p v-if="form.canais.length === 0" class="err small">escolha pelo menos um canal</p>
          <div class="row">
            <button class="primary" :disabled="sending" @click="enviarLink">
              {{ sending ? 'enviando…' : 'baixar e colocar na fila' }}
            </button>
            <Ajuda
              titulo="Baixar e colocar na fila"
              texto="Cria o job com o link e acorda a fábrica; ela baixa, transcodifica e só então a mídia entra no catálogo. Ao terminar, a grade de todos os canais é replanejada."
              atencao="Se o YouTube barrar ('Sign in to confirm you're not a bot'), o job cai em erro na fila — renove os cookies e clique ↻."
            />
          </div>
        </div>
      </template>

      <template v-if="file && meta">
        <div class="escolhido">
          <span class="grow">
            🎞 {{ file.name }} · {{ fmtDur(Math.round(meta.duration)) }} · {{ meta.width }}x{{ meta.height }}
          </span>
          <Ajuda
            titulo="Sugestões automáticas"
            texto="Duração e resolução são lidas no próprio navegador; título, id, série e canais saem do nome do arquivo, e o tipo sai do nome mais a duração. Confira antes de enviar."
            atencao="Menos de 90s vira 'comercial' e mais de 1h vira 'filme'; nome com jetix/fox kids, cartoon/cn ou disney já marca o canal sozinho."
          />
          <button v-if="!sending" class="ghost" @click="limparEscolha">✕ trocar arquivo</button>
        </div>
        <div class="form">
          <label>Título <input v-model="form.title" /></label>
          <label>Tipo
            <Ajuda
              titulo="Tipo da mídia"
              texto="Define o papel na grade: episódio e filme entram na rotação de programas; comercial e vinheta entram no pool de intervalo. Só episódio e filme ganham pontos de corte pra intervalo."
              atencao="Nos canais em modo fiel, comercial ou vinheta cuja fala promete programação fica FORA do rodízio até você decidir na aba Promessas."
            />
            <select v-model="form.tipo">
              <option value="episodio">episódio</option>
              <option value="filme">filme</option>
              <option value="comercial">comercial</option>
              <option value="vinheta">vinheta</option>
            </select>
          </label>
          <label>ID
            <Ajuda
              titulo="ID da mídia"
              texto="É o identificador único e vira a pasta do vídeo no armazenamento. Aceita só minúsculas, números e _ (3 a 40) e não pode repetir id que já exista no catálogo, na fila ou num upload em andamento."
              atencao="O id não é editável depois. Como os episódios de uma série são ordenados pelo id, manter o padrão ep_serie_e03 é o que garante a ordem certa na grade."
            />
            <input v-model="form.id" />
          </label>
          <div class="row">
            <label>Série
              <Ajuda
                titulo="Série (slug)"
                texto="É o apelido que agrupa os episódios; sem ele o vídeo é peça avulsa. A série é o que liga blocos de episódios seguidos, âncoras de horário fixo, maratonas e as promessas do tipo 'a seguir'."
                atencao="Use minúsculas com _ (ex.: power_rangers). Com espaço ou acento não casa com âncora de horário nem com a troca de canais em lote por série."
              />
              <input v-model="form.series_id" placeholder="opcional" />
            </label>
            <label>Ep nº
              <Ajuda
                titulo="Ep nº"
                texto="Guarda o número do episódio na ficha da mídia. A ordem de exibição na grade não usa este campo — ela segue o id em ordem alfabética dentro da série."
              />
              <input v-model="form.episode" placeholder="opcional" />
            </label>
          </div>
          <label>Tags
            <Ajuda
              titulo="Tags"
              texto="Fica guardado na ficha da mídia, separado por vírgula. Hoje nenhuma parte da grade lê as tags — pode deixar vazio."
            />
            <input v-model="form.tags" placeholder="acao,anos90" />
          </label>
          <div class="canais-check">
            <span class="dim small">Canais:
              <Ajuda
                titulo="Canais"
                texto="Escolhe em quais canais o vídeo entra no rodízio da grade; pelo menos um é obrigatório, senão o envio é recusado. Dá pra trocar depois no Catálogo."
              />
            </span>
            <label v-for="c in channels" :key="c.id" class="check">
              <input type="checkbox" :value="c.id" v-model="form.canais" /> {{ c.nome }}
            </label>
          </div>
          <p v-if="form.canais.length === 0" class="err small">escolha pelo menos um canal</p>
          <div class="row">
            <button class="primary" :disabled="sending" @click="submit">
              {{ sending ? `enviando… ${pct}%` : 'enviar pra fila' }}
            </button>
            <button v-if="sending" class="ghost perigo" @click="cancelarForm">✕ cancelar envio</button>
            <Ajuda
              v-if="!sending"
              titulo="Enviar pra fila"
              texto="Cria a sessão no servidor antes do primeiro byte e sobe o arquivo em pedaços de 10 MB, com nova tentativa automática se a rede cair. Quando termina, nasce o job."
              atencao="Recarregar a página no meio não perde o envio: a sessão fica em 'uploads interrompidos' e continua de onde parou quando você reanexar o mesmo arquivo."
            />
            <Ajuda
              v-else
              titulo="Cancelar o envio"
              texto="Interrompe o envio e apaga a sessão no servidor. Os pedaços já enviados são descartados: pra mandar de novo, é do zero."
              atencao="Em compensação o id volta a ficar livre na hora — a próxima tentativa não esbarra em 'id já existe'."
            />
          </div>
          <div v-if="sending" class="bar"><div class="bar-fill" :style="{ width: pct + '%' }" /></div>
        </div>
      </template>

      <template v-if="lote.length">
        <div class="escolhido">
          <span class="grow">
            📦 {{ lote.length }} vídeos no lote · {{ loteFeitos }} na fila
          </span>
          <Ajuda
            titulo="Como o lote é montado"
            texto="Série e episódio são deduzidos do nome da pasta e do número do arquivo. O título e o tipo dá pra corrigir linha a linha aqui; o id foi montado na leitura da pasta e não muda."
            atencao="Se um item precisar de id diferente, mande esse arquivo sozinho pelo formulário de um vídeo só — lá o ID é campo editável."
          />
          <button v-if="!loteEnviando" class="ghost" @click="limparEscolha">✕ descartar o lote</button>
          <button v-else class="ghost perigo" @click="cancelarLoteInteiro">✕ parar o lote</button>
        </div>
        <div v-if="loteEnviando || loteFeitos" class="bar">
          <div class="bar-fill" :style="{ width: Math.round((loteFeitos / lote.length) * 100) + '%' }" />
        </div>
        <div class="canais-check">
          <span class="dim small">Canais do lote:
            <Ajuda
              titulo="Canais do lote"
              texto="Valem pra TODOS os vídeos do lote — não dá pra escolher canal item a item aqui. Pelo menos um é obrigatório, senão o envio nem começa."
              atencao="Se um item precisar ir pra outro canal, ajuste depois pela aba Catálogo."
            />
          </span>
          <label v-for="c in channels" :key="c.id" class="check">
            <input type="checkbox" :value="c.id" v-model="loteCanais" /> {{ c.nome }}
          </label>
        </div>
        <p v-if="loteCanais.length === 0" class="err small">escolha pelo menos um canal pro lote</p>
        <div v-for="item in lote" :key="item.rel || item.file.name" class="lote-row">
          <span class="mono">{{ item.id }}</span>
          <input v-model="item.titulo" class="lote-titulo" :aria-label="`título de ${item.id}`" />
          <select v-model="item.tipo" :aria-label="`tipo de ${item.id}`">
            <option value="episodio">ep</option>
            <option value="filme">filme</option>
            <option value="comercial">com</option>
            <option value="vinheta">vin</option>
          </select>
          <span class="mini-bar" v-if="item.status.startsWith('enviando')">
            <span class="mini-bar-fill" :style="{ width: item.pct + '%' }" />
          </span>
          <span class="chip" :class="item.status === 'na fila' ? 'st-done' : item.status.startsWith('erro') || item.status === 'cancelado' ? 'st-error' : 'st-queued'">{{ item.status }}</span>
          <button
            v-if="item.status.startsWith('enviando') || item.status === 'reservado'"
            class="ghost" title="parar o envio deste item" aria-label="parar o envio deste item"
            @click="cancelarItem(item)"
          >✕</button>
          <template v-else>
            <button
              v-if="item.status.startsWith('erro') || item.status === 'cancelado'"
              class="ghost" title="tentar de novo (continua de onde parou)" aria-label="tentar de novo"
              @click="tentarDeNovo(item)"
            >↻</button>
            <button
              v-if="item.status !== 'na fila'"
              class="ghost" title="tirar este vídeo do lote" aria-label="tirar do lote"
              @click="removeDoLote(item)"
            >🗑</button>
          </template>
        </div>
        <div class="row lote-acoes">
          <button class="primary" :disabled="loteEnviando" @click="enviarLote">
            {{ loteEnviando ? 'enviando lote…' : `enviar ${lote.length} pra fila` }}
          </button>
          <Ajuda
            titulo="Enviar o lote todo"
            texto="Primeiro reserva a sessão de TODOS os itens no servidor e só depois começa a subir, um arquivo por vez. É por isso que um reload no meio não perde nenhum item."
            atencao="Item cujo id já exista no catálogo ou na fila falha logo na reserva com 'id já existe'."
          />
          <button v-if="loteComProblema.length" class="ghost" @click="limparLoteComProblema">
            🧹 tirar os {{ loteComProblema.length }} com erro/cancelados
          </button>
        </div>
      </template>

      <template v-if="pendentesVisiveis.length || retomadas.length">
        <h2 class="mt">Uploads interrompidos
          <Ajuda
            titulo="Uploads interrompidos"
            texto="Envios que ficaram pela metade e continuam vivos no servidor, com quantas partes já subiram. Eles não somem sozinhos: ou você retoma, ou descarta."
            atencao="Enquanto a sessão existir, o id dela fica reservado — um envio novo com o mesmo id é recusado com 'id já existe'."
          />
        </h2>
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
          <button class="ghost perigo" title="abandona e limpa este upload" @click="descartar(p)">🗑 descartar</button>
          <Ajuda
            titulo="Descartar o upload"
            texto="Apaga a sessão e joga fora os pedaços já enviados — depois disso não tem como retomar. Serve pra limpar envio pela metade e soltar o id que ficou preso."
          />
        </div>
        <div v-if="pendentesVisiveis.length > 1" class="row">
          <button class="ghost perigo" :disabled="descartandoTudo" @click="descartarTodos">
            {{ descartandoTudo ? 'descartando…' : `🗑 descartar todos (${pendentesVisiveis.length})` }}
          </button>
          <Ajuda
            titulo="Descartar todos"
            texto="Apaga de uma vez as sessões interrompidas e as partes já enviadas de cada uma. Os ids voltam a ficar livres."
            atencao="Não tem volta: reenviar depois recomeça do zero."
          />
        </div>
        <div v-for="r in retomadas" :key="r.sess.id" class="job-row">
          <span class="mono">{{ r.sess.media_id }}</span>
          <span class="dim grow">{{ r.sess.title }}</span>
          <span class="mini-bar" v-if="r.status.startsWith('enviando')">
            <span class="mini-bar-fill" :style="{ width: r.pct + '%' }" />
          </span>
          <span class="chip" :class="r.status === 'na fila' ? 'st-done' : r.status.startsWith('erro') || r.status === 'cancelado' ? 'st-error' : 'st-queued'">{{ r.status }}</span>
          <button
            v-if="r.status.startsWith('enviando') || r.status.startsWith('aguardando')"
            class="ghost" title="pausar (a sessão continua no servidor)" aria-label="pausar a retomada"
            @click="cancelarRetomada(r)"
          >⏸</button>
        </div>
        <div v-if="retomadas.some((r) => r.status === 'na fila' || r.status.startsWith('erro') || r.status === 'cancelado')" class="row">
          <button class="ghost" @click="limparRetomadas">🧹 limpar as retomadas encerradas</button>
        </div>
      </template>
      </section>

      <section v-show="aba === 'playlist'" class="card">
        <h2>🎬 Séries em partes (playlist)
          <Ajuda
            titulo="Pra que serve esta aba"
            texto="Aqui entra playlist em que cada episódio vem picado em vários vídeos. O caminho é sempre: analisar (a fábrica lista os vídeos e a IA agrupa as partes) → revisar → marcar episódios → baixar."
            atencao="Vídeo inteiro, um por episódio, não precisa passar por aqui — cole o link direto na aba Enviar."
          />
        </h2>
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
            <label>Série
              <Ajuda
                titulo="Série (dica pro agrupamento)"
                texto="É a dica que vira o slug da série e entra no id de cada episódio. Deixando vazio, a IA propõe um a partir dos títulos dos vídeos — e você confere na revisão."
              />
              <input v-model="plSerie" placeholder="ex.: jake_long (opcional)" />
            </label>
            <label>Temporada
              <Ajuda
                titulo="Temporada"
                texto="Entra no id do episódio pra separar temporadas da mesma série (ep_serie_s2e05). Deixe vazio se a série não tem temporadas separadas."
              />
              <input v-model="plTemporada" placeholder="opcional" />
            </label>
          </div>
          <div class="canais-check">
            <span class="dim small">Canais:</span>
            <label v-for="c in channels" :key="c.id" class="check">
              <input type="checkbox" :value="c.id" v-model="plCanais" /> {{ c.nome }}
            </label>
          </div>
          <p v-if="plUrl && !ehPlaylist" class="err small">esse link não tem "list=" — não parece uma playlist</p>
          <div class="row">
            <button class="primary" :disabled="plBusy || !ehPlaylist" @click="analisarPlaylist">
              {{ plBusy ? 'analisando…' : 'analisar playlist' }}
            </button>
            <Ajuda
              titulo="Analisar não baixa nada"
              texto="Só lista os vídeos da playlist e deixa a IA agrupar as partes por episódio. Nada é baixado até você revisar e confirmar quais episódios quer."
              atencao="A listagem usa os cookies do YouTube salvos na aba Enviar — playlist privada ou cookie vencido cai em 'erro'."
            />
          </div>
        </div>

        <p v-if="analises.length === 0" class="dim">nenhuma playlist analisada ainda</p>
        <div v-for="pl in analises" :key="pl.id" class="pl-analise">
          <div class="pl-head">
            <span class="mono small grow">{{ pl.url }}</span>
            <span class="chip" :class="`pl-${pl.status}`">{{ PL_STATUS[pl.status] ?? pl.status }}</span>
            <button class="ghost perigo" title="descartar esta análise" aria-label="descartar esta análise" @click="descartarAnalise(pl)">✕</button>
            <Ajuda
              titulo="Descartar a análise"
              texto="Some só daqui. Episódios que você já confirmou viraram jobs e continuam baixando na aba Fila."
              atencao="Não existe 'tentar de novo' numa análise em erro: descarte e cole o link outra vez."
            />
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
              <Ajuda
                titulo="Atalhos de seleção"
                texto="Marcam episódios na lista abaixo — 'limpar' só desmarca, não apaga nada. Cada episódio marcado vira um job separado e a fábrica processa um por vez."
                atencao="Olhe a estimativa embaixo da lista antes de mandar a temporada toda."
              />
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
        <h2>Fábrica de comerciais
          <Ajuda
            titulo="O que a fábrica faz"
            :largura="340"
            texto="Aqui você monta os comerciais que anunciam um programa: a fábrica cola 5 pedaços de locução (frase + nome + frequência + horário + assinatura) e monta o vídeo com a amostra do programa dentro do molde do canal. A montagem não roda no painel — sai daqui como job e quem executa é a fábrica no GitHub Actions."
            atencao="Se qualquer peça (clipe de fala, amostra ou molde) faltar, o job vai pra 'erro' em vez de montar pela metade."
          />
        </h2>
        <p class="dim small">
          Monte o comercial no painel de cima; os cadastros de que ele depende (voz, falas,
          amostras, moldes e âncoras) ficam nos blocos abaixo — abra só o que precisar.
        </p>
        <div class="fab-grid">
          <div class="fab-panel fab-main">
            <h3>Montar comercial</h3>
            <div class="form">
              <div class="row">
                <label>Molde
                  <Ajuda
                    titulo="Molde = arte + canal"
                    texto="O molde escolhe a arte de fundo e, junto com ela, o CANAL do comercial: é o canal do molde que decide de onde vêm as falas e em que canal o comercial vai ao ar quando ficar pronto."
                    atencao="Trocar o molde limpa a Frase já escolhida, e clipe gravado pra outro canal nunca é usado nessa montagem."
                  />
                  <select v-model="buildForm.molde_id">
                    <option value="">escolha</option>
                    <option v-for="m in fabrica.moldes" :key="m.id" :value="m.id">{{ m.nome }} · {{ nomeCanal(m.canal) }}</option>
                  </select>
                </label>
                <label>Programa
                  <Ajuda
                    titulo="Programa anunciado"
                    texto="Lista as séries que já têm episódio ou filme no catálogo. Ao escolher, o painel sugere o ID final do comercial."
                    atencao="O nome falado e as frases precisam estar cadastrados pra ESTA série no canal do molde — série sem clipe 'nome' faz o job falhar."
                  />
                  <select v-model="buildForm.series_id" @change="sugereComercialId">
                    <option value="">escolha</option>
                    <option v-for="s in fabrica.series" :key="s.sid" :value="s.sid">{{ s.titulo }} · {{ s.sid }}</option>
                  </select>
                </label>
              </div>
              <div class="row">
                <label>Hora
                  <Ajuda
                    titulo="A hora manda em 3 coisas"
                    texto="Define o clipe de horário que será falado (casado pela chave HH:MM), o texto impresso na cartela e o horário que o comercial anuncia."
                    atencao="Precisa existir clipe de horário com a chave EXATA nesse canal. A biblioteca base só assa de 15 em 15 minutos — 16:10, por exemplo, dá 'faltam clipes de fala'."
                  />
                  <input v-model="buildForm.hora" type="time" @change="sugereComercialId" />
                </label>
                <label>ID final
                  <Ajuda
                    titulo="ID no catálogo"
                    texto="É o id da mídia no catálogo (minúsculas, dígitos e _, de 3 a 40). Deixando vazio, o servidor gera um com sufixo aleatório."
                    atencao="O ID sugerido pelo painel não tem sufixo — montar um segundo comercial do mesmo programa no mesmo horário devolve 'id já existe'. Mude o ID nesse caso."
                  />
                  <input v-model="buildForm.media_id" placeholder="com_power_rangers_16h" />
                </label>
              </div>
              <div class="fab-days">
                <span class="dim small">Dias:
                  <Ajuda
                    titulo="Dias = frequência falada"
                    texto="Os dias marcados viram a chave da frequência que será falada ('de segunda a sexta', 'todos os dias') e o texto na tela ('SEG A SEX · 16H')."
                    atencao="Só existem prontos os combos todos, seg-sex, fim de semana e dia único. Um combo tipo seg+qua+sex exige que você grave/sintetize esse clipe antes."
                  />
                </span>
                <button
                  v-for="d in DIAS_FAB"
                  :key="d.n"
                  class="chip chip-btn"
                  :class="{ 'chip-on': buildForm.dias.includes(d.n) }"
                  :aria-pressed="buildForm.dias.includes(d.n)"
                  @click="toggleDiaFab(d.n)"
                >{{ d.label }}</button>
              </div>
              <div class="row">
                <label>Amostra
                  <Ajuda
                    titulo="Vídeo que aparece"
                    texto="É o trecho do programa que aparece em tela cheia e depois encolhe pra dentro do molde. 'Automática' pega a amostra mais recente cadastrada pra essa série."
                    atencao="Sem nenhuma amostra da série o job falha com 'cadastre uma amostra'. A lista filtra por série, não por canal."
                  />
                  <select v-model="buildForm.sample_id">
                    <option value="">automática</option>
                    <option v-for="s in samplesDaSerie" :key="s.id" :value="s.id">{{ s.rotulo }}</option>
                  </select>
                </label>
                <label>Frase
                  <Ajuda
                    titulo="A frase abre a locução"
                    texto="É o clipe de categoria 'frase' que abre a locução e cronometra a virada: enquanto a frase fala, a amostra fica em tela cheia; quando ela acaba, entra a cartela com nome e horário."
                    atencao="Vazio significa sorteio aleatório entre as frases dessa série/canal."
                  />
                  <select v-model="buildForm.frase_id">
                    <option value="">sortear entre as frases</option>
                    <option v-for="f in frasesDaSerie" :key="f.id" :value="f.id">{{ f.rotulo }}</option>
                  </select>
                </label>
              </div>
              <label>Título no catálogo
                <Ajuda
                  titulo="Nome na lista"
                  texto="Nome que o comercial recebe no catálogo e na grade. Vazio vira automaticamente '<título da série> — SEG A SEX · 16H'."
                />
                <input v-model="buildForm.title" placeholder="opcional" />
              </label>
              <p v-if="!buildForm.molde_id || !buildForm.series_id || !buildForm.dias.length" class="err small">
                escolha molde, programa e pelo menos um dia
              </p>
              <div class="row">
                <button class="primary" :disabled="fabBusy" @click="montarComercial">
                  {{ fabBusy ? 'trabalhando…' : 'montar comercial' }}
                </button>
                <Ajuda
                  titulo="O que acontece ao montar"
                  texto="Cria o job e acorda a fábrica. Quando terminar, o comercial entra no catálogo do canal do molde, nasce como recado genérico (entra no rodízio normal) e a grade daquele canal é replanejada na hora."
                  atencao="O comercial toca em qualquer hora do dia — quem faz o horário anunciado virar verdade é a Âncora de grade, abaixo."
                />
              </div>
            </div>
          </div>

          <details
            class="fab-panel"
            :open="fabAbertos.vozes"
            @toggle="alternaFab('vozes', ($event.target as HTMLDetailsElement).open)"
          >
            <summary>Vozes dos canais
              <span class="dim">· {{ fabrica.tts_disponivel ? 'ElevenLabs ligado' : 'sem chave (só upload)' }}</span>
            </summary>
            <div class="fab-list">
              <div v-for="c in fabrica.canais" :key="c.id" class="fab-mini">
                <span class="mono">{{ c.nome }}</span>
                <input v-model="vozEdit[c.id]" placeholder="voice_id do ElevenLabs" class="mono grow" :aria-label="`voice_id de ${c.nome}`" />
                <select v-model="vozModelo[c.id]" title="modelo de voz" :aria-label="`modelo de voz de ${c.nome}`">
                  <option value="eleven_v3">v3 (tags/pausa)</option>
                  <option value="eleven_multilingual_v2">multilingual v2</option>
                </select>
                <button class="ghost" :disabled="fabBusy" @click="salvarVozCanal(c.id)">salvar</button>
                <button class="ghost" :disabled="!!vozTestando || !c.voz_id" @click="testarVoz(c.id)">
                  {{ vozTestando === c.id ? '…' : '▶ testar' }}
                </button>
                <button class="ghost" :disabled="fabBusy || !c.voz_id" title="gerar horários/frequências/assinatura" @click="gerarBiblioteca(c.id)">📚 base</button>
              </div>
            </div>
            <div class="row">
              <span class="dim small">
                <Ajuda
                  titulo="Narrador do canal"
                  texto="O voice_id é a voz do ElevenLabs que narra este canal — é a voz padrão de tudo que ele sintetiza. O modelo v3 entende as tags de emoção e pausa; o multilingual v2 é o antigo, sem esse recurso."
                  atencao="Digitar não basta: 'testar' e '📚 base' usam a voz JÁ SALVA no servidor. Clique em salvar antes. Trocar o modelo faz toda fala ser sintetizada de novo (gasta crédito)."
                />
                voice_id e modelo
              </span>
              <span class="dim small">
                <Ajuda
                  titulo="Assar a biblioteca base"
                  texto="'📚 base' sintetiza de uma vez a biblioteca fixa do canal: os horários de 15 em 15 min, as frequências, a assinatura e os conectores — cerca de 95 clipes. Pula o que já existe."
                  atencao="É o botão que mais gasta crédito do painel. Se a cota ou a chave falhar ele para no meio, avisa quantos faltam, e você clica de novo depois."
                />
                📚 base
              </span>
              <span class="dim small">
                <Ajuda
                  titulo="Ouvir a voz"
                  texto="'▶ testar' sintetiza o texto de teste na voz salva do canal e toca na hora."
                  atencao="Gasta crédito na primeira vez; repetir o mesmo texto com a mesma voz e modelo sai de graça (fica em cache)."
                />
                ▶ testar
              </span>
            </div>
            <label>Texto de teste <input v-model="vozTexto" placeholder="frase para ouvir a voz" /></label>
            <p class="dim">No v3 dá pra usar tags de emoção: <span class="mono">[excited]</span> <span class="mono">[playful]</span> <span class="mono">[short pause]</span> — e uma pausa antes de "Jetix" limpa a pronúncia.</p>
          </details>

          <details
            class="fab-panel"
            :open="fabAbertos.clipes"
            @toggle="alternaFab('clipes', ($event.target as HTMLDetailsElement).open)"
          >
            <summary>Clipes de fala <span class="dim">· {{ fabrica.voice_clips.length }}</span>
              <Ajuda
                titulo="Banco de pedaços de fala"
                :largura="340"
                texto="É o banco de pedaços que a fábrica concatena. A locução final é sempre 5 pedaços: frase + nome + frequência + horário + assinatura (na promo de maratona vira 'neste [dia]' + 'maratona de' + nome + horário + assinatura)."
                atencao="Faltando um dos 5, o job para com 'faltam clipes de fala' e nada é publicado."
              />
            </summary>
            <div class="form">
              <div class="row">
                <label>Canal
                  <Ajuda
                    titulo="Clipe pertence a um canal"
                    texto="O clipe só é usado por comerciais cujo molde é deste canal — cada canal tem seu narrador e nunca empresta fala pro outro."
                    atencao="Cadastrar no canal errado faz o clipe simplesmente nunca ser encontrado na montagem."
                  />
                  <select v-model="clipForm.canal">
                    <option v-for="c in channels" :key="c.id" :value="c.id">{{ c.nome }}</option>
                  </select>
                </label>
                <label>Categoria
                  <Ajuda
                    titulo="Categoria = como é achado"
                    texto="A categoria decide como a fábrica encontra o clipe: horário, frequência e conector casam pela CHAVE; nome e frase casam pela SÉRIE."
                    atencao="Nome e frase exigem série válida; horário, frequência e conector exigem chave — o servidor recusa o cadastro se faltar."
                  />
                  <select v-model="clipForm.categoria">
                    <option value="frase">frase</option>
                    <option value="nome">nome</option>
                    <option value="frequencia">frequência</option>
                    <option value="horario">horário</option>
                    <option value="conector">conector</option>
                  </select>
                </label>
              </div>
              <label>Série
                <Ajuda
                  titulo="Série do clipe"
                  texto="Só vale nas categorias nome e frase; nas outras o servidor ignora. Use o mesmo slug que aparece no seletor Programa."
                  atencao="Palavra diferente vira slug diferente: 'padrinhos' e 'os_padrinhos' são séries distintas e a montagem não acha o clipe."
                />
                <input v-model="clipForm.series_id" placeholder="só nome/frase" />
              </label>
              <label>Chave
                <Ajuda
                  titulo="A chave é o casamento"
                  :largura="340"
                  texto="É por ela que a montagem acha o clipe: horário usa HH:MM ('16:00'); frequência usa a chave dos dias (todos, seg-sex, fimsemana, um dia solto). Nos conectores, a montagem usa encerramento, maratona e evento_dia_1 a 7."
                  atencao="Chave que não bate com o que a montagem procura nunca é usada — o clipe fica no banco sem nunca tocar."
                />
                <input v-model="clipForm.chave" placeholder="16:00, seg-sex, todos..." />
              </label>
              <label>Rótulo falado
                <Ajuda
                  titulo="O texto que será falado"
                  texto="É o texto que vai ser sintetizado e o que entra na transcrição do comercial. Escreva como se fala: 'às quatro da tarde'."
                  atencao="No clipe de categoria 'nome' esse mesmo texto vira o título impresso na cartela — escreva o nome como ele deve aparecer na tela E ser falado."
                />
                <input v-model="clipForm.rotulo" placeholder="às quatro da tarde" />
              </label>
              <label class="fab-check">
                <input type="checkbox" v-model="clipForm.sintetizar" :disabled="!fabrica.tts_disponivel" />
                sintetizar com a voz do canal (ElevenLabs)
                <Ajuda
                  titulo="Sintetizar ou subir áudio"
                  texto="Marcado, o servidor gera o áudio na hora a partir do rótulo usando a voz do canal. Desmarcado, aparece o campo pra você subir um áudio já gravado."
                  atencao="A síntese gasta crédito na primeira vez e reaproveita o arquivo nas próximas (mesmo texto + voz + modelo). Se a cota ou a chave falhar, o clipe não é criado."
                />
              </label>
              <label v-if="clipForm.sintetizar">Voz específica (opcional)
                <input v-model="clipForm.voz_id" placeholder="voice_id só para este clipe" class="mono" />
              </label>
              <input v-else type="file" accept="audio/*,video/*" @change="onClipFile" />
              <p v-if="clipForm.sintetizar && !vozDoCanal(clipForm.canal) && !clipForm.voz_id" class="dim">
                ⚠️ o canal "{{ clipForm.canal }}" ainda não tem voz — configure em "Vozes dos canais".
              </p>
              <button class="ghost" :disabled="fabBusy" @click="salvarClip">
                {{ clipForm.sintetizar ? 'sintetizar fala' : 'salvar fala' }}
              </button>
            </div>
            <div class="row" style="margin-top: 12px">
              <label>Filtrar canal
                <select v-model="clipFiltroCanal">
                  <option value="">todos</option>
                  <option v-for="c in fabrica.canais" :key="c.id" :value="c.id">{{ c.nome }}</option>
                </select>
              </label>
              <label>Filtrar categoria
                <select v-model="clipFiltroCat">
                  <option value="">todas</option>
                  <option value="horario">horário</option>
                  <option value="frequencia">frequência</option>
                  <option value="nome">nome</option>
                  <option value="frase">frase</option>
                  <option value="conector">conector</option>
                </select>
              </label>
              <input v-model="clipBusca" class="grow" placeholder="🔎 buscar no rótulo/chave" />
            </div>
            <p class="dim">Mostrando {{ clipesVisiveis.length }} de {{ clipesFiltrados.length }} — clique ▶ pra ouvir.</p>
            <p v-if="fabrica.voice_clips.length === 0" class="dim small">
              nenhuma fala cadastrada ainda — configure a voz do canal acima e clique em "📚 base" pra assar a biblioteca fixa (horários, frequências e assinatura).
            </p>
            <div class="fab-list">
              <div v-for="c in clipesVisiveis" :key="c.id" class="fab-mini">
                <span class="mono">{{ c.canal }} · {{ c.categoria }}</span>
                <span class="dim grow">{{ c.series_id || c.chave }} · {{ c.rotulo }}</span>
                <button class="ghost" :disabled="!!clipTocando" title="ouvir" aria-label="ouvir este clipe" @click="tocarClip(c.id)">{{ clipTocando === c.id ? '…' : '▶' }}</button>
                <button class="ghost perigo" title="remover clipe" aria-label="remover clipe" @click="apagarFab('voice-clips', c.id, c.rotulo)">✕</button>
              </div>
            </div>
            <button v-if="clipesFiltrados.length > clipesVisiveis.length" class="ghost" @click="clipLimite += 60">
              ▾ mostrar mais 60
            </button>
          </details>

          <details
            class="fab-panel"
            :open="fabAbertos.amostras"
            @toggle="alternaFab('amostras', ($event.target as HTMLDetailsElement).open)"
          >
            <summary>Amostras <span class="dim">· {{ fabrica.samples.length }}</span>
              <Ajuda
                titulo="Amostra = a imagem do comercial"
                texto="É o trecho de vídeo do programa que aparece no comercial: primeiro em tela cheia, depois encolhido dentro do buraco do molde. Pode ser um arquivo enviado ou um link do YouTube."
              />
            </summary>
            <div class="form">
              <label>Série
                <Ajuda
                  titulo="Amarra a amostra à série"
                  texto="A montagem procura a amostra por este slug; ele precisa ser igual ao series_id do programa escolhido em 'Montar comercial'."
                  atencao="Slug diferente = amostra invisível pra fábrica e job com erro 'cadastre uma amostra'."
                />
                <input v-model="sampleForm.series_id" placeholder="power_rangers_forca_animal" />
              </label>
              <label>Rótulo <input v-model="sampleForm.rotulo" placeholder="cortes de ação 01" /></label>
              <label>Link do YouTube
                <Ajuda
                  titulo="Amostra vinda de link"
                  texto="Guarda só o link; o vídeo é baixado pela fábrica na hora da montagem."
                  atencao="Usa os cookies salvos em '🍪 cookies do YouTube' (aba Enviar). Renovar os cookies reenfileira a fila de envios, mas NÃO os jobs da fábrica — nesses, clique o ↻."
                />
                <input v-model="sampleForm.source_url" type="url" placeholder="https://youtube.com/watch?v=..." />
              </label>
              <label>Vídeo local
                <Ajuda
                  titulo="Amostra enviada"
                  texto="Sobe o trecho e ele fica guardado como amostra da série."
                  atencao="Link e arquivo não podem ir juntos. Este envio é de uma vez só, sem retomada — prefira trechos curtos."
                />
                <input type="file" accept="video/*" @change="onSampleFile" />
              </label>
              <button class="ghost" :disabled="fabBusy" @click="salvarSample">salvar amostra</button>
            </div>
            <p v-if="fabrica.samples.length === 0" class="dim small">
              nenhuma amostra ainda — sem pelo menos uma da série, a montagem falha.
            </p>
            <div class="fab-list">
              <div v-for="s in fabrica.samples.slice(0, 10)" :key="s.id" class="fab-mini">
                <span class="mono">{{ s.series_id }}</span>
                <span class="dim grow">{{ s.source_url ? 'YouTube · ' : '' }}{{ s.rotulo }}</span>
                <button class="ghost perigo" title="remover amostra" aria-label="remover amostra" @click="apagarFab('samples', s.id, s.rotulo)">✕</button>
              </div>
            </div>
            <p v-if="fabrica.samples.length > 10" class="dim small">
              mostrando as 10 mais recentes de {{ fabrica.samples.length }} — as outras continuam valendo pra montagem.
            </p>
          </details>

          <details
            class="fab-panel"
            :open="fabAbertos.moldes"
            @toggle="alternaFab('moldes', ($event.target as HTMLDetailsElement).open)"
          >
            <summary>Moldes <span class="dim">· {{ fabrica.moldes.length }}</span>
              <Ajuda
                titulo="Molde é a arte do canal"
                texto="É o PNG que emoldura o vídeo. O canal do molde é o que decide de onde vêm as falas e onde o comercial vai ao ar."
                atencao="Não dá pra trocar o canal depois — pra outro canal, cadastre outro molde."
              />
            </summary>
            <div class="form">
              <label>Nome <input v-model="moldeForm.nome" /></label>
              <label>Canal
                <select v-model="moldeForm.canal">
                  <option v-for="c in channels" :key="c.id" :value="c.id">{{ c.nome }}</option>
                </select>
              </label>
              <label>PNG do molde
                <Ajuda
                  titulo="A arte com o buraco preto"
                  :largura="340"
                  texto="PNG da arte (redimensionado pra 1280x720) com a janela do vídeo em PRETO sólido: a fábrica transforma o preto em transparência e põe o molde por cima do vídeo, então até janela torta fica recortada certinho."
                  atencao="Se não achar área preta suficiente, ele usa um retângulo padrão à direita da tela e o enquadramento sai errado."
                />
                <input type="file" accept="image/png" @change="onMoldeFile" />
              </label>
              <label>Música de fundo
                <Ajuda
                  titulo="Cama musical do molde"
                  texto="Trilha que toca embaixo da locução em volume reduzido em todos os comerciais desse molde."
                  atencao="Enviando música, ela SUBSTITUI o áudio da amostra; sem música, entra o áudio original da amostra baixinho."
                />
                <input type="file" accept="audio/*" @change="onMusicaFile" />
              </label>
              <button class="ghost" :disabled="fabBusy" @click="salvarMolde">salvar molde</button>
            </div>
            <p v-if="fabrica.moldes.length === 0" class="dim small">
              nenhum molde ainda — sem molde não dá pra montar comercial nenhum.
            </p>
            <div class="fab-list">
              <div v-for="m in fabrica.moldes" :key="m.id" class="fab-mini">
                <span class="mono">{{ m.canal }}</span>
                <span class="dim grow">{{ m.nome }}{{ m.musica_key ? ' · música' : '' }}</span>
                <button class="ghost perigo" title="remover molde" aria-label="remover molde" @click="apagarFab('moldes', m.id, m.nome)">✕</button>
              </div>
            </div>
          </details>

          <details
            class="fab-panel"
            :open="fabAbertos.ancoras"
            @toggle="alternaFab('ancoras', ($event.target as HTMLDetailsElement).open)"
          >
            <summary>Âncoras de grade <span class="dim">· {{ fabrica.ancoras.length }}</span>
              <Ajuda
                titulo="O que é uma âncora"
                texto="Âncora é um horário fixo de verdade na grade: o programa X passa sempre naquele dia e hora, e o resto da programação se ajusta em volta. É o que faz o comercial 'toda quarta às 16h' deixar de ser mentira."
              />
            </summary>
            <p class="dim small">horário fixo do programa (o agendador honra) → o comercial “toda [dias] às [hora]” vira verdade</p>
            <div class="form">
              <div class="row">
                <label>Canal
                  <select v-model="ancoraForm.canal">
                    <option v-for="c in channels" :key="c.id" :value="c.id">{{ c.nome }}</option>
                  </select>
                </label>
                <label>Programa
                  <Ajuda
                    titulo="Programa do horário fixo"
                    texto="A série que vai ocupar o horário. Ela precisa ter episódio pronto e liberado no canal escolhido."
                    atencao="Se a série não tiver episódio no canal, a âncora é ignorada em silêncio na hora de montar a grade — nada avisa no painel."
                  />
                  <select v-model="ancoraForm.series_id">
                    <option value="">escolha</option>
                    <option v-for="s in fabrica.series" :key="s.sid" :value="s.sid">{{ s.titulo }} · {{ s.sid }}</option>
                  </select>
                </label>
              </div>
              <div class="row">
                <label>Hora
                  <Ajuda titulo="Hora local da âncora" texto="Hora de Brasília em que o bloco começa (o código usa -03:00 fixo, sem horário de verão)." />
                  <input v-model="ancoraForm.hora" type="time" />
                </label>
                <label>Episódios
                  <Ajuda
                    titulo="Episódios emendados"
                    texto="Quantos episódios da série tocam emendados a partir daquele horário (1 a 20), com intervalo entre eles."
                    atencao="Quanto maior o número, mais tempo da grade fica travado naquela série — o rodízio só volta depois do bloco inteiro."
                  />
                  <input v-model.number="ancoraForm.episodios" type="number" min="1" max="20" />
                </label>
              </div>
              <div class="fab-days">
                <span class="dim small">Dias:
                  <Ajuda
                    titulo="Dias da âncora"
                    texto="Dias da semana em que esse horário fixo vale; a grade repete o bloco em todos eles."
                    atencao="São independentes dos dias escolhidos em 'Montar comercial' — se ficarem diferentes, o comercial anuncia um horário que a grade não cumpre."
                  />
                </span>
                <button
                  v-for="d in DIAS_FAB"
                  :key="d.n"
                  class="chip chip-btn"
                  :class="{ 'chip-on': ancoraForm.dias.includes(d.n) }"
                  :aria-pressed="ancoraForm.dias.includes(d.n)"
                  @click="toggleDiaAncora(d.n)"
                >{{ d.label }}</button>
              </div>
              <div class="row">
                <button class="ghost" :disabled="fabBusy" @click="salvarAncora">salvar âncora</button>
                <Ajuda
                  titulo="Cria e replaneja na hora"
                  texto="Cria a âncora e já replaneja as próximas 48h desse canal (o bloco que está no ar é preservado)."
                  atencao="Nada atravessa a âncora: um episódio que cruzaria o horário é CORTADO nele e os intervalos encurtam pra ela começar pontual. Maratona agendada tem prioridade e anula a âncora naquele período."
                />
              </div>
            </div>
            <p v-if="fabrica.ancoras.length === 0" class="dim small">
              nenhum horário fixo — hoje a grade é rodízio livre o dia todo.
            </p>
            <div class="fab-list">
              <div v-for="a in fabrica.ancoras" :key="a.id" class="fab-mini">
                <span class="mono">{{ a.canal }}</span>
                <span class="dim grow">{{ tituloSerieFab(a.series_id) }} · {{ diasFabLabel(ancoraDias(a)) }} · {{ a.hora }}<span v-if="a.episodios > 1"> · {{ a.episodios }}ep</span></span>
                <button class="ghost" title="gerar comercial deste horário" aria-label="gerar comercial deste horário" @click="gerarComercialAncora(a)">📢</button>
                <button class="ghost perigo" title="remover âncora" aria-label="remover âncora" @click="apagarAncora(a)">✕</button>
              </div>
            </div>
          </details>
        </div>

        <h2 class="mt">Jobs da fábrica
          <Ajuda
            titulo="Fila de montagem"
            texto="Os últimos 50 jobs de montagem. A montagem roda fora do painel (GitHub Actions), então leva alguns minutos e a porcentagem só anda quando a fábrica reporta progresso."
            atencao="Job parado em 'montando' há mais de 2 horas volta pra fila sozinho no próximo ciclo."
          />
        </h2>
        <p v-if="fabrica.jobs.length === 0" class="dim">nenhum comercial montado por aqui ainda</p>
        <div v-if="fabErro.length || fabFeitos.length" class="row limpeza">
          <span class="dim small">limpar de uma vez:</span>
          <button v-if="fabErro.length" class="ghost perigo" :disabled="fabBusy" @click="limparFabJobs('error')">
            🧹 as {{ fabErro.length }} com erro
          </button>
          <button v-if="fabFeitos.length" class="ghost" :disabled="fabBusy" @click="limparFabJobs('done')">
            🧹 as {{ fabFeitos.length }} concluídas
          </button>
          <Ajuda
            titulo="Limpar a lista de montagens"
            texto="Some só o registro da fábrica. Comercial já montado continua no catálogo e no ar — pra tirar do ar de verdade, use o Catálogo."
          />
        </div>
        <div v-for="j in fabrica.jobs" :key="j.id" class="job-row fab-job">
          <span class="mono">{{ j.media_id }}</span>
          <span class="dim grow">{{ j.title }}</span>
          <span v-if="j.status === 'processing' && j.progress > 0" class="mini-bar">
            <span class="mini-bar-fill" :style="{ width: j.progress + '%' }" />
          </span>
          <span class="chip" :class="`st-${j.status}`">
            {{ j.status === 'processing' && j.progress > 0 ? `montando ${j.progress}%` : (fabStatus[j.status] ?? j.status) }}
          </span>
          <button v-if="j.status === 'error'" class="ghost" title="tentar de novo" aria-label="tentar montar de novo" @click="retryFabJob(j)">↻</button>
          <button
            v-if="j.status !== 'done'"
            class="ghost" title="cancelar esta montagem" aria-label="cancelar esta montagem"
            @click="cancelarFabJob(j)"
          >✕</button>
          <span v-if="j.error" class="err small job-erro">{{ j.error }}</span>
        </div>
      </section>

      <section v-show="aba === 'fila'" class="card">
        <div class="fila-head">
          <h2>Fila de processamento
            <Ajuda
              titulo="O que acontece na fila"
              texto="Quem transcodifica é a fábrica, que roda no GitHub Actions — fora do painel. Por isso o vídeo fica um tempo em 'na fila' antes de começar, e a porcentagem só anda quando a fábrica reporta."
              atencao="Job parado em 'processando' há mais de 2 horas volta pra fila sozinho no próximo ciclo."
            />
          </h2>
          <button
            class="ghost"
            title="o diretor apaga a grade futura e remonta do zero (o bloco no ar é preservado) — use depois de excluir/desativar vídeos"
            @click="replanejar"
          >🔄 diretor: reajustar a grade</button>
          <Ajuda
            titulo="Reajustar a grade"
            texto="Apaga a programação futura e remonta do zero em TODOS os canais. O bloco que está no ar é preservado, então ninguém vê corte."
            atencao="A ordem dos programas muda: o que estava anunciado pras próximas horas pode não ser mais o mesmo."
          />
        </div>

        <div class="secao-sub">
          <span class="sub-label">Em andamento</span>
          <span class="dim small">{{ jobsAtivos.length }} ativo(s)</span>
        </div>
        <p v-if="carregando" class="dim">carregando…</p>
        <p v-else-if="jobsAtivos.length === 0" class="dim">nada processando no momento</p>
        <div v-for="j in jobsAtivos" :key="j.id" class="job-row">
          <span class="mono">{{ j.id }}</span>
          <span class="dim grow">{{ j.title }}</span>
          <span v-if="j.status === 'processing' && j.progress > 0" class="mini-bar">
            <span class="mini-bar-fill" :style="{ width: j.progress + '%' }" />
          </span>
          <span class="chip" :class="`st-${j.status}`">
            {{ j.status === 'processing' && j.progress > 0 ? `processando ${j.progress}%` : (STATUS_PT[j.status] ?? j.status) }}
          </span>
          <button class="ghost" title="cancelar (tira da fila)" aria-label="cancelar este job" @click="cancelJob(j)">✕</button>
          <span v-if="j.error" class="err small job-erro">{{ j.error }}</span>
        </div>

        <!-- limpeza em massa: o histórico enche em minutos e cada linha saía uma a uma -->
        <div v-if="jobsErro.length || jobsFeitos.length" class="row limpeza">
          <span class="dim small">limpar de uma vez:</span>
          <button
            v-if="jobsErro.length"
            class="ghost perigo"
            :disabled="!!limpandoFila"
            @click="limparFila('error')"
          >{{ limpandoFila === 'error' ? 'limpando…' : `🧹 os ${jobsErro.length} com erro` }}</button>
          <Ajuda
            v-if="jobsErro.length"
            titulo="Limpar os que deram erro"
            texto="Tira da fila, de uma vez, todos os itens em erro — eles não serão processados."
            atencao="Em job que veio de UPLOAD, o arquivo já enviado é apagado junto: reenviar depois é do zero. Job de link não perde nada (o vídeo está na origem)."
          />
          <button
            v-if="jobsErro.length"
            class="ghost"
            :disabled="!!limpandoFila"
            @click="retryTodos"
          >{{ limpandoFila === 'retry' ? 'reenfileirando…' : `↻ tentar os ${jobsErro.length} de novo` }}</button>
          <Ajuda
            v-if="jobsErro.length"
            titulo="Tentar todos de novo"
            texto="Devolve pra fila tudo que falhou de uma vez e acorda a fábrica. O caso típico é renovar os cookies do YouTube e reprocessar a leva inteira."
            atencao="Quem falhou por link morto vai tentar e falhar de novo."
          />
          <button
            v-if="jobsFeitos.length"
            class="ghost"
            :disabled="!!limpandoFila"
            @click="limparFila('done')"
          >{{ limpandoFila === 'done' ? 'limpando…' : `🧹 os ${jobsFeitos.length} concluídos` }}</button>
          <Ajuda
            v-if="jobsFeitos.length"
            titulo="Limpar os concluídos"
            texto="Some só o registro da fila — os vídeos continuam no catálogo e no ar, intactos. Serve pra desentupir o histórico."
          />
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
            <button v-if="j.status === 'error'" class="ghost" title="tentar de novo (volta pra fila)" aria-label="tentar de novo" @click="retryJob(j)">↻</button>
            <button v-if="j.status === 'error'" class="ghost" title="cancelar (remove da lista)" aria-label="remover da lista" @click="cancelJob(j)">✕</button>
            <span v-if="j.error" class="err small job-erro">{{ j.error }}</span>
          </div>
        </div>
      </section>

      <section v-show="aba === 'promessas'" class="card">
        <div class="fieis-row">
          <span class="dim small">comerciais por canal:
            <Ajuda
              titulo="Fiel × livre, por canal"
              :largura="340"
              texto="🎯 FIEL: comercial que promete programação só vai ao ar quando a grade cumpre a promessa. 🎲 LIVRE: rodízio cego, toca todo o acervo de comerciais sem checar promessa nenhuma."
              atencao="Trocar replaneja o canal na hora. O modo livre serve pra época de acervo ainda não editado — deixar assim faz o canal prometer coisa que não acontece."
            />
          </span>
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

      <p v-if="!promPendentes.length && !promDecididas.length" class="dim">
        nenhum comercial analisado ainda — assim que um comercial ou vinheta com fala entrar
        no catálogo, a IA propõe aqui o que ele promete.
      </p>
      <template v-if="promPendentes.length || promDecididas.length">
        <h2 class="mt">Promessas de comerciais
          <Ajuda
            titulo="Por que isto existe"
            :largura="340"
            texto="Comercial antigo costuma prometer coisa ('a seguir, Power Rangers', 'toda quarta às 16h'). A IA lê a transcrição e propõe o que ele promete; enquanto você não decide, ele fica fora do ar pra não mentir no ar."
            atencao="Vale só nos canais em modo 🎯 fiel. No modo 🎲 livre tudo toca sem checagem."
          />
        </h2>
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
            <Ajuda
              titulo="Confirmar a promessa"
              texto="Aceita a proposta: o comercial passa a tocar SÓ quando a grade cumpre o que ele promete (colado no programa certo, no horário certo). Os canais dele são replanejados na hora."
              atencao="Promessa do tipo 'a seguir' ou 'você está vendo' exige uma série alvo que já tenha episódio pronto — sem isso o servidor recusa."
            />
            <button class="ghost" @click="decidePromessa(p, 'generico')">é genérico</button>
            <Ajuda
              titulo="É genérico"
              texto="Diz que ele não promete nada de concreto (recado institucional, 'já já tem mais'). Ele volta pro rodízio normal e toca a qualquer hora."
            />
            <button class="ghost perigo" @click="decidePromessa(p, 'ignorar')">não usar</button>
            <Ajuda
              titulo="Não usar"
              texto="Tira o comercial do rodízio — ele não toca em nenhum canal fiel. Não apaga nada: dá pra voltar atrás em 'revisar' na lista de decididas."
            />
            <button class="ghost" title="pede outra análise da IA (útil quando a proposta veio vazia)" aria-label="reanalisar com a IA" @click="reanalisar(p)">🔄</button>
            <Ajuda
              titulo="Pedir outra análise"
              texto="Manda a transcrição pra IA de novo e substitui a proposta. Útil quando a proposta veio vazia ou claramente errada."
            />
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
        <h2 class="mt">✏️ A nomear ({{ aNomear.length }})
          <Ajuda
            titulo="O que cai em &quot;A nomear&quot;"
            texto="O sistema marca sozinho quem tem título ruim: menos de 4 caracteres, só números, monte de consoantes emendadas, ou 14+ caracteres sem nenhum espaço. A linha sai daqui quando você salva um nome que passa nessa regra ou clica em 'está bom'."
          />
        </h2>
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
          <Ajuda
            titulo="Sugerir com IA"
            texto="Manda os ids e títulos atuais do lote inteiro pra IA numa chamada só, junto com o contexto que você escreveu, e ela devolve título, série e episódio pra cada um. Nada é salvo automaticamente: os campos ficam preenchidos e você salva linha a linha."
            atencao="Isto SOBRESCREVE o que já estiver digitado nos campos. O selo 'IA 80%' é a confiança que ela mesma declarou — confira os de confiança baixa."
          />
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
        <h2 class="mt">Séries — canais em lote
          <Ajuda
            titulo="Trocar o canal da série inteira"
            texto="Um clique aplica o canal a TODOS os episódios daquela série de uma vez, e a grade dos canais afetados é replanejada na hora. É o conserto pra 'coloquei a temporada no canal errado'."
            atencao="O agrupamento vem do campo série da mídia — episódio sem série não aparece aqui e precisa ser ajustado um a um lá embaixo."
          />
        </h2>
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
              :aria-pressed="s.canais.has(c.id)"
              @click="toggleCanalSerie(s, c.id)"
            >{{ s.canais.has(c.id) ? '✓' : '+' }} {{ c.nome }}</button>
          </span>
        </div>
      </template>

      <h2 class="mt">Catálogo
        <Ajuda
          titulo="O que é esta lista"
          texto="São as 200 mídias mais recentes que o servidor manda. A busca e os filtros abaixo trabalham em cima dessas — mídia antiga fora das 200 não aparece nem buscando."
        />
        <Ajuda
          titulo="Os botões de cada linha"
          largura="340"
          texto="O seletor muda o TIPO (episódio/filme entram como programa; comercial/vinheta entram no intervalo). Os chips ligam e desligam canais. O campo à direita é a SÉRIE. 'tirar do ar' esconde da grade sem apagar nada. O 🗑 apaga de vez."
          atencao="Trocar tipo, canal ou tirar do ar replaneja a grade daquele canal na hora. O 🗑 só é liberado depois de tirar do ar, e pede confirmação digitada."
        />
      </h2>

      <!-- busca + filtros: 200 linhas de uma vez eram impossíveis de garimpar -->
      <div class="cat-filtros">
        <input v-model="catBusca" class="cat-busca" placeholder="🔎 buscar por título, id ou série" />
        <select v-model="catTipo" aria-label="filtrar por tipo">
          <option value="">todos os tipos</option>
          <option value="episodio">episódio</option>
          <option value="filme">filme</option>
          <option value="comercial">comercial</option>
          <option value="vinheta">vinheta</option>
        </select>
        <select v-model="catCanal" aria-label="filtrar por canal">
          <option value="">todos os canais</option>
          <option v-for="c in channels" :key="c.id" :value="c.id">{{ c.nome }}</option>
        </select>
        <select v-model="catStatus" aria-label="filtrar por situação">
          <option value="">no ar e fora do ar</option>
          <option value="ready">só no ar</option>
          <option value="disabled">só fora do ar</option>
        </select>
        <button v-if="catFiltrando" class="ghost" @click="limparFiltrosCat">✕ limpar filtros</button>
      </div>
      <p class="dim small">
        mostrando {{ catalogoVisivel.length }} de {{ catalogoFiltrado.length }}
        <template v-if="catFiltrando"> (filtrado de {{ media.length }})</template>
      </p>
      <p v-if="carregando" class="dim">carregando…</p>
      <p v-else-if="catalogoFiltrado.length === 0" class="dim">
        {{ catFiltrando ? 'nada encontrado com esses filtros' : 'nenhuma mídia no catálogo ainda — comece pela aba Enviar' }}
      </p>

      <template v-for="m in catalogoVisivel" :key="m.id">
        <div class="job-row wrapy cat-row">
          <span class="cat-nome grow">
            <b class="cat-titulo" :title="titleOf(m)">{{ titleOf(m) }}</b>
            <span class="mono">{{ m.id }} · {{ fmtDur(m.duracao_seg) }}</span>
          </span>
          <select
            class="tipo-select"
            :value="m.tipo"
            :aria-label="`tipo de ${titleOf(m)}`"
            @change="mudarTipo(m, ($event.target as HTMLSelectElement).value)"
          >
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
              :aria-pressed="canaisDe(m).includes(c.id)"
              :title="`${canaisDe(m).includes(c.id) ? 'remover de' : 'adicionar a'} ${c.nome}`"
              @click="toggleCanal(m, c.id)"
            >{{ canaisDe(m).includes(c.id) ? '✓' : '+' }} {{ c.nome }}</button>
          </span>
          <input
            class="series-input"
            :value="seriesOf(m)"
            :aria-label="`série de ${titleOf(m)}`"
            placeholder="série (p/ excluir a temporada toda)"
            @change="saveSeries(m, ($event.target as HTMLInputElement).value)"
          />
          <span class="chip" :class="m.status === 'ready' ? 'st-done' : 'st-error'">
            {{ MEDIA_STATUS[m.status] ?? m.status }}
          </span>
          <button class="ghost" @click="toggle(m)">{{ m.status === 'ready' ? 'tirar do ar' : 'pôr no ar' }}</button>
          <button
            class="ghost perigo"
            title="apagar de vez (não tem volta)"
            aria-label="apagar esta mídia de vez"
            @click="abreDel(m)"
          >🗑</button>
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
      <button
        v-if="catalogoFiltrado.length > catalogoVisivel.length"
        class="ghost hist-toggle"
        @click="catLimite += 50"
      >▾ mostrar mais 50 (faltam {{ catalogoFiltrado.length - catalogoVisivel.length }})</button>
      </section>

      <section v-show="god && aba === 'diretor'" class="card god-card">
      <h2>⚡ Modo God — fale com o Diretor
        <Ajuda
          titulo="O chat executa de verdade"
          :largura="340"
          texto="O que você pedir vira ação no banco na hora: tirar do ar uma mídia ou uma série inteira, cancelar essa exclusão, agendar maratona, replanejar. Não há tela de confirmação, e a grade do canal é replanejada assim que alguma ação passa."
          atencao="Só as 12 últimas mensagens vão pro modelo. Sem IA disponível ele responde que os provedores estão fora e nada é executado."
        />
      </h2>
      <div class="chat-head">
        <select v-model="chatCanal" class="chat-canal" aria-label="canal do Diretor">
          <option v-for="c in channels" :key="c.id" :value="c.id">{{ c.nome }}</option>
        </select>
        <Ajuda
          titulo="Tudo aqui é por canal"
          texto="Chat, 'decidir a noite' e as ordens abaixo valem só pro canal escolhido. O histórico da conversa fica guardado neste navegador, separado por canal."
        />
        <button class="ghost" :disabled="planejando" title="o diretor olha a identidade do canal, as séries e o histórico e decide se hoje tem maratona" @click="decidirANoite">
          {{ planejando ? 'decidindo…' : '🌙 decidir a noite' }}
        </button>
        <Ajuda
          titulo="Decidir a noite agenda maratona"
          :largura="340"
          texto="Roda o mesmo cérebro do planejamento automático das 03:00, só pro canal escolhido. Decidindo que sim, agenda a maratona de uma série pra hoje à noite (no máximo 4 horas), replaneja o canal e manda a fábrica montar um comercial anunciando o evento."
          atencao="Se já existir maratona automática agendada nas próximas 24h, ele não decide de novo. O comercial só sai se o canal tiver molde, amostra e clipes de voz."
        />
        <button class="ghost" @click="replanejar">replanejar grade</button>
        <Ajuda
          titulo="Replaneja TODOS os canais"
          texto="Apaga a grade futura e remonta do zero em todos os canais, não só no que está selecionado. O bloco que está no ar é preservado."
          atencao="A ordem dos programas muda: o que estava anunciado pras próximas horas pode não ser mais o mesmo."
        />
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

      <h2 class="mt">Identidades editoriais
        <Ajuda
          titulo="É o roteiro que a IA lê"
          texto="Esse texto entra no prompt do Diretor, tanto no chat quanto na decisão da noite. Salvar não mexe na grade atual — muda só as próximas decisões."
        />
      </h2>
      <p class="dim">O "roteiro" que o Diretor segue em cada canal — edite à vontade.</p>
      <div v-for="ch in channels" :key="ch.id" class="ident">
        <h3 :style="{ color: ch.cor }">{{ ch.nome }}</h3>
        <textarea v-model="ch.identidade" rows="4" />
        <button class="ghost" :disabled="identSaving === ch.id" @click="saveIdentidade(ch)">
          {{ identSaving === ch.id ? 'salvando…' : 'salvar identidade' }}
        </button>
        <label class="bloco-row">
          <span>episódios seguidos por série:</span>
          <Ajuda
            titulo="Quantos episódios emendam"
            texto="Quantos episódios da mesma série o Diretor coloca em sequência antes de trocar de programa (1 = sem agrupar, as séries entram em rodízio puro). Salva no ato e replaneja a grade futura desse canal."
          />
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
.nav-badge.vermelho { background: rgba(255, 107, 107, 0.16); color: #ff6b6b; }

.content { min-width: 0; display: flex; flex-direction: column; gap: 16px; }
.global-msg { display: flex; align-items: center; gap: 10px;
  border: 1px solid var(--line); background: var(--panel); border-radius: 8px;
  padding: 10px 14px; font-size: 13px; }
.global-msg.err { color: #ff6b6b; border-color: rgba(255, 107, 107, 0.4); }
.global-msg.ok { color: var(--ok); border-color: rgba(56, 217, 122, 0.4); }
.msg-x { background: transparent; border: 0; color: inherit; opacity: 0.6; font-size: 13px; flex: none; }
.msg-x:hover { opacity: 1; }

/* faixa de pendências: o que precisa de mim, e em que aba está */
.resumo { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.resumo-label { font-size: 11px; font-weight: 700; letter-spacing: 0.08em;
  text-transform: uppercase; color: var(--text-dim); }
.resumo-pill { background: var(--panel); border: 1px solid var(--line); border-radius: 999px;
  color: var(--text); padding: 5px 13px; font-size: 12px; font-weight: 600; }
.resumo-pill:hover { border-color: var(--accent); }
.resumo-ok { font-size: 12px; color: var(--ok); opacity: 0.75; }

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
/* .dim é usada tanto em parágrafo quanto em <span> dentro de linha flex — a
   margem só faz sentido no parágrafo (num item flex ela desalinha a linha) */
.dim { color: var(--text-dim); font-size: 13px; }
p.dim { margin: 8px 0; }
.err { color: #ff6b6b; font-size: 13px; margin-top: 8px; }
.ok { color: var(--ok); font-size: 13px; margin-top: 8px; }
.small { font-size: 11px; }
.mono { font-family: ui-monospace, monospace; font-size: 12px; color: var(--text-dim);
  min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.grow { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.form { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }
.form label { position: relative; display: flex; flex-direction: column; gap: 4px;
  font-size: 12px; color: var(--text-dim); flex: 1; }
/* O rótulo é uma coluna (texto em cima, campo embaixo) e o "?" viraria uma
   terceira linha — fora do fluxo ele fica na ponta da linha do rótulo.
   :deep() porque o botão é a raiz de um componente filho e não carrega o
   atributo de escopo desta folha de estilo. */
.form label > :deep(.ajuda-btn) { position: absolute; top: -1px; right: 0; margin: 0; }
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
/* alvos de clique: 5px de padding num botão de 12px era quase impossível de acertar */
button.ghost { background: transparent; border: 1px solid var(--line); color: var(--text-dim);
  border-radius: 8px; padding: 7px 12px; font-size: 13px; min-height: 34px; }
button.ghost:hover { color: var(--text); border-color: var(--text-dim); }
button.ghost:disabled { opacity: 0.45; }
button.ghost.small { padding: 5px 10px; font-size: 12px; min-height: 0; }
@media (pointer: coarse) {
  button.ghost, .chip-btn, .fieis-btn { min-height: 44px; }
}

.bar { height: 5px; background: var(--panel-2); border-radius: 999px; overflow: hidden; }
.bar-fill { height: 100%; background: var(--accent); }
.mini-bar { width: 90px; height: 5px; flex: none; background: var(--panel-2);
  border-radius: 999px; overflow: hidden; }
.mini-bar-fill { display: block; height: 100%; background: #4da3ff; transition: width 0.6s; }

.job-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 9px 0; border-bottom: 1px solid var(--line); }
.job-row:last-child { border-bottom: 0; }
.wrapy { flex-wrap: wrap; }
/* mensagem de erro numa linha só dela — antes espremia a linha inteira */
.job-erro { flex-basis: 100%; white-space: normal; margin-top: 2px; }
.chip { font-size: 11px; font-weight: 700; border-radius: 999px; padding: 3px 10px;
  border: 1px solid var(--line); white-space: nowrap; }
/* opacity .5 dava contraste ~2,5:1 — cor real e borda resolvem sem perder o "apagado" */
.chip-btn { background: transparent; color: var(--text-dim); cursor: pointer;
  padding: 5px 11px; font-size: 12px; min-height: 30px; }
.chip-btn:hover { color: var(--text); }
.chip-btn.chip-on { color: var(--text); border-color: var(--accent); background: rgba(255, 45, 85, 0.12); }
.canal-chips { display: flex; gap: 4px; flex-wrap: wrap; }
.series-input { width: 200px; flex: none; padding: 6px 8px; font-size: 12px; }

/* linha do catálogo: título em primeiro plano, id/duração como legenda */
.cat-row { align-items: center; }
.cat-row .series-input { width: 150px; }
.cat-nome { display: flex; flex-direction: column; gap: 2px; flex: 1 1 220px; }
.cat-titulo { font-size: 14px; font-weight: 600; color: var(--text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cat-filtros { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 8px; }
.cat-filtros select { width: auto; flex: none; font-size: 12px; padding: 7px 8px; }
.cat-busca { flex: 1; min-width: 200px; }
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

.cookies-box { margin-top: 14px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.cookies-toggle { flex: 1; text-align: left; }
.cookies-panel { flex-basis: 100%; }
.cookies-toggle .ok { color: var(--ok); }
.cookies-panel { display: flex; flex-direction: column; gap: 8px; margin-top: 8px;
  padding: 10px; border: 1px dashed var(--line); border-radius: 8px; }
.cookies-panel textarea { font-family: ui-monospace, monospace; font-size: 11px; }

.pasta-btn { display: block; font-size: 13px; color: var(--text-dim);
  border: 1px dashed var(--line); border-radius: 8px; padding: 10px 12px; cursor: pointer; }
.pasta-btn:hover { color: var(--text); border-color: var(--text-dim); }
.oculto { display: none; }
.lote-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 7px 0; border-bottom: 1px solid var(--line); }
.lote-row select { width: auto; padding: 6px; font-size: 12px; }
.lote-titulo { flex: 1; min-width: 160px; padding: 6px 8px; font-size: 13px; }
.lote-acoes { flex-wrap: wrap; margin-top: 10px; }

/* as três origens de mídia, numeradas — antes eram três controles soltos */
.fonte { display: flex; gap: 10px; align-items: flex-start; margin-top: 12px; }
.fonte-num { flex: none; width: 22px; height: 22px; border-radius: 999px; margin-top: 2px;
  display: grid; place-items: center; font-size: 11px; font-weight: 800;
  color: var(--text-dim); border: 1px solid var(--line); }
.fonte-corpo { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.fonte-tit { font-size: 13px; font-weight: 600; color: var(--text); }

/* barra do que está escolhido, com o botão de desistir sempre à vista */
.escolhido { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  margin-top: 14px; padding: 9px 12px; border-radius: 8px;
  background: var(--panel-2); border: 1px solid var(--line); font-size: 13px; }

.limpeza { flex-wrap: wrap; align-items: center; margin-top: 14px;
  padding-top: 12px; border-top: 1px solid var(--line); }

.fila-head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
/* o "?" acompanha o botão; sem isto o space-between jogava ele na outra ponta */
.fila-head h2 { margin-bottom: 0; margin-right: auto; }

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

/* fábrica de comerciais: um painel principal na largura toda + cadastros
   recolhidos (antes eram 6 painéis num grid, com até 6 rolagens aninhadas) */
.fab-grid { display: grid; grid-template-columns: 1fr; gap: 10px; align-items: start; min-width: 0; }
.fab-panel { min-width: 0; border: 1px solid var(--line); border-radius: 10px; padding: 12px; background: var(--panel-2); }
.fab-panel h3 { font-size: 12px; color: var(--text); margin-bottom: 8px; }
.fab-panel > summary { font-size: 13px; font-weight: 600; color: var(--text);
  cursor: pointer; list-style: none; display: flex; align-items: center; gap: 6px; }
.fab-panel > summary::-webkit-details-marker { display: none; }
.fab-panel > summary::before { content: '▸'; color: var(--text-dim); font-size: 11px; }
.fab-panel[open] > summary { margin-bottom: 10px; }
.fab-panel[open] > summary::before { content: '▾'; }
.fab-panel .row > label { min-width: 0; }
.fab-days { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.fab-list { margin-top: 10px; max-height: 340px; overflow: auto; }
.fab-mini { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 6px 0; border-bottom: 1px solid var(--line); }
.fab-mini .grow { min-width: 0; }
.fab-mini:last-child { border-bottom: 0; }
.fab-mini input { min-width: 0; color: inherit; }
.fab-check { flex-direction: row !important; align-items: center; gap: 8px; font-size: 13px; }
.fab-check input { width: auto; flex: 0 0 auto; }
.fab-mini select { width: auto; flex: 0 0 auto; }
@media (max-width: 620px) {
  .fab-panel .row { flex-direction: column; align-items: stretch; }
  .fab-mini .grow { white-space: normal; }
}

/* abaixo de 620px nenhuma linha cabe numa linha só — quebrar é melhor que cortar */
@media (max-width: 620px) {
  .card { padding: 12px; }
  .job-row .mono, .lote-row .mono { flex-basis: 100%; }
  .series-input, .cat-busca, .chat-canal { width: 100%; }
  .cat-nome { min-width: 100%; }
  .fila-head, .fieis-row, .chat-head, .pl-atalhos { flex-wrap: wrap; }
}
</style>
