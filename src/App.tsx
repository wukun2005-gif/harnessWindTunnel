import { useEffect, useState, type ReactNode } from 'react'
import { useApp } from './stores'
import { useI18n, useT } from './i18n'
import { startDemo, stopDemo, isDemoPlaying, subscribeDemoState } from './demo/demo'
import MRI from './screens/MRI'
import WindTunnel from './screens/WindTunnel'
import Forge from './screens/Forge'
import Settings from './screens/Settings'
import Legal from './screens/Legal'
import Security from './screens/Security'
import Playground from './screens/Playground'
import { ModuleNav } from './components/ModuleNav'
import { Glossary } from './components/Glossary'

function useHashRoute(): string {
  const normalize = (h: string) => {
    const r = (h.replace(/^#/, '') || '/').split('?')[0]
    return r === '/mri' ? '/insight' : r === '/forge' ? '/evolution' : r // legacy routes retired with the MRI/Forge names
  }
  const [hash, setHash] = useState(() => normalize(window.location.hash))
  useEffect(() => {
    const fn = () => setHash(normalize(window.location.hash))
    window.addEventListener('hashchange', fn)
    return () => window.removeEventListener('hashchange', fn)
  }, [])
  return hash
}

const TITLES: Record<string, string> = {
  '/': 'Overview',
  '/insight': 'Run Insight',
  '/tunnel': 'Wind Tunnel',
  '/evolution': 'Evolution',
  '/legal': 'Legal',
  '/security': 'Security',
  '/playground': 'Playground',
}

const MODULE_ICON_PATHS = {
  observe: (
    <>
      <path d="M12 3 3 8l9 5 9-5-9-5Z" />
      <path d="m3 13 9 5 9-5" />
    </>
  ),
  measure: (
    <>
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="8" cy="17" r="2" />
    </>
  ),
  improve: (
    <>
      <circle cx="6" cy="5" r="2.2" />
      <circle cx="6" cy="19" r="2.2" />
      <circle cx="18" cy="8" r="2.2" />
      <path d="M6 7.2v9.6" />
      <path d="M18 10.2c0 3.8-4.6 3.6-6 8.8" />
    </>
  ),
  defend: (
    <>
      <path d="M12 3 5 6v5c0 4.4 2.8 7.8 7 10 4.2-2.2 7-5.6 7-10V6l-7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  comply: (
    <>
      <path d="M12 4v16M7 20h10M5 7h14" />
      <path d="m5 7-3 6h6L5 7ZM19 7l-3 6h6l-3-6Z" />
    </>
  ),
  evaluate: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m10 8 6 4-6 4V8Z" />
    </>
  ),
} satisfies Record<string, ReactNode>

type ModuleIconName = keyof typeof MODULE_ICON_PATHS

function ModuleIcon({ name }: { name: ModuleIconName }) {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {MODULE_ICON_PATHS[name]}
    </svg>
  )
}

export default function App() {
  const route = useHashRoute()
  const { bootstrap, ready, online } = useApp()
  const { lang, setLang } = useI18n()
  const t = useT()
  const [glossaryOpen, setGlossaryOpen] = useState(false)
  // The demo mutates the page outside React; subscribe so the topbar label
  // survives route re-renders instead of reverting to "▶ One-click Demo".
  const [demoPlaying, setDemoPlaying] = useState(false)
  useEffect(() => subscribeDemoState(setDemoPlaying), [])
  useEffect(() => { void bootstrap() }, [bootstrap])

  const toggleLang = () => setLang(lang === 'en' ? 'zh' : 'en')
  const inLoop = route === '/insight' || route === '/tunnel' || route === '/evolution'

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-main">
          <div className="brand">
            <a href="#/" style={{ textDecoration: 'none', fontWeight: 700 }}>{t('app.brand.title')}</a>
          </div>
          <div className="spacer" />
          {route !== '/' && (
            <button
              id="demo-btn"
              className="primary demo-btn"
              style={{ padding: '4px 12px', fontSize: '13px', marginRight: '8px' }}
              onClick={() => { if (isDemoPlaying()) stopDemo(); else startDemo() }}
            >
              {demoPlaying ? t('demo.stop') : t('demo.button')}
            </button>
          )}
          <button
            type="button"
            className="glossary-link"
            title={t('glossary.title')}
            onClick={() => setGlossaryOpen(true)}
          >? {t('glossary.open')}</button>
          <a
            href="#/settings"
            className="settings-link"
            title={t('settings.title')}
          >
            ⚙ {t('nav.settings')}
          </a>
          <button 
            onClick={toggleLang}
            className="lang-toggle"
            style={{ 
              padding: '4px 10px', 
              fontSize: '13px', 
              border: '1px solid var(--dim)', 
              background: 'transparent',
              color: 'var(--fg)',
              borderRadius: '4px',
              cursor: 'pointer',
              marginRight: '12px',
              fontFamily: 'var(--mono)'
            }}
            title={t('common.switchLang')}
          >
            {lang === 'en' ? 'EN' : '中'}
          </button>
        </div>
        <ModuleNav current={route} />
      </header>

      {ready && inLoop && <ContextBar />}

      {!ready ? (
        <div className="loading">{t('status.loading')}</div>
      ) : route === '/insight' ? (
        <MRI />
      ) : route === '/tunnel' ? (
        <WindTunnel />
      ) : route === '/evolution' ? (
        <Forge />
      ) : route === '/settings' ? (
        <Settings />
      ) : route === '/legal' ? (
        <Legal />
      ) : route === '/security' ? (
        <Security />
      ) : route === '/playground' ? (
        <Playground />
      ) : (
        <Home online={online} />
      )}
      <Glossary open={glossaryOpen} onClose={() => setGlossaryOpen(false)} />
    </div>
  )
}

/** What stays fixed while the loop runs: scenario, model, data provenance. */
function ContextBar() {
  const t = useT()
  const { current, metas } = useApp()
  const meta = metas[current]
  const scenarioKey = `scenario.${current}.family`
  const family = meta
    ? (t(scenarioKey) !== scenarioKey ? t(scenarioKey) : meta.familyLabel)
    : current || '—'
  // meta.model carries an English qualifier ("fixed model, illustrative").
  // Show the bare id + a localized qualifier so Chinese mode stays Chinese.
  const modelId = meta?.model?.split(' (')[0] ?? ''
  const modelKey = `model.${modelId}`
  const modelLabel = meta
    ? (t(modelKey) !== modelKey ? t(modelKey) : meta.model)
    : '—'
  return (
    <div className="context-bar">
      <span className="cb-label">{t('context.fixed')}</span>
      <span className="cb-item"><b>{t('context.scenario')}</b> {family}</span>
      <span className="cb-item"><b>{t('context.model')}</b> <span className="mono">{modelLabel}</span></span>
      <span className="cb-item"><b>{t('context.data')}</b> {t('context.offline')}</span>
      <a className="cb-switch" href="#/insight">{t('context.switch')} →</a>
    </div>
  )
}

function Home({ online }: { online: boolean }) {
  const t = useT()
  const [demoPlaying, setDemoPlaying] = useState(false)
  useEffect(() => subscribeDemoState(setDemoPlaying), [])
  const main: Array<{ href: string; icon: ModuleIconName; title: string; desc: string; step: number }> = [
    { href: '#/insight', icon: 'observe', title: t('home.screen1.title'), desc: t('home.screen1.desc'), step: 1 },
    { href: '#/tunnel', icon: 'measure', title: t('home.screen2.title'), desc: t('home.screen2.desc'), step: 2 },
    { href: '#/evolution', icon: 'improve', title: t('home.screen3.title'), desc: t('home.screen3.desc'), step: 3 },
  ]
  const topics: Array<{ href: string; icon: ModuleIconName; tag: string; title: string; desc: string; live?: boolean }> = [
    { href: '#/security', icon: 'defend', tag: t('security.eyebrow'), title: t('home.screen4.title'), desc: t('home.screen4.desc') },
    { href: '#/legal', icon: 'comply', tag: t('legal.eyebrow'), title: t('home.screen5.title'), desc: t('home.screen5.desc') },
    { href: '#/playground', icon: 'evaluate', tag: t('playground.eyebrow'), title: t('home.playground.title'), desc: t('home.playground.desc'), live: true },
  ]

  return (
    <div className="page">
      <div className="home-hero">
        <h1>{t('home.hero.title')}</h1>
        <p>{t('home.hero.desc')}</p>
        <p className="faint">{t('home.hero.tagline')}</p>
        <div style={{ marginTop: 16 }}>
          <button
            className="primary demo-btn"
            style={{ padding: '8px 22px', fontSize: '14px' }}
            onClick={() => { if (isDemoPlaying()) stopDemo(); else startDemo() }}
          >
            {demoPlaying ? t('demo.stop') : t('demo.button')}
          </button>
        </div>

        <section className="home-section">
          <div className="home-section-head">
            <span className="home-section-no">1 · 2 · 3</span>
            <h2>{t('home.main.title')}</h2>
            <span className="faint">{t('home.main.sub')}</span>
          </div>
          <div className="home-main-cards">
            {main.map((card) => (
              <a key={card.href} className="panel home-main-card" href={card.href}>
                <div className="home-main-top">
                  <span className="home-main-step">{card.step}</span>
                  <span className="home-main-verb">{t(`home.step.${card.step}`)}</span>
                </div>
                <h4>{card.title}</h4>
                <p>{card.desc}</p>
                <span className="home-main-go">{t('home.open')} →</span>
              </a>
            ))}
          </div>
        </section>

        <section className="home-section">
          <div className="home-section-head">
            <h2>{t('home.topics.title')}</h2>
            <span className="faint">{t('home.topics.sub')}</span>
          </div>
          <div className="screen-cards home-topic-cards">
            {topics.map((card) => (
              <a key={card.href} className={`panel screen-card${card.live ? ' live' : ''}`} href={card.href}>
                <div className="screen-card-top">
                  <span className="screen-card-icon"><ModuleIcon name={card.icon} /></span>
                  <span className="screen-card-tag">{card.tag}</span>
                  <span className="screen-card-arrow" aria-hidden="true">→</span>
                </div>
                <h4>{card.title}</h4>
                <p>{card.desc}</p>
              </a>
            ))}
          </div>
        </section>

        <p className="faint" style={{ marginTop: 18 }}>
          {online ? t('home.status.ready') : t('home.status.offline')}
        </p>
      </div>
    </div>
  )
}
