// Provider settings — ported from docStudio client/src/components/Settings.tsx
// (LLM Providers tab only). 13 preset cards are always rendered (no add flow);
// order + expanded state persist in localStorage; provider configs persist via
// the server settings store (GET /api/settings, POST /api/settings/providers).
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { useT, useI18n, t as translate } from '../../i18n'
import { ScreenNav } from '../../components/ScreenNav'
import {
  PRESET_PROVIDERS,
  trimBaseUrl,
  type AppSettings,
  type ModelInfo,
  type ProviderConfig,
} from '../../../shared/provider'

interface FormProvider {
  providerId: string
  name: string
  enabled: boolean
  apiKey: string
  baseUrl: string
  modelIds: string[]
  defaultModelId: string
  modelFallbacks: string[]
  enableModelFallback: boolean
}

const PROVIDER_EXPANDED_KEY = 'docstudio-provider-expanded'
const PROVIDER_ORDER_KEY = 'docstudio-provider-order'

function loadExpandedState(): Record<string, boolean> {
  try {
    const saved = localStorage.getItem(PROVIDER_EXPANDED_KEY)
    if (saved) return JSON.parse(saved)
  } catch { /* ignore */ }
  return {}
}

function saveExpandedState(state: Record<string, boolean>) {
  try {
    localStorage.setItem(PROVIDER_EXPANDED_KEY, JSON.stringify(state))
  } catch { /* ignore */ }
}

function loadProviderOrder(): string[] {
  try {
    const saved = localStorage.getItem(PROVIDER_ORDER_KEY)
    if (saved) {
      const parsed = JSON.parse(saved)
      if (Array.isArray(parsed)) return parsed
    }
  } catch { /* ignore */ }
  return []
}

function saveProviderOrder(order: string[]) {
  try {
    localStorage.setItem(PROVIDER_ORDER_KEY, JSON.stringify(order))
  } catch { /* ignore */ }
}

let catalogCache: Record<string, ModelInfo[]> | null = null

function getModelMeta(providerId: string, modelId: string, catalog?: Record<string, ModelInfo[]>): ModelInfo | undefined {
  if (!catalog) return undefined
  return catalog[providerId]?.find((m) => m.id === modelId)
}

export default function Settings() {
  const t = useT()
  const { lang } = useI18n()
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [enableProviderFallback, setEnableProviderFallback] = useState(true)
  const [catalog, setCatalog] = useState<Record<string, ModelInfo[]>>({})
  const [formState, setFormState] = useState<Record<string, FormProvider>>({})
  const [loadingModels, setLoadingModels] = useState<string | null>(null)
  const [verifiedModels, setVerifiedModels] = useState<Record<string, Set<string>>>({})
  const [expandedProviders, setExpandedProviders] = useState<Record<string, boolean>>(loadExpandedState)
  const [providerOrder, setProviderOrder] = useState<string[]>(loadProviderOrder)
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const dragItem = useRef<{ providerId: string; index: number } | null>(null)
  const dragOverItem = useRef<{ providerId: string; index: number } | null>(null)
  const dragProviderItem = useRef<{ index: number } | null>(null)
  const dragProviderOver = useRef<{ index: number } | null>(null)

  const sortedProviders = [...PRESET_PROVIDERS].sort((a, b) => {
    const aIdx = providerOrder.indexOf(a.id)
    const bIdx = providerOrder.indexOf(b.id)
    if (aIdx === -1 && bIdx === -1) return 0
    if (aIdx === -1) return 1
    if (bIdx === -1) return -1
    return aIdx - bIdx
  })

  const showToast = (type: 'success' | 'error', message: string) => {
    setToast({ type, message })
    setTimeout(() => setToast(null), 2000)
  }

  const loadSettings = useCallback(async (quiet = false) => {
    try {
      const res = await api.settings()
      const list: ProviderConfig[] = []
      let fallback = true
      const all = res.settings['provider_all']
      if (all && typeof all === 'object') {
        const app = all as AppSettings
        list.push(...(app.providers ?? []))
        fallback = app.enableProviderFallback ?? true
      } else {
        for (const [key, value] of Object.entries(res.settings)) {
          if (key.startsWith('provider_') && key !== 'provider_all' && typeof value === 'object' && value !== null) {
            list.push(value as ProviderConfig)
          }
        }
      }
      setProviders(list)
      setEnableProviderFallback(fallback)
    } catch (e) {
      // Server offline: keep the empty form but say so (docStudio: store.error).
      if (!quiet) {
        const lang = useI18n.getState().lang
        showToast('error', translate('settings.llm.loadFailed', lang, { error: e instanceof Error ? e.message : String(e) }))
      }
    }
  }, [])

  useEffect(() => { void loadSettings() }, [loadSettings])

  useEffect(() => {
    let live = true
    api.modelCatalog()
      .then((r) => { if (live && r.ok) { catalogCache = r.catalog; setCatalog(r.catalog) } })
      .catch(() => { /* catalog is advisory only */ })
    return () => { live = false }
  }, [])

  useEffect(() => {
    const map: Record<string, FormProvider> = {}
    PRESET_PROVIDERS.forEach((p) => {
      const saved = providers.find((c) => c.providerId === p.id)
      map[p.id] = {
        providerId: p.id, name: p.name, enabled: saved?.enabled ?? false,
        apiKey: saved?.apiKey || saved?.apiKeyRef || '', baseUrl: saved?.baseUrl || p.defaultBaseUrl,
        modelIds: saved?.modelIds || [], defaultModelId: saved?.defaultModelId || '',
        modelFallbacks: saved?.modelFallbacks || [], enableModelFallback: saved?.enableModelFallback ?? false,
      }
    })
    providers.filter((c) => !PRESET_PROVIDERS.find((p) => p.id === c.providerId)).forEach((c) => {
      map[c.providerId] = {
        providerId: c.providerId, name: c.providerId, enabled: c.enabled,
        apiKey: c.apiKey || c.apiKeyRef || '', baseUrl: c.baseUrl || '',
        modelIds: c.modelIds || [], defaultModelId: c.defaultModelId || '',
        modelFallbacks: c.modelFallbacks || [], enableModelFallback: c.enableModelFallback ?? false,
      }
    })
    setFormState(map)
  }, [providers])

  const toggleExpanded = (providerId: string) => {
    setExpandedProviders((prev) => {
      const next = { ...prev, [providerId]: !prev[providerId] }
      saveExpandedState(next)
      return next
    })
  }

  const updateField = (id: string, field: keyof FormProvider, value: FormProvider[keyof FormProvider]) => {
    setFormState((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }))
  }

  const handleSelectDefault = (providerId: string, modelId: string) => {
    setFormState((prev) => {
      const current = prev[providerId]
      if (!current) return prev
      const fallbacks = (current.modelFallbacks ?? current.modelIds).filter((m) => m !== modelId)
      return {
        ...prev,
        [providerId]: { ...current, defaultModelId: modelId, modelFallbacks: [modelId, ...fallbacks] },
      }
    })
  }

  const handleDragStart = (providerId: string, index: number) => {
    dragItem.current = { providerId, index }
  }
  const handleDragEnd = () => {
    dragItem.current = null
    dragOverItem.current = null
  }
  const handleDragOver = (e: React.DragEvent, providerId: string, index: number) => {
    e.preventDefault()
    e.stopPropagation()
    dragOverItem.current = { providerId, index }
  }
  const handleDrop = (providerId: string) => {
    if (!dragItem.current || !dragOverItem.current) return
    if (dragItem.current.providerId !== providerId) return
    if (dragItem.current.index === dragOverItem.current.index) return
    const fromIndex = dragItem.current.index
    const toIndex = dragOverItem.current.index
    setFormState((prev) => {
      const current = prev[providerId]
      if (!current) return prev
      const list = [...(current.modelFallbacks ?? current.modelIds)]
      const [moved] = list.splice(fromIndex, 1)
      if (moved !== undefined) list.splice(toIndex, 0, moved)
      return { ...prev, [providerId]: { ...current, modelFallbacks: list } }
    })
    dragItem.current = null
    dragOverItem.current = null
  }

  const handleProviderDragStart = (index: number) => {
    dragProviderItem.current = { index }
  }
  const handleProviderDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    dragProviderOver.current = { index }
  }
  const handleProviderDrop = () => {
    if (!dragProviderItem.current || !dragProviderOver.current) return
    if (dragProviderItem.current.index === dragProviderOver.current.index) return
    const fromIndex = dragProviderItem.current.index
    const toIndex = dragProviderOver.current.index
    const newOrder = sortedProviders.map((p) => p.id)
    const [moved] = newOrder.splice(fromIndex, 1)
    if (moved !== undefined) newOrder.splice(toIndex, 0, moved)
    setProviderOrder(newOrder)
    saveProviderOrder(newOrder)
    const orderedFormState: Record<string, FormProvider> = {}
    for (const id of newOrder) {
      if (formState[id]) orderedFormState[id] = formState[id]
    }
    for (const [id, p] of Object.entries(formState)) {
      if (!orderedFormState[id]) orderedFormState[id] = p
    }
    setFormState(orderedFormState)
    dragProviderItem.current = null
    dragProviderOver.current = null
  }
  const handleProviderDragEnd = () => {
    dragProviderItem.current = null
    dragProviderOver.current = null
  }

  const buildSaveList = (): ProviderConfig[] =>
    sortedProviders.map((p) => {
      const c = formState[p.id]
      if (!c) return null
      return {
        providerId: c.providerId, enabled: c.enabled,
        apiKey: c.apiKey.trim(), apiKeyRef: c.apiKey.trim(),
        baseUrl: trimBaseUrl(c.baseUrl),
        modelIds: c.modelIds, defaultModelId: c.defaultModelId,
        modelFallbacks: c.modelFallbacks, enableModelFallback: c.enableModelFallback,
      }
    }).filter((p): p is NonNullable<typeof p> => p !== null)

  const handleSave = async () => {
    try {
      await api.settingsProviders(buildSaveList(), enableProviderFallback)
      showToast('success', t('settings.llm.saved'))
      await loadSettings(true)
    } catch (e) {
      showToast('error', t('settings.llm.saveFailed', { error: e instanceof Error ? e.message : String(e) }))
    }
  }

  const handleQueryModels = useCallback(async (providerId: string) => {
    const provider = formState[providerId]
    if (!provider?.apiKey) return
    setLoadingModels(providerId)
    setVerifiedModels((prev) => {
      const next = { ...prev }
      delete next[providerId]
      return next
    })
    try {
      const data = await api.queryModels(providerId, provider.apiKey, trimBaseUrl(provider.baseUrl))
      if (!data.ok) throw new Error(data.error || t('settings.llm.queryFailed'))
      const models: string[] = data.models || []
      const userDefaultId = provider.defaultModelId ?? ''
      const existingFallbacks = provider.modelFallbacks ?? []
      const modelSet = new Set(models)
      const mergedModels = userDefaultId && !modelSet.has(userDefaultId) ? [userDefaultId, ...models] : [...models]
      const preserved = existingFallbacks.filter((m) => mergedModels.includes(m))
      const preservedSet = new Set(preserved)
      const newModels = mergedModels.filter((m) => !preservedSet.has(m))
      const fallbacks = [...preserved, ...newModels]
      setFormState((prev) => {
        const current = prev[providerId]
        if (!current) return prev
        return {
          ...prev,
          [providerId]: {
            ...current,
            modelIds: mergedModels,
            defaultModelId: userDefaultId || models[0] || current.defaultModelId,
            modelFallbacks: fallbacks,
          },
        }
      })
      const verified = new Set<string>()
      const CONCURRENCY = 3
      const queue = [...models]
      const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () =>
        (async () => {
          while (queue.length > 0) {
            const modelId = queue.shift()
            if (!modelId) break
            try {
              const r = await api.verifyModel(providerId, provider.apiKey, trimBaseUrl(provider.baseUrl), modelId)
              if (r.ok) verified.add(modelId)
            } catch { /* per-model failure marks unverified */ }
          }
        })(),
      )
      await Promise.all(workers)
      setVerifiedModels((prev) => ({ ...prev, [providerId]: verified }))
      showToast('success', t('settings.llm.queried', { count: models.length }))
    } catch (e) {
      showToast('error', `${t('settings.llm.queryFailed')}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoadingModels(null)
    }
  }, [formState, t])

  return (
    <div className="page">
      <div className="screen-head">
        <span className="no">{t('settings.eyebrow')}</span>
        <h1>{t('settings.title')}</h1>
        <span className="q">{t('settings.subtitle')}</span>
      </div>
      <ScreenNav current="/settings" />
      {toast && (
        <div style={{
          position: 'fixed', top: 20, right: 20, zIndex: 50, padding: '10px 20px', borderRadius: 6,
          color: '#fff', fontSize: 14, background: toast.type === 'success' ? 'var(--green)' : 'var(--red)',
        }}>
          {toast.message}
        </div>
      )}
      <div className="panel">
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 4 }}>
          <h3 style={{ margin: 0 }}>{t('settings.llm.title')}</h3>
          <span style={{ flex: 1 }} />
          <button className="primary" style={{ padding: '3px 14px', fontSize: 12 }} onClick={() => void handleSave()}>{t('settings.llm.save')}</button>
        </div>
        <div className="faint" style={{ marginBottom: 12 }}>{t('settings.llm.desc')}</div>
        <div className="panel" style={{ marginBottom: 12 }}>
          <label className="faint" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <input
              type="checkbox"
              checked={enableProviderFallback}
              onChange={() => {
                const next = !enableProviderFallback
                setEnableProviderFallback(next)
                void api.settingsProviders(buildSaveList(), next).catch((e: unknown) => {
                  setEnableProviderFallback(!next)
                  showToast('error', t('settings.llm.saveFailed', { error: e instanceof Error ? e.message : String(e) }))
                })
              }}
            />
            <b style={{ color: 'var(--text)' }}>{t('settings.llm.enableFallback')}</b>
            {t('settings.llm.fallbackDesc')}
          </label>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {sortedProviders.map((preset, index) => {
            const c = formState[preset.id]
            if (!c) return null
            const isExpanded = expandedProviders[preset.id] ?? false
            const fallbackList = c.modelFallbacks ?? c.modelIds ?? []
            const isLoading = loadingModels === preset.id
            const modelMetaMap = new Map(
              fallbackList.map((id) => [id, getModelMeta(preset.id, id, catalogCache ?? catalog)]),
            )
            return (
              <div
                key={preset.id}
                className="panel"
                style={{ margin: 0, opacity: c.enabled ? undefined : 0.6 }}
                onDragOver={(e) => handleProviderDragOver(e, index)}
                onDrop={() => handleProviderDrop()}
              >
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', cursor: 'pointer' }}>
                  <span
                    draggable
                    onDragStart={() => handleProviderDragStart(index)}
                    onDragEnd={handleProviderDragEnd}
                    title={t('settings.llm.dragSort')}
                    style={{ cursor: 'grab', color: 'var(--text-faint)', userSelect: 'none' }}
                  >⋮⋮</span>
                  <button
                    type="button"
                    style={{ display: 'flex', gap: 8, alignItems: 'center', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: 0, fontSize: 14 }}
                    onClick={() => toggleExpanded(preset.id)}
                  >
                    <span style={{ fontSize: 11 }}>{isExpanded ? '▼' : '▶'}</span>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: c.enabled ? 'var(--green)' : 'var(--text-faint)', display: 'inline-block' }} />
                    <b>{lang === 'en' ? (preset.nameEn ?? preset.name) : preset.name}</b>
                    <span className="faint" style={{ fontSize: 12 }}>{lang === 'en' ? (preset.descEn ?? preset.desc) : preset.desc}</span>
                  </button>
                  <span style={{ flex: 1 }} />
                  <label className="faint" style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12 }} onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={c.enableModelFallback ?? false} onChange={(e) => updateField(c.providerId, 'enableModelFallback', e.target.checked)} />
                    {t('settings.llm.modelFallback')}
                  </label>
                  <label className="faint" style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12 }} onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={c.enabled} onChange={(e) => updateField(c.providerId, 'enabled', e.target.checked)} />
                    {t('settings.llm.enabled')}
                  </label>
                  {c.apiKey
                    ? <span className="src-badge src-live">{t('settings.llm.configured')}</span>
                    : <span className="src-badge src-fixture">{t('settings.llm.needKey')}</span>}
                  {c.modelIds.length > 0 && <span className="faint" style={{ fontSize: 12 }}>{t('settings.llm.models', { count: c.modelIds.length })}</span>}
                </div>
                {isExpanded && (
                  <div style={{ marginTop: 12, display: 'grid', gap: 12 }}>
                    <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                      <span className="faint">{t('settings.llm.apiKey')}</span>
                      <input type="password" value={c.apiKey} onChange={(e) => updateField(c.providerId, 'apiKey', e.target.value)} placeholder={preset.keyPlaceholder} autoComplete="off" />
                    </label>
                    <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                      <span className="faint">{t('settings.llm.baseUrl')}</span>
                      <input type="text" value={c.baseUrl} onChange={(e) => updateField(c.providerId, 'baseUrl', e.target.value)} placeholder={preset.defaultBaseUrl || 'https://api.example.com/v1'} />
                    </label>
                    {c.apiKey && (
                      <div>
                        <button
                          onClick={() => void handleQueryModels(c.providerId)}
                          disabled={isLoading}
                          className={isLoading ? '' : 'primary'}
                          style={{ padding: '3px 14px', fontSize: 12 }}
                        >{isLoading ? t('settings.llm.querying') : t('settings.llm.queryModels')}</button>
                      </div>
                    )}
                    {fallbackList.length > 0 && (
                      <div>
                        <div className="faint" style={{ marginBottom: 6, fontSize: 12 }}>{t('settings.llm.defaultModel')}</div>
                        <table className="t" style={{ width: '100%' }}>
                          <thead><tr>
                            <th style={{ width: 32 }}>#</th>
                            <th>{t('settings.modelId')}</th>
                            <th>{t('settings.llm.recommended')}</th>
                            <th>{t('settings.llm.quota')}</th>
                            <th style={{ width: 90 }}>{t('settings.llm.action')}</th>
                          </tr></thead>
                          <tbody>
                            {fallbackList.map((model, i) => {
                              const isDefault = model === c.defaultModelId
                              const meta = modelMetaMap.get(model)
                              const verified = verifiedModels[preset.id]
                              const isVerified = verified ? verified.has(model) : null
                              return (
                                <tr
                                  key={model}
                                  style={isDefault ? { background: 'rgba(59,91,219,.08)' } : undefined}
                                  onDragOver={(e) => handleDragOver(e, preset.id, i)}
                                  onDrop={(e) => { e.stopPropagation(); handleDrop(preset.id) }}
                                >
                                  <td>
                                    <span
                                      draggable
                                      onDragStart={() => handleDragStart(preset.id, i)}
                                      onDragEnd={handleDragEnd}
                                      title={t('settings.llm.dragSort')}
                                      style={{ cursor: 'grab', color: 'var(--text-faint)', userSelect: 'none' }}
                                    >⠿</span>
                                  </td>
                                  <td className="mono" style={{ fontSize: 12 }}>
                                    {model}
                                    {isDefault && <span className="src-badge src-live" style={{ marginLeft: 8 }}>{t('settings.llm.currentDefault')}</span>}
                                    {isVerified === true && <span style={{ color: 'var(--green)', marginLeft: 4 }} title={t('settings.llm.verifiedOk')}>✓</span>}
                                    {isVerified === false && <span style={{ color: 'var(--amber)', marginLeft: 4 }} title={t('settings.llm.verifyFailedTitle')}>⚠</span>}
                                    {isVerified === null && isLoading && <span className="faint" style={{ marginLeft: 4 }} title={t('settings.llm.verifyingTitle')}>⏳</span>}
                                  </td>
                                  <td style={{ color: 'var(--text-dim)', fontSize: 12 }}>{meta?.recommendation ?? '—'}</td>
                                  <td style={{ color: 'var(--text-dim)', fontSize: 12 }}>{meta ? `RPM ${meta.rpm ?? '?'} / RPD ${meta.rpd ?? '?'} / TPM ${meta.tpm ?? '?'}` : '—'}</td>
                                  <td>
                                    {!isDefault && (
                                      <button
                                        type="button"
                                        style={{ padding: '1px 8px', fontSize: 12 }}
                                        onClick={() => handleSelectDefault(c.providerId, model)}
                                      >{t('settings.llm.setDefault')}</button>
                                    )}
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <button className="primary" style={{ padding: '3px 14px', fontSize: 12 }} onClick={() => void handleSave()}>{t('settings.llm.save')}</button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
