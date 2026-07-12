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
  } catch {
    /* sem pânico em polling */
  }
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

async function onPick(ev: Event) {
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

  <main v-else class="grid-2">
    <section class="card">
      <h2>Enviar mídia</h2>
      <input type="file" accept="video/*" multiple @change="onPick" />
      <label class="pasta-btn">
        📁 ou enviar uma pasta inteira (ex.: "pwr rangers/001.mp4, 002.mp4…")
        <input type="file" webkitdirectory multiple class="oculto" @change="onPick" />
      </label>

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

      <p v-if="msg" :class="msg.startsWith('✖') ? 'err' : 'ok'">{{ msg }}</p>

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

    <section class="card">
      <h2>Fila de processamento</h2>
      <p v-if="jobs.length === 0" class="dim">nenhum job ainda</p>
      <div v-for="j in jobs" :key="j.id" class="job-row">
        <span class="mono">{{ j.id }}</span>
        <span class="dim grow">{{ j.title }}</span>
        <span v-if="j.status === 'processing' && j.progress > 0" class="mini-bar">
          <span class="mini-bar-fill" :style="{ width: j.progress + '%' }" />
        </span>
        <span class="chip" :class="`st-${j.status}`">
          {{ j.status === 'processing' && j.progress > 0 ? `processando ${j.progress}%` : (STATUS_PT[j.status] ?? j.status) }}
        </span>
        <span v-if="j.error" class="err small">{{ j.error }}</span>
      </div>

      <h2 class="mt">Catálogo</h2>
      <template v-for="m in media" :key="m.id">
        <div class="job-row wrapy">
          <span class="mono">{{ m.id }}</span>
          <span class="dim grow">{{ titleOf(m) }} · {{ m.tipo }} · {{ fmtDur(m.duracao_seg) }}</span>
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
            v-if="m.status === 'disabled'"
            class="ghost perigo"
            title="apaga os arquivos e todos os registros — não tem volta"
            @click="abreDel(m)"
          >🗑 excluir de vez</button>
        </div>
        <div v-if="del && del.id === m.id" class="del-zone">
          <p class="err small">
            Isto apaga os segmentos do R2 e todos os registros desta mídia. <b>Não tem volta.</b>
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
        </div>
      </template>
    </section>

    <section v-if="god" class="card god-card">
      <h2>⚡ Modo God — fale com o Diretor</h2>
      <div class="chat-head">
        <select v-model="chatCanal" class="chat-canal">
          <option v-for="c in channels" :key="c.id" :value="c.id">{{ c.nome }}</option>
        </select>
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
          <span class="chip st-queued">maratona</span>
          <span class="dim grow">{{ e.media_id }}: {{ e.inicio }} → {{ e.fim }}</span>
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
      </div>
    </section>
  </main>

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
.grid-2 { display: grid; grid-template-columns: minmax(300px, 1fr) minmax(0, 1.4fr); gap: 20px; align-items: start; }
@media (max-width: 900px) { .grid-2 { grid-template-columns: 1fr; } }
.god-card { grid-column: 1 / -1; }

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

.pasta-btn { display: block; margin-top: 8px; font-size: 12px; color: var(--text-dim);
  border: 1px dashed var(--line); border-radius: 8px; padding: 8px 10px; cursor: pointer; }
.pasta-btn:hover { color: var(--text); border-color: var(--text-dim); }
.oculto { display: none; }
.lote-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--line); }
.lote-row select { width: auto; padding: 5px 6px; font-size: 12px; }
.lote-titulo { flex: 1; padding: 5px 8px; font-size: 13px; }

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
</style>
