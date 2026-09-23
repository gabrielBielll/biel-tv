<script setup lang="ts">
import Hls from 'hls.js'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const props = withDefaults(defineProps<{ src: string; mode?: 'live' | 'vod' }>(), {
  mode: 'live',
})
const emit = defineEmits<{ (e: 'back-to-live'): void }>()

// VOD (reprise): playlist finito → mostra controles nativos (barra/seek) e não
// força a "cauda ao vivo" do hls.js. O App re-monta o player ao trocar de modo.
const isVod = computed(() => props.mode === 'vod')

const video = ref<HTMLVideoElement>()
const muted = ref(true)
const playing = ref(false)
let hls: Hls | null = null

onMounted(() => {
  const el = video.value!
  el.addEventListener('playing', () => (playing.value = true))

  if (Hls.isSupported()) {
    hls = new Hls(isVod.value ? {} : { liveDurationInfinity: true })
    hls.loadSource(props.src)
    hls.attachMedia(el)
    hls.on(Hls.Events.MANIFEST_PARSED, () => el.play().catch(() => {}))
    hls.on(Hls.Events.ERROR, (_ev, data) => {
      if (!data.fatal || !hls) return
      // recuperação padrão do hls.js para live: rede → recomeça o load,
      // mídia → tenta recuperar o decoder
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad()
      else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError()
    })
  } else if (el.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari (iPhone/Mac): HLS nativo, sem hls.js
    el.src = props.src
    el.play().catch(() => {})
  }
})

onBeforeUnmount(() => hls?.destroy())

function unmute() {
  const el = video.value!
  el.muted = false
  muted.value = false
  el.play().catch(() => {})
}
</script>

<template>
  <div class="player">
    <video ref="video" autoplay muted playsinline :controls="isVod"></video>
    <div v-if="!isVod" class="live-badge"><span class="dot" /> AO VIVO</div>
    <button v-if="isVod" class="back-live" @click="emit('back-to-live')">◀ ao vivo</button>
    <button v-if="muted && playing" class="unmute" @click="unmute">🔇 clique para ativar o som</button>
  </div>
</template>

<style scoped>
.player {
  position: relative;
  aspect-ratio: 16 / 9;
  background: #000;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--line);
}

video {
  width: 100%;
  height: 100%;
  display: block;
}

.live-badge {
  position: absolute;
  top: 12px;
  left: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(0, 0, 0, 0.65);
  border: 1px solid var(--line);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  padding: 5px 10px;
  border-radius: 999px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  animation: pulse 1.6s ease-in-out infinite;
}

.back-live {
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(0, 0, 0, 0.65);
  border: 1px solid var(--line);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  padding: 6px 12px;
  border-radius: 999px;
  cursor: pointer;
}

.back-live:hover {
  background: var(--accent);
  border-color: transparent;
}

@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}

.unmute {
  position: absolute;
  bottom: 14px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 9px 16px;
  font-size: 14px;
  backdrop-filter: blur(4px);
}

.unmute:hover {
  background: rgba(30, 30, 40, 0.85);
}
</style>
