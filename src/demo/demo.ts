// One-click demo — cursor + tooltip + progress tour across all screens.
//
// Mirrors the agentEvalPlatform demo-overlay design:
//   - fixed overlay: click-catcher + progress bar + tooltip + cursor
//   - hash-route navigation (#/insight, #/tunnel, #/evolution, #/legal, #/security, #/)
//   - every screen opens with a purpose intro before any detail
//   - tooltip follows the pointed element, falls back to screen center
//   - the tooltip is hidden on every navigation so it never lingers
//   - ESC or clicking anywhere stops the tour
//   - every step is deterministic fixture replay (offline, zero side effects)
import { t, useI18n, type Language } from '../i18n'
import { useApp, useForge, useRun, useTunnel } from '../stores'
import { PRESETS } from '../../shared/presets'

let isPlaying = false

type Step =
  | { action: 'center'; key: string; wait?: number }
  | { action: 'nav'; route: string; wait?: number }
  | { action: 'wait'; ms: number }
  | { action: 'waitFor'; selector: string; maxMs?: number }
  | { action: 'point'; selector: string; key: string; wait?: number }
  | { action: 'clickPreset'; index: number; key: string; wait?: number }
  | { action: 'clickGate'; index: number; key: string; wait?: number }
  | { action: 'clickBranch'; id: string; key: string; wait?: number }
  | { action: 'clickStep'; index: number | 'critical'; key?: string; wait?: number; rewind?: boolean }
  | { action: 'do'; fn: () => void | Promise<void> }

const lang = (): Language => useI18n.getState().lang
const text = (key: string): string => t(key, lang())

function $(sel: string): Element | null {
  return document.querySelector(sel)
}
function $all(sel: string): Element[] {
  return [...document.querySelectorAll(sel)]
}
function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
function checkCancelled(): void {
  if (!isPlaying) throw new Error('__CANCELLED__')
}

function ensureOverlay(): void {
  if (document.getElementById('demo-overlay')) return
  const overlay = document.createElement('div')
  overlay.id = 'demo-overlay'
  overlay.innerHTML = `
    <div id="demo-click-catcher"></div>
    <div id="demo-progress"><div id="demo-progress-bar"></div></div>
    <div id="demo-tooltip" style="display:none"></div>
    <div id="demo-cursor" style="display:none">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <path d="M4 2L20 10.6667L12 13L10 21L4 2Z" fill="white" stroke="black" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>
    </div>
  `
  document.body.appendChild(overlay)
  document.getElementById('demo-click-catcher')?.addEventListener('click', () => void stopDemo())
}

function setProgress(pct: number): void {
  const bar = document.getElementById('demo-progress-bar')
  if (bar) bar.style.width = `${pct}%`
}

function moveCursor(x: number, y: number): void {
  const cursor = document.getElementById('demo-cursor')
  if (!cursor) return
  cursor.style.display = 'block'
  cursor.style.left = `${x - 12}px`
  cursor.style.top = `${y - 12}px`
}

function showTooltip(msg: string, x: number, y: number): void {
  const tip = document.getElementById('demo-tooltip')
  if (!tip) return
  tip.textContent = msg
  tip.style.display = 'block'
  const rect = tip.getBoundingClientRect()
  const margin = 10
  const topbar = 60
  const gap = 22
  const placeRight = x < 320 && x + gap + rect.width + margin < window.innerWidth
  let left = placeRight ? x + gap : x - rect.width / 2
  left = Math.max(margin, Math.min(left, window.innerWidth - rect.width - margin))
  // Keep the whole box inside the viewport: prefer below the cursor,
  // flip above when near the bottom, pin under the topbar otherwise.
  let top = y + 30
  if (top + rect.height > window.innerHeight - margin) top = y - rect.height - 14
  if (top < topbar) top = topbar
  if (top + rect.height > window.innerHeight - margin) top = Math.max(topbar, window.innerHeight - rect.height - margin)
  tip.style.left = `${left}px`
  tip.style.top = `${top}px`
}

function hideCursor(): void {
  const cursor = document.getElementById('demo-cursor')
  const tip = document.getElementById('demo-tooltip')
  if (cursor) cursor.style.display = 'none'
  if (tip) tip.style.display = 'none'
}

function setDemoButtons(label: string): void {
  $all('.demo-btn').forEach((b) => { (b as HTMLElement).textContent = label })
}

async function moveToCenter(msg: string, waitMs = 4200): Promise<void> {
  checkCancelled()
  const x = window.innerWidth / 2
  const y = window.innerHeight / 2
  moveCursor(x, y)
  showTooltip(msg, x, y)
  await wait(waitMs)
}

async function pointTo(selector: string, msg: string, waitMs = 5200): Promise<void> {
  checkCancelled()
  const el = $(selector)
  if (!el) {
    await moveToCenter(msg, waitMs)
    return
  }
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  await wait(600)
  checkCancelled()
  const r = el.getBoundingClientRect()
  // Anchor near the top of the element so tall panels never push the
  // cursor (and its tooltip) outside the viewport; clamp into view.
  const x = Math.max(200, Math.min(r.left + r.width / 2, window.innerWidth - 200))
  const y = Math.max(90, Math.min(r.top + Math.min(120, r.height * 0.2), window.innerHeight - 220))
  moveCursor(x, y)
  showTooltip(msg, x, y)
  el.classList.add('demo-focus')
  await wait(waitMs)
  el.classList.remove('demo-focus')
}

async function clickEl(el: Element, msg: string, waitAfter: number): Promise<void> {
  checkCancelled()
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  await wait(600)
  checkCancelled()
  const r = el.getBoundingClientRect()
  const x = r.left + r.width / 2
  const y = r.top + r.height / 2
  moveCursor(x, y)
  showTooltip(msg, x, y)
  await wait(800)
  checkCancelled()
  ;(el as HTMLElement).click()
  await wait(waitAfter)
}

async function clickPreset(index: number, msg: string, waitAfter = 3500): Promise<void> {
  checkCancelled()
  const container = $('[data-demo="presets"]')
  const btns = container ? [...container.querySelectorAll('button')] : $all('button').filter((b) => (b.textContent ?? '').includes('▶'))
  const btn = btns[index]
  if (!btn) {
    await moveToCenter(msg, 3000)
    return
  }
  await clickEl(btn, msg, waitAfter)
}

async function clickGate(index: number, msg: string, waitAfter = 3000): Promise<void> {
  checkCancelled()
  const btns = [...document.querySelectorAll('.gate button')]
  const btn = btns[index]
  if (!btn) {
    await moveToCenter(msg, 3000)
    return
  }
  await clickEl(btn, msg, waitAfter)
}

async function waitFor(selector: string, maxMs = 6000): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    checkCancelled()
    if ($(selector)) return
    await wait(100)
  }
}

/** Wait until the replay store finishes loading the given branch. */
async function waitForRunBranch(id: string, maxMs = 9000): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    checkCancelled()
    const s = useRun.getState()
    if (!s.loading && s.run && s.meta?.branchId === id) return
    await wait(120)
  }
}

async function revealFullRun(): Promise<void> {
  const total = useRun.getState().run?.events.length ?? 0
  if (total > 0) useRun.getState().setPlayhead(total)
  await wait(900)
}

/** Click a real branch button, wait for its replay, reveal the full run. */
async function clickBranch(id: string, msg: string, waitAfter = 3000): Promise<void> {
  checkCancelled()
  const btn = document.querySelector(`[data-demo-branch="${id}"]`)
  if (!btn) {
    await moveToCenter(msg, 3000)
    return
  }
  await clickEl(btn, msg, 600)
  await waitForRunBranch(id)
  await revealFullRun()
  await wait(waitAfter)
}

/** Click a real timeline step card (selects the step + moves the playhead).
 * Unless leaveRewound is set, the playhead is restored to full afterwards so
 * later marks and shaper fires stay visible while the selection is kept. */
async function clickStep(index: number | 'critical', msg: string | null, waitAfter = 2200, leaveRewound = false): Promise<void> {
  checkCancelled()
  const cards = [...document.querySelectorAll('.tl-track .tl-step')]
  const el = index === 'critical'
    ? cards.find((c) => c.classList.contains('critical')) ?? cards[cards.length - 1]
    : cards[index]
  if (!el) {
    if (msg) await moveToCenter(msg, 2500)
    return
  }
  if (msg) {
    await clickEl(el, msg, 400)
  } else {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    await wait(500)
    checkCancelled()
    const r = el.getBoundingClientRect()
    moveCursor(r.left + r.width / 2, r.top + r.height / 2)
    await wait(400)
    checkCancelled()
    ;(el as HTMLElement).click()
    await wait(400)
  }
  checkCancelled()
  if (!leaveRewound) {
    const total = useRun.getState().run?.events.length ?? 0
    if (total > 0) useRun.getState().setPlayhead(total)
  }
  await wait(waitAfter)
}

function highlightNav(route: string): void {
  document.querySelectorAll('.screen-nav-item').forEach((n) => {
    const href = (n as HTMLAnchorElement).getAttribute('href') ?? ''
    n.classList.toggle('demo-active-page', href === `#${route}`)
  })
}

function clearNavHighlight(): void {
  document.querySelectorAll('.screen-nav-item').forEach((n) => n.classList.remove('demo-active-page'))
}

// ---- deterministic demo drivers (fixture replay only) ----

function pickWorkflowScenario(): string {
  const app = useApp.getState()
  return app.scenarios.find((s) => s.scenarioId === 'workflow-crm-export')?.scenarioId
    ?? app.scenarios[0]?.scenarioId
    ?? 'workflow-crm-export'
}

/** Load the failing baseline and play it step by step so the audience
 * watches the trajectory unfold instead of jumping to 30/30. */
async function driveInsightAnimated(): Promise<void> {
  hideCursor()
  const app = useApp.getState()
  const scenario = pickWorkflowScenario()
  app.select(scenario)
  await useRun.getState().load(scenario, 'base')
  useRun.getState().setPlayhead(0)
  await wait(800)
  const run = useRun.getState().run
  if (!run) return
  const idxs = [...new Set(run.steps.map((s) => s.reqIdx + 1))].sort((a, b) => a - b)
  for (const i of idxs) {
    checkCancelled()
    useRun.getState().setPlayhead(i)
    await wait(700)
  }
  await wait(900)
}

async function lockFirstBaseline(): Promise<void> {
  const first = useTunnel.getState().variants[0]
  if (first) useTunnel.getState().lockBaseline(first.key)
}

const SCRIPT: Step[] = [
  // Act 0 — opening on home (#/)
  { action: 'nav', route: '/' },
  { action: 'waitFor', selector: '.home-hero' },
  { action: 'center', key: 'demo.intro1', wait: 4500 },
  { action: 'center', key: 'demo.intro2', wait: 4000 },

  // Act 1 — Run Insight (#/insight): operate, don't narrate.
  // Same task, three harnesses: base fails with no interventions,
  // verifier succeeds with gates + verdicts, compression fires yet fails.
  { action: 'nav', route: '/insight' },
  { action: 'waitFor', selector: '.mri-layout' },
  { action: 'center', key: 'demo.insightIntro', wait: 5000 },
  { action: 'do', fn: driveInsightAnimated },
  { action: 'waitFor', selector: '.tl-track' },
  { action: 'wait', ms: 600 },
  { action: 'point', selector: '.tl-track', key: 'demo.insight1', wait: 5200 },
  { action: 'clickStep', index: 'critical', key: 'demo.insight2', wait: 3200 },
  { action: 'point', selector: '.tl-step.critical .tl-mark', key: 'demo.insight5', wait: 5500 },
  { action: 'point', selector: '.stack-bar', key: 'demo.insight3', wait: 5500 },
  { action: 'point', selector: '.shaper-stage', key: 'demo.insight4', wait: 5200 },
  { action: 'clickBranch', id: 'verifier', key: 'demo.insight6', wait: 2600 },
  { action: 'clickStep', index: 4, wait: 1200 },
  { action: 'point', selector: '.tl-track .tl-step:nth-child(5) .tl-mark', key: 'demo.insight7', wait: 6000 },
  { action: 'clickBranch', id: 'compress', key: 'demo.insight8', wait: 2600 },
  { action: 'clickStep', index: 3, wait: 1200, rewind: true },
  { action: 'point', selector: '.shaper-row.lit', key: 'demo.insight9', wait: 6000 },
  { action: 'clickStep', index: 4, wait: 1200 },
  { action: 'point', selector: '.tl-track .tl-step:nth-child(5) .tl-mark', key: 'demo.insight10', wait: 6000 },
  { action: 'clickStep', index: 5, wait: 1200 },
  { action: 'point', selector: '.tl-track .tl-step:nth-child(6) .tl-mark', key: 'demo.insight11', wait: 6000 },

  // Act 2 — Wind Tunnel (#/tunnel): purpose first, then details
  { action: 'nav', route: '/tunnel' },
  { action: 'waitFor', selector: '.grid-tunnel' },
  { action: 'center', key: 'demo.tunnelIntro', wait: 5500 },
  { action: 'point', selector: '[data-demo="board"]', key: 'demo.tunnelBoard', wait: 5200 },
  { action: 'clickPreset', index: 0, key: 'demo.tunnelPreset', wait: 4200 },
  { action: 'do', fn: lockFirstBaseline },
  { action: 'waitFor', selector: '[data-demo="readings"] table.t' },
  { action: 'wait', ms: 1200 },
  { action: 'point', selector: '[data-demo="readings"] table.t tbody tr:nth-child(2)', key: 'demo.tunnel2', wait: 6000 },
  { action: 'point', selector: '[data-demo="readings"] table.t tbody tr:nth-child(3)', key: 'demo.tunnel3', wait: 6000 },
  { action: 'point', selector: '[data-demo="lowertail"]', key: 'demo.tunnel4', wait: 5500 },
  { action: 'clickPreset', index: 2, key: 'demo.tunnel5', wait: 4200 },
  { action: 'wait', ms: 800 },
  { action: 'point', selector: '[data-demo="diff"]', key: 'demo.tunnel6', wait: 6000 },

  // Act 3 — Evolution (#/evolution)
  { action: 'nav', route: '/evolution' },
  { action: 'waitFor', selector: '.grid-forge' },
  { action: 'center', key: 'demo.forgeIntro', wait: 5500 },
  { action: 'do', fn: () => useForge.getState().reset() },
  { action: 'do', fn: () => useForge.getState().setGen(1) },
  { action: 'wait', ms: 700 },
  { action: 'point', selector: '.change-card', key: 'demo.forge1', wait: 5500 },
  { action: 'do', fn: () => useForge.getState().setGen(6) },
  { action: 'wait', ms: 700 },
  { action: 'point', selector: '.falsify', key: 'demo.forge2', wait: 5500 },
  { action: 'do', fn: () => useForge.getState().setGen(1) },
  { action: 'wait', ms: 700 },
  { action: 'clickGate', index: 0, key: 'demo.forge3', wait: 3200 },
  { action: 'point', selector: '.gen-list', key: 'demo.forgeList', wait: 4800 },
  { action: 'do', fn: () => useForge.getState().setGen(6) },
  { action: 'wait', ms: 700 },
  { action: 'clickGate', index: 1, key: 'demo.forgeReject', wait: 3200 },
  { action: 'point', selector: '.vtree', key: 'demo.forge4', wait: 5500 },
  { action: 'point', selector: '[data-demo="curve"]', key: 'demo.forge5', wait: 5500 },

  // Act 4 — Security chamber (#/security), before Legal per screen order 04 → 05
  { action: 'nav', route: '/security' },
  { action: 'waitFor', selector: '[data-demo="kill"]' },
  { action: 'center', key: 'demo.secIntro', wait: 5000 },
  { action: 'point', selector: '[data-demo="kill"]', key: 'demo.sec1', wait: 6000 },
  { action: 'point', selector: '[data-demo="pareto"] table.t', key: 'demo.sec2', wait: 6000 },
  { action: 'point', selector: '[data-demo="policy"] h3', key: 'demo.secPolicy', wait: 6000 },
  { action: 'center', key: 'demo.sec3', wait: 4500 },

  // Act 5 — Legal chamber (#/legal)
  { action: 'nav', route: '/legal' },
  { action: 'waitFor', selector: '[data-demo="case"]' },
  { action: 'center', key: 'demo.legalIntro', wait: 5000 },
  { action: 'point', selector: '[data-demo="case"]', key: 'demo.legal1', wait: 6000 },
  { action: 'point', selector: '[data-demo="stair"]', key: 'demo.legal2', wait: 6000 },
  { action: 'point', selector: '[data-demo="license"]', key: 'demo.legal3', wait: 5500 },

  // Finale — back home
  { action: 'nav', route: '/' },
  { action: 'waitFor', selector: '.home-hero' },
  { action: 'center', key: 'demo.outro1', wait: 4500 },
  { action: 'center', key: 'demo.outro2', wait: 5000 },
]

async function runDemo(): Promise<void> {
  const total = SCRIPT.length
  let i = 0
  try {
    for (const step of SCRIPT) {
      checkCancelled()
      i += 1
      setProgress((i / total) * 100)
      switch (step.action) {
        case 'center':
          await moveToCenter(text(step.key), step.wait ?? 4200)
          break
        case 'nav':
          // Hide first: the old screen's tooltip must never linger on the new screen.
          hideCursor()
          highlightNav(step.route)
          if (window.location.hash !== `#${step.route}`) window.location.hash = `#${step.route}`
          // Start at the top so the screen head (eyebrow + title) is visible
          // before the intro states the screen's purpose.
          window.scrollTo(0, 0)
          await wait(step.wait ?? 900)
          break
        case 'wait':
          await wait(step.ms)
          break
        case 'waitFor':
          await waitFor(step.selector, step.maxMs ?? 6000)
          break
        case 'point':
          await pointTo(step.selector, text(step.key), step.wait ?? 5200)
          break
        case 'clickPreset':
          await clickPreset(step.index, text(step.key), step.wait ?? 3500)
          break
        case 'clickGate':
          await clickGate(step.index, text(step.key), step.wait ?? 3000)
          break
        case 'clickBranch':
          await clickBranch(step.id, text(step.key), step.wait ?? 2600)
          break
        case 'clickStep':
          await clickStep(step.index, step.key ? text(step.key) : null, step.wait ?? 2200, step.rewind ?? false)
          break
        case 'do':
          await step.fn()
          break
      }
    }
  } catch (e) {
    if ((e as Error).message !== '__CANCELLED__') console.error('Demo error:', e)
  }
  stopDemo()
}

export function startDemo(): void {
  if (isPlaying) return
  ensureOverlay()
  const overlay = document.getElementById('demo-overlay')
  if (overlay) overlay.style.display = 'block'
  setDemoButtons(text('demo.stop'))
  isPlaying = true
  void runDemo()
}

export function stopDemo(): void {
  isPlaying = false
  clearNavHighlight()
  document.querySelectorAll('.demo-focus').forEach((n) => n.classList.remove('demo-focus'))
  hideCursor()
  setProgress(0)
  const overlay = document.getElementById('demo-overlay')
  if (overlay) overlay.style.display = 'none'
  setDemoButtons(t('demo.button', lang()))
}

export function isDemoPlaying(): boolean {
  return isPlaying
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isPlaying) stopDemo()
  })
}

// Re-exported for tests: preset button order in the quick-load row.
export const DEMO_PRESET_ORDER = ['nlah-ablation', 'harness-r1-regress', 'minimal-rich-pairs'] as const
export function presetIndexFor(id: string): number {
  return PRESETS.filter((p) => (DEMO_PRESET_ORDER as readonly string[]).includes(p.id)).findIndex((p) => p.id === id)
}
