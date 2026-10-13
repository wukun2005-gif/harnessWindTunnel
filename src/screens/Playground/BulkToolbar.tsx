import { api } from '../../api'

interface Props {
  selected: string[]
  onClear: () => void
  onChanged: () => void
}

/**
 * Bulk action bar shown once ≥1 run is selected in the result matrix (design
 * §10 M3 / §14). Multi-run export, plus single-at-a-time deletion (bulk wipe
 * is intentionally not offered: it could remove the C0 reference that every
 * lift is computed against).
 */
export function BulkToolbar({ selected, onClear, onChanged }: Props) {
  if (selected.length === 0) return null
  const ids = selected.join(',')

  async function deleteAll() {
    for (const id of selected) {
      try {
        await api.pgDeleteRun(id)
      } catch {
        /* a run may be in-flight; leave it */
      }
    }
    onClear()
    onChanged()
  }

  return (
    <div className="pg-bulk">
      <span className="pg-bulk-n">{selected.length} selected</span>
      <a className="pg-bulk-link" href={api.pgExportUrl(ids, 'json')} download>Export JSON</a>
      <a className="pg-bulk-link" href={api.pgExportUrl(ids, 'jsonl')} download>Export JSONL</a>
      <a className="pg-bulk-link" href={api.pgExportUrl(ids, 'txt')} download>Export TXT</a>
      <button className="pg-bulk-del" onClick={() => void deleteAll()}>Delete one by one</button>
      <button className="pg-bulk-clear" onClick={onClear}>Clear selection</button>
    </div>
  )
}
