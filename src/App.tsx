import { useEffect, useState } from 'react'
import { useApp } from './stores'
import { useI18n, useT } from './i18n'
import MRI from './screens/MRI'
import WindTunnel from './screens/WindTunnel'
import Forge from './screens/Forge'
import Demo from './screens/Demo'
import Settings from './screens/Settings'
import Legal from './screens/Legal'
import Security from './screens/Security'

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
  '/demo': 'Demo Tour',
  '/legal': 'Legal',
  '/security': 'Security',
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
          <a href="#/" className="en" style={{ textDecoration: 'none' }}>HarnessWindTunnel</a>
        </div>
        <div className="spacer" />
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
          title="Switch language"
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
      ) : route === '/demo' ? (
        <Demo />
      ) : route === '/settings' ? (
        <Settings />
      ) : route === '/legal' ? (
        <Legal />
      ) : route === '/security' ? (
        <Security />
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
        <div className="screen-cards">
          <a className="panel screen-card" href="#/insight">
            <span className="no2">SCREEN 01</span>
            <h4>{t('home.screen1.title')}</h4>
            <p>{t('home.screen1.desc')}</p>
          </a>
          <a className="panel screen-card" href="#/tunnel">
            <span className="no2">SCREEN 02</span>
            <h4>{t('home.screen2.title')}</h4>
            <p>{t('home.screen2.desc')}</p>
          </a>
          <a className="panel screen-card" href="#/evolution">
            <span className="no2">SCREEN 03</span>
            <h4>{t('home.screen3.title')}</h4>
            <p>{t('home.screen3.desc')}</p>
          </a>
        </div>
        <p style={{ marginTop: 34 }}>
          <a className="primary" style={{ textDecoration: 'none', display: 'inline-block', padding: '9px 22px' }} href="#/demo">
            {t('home.demo.button')}
          </a>
        </p>
        <p className="faint" style={{ marginTop: 18 }}>
          {online ? t('home.status.ready') : t('home.status.offline')}
        </p>
      </div>
    </div>
  )
}
