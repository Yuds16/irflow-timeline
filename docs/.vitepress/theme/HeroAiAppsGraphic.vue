<template>
  <div
    class="hero-ai-apps"
    @mouseenter="pauseCycle"
    @mouseleave="resumeCycle"
  >
    <svg viewBox="0 0 300 300" class="hero-ai-apps-svg" role="img" aria-label="AI Apps scan merges local assistant history into one timeline tab">
      <defs>
        <linearGradient id="heroAiHub" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#E85D2A" stop-opacity="0.55" />
          <stop offset="100%" stop-color="#E85D2A" stop-opacity="0.1" />
        </linearGradient>
        <radialGradient id="heroAiAura" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#E85D2A" stop-opacity="0.22" />
          <stop offset="100%" stop-color="#E85D2A" stop-opacity="0" />
        </radialGradient>
        <filter id="heroAiGlow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <!-- Ambient glow -->
      <circle cx="150" cy="138" r="88" fill="url(#heroAiAura)" class="hero-ai-aura" />

      <!-- Header -->
      <text x="24" y="24" fill="#777" font-size="8" font-family="'JetBrains Mono', monospace" letter-spacing="1.4">AI APPS SCAN</text>
      <rect x="224" y="10" width="52" height="18" rx="3" fill="#E85D2A18" stroke="#E85D2A" stroke-width="0.7" stroke-opacity="0.55" />
      <text x="250" y="22" fill="#E85D2A" font-size="7" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-weight="700">8 APPS</text>

      <!-- Scan rays + flowing packets -->
      <g v-for="(app, i) in apps" :key="'r' + i">
        <line
          :x1="app.x" :y1="app.y" x2="150" y2="138"
          :stroke="rayColor(i, app.color)"
          :stroke-width="isActive(i) ? 1.6 : 0.8"
          :stroke-opacity="isActive(i) ? 0.65 : 0.14"
          class="hero-ai-ray"
          :class="{ 'hero-ai-ray-active': isActive(i) }"
          :style="{ animationDelay: `${i * 0.35}s` }"
        />
        <circle
          :cx="packetPos(i).x" :cy="packetPos(i).y" r="2.2"
          :fill="app.color"
          class="hero-ai-packet"
          :class="{ 'hero-ai-packet-active': isActive(i) }"
          :style="{ animationDelay: `${i * 0.45}s` }"
        />
      </g>

      <!-- Orbit ring -->
      <circle cx="150" cy="138" r="62" fill="none" stroke="#E85D2A" stroke-width="0.6" stroke-opacity="0.12" class="hero-ai-orbit" />

      <!-- Central hub -->
      <g class="hero-ai-hub">
        <rect x="104" y="114" width="92" height="48" rx="6" fill="url(#heroAiHub)" stroke="#E85D2A" stroke-width="1.2" stroke-opacity="0.85" filter="url(#heroAiGlow)" />
        <text x="150" y="132" fill="#F0845A" font-size="7.5" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-weight="700">AI QUERY</text>
        <text x="150" y="145" fill="#CCC" font-size="6.5" text-anchor="middle" font-family="'JetBrains Mono', monospace">HISTORY TAB</text>
        <text x="150" y="156" fill="#888" font-size="5.5" text-anchor="middle" font-family="'JetBrains Mono', monospace">{{ activeLabel }} → merged</text>
      </g>

      <!-- App nodes (interactive) -->
      <g
        v-for="(app, i) in apps"
        :key="'a' + i"
        class="hero-ai-node"
        :class="{ 'hero-ai-node-active': isActive(i) }"
        @mouseenter="setActive(i)"
        @focusin="setActive(i)"
        tabindex="0"
        role="button"
        :aria-label="`Highlight ${app.label} scan path`"
      >
        <circle
          :cx="app.x" :cy="app.y" :r="isActive(i) ? 17 : 14"
          :fill="app.color + (isActive(i) ? '35' : '20')"
          :stroke="app.color"
          :stroke-width="isActive(i) ? 1.6 : 1"
          stroke-opacity="0.9"
        />
        <circle v-if="isActive(i)" :cx="app.x" :cy="app.y" r="22" fill="none" :stroke="app.color" stroke-width="0.8" stroke-opacity="0.35" class="hero-ai-node-ring" />
        <text :x="app.x" :y="app.y + 2" :fill="app.color" font-size="5.5" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-weight="700">{{ app.abbr }}</text>
        <text :x="app.x" :y="app.y + 24" :fill="isActive(i) ? '#DDD' : '#AAA'" font-size="5.5" text-anchor="middle" font-family="'JetBrains Mono', monospace">{{ app.label }}</text>
      </g>

      <!-- Secret Hunt footer -->
      <rect x="44" y="262" width="100" height="22" rx="4" fill="#FF3B3B12" stroke="#FF3B3B" stroke-width="0.7" stroke-opacity="0.45" class="hero-ai-chip" />
      <text x="94" y="276" fill="#FF6B6B" font-size="6.5" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-weight="600">AI SECRET HUNT</text>
      <rect x="156" y="262" width="100" height="22" rx="4" fill="#E85D2A10" stroke="#E85D2A" stroke-width="0.7" stroke-opacity="0.4" class="hero-ai-chip hero-ai-chip-delay" />
      <text x="206" y="276" fill="#E85D2A" font-size="6.5" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-weight="600">KAPE / TRIAGE</text>
    </svg>
    <p class="hero-ai-hint">Hover an app · auto-cycles scan paths</p>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'

const apps = [
  { label: 'Claude', abbr: 'CL', color: '#D4A574', x: 48, y: 88 },
  { label: 'Codex', abbr: 'CX', color: '#10A37F', x: 48, y: 196 },
  { label: 'Cursor', abbr: 'CU', color: '#6BA3E8', x: 104, y: 68 },
  { label: 'Copilot', abbr: 'CP', color: '#4A90D9', x: 104, y: 212 },
  { label: 'ChatGPT', abbr: 'GPT', color: '#74AA9C', x: 196, y: 68 },
  { label: 'Gemini', abbr: 'GM', color: '#4285F4', x: 252, y: 138 },
  { label: 'Windsurf', abbr: 'WS', color: '#00C2B2', x: 196, y: 212 },
  { label: 'Continue', abbr: 'CT', color: '#9B59B6', x: 252, y: 196 },
]

const HUB = { x: 150, y: 138 }
const activeIndex = ref(0)
const paused = ref(false)
let cycleIv = null

const activeLabel = computed(() => apps[activeIndex.value]?.label || 'Apps')

function isActive(i) {
  return activeIndex.value === i
}

function rayColor(i, color) {
  return isActive(i) ? color : '#E85D2A'
}

function packetPos(i) {
  const app = apps[i]
  const t = 0.35 + (i * 0.08)
  return {
    x: app.x + (HUB.x - app.x) * t,
    y: app.y + (HUB.y - app.y) * t,
  }
}

function setActive(i) {
  activeIndex.value = i
}

function pauseCycle() {
  paused.value = true
}

function resumeCycle() {
  paused.value = false
}

function advanceCycle() {
  if (paused.value) return
  activeIndex.value = (activeIndex.value + 1) % apps.length
}

const prefersReducedMotion = typeof window !== 'undefined'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches

onMounted(() => {
  if (prefersReducedMotion) return
  cycleIv = setInterval(advanceCycle, 2200)
})

onUnmounted(() => {
  if (cycleIv) clearInterval(cycleIv)
})
</script>

<style scoped>
.hero-ai-apps {
  width: 100%;
  max-width: 440px;
  margin: 0 auto;
  pointer-events: auto;
  cursor: default;
}

.hero-ai-apps-svg {
  width: 100%;
  height: auto;
  display: block;
}

.hero-ai-hint {
  margin: 10px 0 0;
  text-align: center;
  font-size: 10px;
  letter-spacing: 0.6px;
  color: var(--vp-c-text-3);
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  opacity: 0.85;
}

/* Ambient + hub motion */
.hero-ai-aura {
  animation: hero-ai-aura-pulse 4s ease-in-out infinite;
  transform-origin: 150px 138px;
}

.hero-ai-hub {
  animation: hero-ai-hub-breathe 2.8s ease-in-out infinite;
  transform-origin: 150px 138px;
}

.hero-ai-orbit {
  transform-origin: 150px 138px;
  animation: hero-ai-orbit-spin 18s linear infinite;
}

/* Rays: marching dashes toward hub */
.hero-ai-ray {
  stroke-dasharray: 4 6;
  animation: hero-ai-dash 2.4s linear infinite;
}

.hero-ai-ray-active {
  stroke-dasharray: none;
  animation: hero-ai-ray-glow 1.6s ease-in-out infinite;
}

/* Data packets slide toward hub */
.hero-ai-packet {
  opacity: 0.35;
  animation: hero-ai-packet-in 2.4s ease-in-out infinite;
}

.hero-ai-packet-active {
  opacity: 1;
  animation-duration: 1.4s;
}

/* App nodes */
.hero-ai-node {
  cursor: pointer;
  outline: none;
  transition: transform 0.25s ease;
}

.hero-ai-node:hover,
.hero-ai-node:focus-visible {
  transform: scale(1.04);
}

.hero-ai-node-active {
  transform: scale(1.06);
}

.hero-ai-node-ring {
  animation: hero-ai-ring-pulse 1.8s ease-in-out infinite;
  transform-origin: center;
}

.hero-ai-chip {
  animation: hero-ai-chip-glow 3s ease-in-out infinite;
}

.hero-ai-chip-delay {
  animation-delay: 1.2s;
}

@keyframes hero-ai-aura-pulse {
  0%, 100% { opacity: 0.55; r: 72; }
  50% { opacity: 1; }
}

@keyframes hero-ai-hub-breathe {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.03); }
}

@keyframes hero-ai-orbit-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@keyframes hero-ai-dash {
  to { stroke-dashoffset: -20; }
}

@keyframes hero-ai-ray-glow {
  0%, 100% { stroke-opacity: 0.5; }
  50% { stroke-opacity: 0.9; }
}

@keyframes hero-ai-packet-in {
  0% { opacity: 0.15; transform: translate(0, 0) scale(0.7); }
  40% { opacity: 1; transform: translate(6px, 4px) scale(1); }
  100% { opacity: 0; transform: translate(14px, 10px) scale(0.5); }
}

@keyframes hero-ai-ring-pulse {
  0%, 100% { opacity: 0.25; transform: scale(1); }
  50% { opacity: 0.7; transform: scale(1.08); }
}

@keyframes hero-ai-chip-glow {
  0%, 100% { stroke-opacity: 0.35; }
  50% { stroke-opacity: 0.75; }
}

@media (prefers-reduced-motion: reduce) {
  .hero-ai-aura,
  .hero-ai-hub,
  .hero-ai-orbit,
  .hero-ai-ray,
  .hero-ai-packet,
  .hero-ai-node-ring,
  .hero-ai-chip {
    animation: none !important;
  }

  .hero-ai-hint { display: none; }
}

@media (max-width: 960px) {
  .hero-ai-apps {
    max-width: 340px;
    margin-top: 12px;
  }
}

@media (max-width: 640px) {
  .hero-ai-apps {
    max-width: 300px;
  }

  .hero-ai-hint {
    font-size: 9px;
  }
}
</style>
