// Card-scoped switch between the readings table and the trajectory readings.
// It lives in the card header so it never reads as a screen-wide filter.
import { useT } from '../i18n'

export type TunnelView = 'results' | 'trajectory'

export function TunnelViewToggle({ view, onView }: { view: TunnelView; onView: (view: TunnelView) => void }) {
  const t = useT()
  return (
    <div className="tunnel-view-toggle" data-demo="viewtoggle" role="group" aria-label={t('tunnel.view.scope')} title={t('tunnel.view.hint')}>
      <button
        type="button"
        className={view === 'results' ? 'active-btn' : ''}
        aria-pressed={view === 'results'}
        onClick={() => onView('results')}
      >{t('tunnel.view.results')}</button>
      <button
        type="button"
        className={view === 'trajectory' ? 'active-btn' : ''}
        aria-pressed={view === 'trajectory'}
        onClick={() => onView('trajectory')}
      >{t('tunnel.view.trajectory')}</button>
    </div>
  )
}
