// Provider settings — ported from docStudio client/src/components/Settings.tsx
// (LLM Providers tab only). 15 preset cards are always rendered (no add flow): the
// 大模型 Provider tab shows the 13 chat cards, the 判定模型 Provider tab shows the two
// Jev decision cards (TypeSafe / OpenCode), which run alongside a chat model. Order +
// expanded state persist in localStorage; provider configs persist via the server
// settings store (GET /api/settings, POST /api/settings/providers).
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { useT, useI18n, t as translate } from '../../i18n'
import {
  PRESET_PROVIDERS,
  isDecisionProvider,
  trimBaseUrl,
  type AppSettings,
  type ModelInfo,
  type ProviderConfig,
} from '../../../shared/provider'
import { PRESET_KNOWLEDGE_PROVIDERS, ACCEPTED_KNOWLEDGE_FORMATS } from '../../../shared/knowledge'
import { PRESET_SEARCH_PROVIDERS, type RetrievalSettingsView, type SearchProviderId } from '../../../shared/search'
import type { JevSettingsPatch, JevSettingsView } from '../../../shared/jev'

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
  const [tab, setTab] = useState<'llm' | 'decision' | 'knowledge' | 'search'>(() => {
    try {
      const saved = localStorage.getItem('hwt-settings-tab')
      if (saved === 'knowledge' || saved === 'search' || saved === 'decision' || saved === 'llm') return saved
    } catch { /* ignore */ }
    return 'llm'
  })
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [enableProviderFallback, setEnableProviderFallback] = useState(true)
  const [enableDecisionFallback, setEnableDecisionFallback] = useState(true)
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
      let decisionFallback = true
      const all = res.settings['provider_all']
      if (all && typeof all === 'object') {
        const app = all as AppSettings
        list.push(...(app.providers ?? []))
        fallback = app.enableProviderFallback ?? true
        decisionFallback = app.enableDecisionProviderFallback ?? true
      } else {
        for (const [key, value] of Object.entries(res.settings)) {
          if (key.startsWith('provider_') && key !== 'provider_all' && typeof value === 'object' && value !== null) {
            list.push(value as ProviderConfig)
          }
        }
      }
      setProviders(list)
      setEnableProviderFallback(fallback)
      setEnableDecisionFallback(decisionFallback)
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
      await api.settingsProviders(buildSaveList(), {
        enableProviderFallback,
        enableDecisionProviderFallback: enableDecisionFallback,
      })
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

  const switchTab = (next: 'llm' | 'decision' | 'knowledge' | 'search') => {
    setTab(next)
    try { localStorage.setItem('hwt-settings-tab', next) } catch { /* ignore */ }
  }

  return (
    <div className="page">
      <div className="screen-head">
        <span className="no">{t('settings.eyebrow')}</span>
        <h1>{t('settings.title')}</h1>
        <span className="q">{t('settings.subtitle')}</span>
      </div>
      {toast && (
        <div style={{
          position: 'fixed', top: 20, right: 20, zIndex: 50, padding: '10px 20px', borderRadius: 6,
          color: '#fff', fontSize: 14, background: toast.type === 'success' ? 'var(--green)' : 'var(--red)',
        }}>
          {toast.message}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {(['llm', 'decision', 'knowledge', 'search'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => switchTab(k)}
            className={tab === k ? 'primary' : ''}
            style={{ padding: '4px 14px', fontSize: 12 }}
          >{t(`settings.tabs.${k}`)}</button>
        ))}
      </div>
      {tab === 'knowledge' && <KnowledgeTab />}
      {tab === 'search' && <SearchTab />}
      {(tab === 'llm' || tab === 'decision') && (
      <div className="panel">
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 4 }}>
          <h3 style={{ margin: 0 }}>{tab === 'decision' ? t('settings.decision.title') : t('settings.llm.title')}</h3>
          <span style={{ flex: 1 }} />
          <button className="primary" style={{ padding: '3px 14px', fontSize: 12 }} onClick={() => void handleSave()}>{t('settings.llm.save')}</button>
        </div>
        <div className="faint" style={{ marginBottom: 12 }}>{tab === 'decision' ? t('settings.decision.desc') : t('settings.llm.desc')}</div>
        {tab === 'llm' && (
        <div className="panel" style={{ marginBottom: 12 }}>
          <label className="faint" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <input
              type="checkbox"
              checked={enableProviderFallback}
              onChange={() => {
                const next = !enableProviderFallback
                setEnableProviderFallback(next)
                void api.settingsProviders(buildSaveList(), {
                  enableProviderFallback: next,
                  enableDecisionProviderFallback: enableDecisionFallback,
                }).catch((e: unknown) => {
                  setEnableProviderFallback(!next)
                  showToast('error', t('settings.llm.saveFailed', { error: e instanceof Error ? e.message : String(e) }))
                })
              }}
            />
            <b style={{ color: 'var(--text)' }}>{t('settings.llm.enableFallback')}</b>
            {t('settings.llm.fallbackDesc')}
          </label>
        </div>
        )}
        {tab === 'decision' && (
        <div className="panel" style={{ marginBottom: 12 }}>
          <label className="faint" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <input
              type="checkbox"
              checked={enableDecisionFallback}
              onChange={() => {
                const next = !enableDecisionFallback
                setEnableDecisionFallback(next)
                void api.settingsProviders(buildSaveList(), {
                  enableProviderFallback,
                  enableDecisionProviderFallback: next,
                }).catch((e: unknown) => {
                  setEnableDecisionFallback(!next)
                  showToast('error', t('settings.llm.saveFailed', { error: e instanceof Error ? e.message : String(e) }))
                })
              }}
            />
            <b style={{ color: 'var(--text)' }}>{t('settings.llm.enableFallback')}</b>
            {t('settings.llm.fallbackDesc')}
          </label>
        </div>
        )}
        {tab === 'decision' && <JevGlobalSetting />}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {sortedProviders
            .map((preset, index) => ({ preset, index }))
            .filter(({ preset }) => (tab === 'decision' ? isDecisionProvider(preset.id) : !isDecisionProvider(preset.id)))
            .map(({ preset, index }) => {
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
                    {preset.kind === 'decision' && tab !== 'decision' && (
                      <span className="src-badge src-fixture" title="判定模型：与主 chat 模型可同时启用，不走 /chat/completions">
                        判定模型
                      </span>
                    )}
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
                    {preset.kind === 'decision' && <JevThresholdSetting />}
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
      )}
    </div>
  )
}

// ── Knowledge base tab (ported from patentExaminator KnowledgeConfigPanel) ──

// 判定模型 tab 全局 Jev 开关（与实况风洞屏读写同一份全局设置）：启用 + 低置信回落主模型。
// 阈值仍在下方判定卡展开处配；判定卡行上的「启用」勾选只定判定目标主次，不拦 Jev。
function JevGlobalSetting() {
  const t = useT()
  const [view, setView] = useState<JevSettingsView | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api
      .pgJevSettings()
      .then((r) => {
        if (live) setView(r.settings)
      })
      .catch(() => {
        if (live) setErr(t('playground.jev.loadFail'))
      })
    return () => {
      live = false
    }
  }, [t])

  const patch = (p: JevSettingsPatch) => {
    setErr(null)
    api
      .pgSaveJevSettings(p)
      .then((r) => setView(r.settings))
      .catch((e: unknown) => setErr(t('playground.jev.saveFail', { error: e instanceof Error ? e.message : String(e) })))
  }

  return (
    <div className="panel" style={{ marginBottom: 12, display: 'grid', gap: 8 }}>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={view?.enabled ?? false}
          disabled={view == null}
          onChange={(e) => patch({ enabled: e.target.checked })}
        />
        <b style={{ color: 'var(--text)' }}>{t('playground.jev.enable')}</b>
        <span className="faint">{t('playground.jev.enableDesc')}</span>
      </label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={view?.cascadeToChatJudge ?? false}
          disabled={view == null}
          onChange={(e) => patch({ cascadeToChatJudge: e.target.checked })}
        />
        <b style={{ color: 'var(--text)' }}>{t('playground.jev.cascade')}</b>
        <span className="faint">{t('playground.jev.cascadeDesc')}</span>
      </label>
      {err && <span style={{ color: 'var(--red)', fontSize: 12 }}>{err}</span>}
    </div>
  )
}

// Jev 判定卡专属：置信阈值（0.5–0.99）。与本页签顶部的全局开关读同一来源（playground_jev 行）。
function JevThresholdSetting() {
  const t = useT()
  const [value, setValue] = useState<number | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api
      .pgJevSettings()
      .then((r) => {
        if (live) setValue(r.settings.confidenceThreshold)
      })
      .catch(() => {
        if (live) setErr(t('playground.jev.loadFail'))
      })
    return () => {
      live = false
    }
  }, [t])

  const shown = text ?? (value == null ? '' : String(value))
  const commit = () => {
    if (value == null) {
      setText(null)
      return
    }
    const v = Number(shown)
    if (!Number.isFinite(v)) {
      setText(null)
      return
    }
    const clamped = Math.min(0.99, Math.max(0.5, v))
    setText(null)
    if (clamped === value) return
    setSaving(true)
    setErr(null)
    api
      .pgSaveJevSettings({ confidenceThreshold: clamped })
      .then((r) => setValue(r.settings.confidenceThreshold))
      .catch((e: unknown) => setErr(t('playground.jev.saveFail', { error: e instanceof Error ? e.message : String(e) })))
      .finally(() => setSaving(false))
  }

  return (
    <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
      <span className="faint">{t('playground.jev.threshold')} (0.5–0.99)</span>
      <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          type="number"
          min={0.5}
          max={0.99}
          step={0.05}
          value={shown}
          disabled={saving || value == null}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          style={{ width: 100 }}
        />
        {saving && <span className="faint">…</span>}
        {err && <span style={{ color: 'var(--red)' }}>{err}</span>}
      </span>
    </label>
  )
}

interface SourceInfo {
  id: string
  name: string
  type: string
  format: string
  mediaType: string
  size: number
  fileHash: string | null
  sourceUrl: string | null
  chunkCount: number
  embedStatus: string
  createdAt: string
}

function KnowledgeTab() {
  const t = useT()
  const [view, setView] = useState<RetrievalSettingsView | null>(null)
  const [sources, setSources] = useState<SourceInfo[]>([])
  const [stats, setStats] = useState({ sourceCount: 0, chunkCount: 0, embeddedCount: 0 })
  const [urlInput, setUrlInput] = useState('')
  const [testQuery, setTestQuery] = useState('')
  const [testResults, setTestResults] = useState('')
  const [importResult, setImportResult] = useState<string | null>(null)
  const [importProgress, setImportProgress] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [searching, setSearching] = useState(false)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [previewChunks, setPreviewChunks] = useState<Array<{ id: string; index: number; text: string }>>([])
  const [toast, setToast] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      const [v, s, st] = await Promise.all([api.retrievalSettings(), api.knowledgeSources(), api.knowledgeStats()])
      setView(v.settings)
      if (s.ok) setSources(s.sources)
      if (st.ok) setStats({ sourceCount: st.sourceCount, chunkCount: st.chunkCount, embeddedCount: st.embeddedCount })
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 2500)
    return () => clearTimeout(timer)
  }, [toast])

  const saveKnowledge = async (patch: { enabled?: boolean; topK?: number; scoreThreshold?: number }) => {
    try {
      const r = await api.saveRetrievalSettings({ knowledge: patch })
      setView(r.settings)
      setToast(t('settings.kb.saved'))
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e))
    }
  }

  const uploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setImporting(true)
    setImportResult(null)
    try {
      const out: string[] = []
      for (const file of Array.from(files)) {
        setImportProgress(`${file.name} …`)
        const buf = await file.arrayBuffer()
        const res = await fetch(`/api/knowledge/upload?name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: buf,
        })
        // SSE stream: parse data: lines for the final done/error message
        const text = await res.text()
        const last = text.split('\n').filter((l) => l.startsWith('data: ')).pop()
        let msg = `✅ ${file.name}`
        try {
          if (last) {
            const data = JSON.parse(last.slice(6)) as { step?: string; message?: string; error?: string }
            if (data.error) msg = `❌ ${file.name} — ${data.error}`
            else if (data.message) msg = data.message
          }
        } catch { /* keep default */ }
        out.push(msg)
      }
      setImportResult(out.join('\n'))
      await load()
    } catch (e) {
      setImportResult(`❌ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setImporting(false)
      setImportProgress(null)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const handleUrlImport = async () => {
    if (!urlInput.trim()) return
    setImporting(true)
    try {
      const r = await api.importKnowledgeUrl(urlInput.trim())
      setImportResult(r.ok ? (r.message ?? `✅ ${urlInput}`) : `❌ ${r.error}`)
      if (r.ok) setUrlInput('')
      await load()
    } catch (e) {
      setImportResult(`❌ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setImporting(false)
    }
  }

  const handleTestSearch = async () => {
    if (!testQuery.trim()) return
    setSearching(true)
    try {
      const r = await api.knowledgeSearch(testQuery.trim(), view?.knowledge.topK ?? 5)
      if (r.ok && r.results && r.results.length > 0) {
        setTestResults(r.results.map((hit, i) => `[${i + 1} · ${hit.score.toFixed(2)}]\n${hit.text.slice(0, 300)}`).join('\n\n---\n\n'))
      } else {
        setTestResults(r.ok ? '(no results)' : `Error: ${r.error}`)
      }
    } catch (e) {
      setTestResults(`Error: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSearching(false)
    }
  }

  const togglePreview = async (id: string) => {
    if (previewId === id) {
      setPreviewId(null)
      setPreviewChunks([])
      return
    }
    setPreviewId(id)
    try {
      const r = await api.knowledgeSourceChunks(id, 20)
      if (r.ok) setPreviewChunks(r.chunks)
    } catch { setPreviewChunks([]) }
  }

  if (!view) return <div className="panel"><span className="faint">Loading…</span></div>
  const enabled = view.knowledge.enabled

  return (
    <div className="panel">
      {toast && <div className="faint" style={{ marginBottom: 8 }}>{toast}</div>}
      <h3 style={{ margin: '0 0 4px' }}>{t('settings.kb.title')}</h3>
      <div className="faint" style={{ marginBottom: 12 }}>{t('settings.kb.desc')}</div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <label className="faint" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => void saveKnowledge({ enabled: e.target.checked })} />
          <b style={{ color: 'var(--text)' }}>{t('settings.kb.enable')}</b>
        </label>
        <span className="faint" style={{ fontSize: 12 }}>sources {stats.sourceCount} · chunks {stats.chunkCount} · embedded {stats.embeddedCount}</span>
      </div>

      <div style={{ opacity: enabled ? undefined : 0.55 }}>
        {(['embedding', 'reranker'] as const).map((ptype) => (
          <div key={ptype} style={{ marginBottom: 12 }}>
            <h4 style={{ margin: '8px 0 4px' }}>{t(ptype === 'embedding' ? 'settings.kb.embedding' : 'settings.kb.reranker')}</h4>
            <div className="faint" style={{ fontSize: 12, marginBottom: 8 }}>{t(ptype === 'embedding' ? 'settings.kb.embeddingHint' : 'settings.kb.rerankerHint')}</div>
            {PRESET_KNOWLEDGE_PROVIDERS.filter((p) => p.providerType === ptype).map((preset) => (
              <KnowledgeProviderCard key={preset.providerId} preset={preset} view={view} onSaved={setView} disabled={!enabled} />
            ))}
          </div>
        ))}

        <div style={{ marginBottom: 12 }}>
          <h4 style={{ margin: '8px 0 4px' }}>{t('settings.kb.upload')}</h4>
          <input ref={fileRef} type="file" accept={ACCEPTED_KNOWLEDGE_FORMATS} multiple disabled={importing || !enabled} onChange={(e) => void uploadFiles(e.target.files)} />
          {importProgress && <span className="faint" style={{ marginLeft: 8 }}>{importProgress}</span>}
        </div>

        <div style={{ marginBottom: 12 }}>
          <h4 style={{ margin: '8px 0 4px' }}>{t('settings.kb.urlImport')}</h4>
          <div style={{ display: 'flex', gap: 8 }}>
            <input type="text" value={urlInput} onChange={(e) => setUrlInput(e.target.value)} placeholder={t('settings.kb.urlPlaceholder')} disabled={!enabled} style={{ flex: 1 }} />
            <button type="button" onClick={() => void handleUrlImport()} disabled={importing || !urlInput.trim() || !enabled}>{t('settings.kb.import')}</button>
          </div>
        </div>

        {importResult && <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{importResult}</pre>}

        {sources.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <h4 style={{ margin: '8px 0 4px' }}>{t('settings.kb.sources')} ({sources.length})</h4>
            {sources.map((s, i) => (
              <div key={s.id} className="panel" style={{ margin: '0 0 8px', padding: '8px 12px' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className="mono faint" style={{ fontSize: 12 }}>#{i + 1}</span>
                  <span style={{ fontSize: 13 }} title={s.name}>{s.name}</span>
                  <span className="faint" style={{ fontSize: 12 }}>{s.mediaType} · {s.chunkCount}</span>
                  <span style={{ flex: 1 }} />
                  <button type="button" style={{ fontSize: 12 }} onClick={() => void togglePreview(s.id)} disabled={!enabled}>
                    {previewId === s.id ? t('settings.kb.collapse') : t('settings.kb.preview')}
                  </button>
                  <button type="button" style={{ fontSize: 12 }} onClick={() => { void api.deleteKnowledgeSource(s.id).then(() => void load()) }} disabled={!enabled}>
                    {t('settings.kb.delete')}
                  </button>
                </div>
                {previewId === s.id && (
                  <div style={{ marginTop: 8 }}>
                    {previewChunks.map((c) => (
                      <div key={c.id} className="faint" style={{ fontSize: 12, marginBottom: 6 }}>
                        <span className="mono">#{c.index + 1}</span> {c.text.slice(0, 300)}{c.text.length > 300 ? '…' : ''}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            <button type="button" style={{ fontSize: 12 }} onClick={() => { if (window.confirm('clear all?')) void api.clearKnowledge().then(() => void load()) }} disabled={!enabled}>
              {t('settings.kb.clearAll')}
            </button>
          </div>
        )}

        <div>
          <h4 style={{ margin: '8px 0 4px' }}>{t('settings.kb.searchTest')}</h4>
          <div style={{ display: 'flex', gap: 8 }}>
            <input type="text" value={testQuery} onChange={(e) => setTestQuery(e.target.value)} placeholder={t('settings.kb.searchPlaceholder')} style={{ flex: 1 }} />
            <button type="button" onClick={() => void handleTestSearch()} disabled={!testQuery.trim() || searching}>{searching ? '…' : t('settings.kb.search')}</button>
          </div>
          {testResults && <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, marginTop: 8 }}>{testResults}</pre>}
        </div>
      </div>
    </div>
  )
}

function KnowledgeProviderCard({ preset, view, onSaved, disabled }: {
  preset: typeof PRESET_KNOWLEDGE_PROVIDERS[number]
  view: RetrievalSettingsView
  onSaved: (v: RetrievalSettingsView) => void
  disabled: boolean
}) {
  const t = useT()
  const existing = view.knowledgeProviders.find((p) => p.providerType === preset.providerType && p.providerId === preset.providerId)
  const hasKey = !!existing?.hasKey
  const [expanded, setExpanded] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [modelId, setModelId] = useState(existing?.modelId ?? preset.defaultModelId)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  useEffect(() => {
    setModelId(existing?.modelId ?? preset.defaultModelId)
  }, [existing?.modelId, preset.defaultModelId])

  const save = async (patch: { enabled?: boolean; apiKey?: string; clearKey?: boolean; modelId?: string }) => {
    const pendingKey = apiKey.trim()
    const outgoing = { ...patch }
    if (!outgoing.clearKey && outgoing.apiKey === undefined && pendingKey) outgoing.apiKey = pendingKey
    const r = await api.saveRetrievalSettings({
      knowledgeProviders: [{ providerType: preset.providerType, providerId: preset.providerId, baseUrl: preset.baseUrl, ...outgoing }],
    })
    onSaved(r.settings)
    if (outgoing.clearKey) setApiKey('')
  }

  return (
    <div className="panel" style={{ margin: '0 0 8px', opacity: existing?.enabled ? undefined : 0.7 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }} onClick={() => setExpanded(!expanded)}>
        <input
          type="checkbox" checked={!!existing?.enabled} disabled={disabled}
          onChange={(e) => { e.stopPropagation(); void save({ enabled: e.target.checked }).catch(() => undefined) }}
          onClick={(e) => e.stopPropagation()}
        />
        <b style={{ fontSize: 13 }}>{preset.displayName}</b>
        <span className="faint" style={{ fontSize: 12 }}>{preset.desc}</span>
        <span style={{ flex: 1 }} />
        {hasKey
          ? <span className="src-badge src-live">{t('settings.llm.configured')}</span>
          : <span className="src-badge src-fixture">{t('settings.llm.needKey')}</span>}
        <span className="faint" style={{ fontSize: 11 }}>{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
          <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
            <span className="faint">Base URL</span>
            <input type="text" value={preset.baseUrl} readOnly disabled style={{ background: 'var(--bg, #f5f5f5)' }} />
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
            <span className="faint">API Key {hasKey && !apiKey ? '(stored — leave blank to keep)' : ''}</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={preset.keyPlaceholder} style={{ flex: 1 }} />
              <button type="button" style={{ fontSize: 12 }} disabled={!apiKey.trim()} onClick={() => void save({ apiKey: apiKey.trim(), modelId, enabled: true }).then(() => setResult(t('settings.kb.saved'))).catch((e: unknown) => setResult(String(e instanceof Error ? e.message : e)))}>
                {t('settings.kb.save')}
              </button>
              {hasKey && (
                <button type="button" style={{ fontSize: 12 }} onClick={() => void save({ clearKey: true, enabled: false }).then(() => setResult(t('settings.kb.saved')))}>
                  {t('settings.kb.clearKey')}
                </button>
              )}
            </div>
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
            <span className="faint">{t('settings.kb.modelId')}</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <input type="text" value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder={preset.defaultModelId} style={{ flex: 1 }} />
              <button type="button" style={{ fontSize: 12 }} onClick={() => void save({ modelId }).then(() => setResult(t('settings.kb.saved')))}>
                {t('settings.kb.save')}
              </button>
            </div>
          </label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" style={{ fontSize: 12 }} disabled={testing || (!apiKey.trim() && !hasKey)} onClick={() => {
              setTesting(true)
              setResult(null)
              const key = apiKey.trim() || '__stored__'
              const test = async () => {
                // useStoredKey path is not available for knowledge test; require a visible key or stored flag
                if (!apiKey.trim() && !hasKey) throw new Error('apiKey required')
                // when testing the stored key, send a save-free probe via the visible input only
                if (!apiKey.trim()) throw new Error('enter key to test (stored key is masked)')
                return api.testKnowledgeProvider(preset.providerType, preset.baseUrl, apiKey.trim(), modelId)
              }
              void test().then((r) => setResult(r.ok ? '✅ OK' : `❌ ${r.error ?? ''}`)).catch((e: unknown) => setResult(`❌ ${e instanceof Error ? e.message : String(e)}`)).finally(() => setTesting(false))
              void key
            }}>
              {testing ? t('settings.kb.testing') : t('settings.kb.test')}
            </button>
            {result && <span className="faint" style={{ fontSize: 12 }}>{result}</span>}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Search API tab (ported from patentExaminator SearchProvidersConfigPanel) ──

function SearchTab() {
  const t = useT()
  const [view, setView] = useState<RetrievalSettingsView | null>(null)
  const [editingKey, setEditingKey] = useState<SearchProviderId | null>(null)
  const [keyInput, setKeyInput] = useState('')
  const [secretInput, setSecretInput] = useState('')
  const [editingUrl, setEditingUrl] = useState<SearchProviderId | null>(null)
  const [urlInput, setUrlInput] = useState('')
  const [verifying, setVerifying] = useState<SearchProviderId | null>(null)
  const [verifyResult, setVerifyResult] = useState<Record<string, { ok: boolean; message?: string; error?: string }>>({})
  const [toast, setToast] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await api.retrievalSettings()
      setView(r.settings)
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  if (!view) return <div className="panel"><span className="faint">Loading…</span></div>

  const getProvider = (id: SearchProviderId) => view.searchProviders.find((p) => p.providerId === id)
  const save = async (providerId: SearchProviderId, patch: { enabled?: boolean; apiKey?: string; clearKey?: boolean; baseUrl?: string }) => {
    const r = await api.saveRetrievalSettings({ searchProviders: [{ providerId, ...patch }] })
    setView(r.settings)
  }

  const handleVerify = async (id: SearchProviderId, useStored: boolean, typedKey: string, baseUrl?: string) => {
    setVerifying(id)
    try {
      const r = await api.verifySearchKey(id, typedKey, baseUrl, useStored)
      setVerifyResult((prev) => ({ ...prev, [id]: { ok: r.ok, message: r.message, error: r.error } }))
    } catch (e) {
      setVerifyResult((prev) => ({ ...prev, [id]: { ok: false, error: e instanceof Error ? e.message : String(e) } }))
    } finally {
      setVerifying(null)
    }
  }

  return (
    <div className="panel">
      {toast && <div className="faint" style={{ marginBottom: 8 }}>{toast}</div>}
      <h3 style={{ margin: '0 0 4px' }}>{t('settings.search.title')}</h3>
      <div className="faint" style={{ marginBottom: 12 }}>{t('settings.search.desc')}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {PRESET_SEARCH_PROVIDERS.map((preset) => {
          const provider = getProvider(preset.id)
          const hasKey = !!provider?.hasKey
          const vResult = verifyResult[preset.id]
          return (
            <div key={preset.id} className="panel" style={{ margin: 0, opacity: provider?.enabled ? undefined : 0.65 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <b style={{ fontSize: 13 }}>{preset.displayName}</b>
                <span className="faint" style={{ fontSize: 12 }}>{preset.desc}</span>
                <span style={{ flex: 1 }} />
                <label className="faint" style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12 }}>
                  <input type="checkbox" checked={!!provider?.enabled} onChange={(e) => void save(preset.id, { enabled: e.target.checked }).catch((err: unknown) => setToast(err instanceof Error ? err.message : String(err)))} />
                  {t('settings.search.enabled')}
                </label>
                {hasKey
                  ? <span className="src-badge src-live">{t('settings.search.configured')}</span>
                  : <span className="src-badge src-fixture">{t('settings.search.notConfigured')}</span>}
              </div>
              <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
                <div style={{ fontSize: 12 }}>
                  <span className="faint">Endpoint: </span>
                  {preset.id === 'serper' ? (
                    editingUrl === preset.id ? (
                      <span style={{ display: 'inline-flex', gap: 6 }}>
                        <input type="text" value={urlInput} onChange={(e) => setUrlInput(e.target.value)} placeholder={preset.baseUrl} style={{ width: 260 }} />
                        <button type="button" style={{ fontSize: 12 }} onClick={() => { void save(preset.id, { baseUrl: urlInput }).then(() => { setEditingUrl(null); setUrlInput('') }) }}>{t('settings.search.save')}</button>
                        <button type="button" style={{ fontSize: 12 }} onClick={() => { setEditingUrl(null); setUrlInput('') }}>{t('settings.search.cancel')}</button>
                      </span>
                    ) : (
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <span className="mono faint">{provider?.baseUrl || preset.baseUrl}</span>
                        <button type="button" style={{ fontSize: 12 }} onClick={() => { setEditingUrl(preset.id); setUrlInput(provider?.baseUrl || '') }}>{t('settings.search.edit')}</button>
                      </span>
                    )
                  ) : (
                    <span className="mono faint">{preset.baseUrl}</span>
                  )}
                </div>
                <div style={{ fontSize: 12 }}>
                  <span className="faint">API Key: </span>
                  {editingKey === preset.id ? (
                    preset.id === 'epo' ? (
                      <span style={{ display: 'inline-flex', gap: 6 }}>
                        <input type="password" autoComplete="off" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} placeholder="Consumer Key" />
                        <input type="password" autoComplete="off" value={secretInput} onChange={(e) => setSecretInput(e.target.value)} placeholder="Consumer Secret" />
                        <button type="button" style={{ fontSize: 12 }} onClick={() => { void save(preset.id, { apiKey: `${keyInput}:${secretInput}` }).then(() => { setEditingKey(null); setKeyInput(''); setSecretInput('') }) }}>{t('settings.search.save')}</button>
                        <button type="button" style={{ fontSize: 12 }} onClick={() => { setEditingKey(null); setKeyInput(''); setSecretInput('') }}>{t('settings.search.cancel')}</button>
                      </span>
                    ) : (
                      <span style={{ display: 'inline-flex', gap: 6 }}>
                        <input type="password" autoComplete="off" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} placeholder={preset.keyPlaceholder} style={{ width: 240 }} />
                        <button type="button" style={{ fontSize: 12 }} onClick={() => { void save(preset.id, { apiKey: keyInput }).then(() => { setEditingKey(null); setKeyInput('') }) }}>{t('settings.search.save')}</button>
                        <button type="button" style={{ fontSize: 12 }} onClick={() => { setEditingKey(null); setKeyInput('') }}>{t('settings.search.cancel')}</button>
                      </span>
                    )
                  ) : (
                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      <span className={hasKey ? '' : 'faint'}>{hasKey ? t('settings.search.configured') : t('settings.search.notConfigured')}</span>
                      <button type="button" style={{ fontSize: 12 }} onClick={() => { setEditingKey(preset.id); setKeyInput(''); setSecretInput('') }}>{hasKey ? t('settings.search.edit') : t('settings.search.save')}</button>
                      {hasKey && (
                        <>
                          <button type="button" style={{ fontSize: 12 }} disabled={verifying === preset.id} onClick={() => void handleVerify(preset.id, true, '', provider?.baseUrl)}>
                            {verifying === preset.id ? t('settings.search.verifying') : t('settings.search.verify')}
                          </button>
                          <button type="button" style={{ fontSize: 12 }} onClick={() => void save(preset.id, { clearKey: true, enabled: false })}>clear</button>
                        </>
                      )}
                    </span>
                  )}
                  {vResult && (
                    <div style={{ color: vResult.ok ? 'var(--green)' : 'var(--red)', marginTop: 4 }}>{vResult.ok ? vResult.message : vResult.error}</div>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
