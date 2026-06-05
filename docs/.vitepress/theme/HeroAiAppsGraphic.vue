<template>
  <div class="hero-ai-apps" aria-hidden="true">
    <svg viewBox="0 0 300 300" class="hero-ai-apps-svg" role="img" aria-label="AI Apps scan merges local assistant history into one timeline tab">
      <defs>
        <linearGradient id="heroAiHub" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#E85D2A" stop-opacity="0.45" />
          <stop offset="100%" stop-color="#E85D2A" stop-opacity="0.08" />
        </linearGradient>
        <linearGradient id="heroAiFrame" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#1C1C1C" />
          <stop offset="100%" stop-color="#111111" />
        </linearGradient>
        <filter id="heroAiGlow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <!-- Device frame -->
      <rect x="18" y="18" width="264" height="264" rx="16" fill="url(#heroAiFrame)" stroke="#2A2A2A" stroke-width="1.2" />
      <rect x="18" y="18" width="264" height="34" rx="16" fill="#161616" />
      <rect x="18" y="36" width="264" height="16" fill="#161616" />
      <circle cx="38" cy="35" r="4.5" fill="#FF5F57" />
      <circle cx="52" cy="35" r="4.5" fill="#FFBD2E" />
      <circle cx="66" cy="35" r="4.5" fill="#28C840" />
      <text x="150" y="37" fill="#888" font-size="8" text-anchor="middle" font-family="'JetBrains Mono', monospace">Collect AI Artifacts</text>

      <!-- Header -->
      <text x="34" y="68" fill="#777" font-size="7.5" font-family="'JetBrains Mono', monospace" letter-spacing="1.2">AI APPS SCAN</text>
      <rect x="214" y="56" width="52" height="16" rx="3" fill="#E85D2A18" stroke="#E85D2A" stroke-width="0.7" stroke-opacity="0.55" />
      <text x="240" y="67" fill="#E85D2A" font-size="6.5" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-weight="700">8 APPS</text>

      <!-- Scan rays -->
      <g class="hero-ai-rays">
        <line v-for="(app, i) in apps" :key="'r' + i"
          :x1="app.x" :y1="app.y" x2="150" y2="152"
          stroke="#E85D2A" stroke-width="0.7" stroke-opacity="0.18"
          stroke-dasharray="3 3"
        />
      </g>

      <!-- Central hub -->
      <rect x="108" y="132" width="84" height="40" rx="5" fill="url(#heroAiHub)" stroke="#E85D2A" stroke-width="1" stroke-opacity="0.75" filter="url(#heroAiGlow)" />
      <text x="150" y="148" fill="#F0845A" font-size="7" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-weight="700">AI QUERY</text>
      <text x="150" y="160" fill="#CCC" font-size="6.5" text-anchor="middle" font-family="'JetBrains Mono', monospace">HISTORY TAB</text>

      <!-- App nodes -->
      <g v-for="(app, i) in apps" :key="'a' + i">
        <circle :cx="app.x" :cy="app.y" r="14" :fill="app.color + '20'" :stroke="app.color" stroke-width="1" stroke-opacity="0.8" />
        <text :x="app.x" :y="app.y + 2" :fill="app.color" font-size="5.5" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-weight="700">{{ app.abbr }}</text>
        <text :x="app.x" :y="app.y + 24" fill="#AAA" font-size="5.5" text-anchor="middle" font-family="'JetBrains Mono', monospace">{{ app.label }}</text>
      </g>

      <!-- Secret Hunt footer -->
      <rect x="34" y="248" width="112" height="20" rx="4" fill="#FF3B3B12" stroke="#FF3B3B" stroke-width="0.7" stroke-opacity="0.45" />
      <text x="90" y="261" fill="#FF6B6B" font-size="6.5" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-weight="600">AI SECRET HUNT</text>
      <rect x="154" y="248" width="112" height="20" rx="4" fill="#E85D2A10" stroke="#E85D2A" stroke-width="0.7" stroke-opacity="0.4" />
      <text x="210" y="261" fill="#E85D2A" font-size="6.5" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-weight="600">KAPE / TRIAGE</text>
    </svg>
  </div>
</template>

<script setup>
const apps = [
  { label: 'Claude', abbr: 'CL', color: '#D4A574', x: 52, y: 98 },
  { label: 'Codex', abbr: 'CX', color: '#10A37F', x: 52, y: 206 },
  { label: 'Cursor', abbr: 'CU', color: '#6BA3E8', x: 108, y: 82 },
  { label: 'Copilot', abbr: 'CP', color: '#4A90D9', x: 108, y: 222 },
  { label: 'ChatGPT', abbr: 'GPT', color: '#74AA9C', x: 192, y: 82 },
  { label: 'Gemini', abbr: 'GM', color: '#4285F4', x: 248, y: 152 },
  { label: 'Windsurf', abbr: 'WS', color: '#00C2B2', x: 192, y: 222 },
  { label: 'Continue', abbr: 'CT', color: '#9B59B6', x: 248, y: 206 },
]
</script>

<style scoped>
.hero-ai-apps {
  width: 100%;
  max-width: 300px;
  margin: 0 auto;
  pointer-events: none;
}

.hero-ai-apps-svg {
  width: 100%;
  height: auto;
  display: block;
  filter: drop-shadow(0 10px 28px rgba(0, 0, 0, 0.35));
}

.hero-ai-rays {
  animation: hero-ai-pulse 3.2s ease-in-out infinite;
}

@keyframes hero-ai-pulse {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .hero-ai-rays {
    animation: none;
    opacity: 0.8;
  }
}

@media (max-width: 960px) {
  .hero-ai-apps {
    max-width: 240px;
    margin-top: 8px;
  }
}
</style>
