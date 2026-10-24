import { useEffect } from 'react'
import { useT } from '../i18n'

const GROUPS = [
  { key: 'core', terms: ['harness', 'model', 'task', 'run', 'variant', 'ablation'] },
  { key: 'metrics', terms: ['asr', 'utility', 'friction', 'pareto', 'tokens'] },
  { key: 'evolution', terms: ['evidence', 'falsification', 'gate', 'rollback', 'heldout'] },
  { key: 'eval', terms: ['decision', 'splits', 'trap', 'fixture', 'jev', 'controls', 'killchain'] },
] as const

/** A single plain-language glossary, reachable from every screen. */
export function Glossary({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="glossary-backdrop" role="presentation" onClick={onClose}>
      <aside
        className="glossary-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={t('glossary.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="glossary-head">
          <div>
            <h3>{t('glossary.title')}</h3>
            <p className="faint">{t('glossary.intro')}</p>
          </div>
          <button type="button" className="glossary-close" onClick={onClose} aria-label={t('glossary.close')}>
            ✕
          </button>
        </header>
        <div className="glossary-body">
          {GROUPS.map((group) => (
            <section className="glossary-group" key={group.key}>
              <h4>{t(`glossary.group.${group.key}`)}</h4>
              <dl>
                {group.terms.map((term) => (
                  <div className="glossary-item" key={term}>
                    <dt>{t(`glossary.${term}.term`)}</dt>
                    <dd>{t(`glossary.${term}.def`)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </aside>
    </div>
  )
}
