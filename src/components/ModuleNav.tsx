import { useT } from '../i18n'

const MAIN = [
  { route: '/insight', labelKey: 'nav.mri', num: '01' },
  { route: '/tunnel', labelKey: 'nav.tunnel', num: '02' },
  { route: '/evolution', labelKey: 'nav.forge', num: '03' },
] as const

/** Side chambers: same method, different stakes. */
const TOPICS = [
  { route: '/security', labelKey: 'nav.security', num: '04' },
  { route: '/legal', labelKey: 'nav.legal', num: '05' },
  { route: '/playground', labelKey: 'nav.playground', num: '06' },
] as const

/** The six modules, always visible below the brand bar, grouped by intent. */
export function ModuleNav({ current }: { current: string }) {
  const t = useT()
  const item = (m: (typeof MAIN)[number] | (typeof TOPICS)[number]) => {
    const active = current === m.route
    return (
      <a
        key={m.route}
        href={`#${m.route}`}
        className={`module-nav-item ${active ? 'active' : ''}`}
        aria-current={active ? 'page' : undefined}
      >
        <span className="module-nav-num">{m.num}</span>
        <span>{t(m.labelKey)}</span>
      </a>
    )
  }
  return (
    <nav className="module-nav" aria-label={t('nav.modules')}>
      <span className="module-nav-group">{t('nav.mainLine')}</span>
      {MAIN.map(item)}
      <span className="module-nav-sep" aria-hidden="true" />
      <span className="module-nav-group">{t('nav.topics')}</span>
      {TOPICS.map(item)}
    </nav>
  )
}
