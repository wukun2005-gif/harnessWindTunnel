import { useRef, useState, type DragEvent } from 'react'
import { api } from '../../api'
import { useT } from '../../i18n'

interface Props {
  onImported: () => void
}

interface Result {
  ok: boolean
  imported: string[]
  formats?: string[]
  skipped?: number
  error?: string
}

const ACCEPT = '.json,.jsonl,.txt'

/**
 * Live tab import entry point (design §10 M3 / §14). Accepts the hwt run
 * envelope plus the two mainstream trajectory shapes (Claude Code JSONL,
 * dsh JSON) and plain text, auto-detected by content.
 */
export function ImportBar({ onImported }: Props) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [paste, setPaste] = useState('')
  const [result, setResult] = useState<Result | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  async function sendText(text: string): Promise<Result> {
    setBusy(true)
    try {
      const r = await api.pgImport(text)
      setResult(r)
      if (r.imported.length > 0) onImported()
      return r
    } catch (err) {
      const r: Result = { ok: false, imported: [], error: (err as Error).message }
      setResult(r)
      return r
    } finally {
      setBusy(false)
    }
  }

  async function handleFiles(files: FileList | File[]) {
    const list = Array.from(files)
    if (list.length === 0) return
    setBusy(true)
    let total = 0
    let last: Result | null = null
    for (const file of list) {
      const text = await file.text()
      last = await sendText(text)
      total += last.imported.length
    }
    void total
    setBusy(false)
    if (last && last.imported.length > 0) onImported()
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(false)
    void handleFiles(e.dataTransfer.files)
  }

  return (
    <div className="pg-import">
      <button className="pg-import-btn" onClick={() => { setOpen((v) => !v); setResult(null) }}>
        {t('playground.import.button')}
      </button>

      {open && (
        <div className="pg-import-panel">
          <div
            className={`pg-dropzone${dragOver ? ' over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            <div className="pg-drop-title">{t('playground.import.dropTitle')}</div>
            <div className="pg-drop-sub">{t('playground.import.dropSub')}</div>
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              multiple
              style={{ display: 'none' }}
              onChange={(e) => { void handleFiles(e.target.files ?? []); e.target.value = '' }}
            />
            <button className="pg-pick-btn" onClick={() => fileRef.current?.click()} disabled={busy}>
              {busy ? t('playground.import.busy') : t('playground.import.choose')}
            </button>
          </div>

          <div className="pg-paste">
            <div className="pg-paste-label">{t('playground.import.pasteLabel')}</div>
            <textarea
              className="pg-paste-area"
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              placeholder={t('playground.import.pastePlaceholder')}
              rows={5}
            />
            <button
              className="pg-paste-btn"
              disabled={busy || !paste.trim()}
              onClick={() => { void sendText(paste); setPaste('') }}
            >
              {t('playground.import.pasteAction')}
            </button>
          </div>

          {result && (
            <div className={`pg-import-result ${result.ok && result.imported.length > 0 ? 'ok' : 'bad'}`}>
              {result.ok && result.imported.length > 0 ? (
                <>
                  {t('playground.import.ok', { n: result.imported.length })}
                  {result.formats?.length ? t('playground.import.formats', { formats: result.formats.join(' / ') }) : ''}
                  {result.skipped ? t('playground.import.skipped', { n: result.skipped }) : ''}
                  <div className="pg-import-hint">{t('playground.import.hint')}</div>
                </>
              ) : (
                <>{t('playground.import.failed', { error: result.error ?? t('playground.import.unknown') })}</>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
