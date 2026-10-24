// One-click demo — cursor + tooltip + chaptered tour across all screens.
//
// Mirrors the agentEvalPlatform demo-overlay design:
//   - fixed overlay: click-catcher + progress bar + tooltip + cursor + controls
//   - hash-route navigation (#/insight, #/tunnel, ...)
//   - every screen opens with a purpose intro before any detail
//   - the tour is split into a ~2:30 main loop and ~1:30 topic chambers;
//     pause / previous / next and chapter jumps are always available
//   - tooltip placement avoids covering the element being explained
//   - the tooltip is hidden on every navigation so it never lingers
//   - ESC stops; Space pauses; ←/→ switch chapters
//   - every step is deterministic fixture replay (offline, zero side effects)
import { t, useI18n, type Language } from '../i18n'
import { useApp, useForge, useRun, useTunnel } from '../stores'
import { PRESETS } from '../../shared/presets'

let isPlaying = false
let paused = false
let runId = 0

type Step =
  | { action: 'center'; key: string; wait?: number }
  | { action: 'nav'; route: string; wait?: number }
  | { action: 'wait'; ms: number }
  | { action: 'waitFor'; selector: string; maxMs?: number }
  | { action: 'point'; selector: string; key: string; wait?: number }
  | { action: 'click'; selector: string; key: string; wait?: number }
  | { action: 'clickPreset'; index: number; key: string; wait?: number }
  | { action: 'clickGate'; index: number; key: string; wait?: number }
  | { action: 'clickBranch'; id: string; key: string; wait?: number }
  | { action: 'clickStep'; index: number | 'critical'; key?: string; wait?: number; rewind?: boolean }
  | { action: 'do'; fn: () => void | Promise<void> }

type ChapterGroup = 'main' | 'topics' | 'outro'

type Chapter = {
  id: string
  group: ChapterGroup
  titleKey: string
  steps: Step[]
}

const lang = (): Language => useI18n.getState().lang
const text = (key: string, params?: Record<string, string | number>): string => t(key, lang(), params)

function $(sel: string): Element | null {
  return document.querySelector(sel)
}
function $all(sel: string): Element[] {
  return [...document.querySelectorAll(sel)]
}
function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Throw when this run has been stopped or replaced by a chapter jump. */
function checkActive(id = runId): void {
  if (!isPlaying || id !== runId) throw new Error('__CANCELLED__')
}

/** Pause-aware wait: the clock freezes while the viewer reads a tooltip. */
async function sleep(ms: number): Promise<void> {
  const id = runId
  const end = Date.now() + ms
  while (Date.now() < end) {
    checkActive(id)
    if (paused) {
      await wait(80)
      continue
    }
    await wait(Math.min(90, end - Date.now()))
  }
  checkActive(id)
}

let currentChapter = 0
let currentStep = 0

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
    <div id="demo-controls">
      <div id="demo-chapter-row"></div>
      <div id="demo-control-bar">
        <button type="button" id="demo-prev">⏮</button>
        <button type="button" id="demo-pause">⏸</button>
        <button type="button" id="demo-next">⏭</button>
        <span id="demo-chapter-label"></span>
        <span id="demo-hint"></span>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  document.getElementById('demo-click-catcher')?.addEventListener('click', () => void stopDemo())
  document.getElementById('demo-prev')?.addEventListener('click', (e) => {
    e.stopPropagation()
    previousChapter()
  })
  document.getElementById('demo-pause')?.addEventListener('click', (e) => {
    e.stopPropagation()
    togglePause()
  })
  document.getElementById('demo-next')?.addEventListener('click', (e) => {
    e.stopPropagation()
    nextChapter()
  })
}

function renderChapters(): void {
  const row = document.getElementById('demo-chapter-row')
  if (!row) return
  row.innerHTML = ''
  let lastGroup: ChapterGroup | null = null
  CHAPTERS.forEach((chapter, i) => {
    if (chapter.group !== lastGroup) {
      lastGroup = chapter.group
      const groupLabel = document.createElement('span')
      groupLabel.className = 'demo-group-label'
      groupLabel.textContent =
        chapter.group === 'main' ? text('demo.chapter.main')
          : chapter.group === 'topics' ? text('demo.chapter.topics')
            : text('demo.chapter.outro')
      row.appendChild(groupLabel)
    }
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'demo-chapter'
    chip.dataset.chapter = String(i)
    chip.textContent = `${i + 1} ${text(chapter.titleKey)}`
    chip.title = text('demo.chapter.jump', { title: text(chapter.titleKey) })
    if (i === currentChapter) chip.classList.add('active')
    if (i < currentChapter) chip.classList.add('done')
    chip.addEventListener('click', (e) => {
      e.stopPropagation()
      jumpToChapter(i)
    })
    row.appendChild(chip)
  })
}

function renderControlState(): void {
  const pauseBtn = document.getElementById('demo-pause')
  if (pauseBtn) {
    pauseBtn.textContent = paused ? '▶' : '⏸'
    const label = paused ? text('demo.controls.resume') : text('demo.controls.pause')
    pauseBtn.title = label
    pauseBtn.setAttribute('aria-label', label)
  }
  const prev = document.getElementById('demo-prev')
  if (prev) {
    prev.title = text('demo.controls.prev')
    prev.setAttribute('aria-label', text('demo.controls.prev'))
  }
  const next = document.getElementById('demo-next')
  if (next) {
    next.title = text('demo.controls.next')
    next.setAttribute('aria-label', text('demo.controls.next'))
  }
  const label = document.getElementById('demo-chapter-label')
  if (label) {
    label.textContent = paused
      ? text('demo.controls.pausedAt', {
          i: currentChapter + 1,
          n: CHAPTERS.length,
          title: text(CHAPTERS[currentChapter]?.titleKey ?? 'demo.chapter.outroTitle'),
        })
      : text('demo.chapter.label', {
          i: currentChapter + 1,
          n: CHAPTERS.length,
          title: text(CHAPTERS[currentChapter]?.titleKey ?? 'demo.chapter.outroTitle'),
        })
  }
  const hint = document.getElementById('demo-hint')
  if (hint) hint.textContent = text('demo.controls.hint')
  $all('.demo-chapter').forEach((chip) => {
    const i = Number((chip as HTMLElement).dataset.chapter)
    chip.classList.toggle('active', i === currentChapter)
    chip.classList.toggle('done', i < currentChapter)
  })
}

function setProgress(pct: number): void {
  const bar = document.getElementById('demo-progress-bar')
  if (bar) bar.style.width = `${pct}%`
}

function updateProgress(): void {
  const total = CHAPTERS.reduce((n, c) => n + c.steps.length, 0)
  const before = CHAPTERS.slice(0, currentChapter).reduce((n, c) => n + c.steps.length, 0)
  setProgress(total > 0 ? ((before + currentStep) / total) * 100 : 0)
}

function moveCursor(x: number, y: number): void {
  const cursor = document.getElementById('demo-cursor')
  if (!cursor) return
  cursor.style.display = 'block'
  cursor.style.left = `${x - 12}px`
  cursor.style.top = `${y - 12}px`
}

type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number }

/**
 * Place the tooltip in a quadrant that does not cover the pointed element.
 * Order: right → left → below → above, then a clamped fallback.
 */
function showTooltip(msg: string, x: number, y: number, avoid?: Box): void {
  const tip = document.getElementById('demo-tooltip')
  if (!tip) return
  tip.textContent = msg
  tip.style.display = 'block'
  const rect = tip.getBoundingClientRect()
  const margin = 12
  const topbar = 64
  const gap = 18
  // Keep the box clear of the chapter controls at the bottom.
  const bottom = window.innerHeight - 12 - 92
  const width = window.innerWidth
  const fits = (left: number, top: number): boolean =>
    left >= margin && top >= topbar && left + rect.width <= width - margin && top + rect.height <= bottom

  let best: { left: number; top: number } | null = null
  if (avoid) {
    const a = { left: avoid.left - 8, top: avoid.top - 8, right: avoid.right + 8, bottom: avoid.bottom + 8 }
    const candidates = [
      { left: a.right + gap, top: y - rect.height / 2 },
      { left: a.left - gap - rect.width, top: y - rect.height / 2 },
      { left: x - rect.width / 2, top: a.bottom + gap },
      { left: x - rect.width / 2, top: a.top - gap - rect.height },
    ]
    best = candidates.find((c) => fits(c.left, c.top)) ?? null
  }
  if (!best) {
    let left = x - rect.width / 2
    left = Math.max(margin, Math.min(left, width - rect.width - margin))
    let top = y + 30
    if (avoid && top < avoid.bottom + gap && top + rect.height > avoid.top - gap) top = avoid.bottom + gap
    if (top + rect.height > bottom) {
      top = avoid ? avoid.top - gap - rect.height : y - rect.height - 14
    }
    top = Math.max(topbar, Math.min(top, bottom - rect.height))
    best = { left, top }
  }
  tip.style.left = `${best.left}px`
  tip.style.top = `${best.top}px`
}

function hideCursor(): void {
  const cursor = document.getElementById('demo-cursor')
  const tip = document.getElementById('demo-tooltip')
  if (cursor) cursor.style.display = 'none'
  if (tip) tip.style.display = 'none'
}

// The topbar button is React-rendered, so a direct textContent write would be
// wiped by the next route re-render. Publish state instead and let App decide.
const demoStateListeners = new Set<(playing: boolean) => void>()

export function subscribeDemoState(listener: (playing: boolean) => void): () => void {
  demoStateListeners.add(listener)
  listener(isPlaying)
  return () => { demoStateListeners.delete(listener) }
}

function emitDemoState(): void {
  demoStateListeners.forEach((listener) => listener(isPlaying))
}

async function moveToCenter(msg: string, waitMs = 4200): Promise<void> {
  checkActive()
  const x = window.innerWidth / 2
  const y = window.innerHeight / 2
  moveCursor(x, y)
  showTooltip(msg, x, y)
  await sleep(waitMs)
}

async function pointTo(selector: string, msg: string, waitMs = 5200): Promise<void> {
  checkActive()
  const el = $(selector)
  if (!el) {
    await moveToCenter(msg, waitMs)
    return
  }
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  await sleep(600)
  checkActive()
  const r = el.getBoundingClientRect()
  // Anchor near the top of the element so tall panels never push the
  // cursor (and its tooltip) outside the viewport; clamp into view.
  const x = Math.max(200, Math.min(r.left + r.width / 2, window.innerWidth - 200))
  const y = Math.max(90, Math.min(r.top + Math.min(120, r.height * 0.2), window.innerHeight - 220))
  moveCursor(x, y)
  showTooltip(msg, x, y, r)
  el.classList.add('demo-focus')
  await sleep(waitMs)
  el.classList.remove('demo-focus')
}

async function clickEl(el: Element, msg: string, waitAfter: number): Promise<void> {
  checkActive()
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  await sleep(600)
  checkActive()
  const r = el.getBoundingClientRect()
  const x = r.left + r.width / 2
  const y = r.top + r.height / 2
  moveCursor(x, y)
  showTooltip(msg, x, y, r)
  await sleep(800)
  checkActive()
  ;(el as HTMLElement).click()
  await sleep(waitAfter)
}

async function clickSelector(selector: string, msg: string, waitAfter = 2600): Promise<void> {
  checkActive()
  const el = $(selector)
  if (!el) {
    await moveToCenter(msg, 2400)
    return
  }
  await clickEl(el, msg, waitAfter)
}

async function clickPreset(index: number, msg: string, waitAfter = 3500): Promise<void> {
  checkActive()
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
  checkActive()
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
    checkActive()
    if ($(selector)) return
    await sleep(120)
  }
}

/** Wait until the replay store finishes loading the given branch. */
async function waitForRunBranch(id: string, maxMs = 9000): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    checkActive()
    const s = useRun.getState()
    if (!s.loading && s.run && s.meta?.branchId === id) return
    await sleep(120)
  }
}

async function revealFullRun(): Promise<void> {
  const total = useRun.getState().run?.events.length ?? 0
  if (total > 0) useRun.getState().setPlayhead(total)
  await sleep(900)
}

/** Click a real branch button, wait for its replay, reveal the full run. */
async function clickBranch(id: string, msg: string, waitAfter = 3000): Promise<void> {
  checkActive()
  const btn = document.querySelector(`[data-demo-branch="${id}"]`)
  if (!btn) {
    await moveToCenter(msg, 3000)
    return
  }
  await clickEl(btn, msg, 600)
  await waitForRunBranch(id)
  await revealFullRun()
  await sleep(waitAfter)
}

/** Click a real timeline step card (selects the step + moves the playhead).
 * Unless leaveRewound is set, the playhead is restored to full afterwards so
 * later marks and shaper fires stay visible while the selection is kept. */
async function clickStep(index: number | 'critical', msg: string | null, waitAfter = 2200, leaveRewound = false): Promise<void> {
  checkActive()
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
    await sleep(500)
    checkActive()
    const r = el.getBoundingClientRect()
    moveCursor(r.left + r.width / 2, r.top + r.height / 2)
    await sleep(400)
    checkActive()
    ;(el as HTMLElement).click()
    await sleep(400)
  }
  checkActive()
  if (!leaveRewound) {
    const total = useRun.getState().run?.events.length ?? 0
    if (total > 0) useRun.getState().setPlayhead(total)
  }
  await sleep(waitAfter)
}

function highlightNav(route: string): void {
  document.querySelectorAll('.module-nav-item').forEach((n) => {
    const href = (n as HTMLAnchorElement).getAttribute('href') ?? ''
    n.classList.toggle('demo-active-page', href === `#${route}`)
  })
}

function clearNavHighlight(): void {
  document.querySelectorAll('.module-nav-item').forEach((n) => n.classList.remove('demo-active-page'))
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
  await sleep(800)
  const run = useRun.getState().run
  if (!run) return
  const idxs = [...new Set(run.steps.map((s) => s.reqIdx + 1))].sort((a, b) => a - b)
  for (const i of idxs) {
    checkActive()
    useRun.getState().setPlayhead(i)
    await sleep(700)
  }
  await sleep(900)
}

async function lockFirstBaseline(): Promise<void> {
  const first = useTunnel.getState().variants[0]
  if (first) useTunnel.getState().lockBaseline(first.key)
}

// ---- chapters: ~2:30 main loop, then ~1:30 topic chambers ----

const CHAPTERS: Chapter[] = [
  {
    id: 'start',
    group: 'main',
    titleKey: 'demo.chapter.start',
    steps: [
      { action: 'nav', route: '/' },
      { action: 'waitFor', selector: '.home-hero' },
      { action: 'center', key: 'demo.intro1', wait: 4300 },
      { action: 'center', key: 'demo.intro2', wait: 4600 },
    ],
  },
  {
    id: 'insight',
    group: 'main',
    titleKey: 'demo.chapter.insight',
    steps: [
      // Same task, three harnesses: base fails with no interventions,
      // verifier succeeds with gates + verdicts, compression fires yet fails.
      { action: 'nav', route: '/insight' },
      { action: 'waitFor', selector: '.mri-layout' },
      { action: 'center', key: 'demo.insightIntro', wait: 4600 },
      { action: 'do', fn: driveInsightAnimated },
      { action: 'waitFor', selector: '.tl-track' },
      { action: 'wait', ms: 500 },
      { action: 'point', selector: '.tl-track', key: 'demo.insight1', wait: 5000 },
      { action: 'clickStep', index: 'critical', key: 'demo.insight2', wait: 2600 },
      { action: 'point', selector: '.tl-step.critical .tl-mark', key: 'demo.insight5', wait: 5200 },
      { action: 'point', selector: '.stack-bar', key: 'demo.insight3', wait: 5200 },
      { action: 'point', selector: '.shaper-stage', key: 'demo.insight4', wait: 4800 },
      { action: 'clickBranch', id: 'verifier', key: 'demo.insight6', wait: 2200 },
      { action: 'clickStep', index: 4, wait: 1000 },
      { action: 'point', selector: '.tl-track .tl-step:nth-child(5) .tl-mark', key: 'demo.insight7', wait: 5500 },
      { action: 'clickBranch', id: 'compress', key: 'demo.insight8', wait: 2200 },
      { action: 'clickStep', index: 3, wait: 1000, rewind: true },
      { action: 'point', selector: '.shaper-row.lit', key: 'demo.insight9', wait: 5500 },
      { action: 'clickStep', index: 4, wait: 1000 },
      { action: 'point', selector: '.tl-track .tl-step:nth-child(5) .tl-mark', key: 'demo.insight10', wait: 5500 },
      { action: 'clickStep', index: 5, wait: 1000 },
      { action: 'point', selector: '.tl-track .tl-step:nth-child(6) .tl-mark', key: 'demo.insight11', wait: 5500 },
    ],
  },
  {
    id: 'tunnel',
    group: 'main',
    titleKey: 'demo.chapter.tunnel',
    steps: [
      { action: 'nav', route: '/tunnel' },
      { action: 'waitFor', selector: '.grid-tunnel' },
      { action: 'center', key: 'demo.tunnelIntro', wait: 4800 },
      { action: 'point', selector: '[data-demo="board"]', key: 'demo.tunnelBoard', wait: 4800 },
      { action: 'clickPreset', index: 0, key: 'demo.tunnelPreset', wait: 3800 },
      { action: 'do', fn: lockFirstBaseline },
      { action: 'waitFor', selector: '[data-demo="readings"] table.t' },
      { action: 'wait', ms: 1000 },
      { action: 'point', selector: '[data-demo="readings"] table.t tbody tr:nth-child(2)', key: 'demo.tunnel2', wait: 5200 },
      { action: 'point', selector: '[data-demo="readings"] table.t tbody tr:nth-child(3)', key: 'demo.tunnel3', wait: 5200 },
      { action: 'point', selector: '[data-demo="lowertail"]', key: 'demo.tunnel4', wait: 5000 },
      { action: 'clickPreset', index: 2, key: 'demo.tunnel5', wait: 3800 },
      { action: 'wait', ms: 700 },
      { action: 'point', selector: '[data-demo="diff"]', key: 'demo.tunnel6', wait: 5200 },
    ],
  },
  {
    id: 'evolution',
    group: 'main',
    titleKey: 'demo.chapter.evolution',
    steps: [
      { action: 'nav', route: '/evolution' },
      { action: 'waitFor', selector: '.grid-forge' },
      { action: 'center', key: 'demo.forgeIntro', wait: 4800 },
      { action: 'do', fn: () => useForge.getState().reset() },
      { action: 'do', fn: () => useForge.getState().setGen(1) },
      { action: 'wait', ms: 600 },
      { action: 'point', selector: '.change-card', key: 'demo.forge1', wait: 5000 },
      { action: 'do', fn: () => useForge.getState().setGen(6) },
      { action: 'wait', ms: 600 },
      { action: 'point', selector: '.falsify', key: 'demo.forge2', wait: 5000 },
      { action: 'do', fn: () => useForge.getState().setGen(1) },
      { action: 'wait', ms: 600 },
      { action: 'clickGate', index: 0, key: 'demo.forge3', wait: 2800 },
      { action: 'point', selector: '.gen-list', key: 'demo.forgeList', wait: 4400 },
      { action: 'do', fn: () => useForge.getState().setGen(6) },
      { action: 'wait', ms: 600 },
      { action: 'clickGate', index: 1, key: 'demo.forgeReject', wait: 2800 },
      { action: 'point', selector: '.vtree', key: 'demo.forge4', wait: 5000 },
      { action: 'point', selector: '[data-demo="curve"]', key: 'demo.forge5', wait: 5000 },
    ],
  },
  {
    id: 'security',
    group: 'topics',
    titleKey: 'demo.chapter.security',
    steps: [
      { action: 'nav', route: '/security' },
      { action: 'waitFor', selector: '[data-demo="kill"]' },
      { action: 'center', key: 'demo.secIntro', wait: 4600 },
      { action: 'point', selector: '[data-demo="kill"]', key: 'demo.sec1', wait: 5500 },
      { action: 'point', selector: '[data-demo="pareto"] .sec-point-list', key: 'demo.sec2', wait: 5500 },
      { action: 'point', selector: '[data-demo="policy"] h3', key: 'demo.secPolicy', wait: 5500 },
      { action: 'center', key: 'demo.sec3', wait: 4200 },
    ],
  },
  {
    id: 'legal',
    group: 'topics',
    titleKey: 'demo.chapter.legal',
    steps: [
      { action: 'nav', route: '/legal' },
      { action: 'waitFor', selector: '[data-demo="case"]' },
      { action: 'center', key: 'demo.legalIntro', wait: 4600 },
      { action: 'point', selector: '[data-demo="case"]', key: 'demo.legal1', wait: 5500 },
      { action: 'point', selector: '[data-demo="stair"]', key: 'demo.legal2', wait: 5500 },
      { action: 'point', selector: '[data-demo="license"]', key: 'demo.legal3', wait: 5000 },
    ],
  },
  {
    id: 'playground',
    group: 'topics',
    titleKey: 'demo.chapter.playground',
    steps: [
      // Read-only chapter: task bank + recorded results. Never presses Run.
      { action: 'nav', route: '/playground' },
      { action: 'waitFor', selector: '.pg-workspace-nav' },
      { action: 'center', key: 'demo.playgroundIntro', wait: 4800 },
      { action: 'point', selector: '.pg-workspace-nav', key: 'demo.playground1', wait: 4600 },
      { action: 'click', selector: '.pg-workspace-tab:nth-child(3)', key: 'demo.playground2', wait: 2400 },
      { action: 'waitFor', selector: '.pg-task-table' },
      { action: 'point', selector: '.pg-task-table', key: 'demo.playground3', wait: 5200 },
      { action: 'click', selector: '.pg-workspace-tab:nth-child(1)', key: 'demo.playground4', wait: 2400 },
      { action: 'waitFor', selector: '.pg-composer' },
      { action: 'point', selector: '.pg-composer', key: 'demo.playground5', wait: 5000 },
      { action: 'point', selector: '.pg-results-head', key: 'demo.playground6', wait: 4800 },
    ],
  },
  {
    id: 'outro',
    group: 'outro',
    titleKey: 'demo.chapter.outroTitle',
    steps: [
      { action: 'nav', route: '/' },
      { action: 'waitFor', selector: '.home-hero' },
      { action: 'center', key: 'demo.outro1', wait: 4200 },
      { action: 'center', key: 'demo.outro2', wait: 4600 },
    ],
  },
]

async function execute(step: Step, id: number): Promise<void> {
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
      await sleep(step.wait ?? 900)
      break
    case 'wait':
      await sleep(step.ms)
      break
    case 'waitFor':
      await waitFor(step.selector, step.maxMs ?? 6000)
      break
    case 'point':
      await pointTo(step.selector, text(step.key), step.wait ?? 5200)
      break
    case 'click':
      await clickSelector(step.selector, text(step.key), step.wait ?? 2600)
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
  checkActive(id)
}

async function runChapters(id: number, startChapter: number): Promise<void> {
  try {
    for (let c = startChapter; c < CHAPTERS.length; c++) {
      checkActive(id)
      currentChapter = c
      currentStep = 0
      renderChapters()
      renderControlState()
      updateProgress()
      const steps = CHAPTERS[c]!.steps
      for (let s = 0; s < steps.length; s++) {
        checkActive(id)
        currentStep = s
        updateProgress()
        try {
          await execute(steps[s]!, id)
        } catch (e) {
          if ((e as Error).message === '__CANCELLED__') throw e
          // A missing selector must not end the whole tour; log and move on.
          console.error('Demo step failed:', steps[s], e)
        }
      }
    }
  } catch (e) {
    if ((e as Error).message !== '__CANCELLED__') console.error('Demo error:', e)
    return
  }
  if (id === runId && isPlaying) stopDemo()
}

function jumpToChapter(index: number): void {
  if (!isPlaying) return
  if (index < 0 || index >= CHAPTERS.length) return
  runId += 1
  const id = runId
  paused = false
  hideCursor()
  document.querySelectorAll('.demo-focus').forEach((n) => n.classList.remove('demo-focus'))
  clearNavHighlight()
  currentChapter = index
  currentStep = 0
  renderChapters()
  renderControlState()
  updateProgress()
  void runChapters(id, index)
}

export function nextChapter(): void {
  if (!isPlaying) return
  if (currentChapter >= CHAPTERS.length - 1) {
    stopDemo()
    return
  }
  jumpToChapter(currentChapter + 1)
}

export function previousChapter(): void {
  if (!isPlaying) return
  jumpToChapter(Math.max(0, currentChapter - 1))
}

export function pauseDemo(): void {
  if (!isPlaying || paused) return
  paused = true
  renderControlState()
}

export function resumeDemo(): void {
  if (!isPlaying || !paused) return
  paused = false
  renderControlState()
}

export function togglePause(): void {
  if (!isPlaying) return
  if (paused) resumeDemo()
  else pauseDemo()
}

export function startDemo(): void {
  if (isPlaying) return
  ensureOverlay()
  const overlay = document.getElementById('demo-overlay')
  if (overlay) overlay.style.display = 'block'
  isPlaying = true
  paused = false
  currentChapter = 0
  currentStep = 0
  runId += 1
  const id = runId
  renderChapters()
  renderControlState()
  setProgress(0)
  emitDemoState()
  void runChapters(id, 0)
}

export function stopDemo(): void {
  runId += 1
  isPlaying = false
  paused = false
  clearNavHighlight()
  document.querySelectorAll('.demo-focus').forEach((n) => n.classList.remove('demo-focus'))
  hideCursor()
  setProgress(0)
  const overlay = document.getElementById('demo-overlay')
  if (overlay) overlay.style.display = 'none'
  currentChapter = 0
  currentStep = 0
  emitDemoState()
}

export function isDemoPlaying(): boolean {
  return isPlaying
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (!isPlaying) return
    if (e.key === 'Escape') {
      stopDemo()
      return
    }
    const tag = (e.target as HTMLElement | null)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    if (e.key === ' ') {
      e.preventDefault()
      togglePause()
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      nextChapter()
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      previousChapter()
    }
  })
}

// Re-exported for tests: preset button order in the quick-load row.
export const DEMO_PRESET_ORDER = ['nlah-ablation', 'harness-r1-regress', 'minimal-rich-pairs'] as const
export function presetIndexFor(id: string): number {
  return PRESETS.filter((p) => (DEMO_PRESET_ORDER as readonly string[]).includes(p.id)).findIndex((p) => p.id === id)
}
