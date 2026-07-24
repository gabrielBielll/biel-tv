<script lang="ts">
// contador no escopo do MÓDULO: dentro do <script setup> ele reiniciaria a
// cada instância e todos os balões nasceriam com o mesmo id
let seq = 0
</script>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'

// Bolinha "?" com a explicação do controle ao lado. Abre no passar do mouse e
// FIXA no clique (fecha com Esc, clique fora ou segundo clique) — no toque,
// onde não existe hover, o clique é o único caminho.
//
// O balão vai pro <body> via Teleport e se posiciona em `fixed`: várias listas
// do painel são overflow:auto (.fab-list, .hist-lista, .chat-box) e recortariam
// um balão posicionado dentro delas. Nenhum contêiner do painel pode ganhar
// transform/filter/will-change — isso criaria um novo referencial pro `fixed`.

const props = withDefaults(defineProps<{
  titulo?: string
  texto: string
  atencao?: string
  largura?: number
}>(), { titulo: '', atencao: '', largura: 300 })

seq += 1
const id = `ajuda-${seq}`

const aberto = ref(false)
const fixado = ref(false)
const botao = ref<HTMLButtonElement | null>(null)
const balao = ref<HTMLElement | null>(null)
const pos = ref({ top: 0, left: 0, larg: 300, acima: false })
let timer: ReturnType<typeof setTimeout> | undefined

function posiciona() {
  const el = botao.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const larg = Math.min(props.largura, window.innerWidth - 24)
  const left = Math.max(12, Math.min(r.left + r.width / 2 - larg / 2, window.innerWidth - larg - 12))
  // sem espaço embaixo (linha no rodapé da tela) → o balão sobe
  const acima = window.innerHeight - r.bottom < 170 && r.top > 170
  pos.value = { top: acima ? r.top - 8 : r.bottom + 8, left, larg, acima }
}

function abre() {
  clearTimeout(timer)
  posiciona()
  aberto.value = true
}

function fecha(forca = false, devolveFoco = false) {
  if (fixado.value && !forca) return
  clearTimeout(timer)
  aberto.value = false
  fixado.value = false
  if (devolveFoco) botao.value?.focus()
}

const abreComAtraso = () => { clearTimeout(timer); timer = setTimeout(abre, 120) }
const fechaComAtraso = () => { clearTimeout(timer); timer = setTimeout(() => fecha(), 180) }
const segura = () => clearTimeout(timer) // o mouse entrou no balão: não fecha

function clique() {
  if (fixado.value) { fecha(true); return }
  abre()
  fixado.value = true
}

// o balão está teleportado pro <body> — não é descendente do botão, então
// precisa ser testado à parte, senão selecionar o texto dele fecha a ajuda
function foraDaAjuda(ev: Event) {
  const alvo = ev.target as Node
  if (!botao.value?.contains(alvo) && !balao.value?.contains(alvo)) fecha(true)
}
const aoRolar = () => fecha(true)             // a página rolou: o balão perdeu a âncora
const aoTeclar = (ev: KeyboardEvent) => {     // Esc no documento: fecha mesmo aberto por hover
  if (ev.key === 'Escape' && aberto.value) fecha(true, true)
}

function escuta(liga: boolean) {
  const fn = liga ? 'addEventListener' : 'removeEventListener'
  document[fn]('pointerdown', foraDaAjuda, true)
  document[fn]('keydown', aoTeclar as EventListener)
  window[fn]('scroll', aoRolar, true)
  window[fn]('resize', posiciona)
}

watch(aberto, escuta)
onBeforeUnmount(() => { clearTimeout(timer); escuta(false) })
</script>

<template>
  <button
    ref="botao"
    type="button"
    class="ajuda-btn"
    :class="{ on: aberto }"
    :aria-label="`ajuda: ${titulo || texto.slice(0, 40)}`"
    :aria-expanded="aberto"
    :aria-describedby="aberto ? id : undefined"
    @click.stop.prevent="clique"
    @mouseenter="abreComAtraso"
    @mouseleave="fechaComAtraso"
    @focus="abre"
    @blur="fecha()"
  >?</button>

  <Teleport to="body">
    <div
      v-if="aberto"
      :id="id"
      ref="balao"
      role="tooltip"
      class="ajuda-balao"
      :class="{ acima: pos.acima }"
      :style="{ top: `${pos.top}px`, left: `${pos.left}px`, width: `${pos.larg}px` }"
      @mouseenter="segura"
      @mouseleave="fechaComAtraso"
    >
      <p v-if="titulo" class="ajuda-titulo">{{ titulo }}</p>
      <p class="ajuda-texto">{{ texto }}</p>
      <p v-if="atencao" class="ajuda-atencao">⚠️ {{ atencao }}</p>
    </div>
  </Teleport>
</template>

<style scoped>
.ajuda-btn {
  display: inline-grid; place-items: center; flex: none;
  width: 17px; height: 17px; padding: 0; margin-left: 5px;
  border: 1px solid var(--line); border-radius: 999px;
  background: transparent; color: var(--text-dim);
  font: 700 10px/1 system-ui, sans-serif; vertical-align: middle;
}
.ajuda-btn:hover, .ajuda-btn.on {
  color: var(--text); border-color: var(--text-dim); background: rgba(255, 255, 255, 0.07);
}
.ajuda-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
/* alvo de toque decente sem inflar a linha */
@media (pointer: coarse) {
  .ajuda-btn { width: 22px; height: 22px; font-size: 12px; }
}

.ajuda-balao {
  position: fixed; z-index: 90;
  background: #12121a; border: 1px solid var(--line); border-radius: 10px;
  padding: 10px 12px; box-shadow: 0 14px 34px rgba(0, 0, 0, 0.6);
  font-size: 12.5px; line-height: 1.5; color: var(--text);
  max-height: min(60vh, 340px); overflow: auto;
}
.ajuda-balao.acima { transform: translateY(-100%); }
.ajuda-titulo { font-weight: 700; margin-bottom: 4px; }
.ajuda-texto { color: var(--text-dim); }
.ajuda-atencao { margin-top: 6px; color: #ffb020; font-size: 11.5px; }
</style>
