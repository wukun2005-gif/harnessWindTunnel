import { useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { useT } from '../../i18n'
import { ScreenNav } from '../../components/ScreenNav'
import {
  CUSTOM_PRESET_ID,
  VENDOR_PRESETS,
  blankConnection,
  customPreset,
  trimBaseUrl,
  type ProviderConnection,
  type VendorPreset,
} from '../../../shared/provider'

const STORE_KEY = 'harness-wind-tunnel-providers'

function loadStored(): ProviderConnection[] {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as ProviderConnection[]
    if (!Array.isArray(arr)) return []
    return arr.filter((c) => c && typeof c.id === 'string' && typeof c.baseUrl === 'string' && Array.isArray(c.models))
  } catch {
    return []
  }
}

export default function Settings() {
  const t = useT()
  const [conns, setConns] = useState<ProviderConnection[]>(loadStored)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(conns))
    } catch { /* private mode: keep memory-only */ }
  }, [conns])

  const patch = (id: string, fn: (c: ProviderConnection) => ProviderConnection) =>
    setConns((cs) => cs.map((c) => (c.id === id ? fn({ ...c }) : c)))
  const move = (id: string, dir: -1 | 1) =>
    setConns((cs) => {
      const i = cs.findIndex((c) => c.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= cs.length) return cs
      const next = [...cs]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })

  const addVendor = (v: VendorPreset) => {
    if (conns.some((c) => c.vendorId === v.id && v.id !== CUSTOM_PRESET_ID)) return
    setConns((cs) => [...cs, blankConnection(v, cs.length)])
  }
  const addCustom = () => {
    setConns((cs) => [...cs, blankConnection(customPreset('https://your-gateway.example/v1'), cs.length)])
    setNotice(t('settings.custom.hint'))
  }

  const missing = VENDOR_PRESETS.filter((v) => !conns.some((c) => c.vendorId === v.id))

  return (
    <div className="page">
      <div className="screen-head">
        <span className="no">SETTINGS</span>
        <h1>{t('settings.title')}</h1>
        <span className="q">{t('settings.subtitle')}</span>
      </div>
      <ScreenNav current="/settings" />
      <div className="panel">
        <h3>{t('settings.add.title')}</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {missing.map((v) => (
            <button key={v.id} style={{ padding: '2px 10px', fontSize: 12 }} onClick={() => addVendor(v)}>+ {v.name}</button>
          ))}
          <button style={{ padding: '2px 10px', fontSize: 12 }} onClick={addCustom}>+ {t('settings.add.custom')}</button>
        </div>
        {notice && <div className="faint" style={{ marginTop: 6 }}>{notice}</div>}
      </div>
      {conns.length === 0 && <div className="panel"><div className="faint">{t('settings.empty')}</div></div>}
      {conns.map((c) => (
        <ProviderCard key={c.id} conn={c} patch={patch} move={move} remove={(id) => setConns((cs) => cs.filter((x) => x.id !== id))} />
      ))}
      <p className="faint" style={{ marginTop: 12 }}>{t('settings.isolation.note')}</p>
    </div>
  )
}

function ProviderCard({ conn, patch, move, remove }: {
  conn: ProviderConnection
  patch: (id: string, fn: (c: ProviderConnection) => ProviderConnection) => void
  move: (id: string, dir: -1 | 1) => void
  remove: (id: string) => void
}) {
  const t = useT()
  const [key, setKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(conn.baseUrl)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState(false)
  const [newModel, setNewModel] = useState('')
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => { setBaseUrl(conn.baseUrl) }, [conn.id, conn.baseUrl])

  const configured = conn.apiKeyRef !== null && conn.baseUrl !== ''

  const save = async () => {
    setBusy(true)
    setMsg(null)
    setErr(false)
    try {
      const url = trimBaseUrl(baseUrl)
      patch(conn.id, (c) => ({ ...c, baseUrl: url }))
      if (key) {
        const r = await api.providerKey(conn.id, key)
        patch(conn.id, (c) => ({ ...c, apiKeyRef: r.ref }))
        setKey('')
      } else if (!conn.apiKeyRef) {
        patch(conn.id, (c) => ({ ...c, apiKeyRef: null }))
      }
      if (mounted.current) setMsg(t('settings.saved'))
    } catch (e) {
      if (mounted.current) {
        setErr(true)
        setMsg(t('settings.save.error', { error: e instanceof Error ? e.message : String(e) }))
      }
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const refreshModels = async () => {
    setBusy(true)
    setMsg(null)
    setErr(false)
    try {
      const r = await api.providerModels(trimBaseUrl(baseUrl))
      const merged = [...new Set([...conn.models, ...r.models])]
      patch(conn.id, (c) => ({
        ...c,
        models: merged,
        defaultModel: merged.includes(c.defaultModel) ? c.defaultModel : (merged[0] ?? ''),
        fallback: merged.filter((m) => m !== (merged.includes(c.defaultModel) ? c.defaultModel : merged[0])),
      }))
      if (mounted.current) setMsg(t('settings.models.ok', { n: r.models.length }) + (r.simulated ? ` ${t('settings.simulated')}` : ''))
    } catch (e) {
      if (mounted.current) {
        setErr(true)
        setMsg(t('settings.models.error', { error: e instanceof Error ? e.message : String(e) }))
      }
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const moveModel = (m: string, dir: -1 | 1) =>
    patch(conn.id, (c) => {
      const fb = [...c.fallback]
      const i = fb.indexOf(m)
      const j = i + dir
      if (i < 0 || j < 0 || j >= fb.length) return c
      ;[fb[i], fb[j]] = [fb[j], fb[i]]
      return { ...c, fallback: fb }
    })

  return (
    <div className="panel" style={{ opacity: conn.enabled ? undefined : 0.65 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <b>{conn.name}</b>
        {configured
          ? <span className="src-badge src-live">{t('settings.configured')}</span>
          : <span className="src-badge src-fixture">{t('settings.unconfigured')}</span>}
        <span style={{ flex: 1 }} />
        <label className="faint" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <input type="checkbox" checked={conn.enabled} onChange={(e) => patch(conn.id, (c) => ({ ...c, enabled: e.target.checked }))} />
          {t('settings.enabled')}
        </label>
        <button style={{ padding: '1px 8px', fontSize: 12 }} onClick={() => move(conn.id, -1)}>↑</button>
        <button style={{ padding: '1px 8px', fontSize: 12 }} onClick={() => move(conn.id, 1)}>↓</button>
        <button style={{ padding: '1px 8px', fontSize: 12 }} onClick={() => patch(conn.id, (c) => ({ ...c, collapsed: !c.collapsed }))}>
          {conn.collapsed ? t('settings.expand') : t('settings.collapse')}
        </button>
        {conn.vendorId === CUSTOM_PRESET_ID && (
          <button className="danger" style={{ padding: '1px 8px', fontSize: 12 }} onClick={() => remove(conn.id)}>✕</button>
        )}
      </div>
      {!conn.collapsed && (
        <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
          <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
            <span className="faint">{t('settings.baseurl')}</span>
            <input type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…" />
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
            <span className="faint">{t('settings.apikey', { ref: conn.apiKeyRef ?? t('settings.apikey.none') })}</span>
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={t('settings.apikey.placeholder')} autoComplete="off" />
          </label>
          <div>
            <div className="faint" style={{ marginBottom: 4 }}>{t('settings.models')}</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {conn.models.map((m) => (
                <label key={m} style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center', border: '1px solid var(--border)', borderRadius: 8, padding: '2px 8px' }}>
                  <input
                    type="checkbox"
                    checked
                    onChange={() => patch(conn.id, (c) => {
                      const models = c.models.filter((x) => x !== m)
                      return {
                        ...c,
                        models,
                        defaultModel: c.defaultModel === m ? (models[0] ?? '') : c.defaultModel,
                        fallback: c.fallback.filter((x) => x !== m),
                      }
                    })}
                  />{m}
                </label>
              ))}
              <input
                type="text" value={newModel} onChange={(e) => setNewModel(e.target.value)} placeholder={t('settings.models.add')}
                style={{ fontSize: 12, width: 160 }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newModel.trim()) {
                    const m = newModel.trim()
                    setNewModel('')
                    patch(conn.id, (c) => (c.models.includes(m) ? c : { ...c, models: [...c.models, m], fallback: [...c.fallback, m] }))
                  }
                }}
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 }}>
            <span className="faint">{t('settings.default')}</span>
            <select value={conn.defaultModel} onChange={(e) => patch(conn.id, (c) => ({ ...c, defaultModel: e.target.value, fallback: c.models.filter((x) => x !== e.target.value) }))}>
              {conn.models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <span className="faint">{t('settings.fallback')}</span>
            {conn.fallback.map((m) => (
              <span key={m} style={{ display: 'inline-flex', gap: 2, alignItems: 'center', border: '1px solid var(--border)', borderRadius: 8, padding: '1px 4px 1px 8px' }}>
                {m}
                <button style={{ padding: '0 5px', fontSize: 11 }} onClick={() => moveModel(m, -1)}>↑</button>
                <button style={{ padding: '0 5px', fontSize: 11 }} onClick={() => moveModel(m, 1)}>↓</button>
                <button className="danger" style={{ padding: '0 5px', fontSize: 11 }} onClick={() => patch(conn.id, (c) => ({ ...c, fallback: c.fallback.filter((x) => x !== m) }))}>✕</button>
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="primary" disabled={busy} style={{ padding: '3px 14px', fontSize: 12 }} onClick={() => void save()}>{t('settings.save')}</button>
            <button disabled={busy} style={{ padding: '3px 14px', fontSize: 12 }} onClick={() => void refreshModels()}>{t('settings.verify')}</button>
          </div>
          {msg && <div style={{ color: err ? 'var(--red)' : 'var(--green)', fontSize: 12 }}>{msg}</div>}
        </div>
      )}
    </div>
  )
}
