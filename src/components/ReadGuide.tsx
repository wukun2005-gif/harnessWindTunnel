import { useT } from '../i18n'

/** Numbered "how to read this screen" line shown under the page title. */
export function ReadGuide({ keys }: { keys: string[] }) {
  const t = useT()
  return (
    <div className="read-guide">
      <span className="rg-label">{t('guide.label')}</span>
      {keys.map((key, i) => (
        <span className="rg-item" key={key}>
          <i>{i + 1}</i>
          {t(key)}
        </span>
      ))}
    </div>
  )
}
