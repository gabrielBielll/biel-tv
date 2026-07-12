<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

const API = import.meta.env.VITE_API_BASE ?? ''
const TOKEN_KEY = 'bieltv_admin_token'

const token = ref(localStorage.getItem(TOKEN_KEY) ?? '')
const authed = ref(false)
const authMsg = ref('')

const jobs = ref<any[]>([])
const media = ref<any[]>([])
let poll: ReturnType<typeof setInterval> | undefined

// formulário de upload
const file = ref<File | null>(null)
const meta = ref<{ duration: number; width: number; height: number } | null>(null)
const form = ref({ id: '', tipo: 'episodio', title: '', series_id: '', episode: '', tags: '' })
const pct = ref(0)
const sending = ref(false)
const msg = ref('')

const hdr = () => ({ authorization: `Bearer ${token.value}` })

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${API}/admin${path}`, { ...init, headers: { ...hdr(), ...(init.headers ?? {}) } })
  if (res.status === 401) {
    authed.value = false
    throw new Error('token inválido')
  }
  return res
}

async function enter() {
  authMsg.value = ''
  try {
    const res = await api('/jobs')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    localStorage.setItem(TOKEN_KEY, token.value)
    authed.value = true
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
  }
}

async function onPick(ev: Event) {
  msg.value = ''
  const f = (ev.target as HTMLInputElement).files?.[0] ?? null
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
  sending.value = true
  msg.value = ''
  pct.value = 0
  try {
    const { staging_key } = await upload(file.value, (n) => (pct.value = n))
    const res = await api('/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...form.value,
        episode: form.value.episode ? Number(form.value.episode) : null,
        staging_key,
        original_name: file.value.name,
      }),
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
  await api(`/media/${m.id}/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: m.status === 'ready' ? 'disabled' : 'ready' }),
  })
  refresh()
}

const STATUS_PT: Record<string, string> = {
  queued: 'na fila', processing: 'processando', done: 'concluído', error: 'erro',
}
const titleOf = (m: any) => {
  try { return JSON.parse(m.metadata).title ?? m.id } catch { return m.id }
}
const fmtDur = (s: number) => `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`

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
      <input type="file" accept="video/*" @change="onPick" />

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
          <button class="primary" :disabled="sending" @click="submit">
            {{ sending ? `enviando… ${pct}%` : 'enviar pra fila' }}
          </button>
          <div v-if="sending" class="bar"><div class="bar-fill" :style="{ width: pct + '%' }" /></div>
        </div>
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
      <div v-for="m in media" :key="m.id" class="job-row">
        <span class="mono">{{ m.id }}</span>
        <span class="dim grow">{{ titleOf(m) }} · {{ m.tipo }} · {{ fmtDur(m.duracao_seg) }}</span>
        <span class="chip" :class="m.status === 'ready' ? 'st-done' : 'st-error'">{{ m.status }}</span>
        <button class="ghost" @click="toggle(m)">{{ m.status === 'ready' ? 'desativar' : 'ativar' }}</button>
      </div>
    </section>
  </main>
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
input, select { background: var(--panel-2); border: 1px solid var(--line); color: var(--text);
  border-radius: 8px; padding: 9px 10px; font: inherit; width: 100%; }
input[type='file'] { padding: 8px; }

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
.chip { font-size: 11px; font-weight: 700; border-radius: 999px; padding: 3px 10px; border: 1px solid var(--line); }
.st-queued { color: #ffb020; border-color: rgba(255, 176, 32, 0.5); }
.st-processing { color: #4da3ff; border-color: rgba(77, 163, 255, 0.5); }
.st-done { color: var(--ok); border-color: rgba(56, 217, 122, 0.5); }
.st-error { color: #ff6b6b; border-color: rgba(255, 107, 107, 0.5); }
</style>
