import { useT } from '../i18n'

const SCREENS = [
  { route: '/insight', labelKey: 'nav.mri', num: '01' },
  { route: '/tunnel', labelKey: 'nav.tunnel', num: '02' },
  { route: '/evolution', labelKey: 'nav.forge', num: '03' },
  { route: '/demo', labelKey: 'nav.demo', num: '04' },
  { route: '/settings', labelKey: 'nav.settings', num: '05' },
] as const

export function ScreenNav({ current }: { current: string }) {
  const t = useT()
  return (
    <div className="screen-nav">
      {SCREENS.map((s) => (
        <a
          key={s.route}
          href={`#${s.route}`}
          className={`screen-nav-item ${current === s.route ? 'active' : ''}`}
        >
          <span className="screen-nav-num">{s.num}</span>
          {t(s.labelKey)}
        </a>
      ))}
    </div>
  )
}
