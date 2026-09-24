import { useEffect, useState } from 'react'
import { useApp } from './stores'
import { useI18n, useT } from './i18n'
import { startDemo, stopDemo, isDemoPlaying } from './demo/demo'
import MRI from './screens/MRI'
import WindTunnel from './screens/WindTunnel'
import Forge from './screens/Forge'
import Settings from './screens/Settings'
import Legal from './screens/Legal'
import Security from './screens/Security'
import Playground from './screens/Playground'

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

export default function App() {
  const route = useHashRoute()
  const { bootstrap, ready, online } = useApp()
  const { lang, setLang } = useI18n()
  const t = useT()
  useEffect(() => { void bootstrap() }, [bootstrap])

  const toggleLang = () => setLang(lang === 'en' ? 'zh' : 'en')

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <a href="#/" style={{ textDecoration: 'none', fontWeight: 700 }}>{t('app.brand.title')}</a>
        </div>
        <div className="spacer" />
        <button
          id="demo-btn"
          className="primary demo-btn"
          style={{ padding: '4px 12px', fontSize: '13px', marginRight: '8px' }}
          onClick={() => { if (isDemoPlaying()) stopDemo(); else startDemo() }}
        >
          {t('demo.button')}
        </button>
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
      </header>

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
    </div>
  )
}

function Home({ online }: { online: boolean }) {
  const t = useT()
  
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
            {t('demo.button')}
          </button>
        </div>
        <div className="screen-cards">
          <a className="panel screen-card" href="#/insight">
            <span className="no2">{t('mri.eyebrow')}</span>
            <h4>{t('home.screen1.title')}</h4>
            <p>{t('home.screen1.desc')}</p>
          </a>
          <a className="panel screen-card" href="#/tunnel">
            <span className="no2">{t('tunnel.eyebrow')}</span>
            <h4>{t('home.screen2.title')}</h4>
            <p>{t('home.screen2.desc')}</p>
          </a>
          <a className="panel screen-card" href="#/evolution">
            <span className="no2">{t('forge.eyebrow')}</span>
            <h4>{t('home.screen3.title')}</h4>
            <p>{t('home.screen3.desc')}</p>
          </a>
          <a className="panel screen-card" href="#/security">
            <span className="no2">{t('security.eyebrow')}</span>
            <h4>{t('home.screen4.title')}</h4>
            <p>{t('home.screen4.desc')}</p>
          </a>
          <a className="panel screen-card" href="#/legal">
            <span className="no2">{t('legal.eyebrow')}</span>
            <h4>{t('home.screen5.title')}</h4>
            <p>{t('home.screen5.desc')}</p>
          </a>
          <a className="panel screen-card" href="#/playground" style={{ borderColor: 'rgba(120,120,255,0.5)' }}>
            <span className="no2">LIVE</span>
            <h4>{t('home.playground.title')}</h4>
            <p>{t('home.playground.desc')}</p>
          </a>
        </div>
        <p className="faint" style={{ marginTop: 18 }}>
          {online ? t('home.status.ready') : t('home.status.offline')}
        </p>
      </div>
    </div>
  )
}
