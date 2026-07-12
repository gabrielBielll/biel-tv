<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

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
  dur: number
  tipo: string
  titulo: string
  id: string
  series: string
  ep: string
  status: string
}
const lote = ref<ItemLote[]>([])
const loteCanais = ref<string[]>([])
const loteEnviando = ref(false)

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
  } catch {
    /* sem pânico em polling */
  }
}

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
    itens.push({ file: f, dur, tipo, titulo, id, series: serieSlug, ep, status: 'pronto' })
  }
  lote.value = itens
  loteCanais.value = [...canaisSugeridos]
}

async function enviarLote() {
  if (loteCanais.value.length === 0) {
    msg.value = '✖ escolha pelo menos um canal pro lote'
    return
  }
  loteEnviando.value = true
  for (const item of lote.value) {
    if (item.status === 'na fila') continue
    item.status = 'enviando…'
    try {
      const { staging_key } = await upload(item.file, () => {})
      const res = await postJson('/jobs', {
        id: item.id,
        tipo: item.tipo,
        title: item.titulo,
        series_id: item.series || null,
        episode: item.ep ? Number(item.ep) : null,
        tags: '',
        canais: loteCanais.value.join(','),
        staging_key,
        original_name: item.file.name,
      })
      const body = await res.json()
      item.status = res.ok ? 'na fila' : `erro: ${body.error ?? res.status}`
    } catch (e) {
      item.status = `erro: ${(e as Error).message}`
    }
    refresh()
  }
  loteEnviando.value = false
  msg.value = `✔ lote enviado — a fábrica processa um por vez`
}

function upload(f: File, onPct: (n: number) => void): Promise<{ staging_key: string }> {
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest()
    x.open('POST', `${API}/admin/upload?name=${encodeURIComponent(f.name)}`)
    x.setRequestHeader('authorization', `Bearer ${token.value}`)
    x.upload.onprogress = (e) => e.lengthComputable && onPct(Math.round((e.loaded / e.total) * 100))
    x.onload = () => (x.status < 300 ? res(JSON.parse(x.responseText)) : rej(new Error(x.responseText)))
    x.onerror = () => rej(new Error('falha de rede no upload'))
    x.send(f)
  })
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
  try {
    const { staging_key } = await upload(file.value, (n) => (pct.value = n))
    const res = await postJson('/jobs', {
      ...form.value,
      canais: form.value.canais.join(','),
      episode: form.value.episode ? Number(form.value.episode) : null,
      staging_key,
      original_name: file.value.name,
    })
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
    msg.value = `✔ "${form.value.title}" entrou na fila — a fábrica processa em instantes`
    file.value = null
    meta.value = null
    refresh()
  } catch (e) {
    msg.value = `✖ ${(e as Error).message}`
  } finally {
    sending.value = false
  }
}

async function toggle(m: any) {
  await postJson(`/media/${m.id}/status`, { status: m.status === 'ready' ? 'disabled' : 'ready' })
  refresh()
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
          <button class="primary" :disabled="sending" @click="submit">
            {{ sending ? `enviando… ${pct}%` : 'enviar pra fila' }}
          </button>
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
        <div v-for="item in lote" :key="item.file.name" class="lote-row">
          <span class="mono">{{ item.id }}</span>
          <input v-model="item.titulo" class="lote-titulo" />
          <select v-model="item.tipo">
            <option value="episodio">ep</option>
            <option value="filme">filme</option>
            <option value="comercial">com</option>
            <option value="vinheta">vin</option>
          </select>
          <span class="chip" :class="item.status === 'na fila' ? 'st-done' : item.status.startsWith('erro') ? 'st-error' : 'st-queued'">{{ item.status }}</span>
        </div>
        <button class="primary" :disabled="loteEnviando" @click="enviarLote">
          {{ loteEnviando ? 'enviando lote…' : `enviar ${lote.length} pra fila` }}
        </button>
      </template>

      <p v-if="msg" :class="msg.startsWith('✖') ? 'err' : 'ok'">{{ msg }}</p>
    </section>

    <section class="card">
      <h2>Fila de processamento</h2>
      <p v-if="jobs.length === 0" class="dim">nenhum job ainda</p>
      <div v-for="j in jobs" :key="j.id" class="job-row">
        <span class="mono">{{ j.id }}</span>
        <span class="dim grow">{{ j.title }}</span>
        <span class="chip" :class="`st-${j.status}`">{{ STATUS_PT[j.status] ?? j.status }}</span>
        <span v-if="j.error" class="err small">{{ j.error }}</span>
      </div>

      <h2 class="mt">Catálogo</h2>
      <div v-for="m in media" :key="m.id" class="job-row wrapy">
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
      </div>
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
