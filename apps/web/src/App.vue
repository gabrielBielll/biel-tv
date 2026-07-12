<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ThePlayer from './components/ThePlayer.vue'
import { coalesce, fetchEpg, hm, nowAndNext, type Program } from './lib/epg'

// Em produção cross-origin, defina VITE_API_BASE na build (URL do Worker);
// em dev o proxy do Vite resolve, e same-origin funciona com ''.
const API = import.meta.env.VITE_API_BASE ?? ''

interface Channel {
  id: string
  nome: string
  cor: string
  has_content: boolean
}

const channels = ref<Channel[]>([])
const canal = ref('')
const cur = computed(() => channels.value.find((c) => c.id === canal.value))
const liveUrl = computed(() => `${API}/live/${canal.value}`)

const programs = ref<Program[]>([])
const erro = ref('')
const now = ref(Date.now() / 1000)
let clockOffset = 0
let tick: ReturnType<typeof setInterval> | undefined
let poll: ReturnType<typeof setInterval> | undefined

async function loadChannels() {
  const res = await fetch(`${API}/channels`)
  channels.value = await res.json()
  const fromUrl = new URLSearchParams(location.search).get('canal')
  const saved = localStorage.getItem('bieltv_canal')
  const valido = (id: string | null) => id && channels.value.some((c) => c.id === id)
  canal.value =
    (valido(fromUrl) ? fromUrl! : '') ||
    (valido(saved) ? saved! : '') ||
    channels.value.find((c) => c.has_content)?.id ||
    channels.value[0]?.id ||
    ''
}

async function load() {
  if (!canal.value) return
  try {
    const data = await fetchEpg(API, canal.value)
    clockOffset = data.now - Date.now() / 1000
    programs.value = coalesce(data.items)
    erro.value = ''
  } catch (e) {
    erro.value = `não consegui carregar a programação (${(e as Error).message})`
  }
}

function trocar(id: string) {
  const alvo = channels.value.find((c) => c.id === id)
  if (!alvo) return
  canal.value = id
  localStorage.setItem('bieltv_canal', id)
}

watch(canal, () => {
  programs.value = []
  load()
})

onMounted(async () => {
  await loadChannels()
  load()
  poll = setInterval(load, 60_000)
  tick = setInterval(() => (now.value = Date.now() / 1000 + clockOffset), 1000)
})

onBeforeUnmount(() => {
  clearInterval(poll)
  clearInterval(tick)
})

const onAir = computed(() => nowAndNext(programs.value, now.value))
const progress = computed(() => {
  const c = onAir.value.current
  if (!c) return 0
  return Math.min(100, ((now.value - c.start) / (c.end - c.start)) * 100)
})
const guide = computed(() => programs.value.filter((p) => p.end > now.value).slice(0, 40))

const clock = computed(() =>
  new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(now.value * 1000)),
)

const TIPO_LABEL: Record<string, string> = {
  episodio: 'EP',
  filme: 'FILME',
  placeholder: '—',
}
</script>

<template>
  <div class="app" :style="{ '--accent': cur?.cor || '#ff2d55' }">
    <header class="topbar">
      <div class="brand"><span class="brand-dot" />BIEL<b>TV</b></div>
      <nav class="canais">
        <button
          v-for="c in channels"
          :key="c.id"
          class="canal-pill"
          :class="{ ativo: c.id === canal, off: !c.has_content }"
          :style="c.id === canal ? { background: c.cor, borderColor: c.cor } : { borderColor: c.cor + '66' }"
          :title="c.has_content ? c.nome : `${c.nome} — em breve`"
          @click="trocar(c.id)"
        >
          {{ c.nome }}<span v-if="!c.has_content" class="breve"> · em breve</span>
        </button>
      </nav>
      <div class="clock">{{ clock }}</div>
    </header>

    <main class="layout">
      <section>
        <ThePlayer v-if="cur?.has_content" :key="canal" :src="liveUrl" />
        <div v-else class="player-off">
          <div class="off-nome">{{ cur?.nome ?? 'Biel TV' }}</div>
          <div class="off-msg">em breve nesta TV 📺</div>
        </div>

        <div class="now-panel" v-if="onAir.current">
          <div class="now-head">
            <span class="tag tag-now">AGORA</span>
            <span class="now-title">{{ onAir.current.title }}</span>
            <span class="tag">{{ TIPO_LABEL[onAir.current.tipo] ?? onAir.current.tipo }}</span>
            <span class="times">{{ hm(onAir.current.start) }} – {{ hm(onAir.current.end) }}</span>
          </div>
          <div class="bar"><div class="bar-fill" :style="{ width: progress + '%' }" /></div>
          <div class="next-line" v-if="onAir.next">
            <span class="tag">A SEGUIR</span>
            {{ hm(onAir.next.start) }} · {{ onAir.next.title }}
          </div>
        </div>
        <div class="now-panel" v-else-if="onAir.next">
          <div class="now-head">
            <span class="tag tag-break">INTERVALO</span>
            <span class="now-title">A seguir: {{ onAir.next.title }}</span>
            <span class="times">às {{ hm(onAir.next.start) }}</span>
          </div>
        </div>
        <div class="now-panel" v-else-if="erro">⚠️ {{ erro }}</div>
      </section>

      <aside class="epg">
        <h2>Programação</h2>
        <ol class="guide">
          <li
            v-for="p in guide"
            :key="p.media_id + p.start"
            class="guide-item"
            :class="{ 'on-air': onAir.current && p.start === onAir.current.start }"
          >
            <span class="g-time">{{ hm(p.start) }}</span>
            <span class="g-title">{{ p.title }}</span>
            <span class="tag">{{ TIPO_LABEL[p.tipo] ?? p.tipo }}</span>
          </li>
        </ol>
      </aside>
    </main>
  </div>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 2px 18px;
  flex-wrap: wrap;
}

.brand {
  font-size: 22px;
  font-weight: 300;
  letter-spacing: 0.04em;
  display: flex;
  align-items: center;
  gap: 10px;
}

.brand b {
  font-weight: 800;
}

.brand-dot {
  width: 12px;
  height: 12px;
  border-radius: 3px;
  background: var(--accent);
  display: inline-block;
  transition: background 0.3s;
}

.canais {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.canal-pill {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--text);
  border-radius: 999px;
  padding: 5px 14px;
  font-size: 13px;
  font-weight: 700;
}

.canal-pill.ativo {
  color: #0a0a0f;
}

.canal-pill.off {
  opacity: 0.45;
}

.breve {
  font-weight: 400;
  font-size: 11px;
}

.clock {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  color: var(--text-dim);
}

.layout {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr);
  gap: 20px;
}

@media (max-width: 900px) {
  .layout {
    grid-template-columns: 1fr;
  }
}

.player-off {
  aspect-ratio: 16 / 9;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: var(--panel);
  display: grid;
  place-content: center;
  text-align: center;
  gap: 8px;
}

.off-nome {
  font-size: 26px;
  font-weight: 800;
  color: var(--accent);
}

.off-msg {
  color: var(--text-dim);
}

.now-panel {
  margin-top: 14px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 14px 16px;
}

.now-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.now-title {
  font-size: 18px;
  font-weight: 700;
}

.times {
  margin-left: auto;
  color: var(--text-dim);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.tag {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--text-dim);
  border: 1px solid var(--line);
  padding: 2px 8px;
  border-radius: 999px;
  white-space: nowrap;
}

.tag-now {
  color: #fff;
  background: var(--accent);
  border-color: transparent;
}

.tag-break {
  color: #ffb020;
  border-color: rgba(255, 176, 32, 0.5);
}

.bar {
  height: 5px;
  background: var(--panel-2);
  border-radius: 999px;
  margin: 12px 0 10px;
  overflow: hidden;
}

.bar-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 999px;
  transition: width 1s linear;
}

.next-line {
  color: var(--text-dim);
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.epg h2 {
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--text-dim);
  text-transform: uppercase;
  margin: 4px 0 10px;
}

.guide {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 72vh;
  overflow-y: auto;
  padding-right: 4px;
}

.guide-item {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px 12px;
}

.guide-item.on-air {
  border-color: var(--accent);
}

.g-time {
  font-variant-numeric: tabular-nums;
  color: var(--text-dim);
  font-size: 13px;
  min-width: 44px;
}

.g-title {
  flex: 1;
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
