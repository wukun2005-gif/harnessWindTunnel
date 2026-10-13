import type { PgDomain, PgPresetId, RunsQuery } from '../../../shared/playground'
import { MAST_LABEL, type MastTag } from '../../../shared/mast'

const MAST_TAGS = Object.keys(MAST_LABEL) as MastTag[]

interface Props {
  filters: RunsQuery
  setFilters: (q: RunsQuery) => void
  resultCount: number
}

/**
 * Full search / review form for the live run list (design §10 M3). The backend
 * list filters are already wired; this only builds the query. "Source" covers
 * live vs imported; imported runs still show but stay out of the aggregates.
 */
export function SearchBar({ filters, setFilters, resultCount }: Props) {
  const set = (patch: Partial<RunsQuery>) => setFilters({ ...filters, ...patch })

  return (
    <div className="pg-search">
      <div className="pg-search-grid">
        <label className="pg-field">
          <span>Domain</span>
          <select value={filters.domain ?? ''} onChange={(e) => set({ domain: (e.target.value || undefined) as PgDomain | undefined })}>
            <option value="">All</option>
            <option value="general">General</option>
            <option value="legal">Legal</option>
            <option value="security">Security</option>
          </select>
        </label>

        <label className="pg-field">
          <span>Source</span>
          <select value={filters.source ?? ''} onChange={(e) => set({ source: (e.target.value || undefined) as RunsQuery['source'] })}>
            <option value="">All</option>
            <option value="live">live</option>
            <option value="imported">imported</option>
          </select>
        </label>

        <label className="pg-field">
          <span>Status</span>
          <select value={filters.status ?? ''} onChange={(e) => set({ status: (e.target.value || undefined) as RunsQuery['status'] })}>
            <option value="">All</option>
            <option value="queued">queued</option>
            <option value="running">running</option>
            <option value="scored">scored</option>
            <option value="error">error</option>
          </select>
        </label>

        <label className="pg-field">
          <span>Failure tag</span>
          <select value={filters.tag ?? ''} onChange={(e) => set({ tag: (e.target.value || undefined) as MastTag | undefined })}>
            <option value="">All</option>
            {MAST_TAGS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>

        <label className="pg-field">
          <span>Model</span>
          <input
            type="text"
            value={filters.model ?? ''}
            placeholder="e.g. gpt-4o"
            onChange={(e) => set({ model: e.target.value || undefined })}
          />
        </label>

        <label className="pg-field">
          <span>Preset</span>
          <input
            type="text"
            value={filters.presetId ?? ''}
            placeholder="e.g. C0"
            onChange={(e) => set({ presetId: (e.target.value || undefined) as PgPresetId | undefined })}
          />
        </label>

        <label className="pg-field">
          <span>From</span>
          <input
            type="datetime-local"
            onChange={(e) => set({ from: e.target.value ? new Date(e.target.value).toISOString() : undefined })}
          />
        </label>

        <label className="pg-field">
          <span>To</span>
          <input
            type="datetime-local"
            onChange={(e) => set({ to: e.target.value ? new Date(e.target.value).toISOString() : undefined })}
          />
        </label>
      </div>

      <div className="pg-search-foot">
        <span className="pg-search-count">{resultCount} run(s)</span>
        <button
          className="pg-search-clear"
          onClick={() => setFilters({ limit: 400 })}
        >
          Clear filters
        </button>
      </div>
    </div>
  )
}
