<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ThePlayer from './components/ThePlayer.vue'
import { coalesce, fetchEpg, hm, isReplayable, nowAndNext, vodUrl, type Program } from './lib/epg'

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
const watching = ref<Program | null>(null) // reprise em curso (null = ao vivo)
const HISTORY = 7 * 24 * 3600 // 7 dias de histórico no guia (catch-up)
const erro = ref('')
const now = ref(Date.now() / 1000)
const guideRef = ref<HTMLOListElement>()
let scrolledOnce = false // rola o guia até o "agora" 1x por canal (histórico fica acima)
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
    const data = await fetchEpg(API, canal.value, { past: HISTORY, future: 24 * 3600 })
    clockOffset = data.now - Date.now() / 1000
    programs.value = coalesce(data.items)
    if (!scrolledOnce) {
      scrolledOnce = true
      scrollToNow()
    }
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
  watching.value = null
  scrolledOnce = false
  vt.value = null
  load()
  loadVotaton()
})

onMounted(async () => {
  await loadChannels()
  load()
  loadVotaton()
  poll = setInterval(load, 60_000)
  tick = setInterval(() => (now.value = Date.now() / 1000 + clockOffset), 1000)
  vtPoll = setInterval(() => {
    vtTick++
    if (vt.value?.rodada || vtTick % 12 === 0) loadVotaton()
  }, 5000)
})

onBeforeUnmount(() => {
  clearInterval(poll)
  clearInterval(tick)
  clearInterval(vtPoll)
})

const onAir = computed(() => nowAndNext(programs.value, now.value))
const progress = computed(() => {
  const c = onAir.value.current
  if (!c) return 0
  return Math.min(100, ((now.value - c.start) / (c.end - c.start)) * 100)
})
// Guia com histórico: do mais antigo retido (7d) até o fim da janela futura.
const guide = computed(() =>
  programs.value.filter((p) => p.end > now.value - HISTORY).slice(0, 300),
)

const fmtDay = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit',
  month: '2-digit',
})
const dayStr = (unix: number) => fmtDay.format(new Date(unix * 1000))
// rótulo de dia só quando o item não é de hoje — separa o histórico no guia
const dayTag = (unix: number, ref: number) => (dayStr(unix) === dayStr(ref) ? '' : dayStr(unix))

// índice do 1º programa que ainda não terminou (no ar, ou o próximo) — âncora do scroll
const nowIndex = computed(() => Math.max(0, guide.value.findIndex((p) => p.end > now.value)))
async function scrollToNow() {
  await nextTick()
  const ol = guideRef.value
  const el = ol?.querySelector<HTMLElement>('.guide-item.now-anchor')
  if (ol && el) ol.scrollTop = Math.max(0, el.offsetTop - ol.offsetTop - 8)
}

function assistir(p: Program) {
  if (!isReplayable(p, now.value)) return // futuro ainda não dá pra ver
  watching.value = p
}
function voltarAoVivo() {
  watching.value = null
}

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

// ── Votaton (fase 10c): a votação do canal ─────────────────────────────────
// Polling adaptativo: 5s com apuração rolando, ~60s em repouso.
const vt = ref<any>(null)
const vtBusy = ref(false)
let vtPoll: ReturnType<typeof setInterval> | undefined
let vtTick = 0

async function loadVotaton() {
  if (!canal.value) return
  try {
    vt.value = await (await fetch(`${API}/votaton/${canal.value}`)).json()
  } catch {
    /* votação fora do ar não derruba a TV */
  }
}

async function votar(sid: string) {
  if (vtBusy.value) return
  vtBusy.value = true
  try {
    await fetch(`${API}/votaton/${canal.value}/votar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ series_id: sid }),
    })
    await loadVotaton()
  } finally {
    vtBusy.value = false
  }
}

async function celebrar() {
  await fetch(`${API}/votaton/${canal.value}/celebrado`, { method: 'POST' }).catch(() => null)
  loadVotaton()
}

const vtCountdown = computed(() => {
  const fim = vt.value?.rodada?.termina_em
  if (!fim) return ''
  const s = Math.max(0, Math.floor(fim - now.value))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
})
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
        <ThePlayer
          v-if="cur?.has_content"
          :key="watching ? 'vod:' + watching.media_id + watching.start : 'live:' + canal"
          :src="watching ? vodUrl(API, watching.media_id) : liveUrl"
          :mode="watching ? 'vod' : 'live'"
          @back-to-live="voltarAoVivo"
        />
        <div v-else class="player-off">
          <div class="off-nome">{{ cur?.nome ?? 'Biel TV' }}</div>
          <div class="off-msg">em breve nesta TV 📺</div>
        </div>

        <div v-if="watching" class="reprise-bar">
          <span class="tag tag-reprise">REPRISE</span>
          <span class="reprise-title">{{ watching.title }} · do início</span>
          <button class="reprise-back" @click="voltarAoVivo">voltar ao vivo</button>
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
        <div
          v-if="vt && (vt.rodada || (vt.resultado && vt.resultado.maratona) || (vt.pode_votar && vt.opcoes?.length >= 2))"
          class="votaton"
        >
          <h2>📊 Votação do canal</h2>

          <template v-if="vt.rodada">
            <p class="vt-sub">
              <span class="vt-live">● AO VIVO</span> apuração encerra em {{ vtCountdown }}
            </p>
            <div
              v-for="v in vt.rodada.votos"
              :key="v.series_id"
              class="vt-row"
              :class="{ minha: v.series_id === vt.rodada.sua }"
            >
              <span class="vt-nome">{{ v.titulo }}<b v-if="v.series_id === vt.rodada.sua"> · seu voto</b></span>
              <div class="vt-bar"><div class="vt-fill" :style="{ width: v.pct + '%' }" /></div>
              <span class="vt-pct">{{ v.pct }}% · {{ v.votos }}</span>
            </div>
          </template>

          <template v-else-if="vt.resultado && vt.resultado.maratona">
            <div class="vt-result" :class="{ win: vt.resultado.venceu_usuario }">
              <b>{{ vt.resultado.titulo }}</b> venceu a votação{{ vt.resultado.venceu_usuario ? ' — com o seu voto! 🏆' : '!' }}
              <div class="vt-mara">
                📺 Maratona {{ vt.resultado.maratona.inicio.slice(11) }}–{{ vt.resultado.maratona.fim.slice(11) }}
                · <span class="vt-selo">PEDIDO DOS TELESPECTADORES</span>
              </div>
            </div>
            <p v-if="vt.proxima_em" class="vt-sub">próxima votação às {{ hm(vt.proxima_em) }}</p>
          </template>

          <template v-else-if="vt.pode_votar">
            <p class="vt-sub">Qual maratona você quer ver hoje? Vote:</p>
            <div class="vt-opcoes">
              <button
                v-for="o in vt.opcoes"
                :key="o.series_id"
                class="vt-opcao"
                :disabled="vtBusy"
                @click="votar(o.series_id)"
              >{{ o.titulo }}</button>
            </div>
          </template>
        </div>

        <h2>Programação</h2>
        <ol ref="guideRef" class="guide">
          <li
            v-for="(p, idx) in guide"
            :key="p.media_id + p.start"
            class="guide-item"
            :class="{
              'on-air': onAir.current && p.start === onAir.current.start,
              'now-anchor': idx === nowIndex,
              replayable: isReplayable(p, now),
              watching: watching && watching.media_id === p.media_id && watching.start === p.start,
            }"
            @click="assistir(p)"
          >
            <span class="g-time">
              <span v-if="dayTag(p.start, now)" class="g-day">{{ dayTag(p.start, now) }}</span>
              {{ hm(p.start) }}
            </span>
            <span class="g-title">{{ p.title }}</span>
            <span v-if="isReplayable(p, now)" class="tag tag-play">▶ do início</span>
            <span class="tag">{{ TIPO_LABEL[p.tipo] ?? p.tipo }}</span>
          </li>
        </ol>
      </aside>
    </main>

    <div v-if="vt?.resultado?.celebrar" class="vt-fest" @click.self="celebrar">
      <div class="vt-fest-card">
        <div class="vt-fest-emoji">🎉 🏆 🎉</div>
        <h3>DEU {{ vt.resultado.titulo.toUpperCase() }}!</h3>
        <p>O seu voto venceu a votação dos telespectadores!</p>
        <p v-if="vt.resultado.maratona" class="vt-fest-hora">
          Maratona hoje, às {{ vt.resultado.maratona.inicio.slice(11) }} — não perca!
        </p>
        <button class="vt-fest-btn" @click="celebrar">🎊 tô dentro!</button>
      </div>
    </div>
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

.guide-item.replayable {
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.guide-item.replayable:hover {
  border-color: var(--accent);
  background: var(--panel-2);
}

.guide-item.watching {
  border-color: var(--accent);
  background: var(--panel-2);
}

.g-day {
  display: block;
  font-size: 10px;
  font-weight: 700;
  color: var(--accent);
  letter-spacing: 0.04em;
}

.tag-play {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
}

/* ── Barra de reprise (catch-up) ─────────────────────────────────────── */
.reprise-bar {
  margin-top: 14px;
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--panel);
  border: 1px solid var(--accent);
  border-radius: 12px;
  padding: 12px 16px;
}

.tag-reprise {
  color: #fff;
  background: var(--accent);
  border-color: transparent;
}

.reprise-title {
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reprise-back {
  margin-left: auto;
  background: var(--panel-2);
  border: 1px solid var(--line);
  color: var(--text);
  border-radius: 999px;
  padding: 7px 14px;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  white-space: nowrap;
}

.reprise-back:hover {
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

/* ── Votaton ─────────────────────────────────────────────────────────── */
.votaton {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 14px 16px;
  margin-bottom: 16px;
}
.votaton h2 { margin-top: 0; }
.vt-sub { color: var(--text-dim); font-size: 13px; margin: 4px 0 10px; }
.vt-live { color: #ff2d55; font-weight: 800; font-size: 11px; letter-spacing: 0.08em;
  animation: vt-pisca 1.2s ease-in-out infinite; }
@keyframes vt-pisca { 50% { opacity: 0.35; } }

.vt-row { display: grid; grid-template-columns: 1fr; gap: 3px; padding: 6px 0; }
.vt-nome { font-size: 13px; font-weight: 600; }
.vt-nome b { color: var(--accent); font-size: 11px; }
.vt-row.minha .vt-nome { color: var(--accent); }
.vt-bar { height: 8px; background: var(--panel-2); border-radius: 999px; overflow: hidden; }
.vt-fill { height: 100%; background: var(--text-dim); border-radius: 999px;
  transition: width 1.2s ease; }
.vt-row.minha .vt-fill { background: var(--accent); }
.vt-pct { font-size: 11px; color: var(--text-dim); font-variant-numeric: tabular-nums; }

.vt-opcoes { display: flex; flex-direction: column; gap: 8px; }
.vt-opcao { background: var(--panel-2); border: 1px solid var(--line); color: var(--text);
  border-radius: 10px; padding: 10px 12px; font-size: 14px; font-weight: 700;
  text-align: left; cursor: pointer; transition: border-color 0.15s; }
.vt-opcao:hover { border-color: var(--accent); }
.vt-opcao:disabled { opacity: 0.5; }

.vt-result { font-size: 14px; line-height: 1.5; }
.vt-result.win b { color: var(--accent); }
.vt-mara { margin-top: 6px; font-size: 13px; color: var(--text-dim); }
.vt-selo { font-size: 10px; font-weight: 800; letter-spacing: 0.08em; color: #ffb020;
  border: 1px solid rgba(255, 176, 32, 0.5); border-radius: 999px; padding: 2px 8px; }

.vt-fest { position: fixed; inset: 0; background: rgba(6, 6, 12, 0.82); z-index: 50;
  display: grid; place-items: center; animation: vt-surge 0.25s ease; }
@keyframes vt-surge { from { opacity: 0; } }
.vt-fest-card { background: var(--panel); border: 2px solid var(--accent);
  border-radius: 18px; padding: 34px 42px; text-align: center; max-width: 440px;
  animation: vt-pula 0.5s cubic-bezier(0.34, 1.56, 0.64, 1); }
@keyframes vt-pula { from { transform: scale(0.6); opacity: 0; } }
.vt-fest-emoji { font-size: 40px; animation: vt-balanca 1s ease-in-out infinite; }
@keyframes vt-balanca { 50% { transform: rotate(4deg) scale(1.08); } }
.vt-fest-card h3 { font-size: 26px; margin: 12px 0 6px; color: var(--accent); }
.vt-fest-card p { color: var(--text); margin: 4px 0; }
.vt-fest-hora { font-weight: 700; }
.vt-fest-btn { margin-top: 18px; background: var(--accent); color: #fff; border: 0;
  border-radius: 999px; padding: 12px 28px; font-size: 16px; font-weight: 800;
  cursor: pointer; }
</style>
