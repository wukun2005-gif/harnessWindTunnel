import { useRef, useState, type DragEvent } from 'react'
import { api } from '../../api'

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
        ⤓ Import trajectory
      </button>

      {open && (
        <div className="pg-import-panel">
          <div
            className={`pg-dropzone${dragOver ? ' over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            <div className="pg-drop-title">Drop a trajectory file, or click to choose</div>
            <div className="pg-drop-sub">.json / .jsonl / .txt — the format is detected automatically</div>
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              multiple
              style={{ display: 'none' }}
              onChange={(e) => { void handleFiles(e.target.files ?? []); e.target.value = '' }}
            />
            <button className="pg-pick-btn" onClick={() => fileRef.current?.click()} disabled={busy}>
              {busy ? 'Importing…' : 'Choose file'}
            </button>
          </div>

          <div className="pg-paste">
            <div className="pg-paste-label">Or paste the text directly</div>
            <textarea
              className="pg-paste-area"
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              placeholder="hwt JSON envelope / JSONL (one JSON per line) / dsh JSON / plain text"
              rows={5}
            />
            <button
              className="pg-paste-btn"
              disabled={busy || !paste.trim()}
              onClick={() => { void sendText(paste); setPaste('') }}
            >
              Import pasted text
            </button>
          </div>

          {result && (
            <div className={`pg-import-result ${result.ok && result.imported.length > 0 ? 'ok' : 'bad'}`}>
              {result.ok && result.imported.length > 0 ? (
                <>
                  Imported {result.imported.length} run(s)
                  {result.formats?.length ? ` · formats ${result.formats.join(' / ')}` : ''}
                  {result.skipped ? ` · skipped ${result.skipped} line(s)` : ''}
                  <div className="pg-import-hint">Imported trajectories stay out of the statistics by default; link them to an eval task in the detail view and re-score to include them.</div>
                </>
              ) : (
                <>Import failed: {result.error ?? 'unknown error'}</>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
