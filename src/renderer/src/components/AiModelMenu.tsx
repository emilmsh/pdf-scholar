// The popover under the chat header's model chip: pick a model (across all
// providers at once) and the reasoning effort. Split out of AiPanel.tsx because
// it is a self-contained popover with a four-prop interface and one job —
// building the cross-provider option list is fiddly enough to deserve reading
// on its own, and none of it touches the conversation.
//
// It writes config straight through to the main process and hands the result
// back via onSaved; it holds no config state of its own, so the panel header
// and this menu can never disagree about the active model.
import { useEffect, useRef, useState } from 'react'
import type { AiConfigView, AiProviderId, ThinkingLevel } from '../../../shared/types'
import { OPENAI_REASONING_RE, PROVIDER_PROFILES } from '../../../shared/ai-provider-profile'
import { bridge } from '../bridge'
import { t, useLang } from '../i18n'
import {
  AI_SCALE_DEFAULT,
  AI_SCALE_MAX,
  AI_SCALE_MIN,
  aiTextScaleLabel,
  stepAiTextScale
} from '../ai-text-scale'
import { useDismissable } from '../useDismissable'
import { keyProviders, MODELS, modelOptions, THINKING_LEVELS } from './ai-models'

/** Show the filter field once the combined list gets this big (an OpenRouter
 *  key alone brings hundreds of models) */
const FILTER_THRESHOLD = 25

/** Aggregator ids carry a vendor prefix (anthropic/claude-…): group by it so
 *  a huge list reads as sections, not soup. Known vendors get their proper
 *  casing; the rest are capitalised mechanically. */
const VENDOR_NAMES: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  'meta-llama': 'Meta',
  mistralai: 'Mistral',
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  'x-ai': 'xAI',
  nvidia: 'NVIDIA'
}
const vendorLabel = (v: string): string => VENDOR_NAMES[v] ?? v.charAt(0).toUpperCase() + v.slice(1)

interface ModelMenuProps {
  config: AiConfigView
  /** Conversation text-size scale — owned by the panel, adjusted here */
  textScale: number
  onTextScale(next: number): void
  onSaved(next: AiConfigView): void
  onClose(): void
  onOpenSettings(): void
}

/** Popover under the header model chip: EVERY provider's models in one flat
 *  list (keyless providers greyed out) plus reasoning effort. Selecting a
 *  model from another provider switches provider too — the chat history is
 *  resent in full on the next question, so mid-chat switches are safe.
 *  Keys/providers are managed in the key settings (button at the bottom). */
export function ModelQuickMenu({
  config,
  textScale,
  onTextScale,
  onSaved,
  onClose,
  onOpenSettings
}: ModelMenuProps): React.JSX.Element {
  useLang()
  const ref = useRef<HTMLDivElement>(null)
  // Was the one surface in the app with no Escape path at all; the shared hook
  // gives it one, and switches mousedown -> pointerdown so touch works too.
  useDismissable(ref, true, onClose)

  const provider = config.provider
  const model = config.models[provider] ?? ''
  const anyKey = keyProviders().some((p) => config.hasKey[p.id])
  // The provider profile decides whether a reasoning control exists at all;
  // within that, model-level exceptions keep the selector honest: Haiku
  // ignores effort, and every effort-style provider only shows the selector
  // for ids the request actually sends the parameter to (same regex request
  // shaping uses — a visible selector wired to nothing is a lie). Azure is
  // the one exemption: deployment names are opaque, so the selector shows
  // and a misfire is caught by the degrade-on-400 net.
  const thinkingApplies =
    PROVIDER_PROFILES[provider].thinking !== 'none' &&
    !/haiku/i.test(model) &&
    (PROVIDER_PROFILES[provider].thinking !== 'effort' ||
      provider === 'azure' ||
      OPENAI_REASONING_RE.test(model))
  const [filter, setFilter] = useState('')

  const patch = (p: Parameters<typeof bridge.aiSetConfig>[0]): void => {
    void bridge.aiSetConfig(p).then(onSaved)
  }

  // Freshen the live model list while the menu is open. TTL-gated in the
  // backend, so with a recent snapshot this resolves immediately with the
  // current view; after a real fetch the new models flow back through onSaved
  // and the list re-renders in place.
  useEffect(() => {
    void bridge.aiRefreshModels().then(onSaved)
    // mount-only: refreshing once per menu open is exactly the cadence we want
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // One flat <select> across providers; option values are "<provider>:<id>".
  // Azure has no curated list — its configured deployment is the entry.
  const value = provider === 'azure' ? `azure:${config.azure.deployment}` : `${provider}:${model}`
  const pick = (v: string): void => {
    const sep = v.indexOf(':')
    const p = v.slice(0, sep) as AiProviderId
    const id = v.slice(sep + 1)
    patch(p === 'azure' ? { provider: p } : { provider: p, models: { ...config.models, [p]: id } })
  }

  const groups = keyProviders().flatMap(({ id, name }) => {
    // Curated list merged with the live catalog: new provider models appear on
    // their own; entries the provider no longer lists get a warning marker.
    const merged = modelOptions(id, config.catalog, config.compat.baseUrl)
    let options = merged.map((m) => ({
      value: `${id}:${m.id}`,
      label: m.missing ? `${m.label} ⚠` : m.label,
      hint: m.missing ? t('ai.modelMissing') : m.hint ? t(m.hint) : undefined
    }))
    if (id === 'azure' && config.azure.deployment)
      options.push({
        value: `azure:${config.azure.deployment}`,
        label: config.azure.deployment,
        hint: undefined
      })
    // A stored model outside today's list stays pickable for EVERY provider:
    // the curated-only trim, a shrunk live list (compat server offline) or an
    // id typed by hand must never eat a choice the user already made
    const stored = id === 'azure' ? '' : (config.models[id] ?? '')
    if (stored && !options.some((o) => o.value === `${id}:${stored}`))
      options.push({ value: `${id}:${stored}`, label: stored, hint: undefined })
    // compat opens on the base URL alone: the model that completes the setup
    // is picked from exactly this list once the endpoint's models are fetched
    const enabled =
      config.hasKey[id] || (id === 'compat' && config.compat.baseUrl.trim() !== '')
    if (filter.trim()) {
      const f = filter.trim().toLowerCase()
      options = options.filter(
        (o) => o.label.toLowerCase().includes(f) || o.value.toLowerCase().includes(f)
      )
    }
    // Aggregator lists (OpenRouter) are sectioned by their vendor/ prefix so
    // hundreds of models read as sections, not soup. Native selects cannot
    // nest optgroups, but flat sibling groups with a shared name prefix carry
    // the same structure.
    const vendorOf = (value: string): string => {
      const modelId = value.slice(id.length + 1)
      return modelId.includes('/') ? modelId.slice(0, modelId.indexOf('/')) : ''
    }
    const vendors = new Set(options.map((o) => vendorOf(o.value)))
    if (options.length > 12 && vendors.size > 2) {
      const byVendor = new Map<string, typeof options>()
      for (const o of options) {
        const vendor = vendorOf(o.value)
        const list = byVendor.get(vendor) ?? []
        list.push(o)
        byVendor.set(vendor, list)
      }
      return [...byVendor.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([vendor, opts]) => ({
          id: `${id}:${vendor}`,
          name: vendor ? `${name} — ${vendorLabel(vendor)}` : name,
          options: opts,
          enabled
        }))
    }
    return [{ id: id as string, name, options, enabled }]
    // Platforms that cannot store keys (plain-web preview) hide the keyless
    // real providers instead of greying them — there is no way to enable them
  }).filter((g) => g.options.length > 0 && (config.keysSupported || g.enabled))
  // The filter field appears only once the combined list is big enough to
  // drown in (an OpenRouter key alone brings hundreds of models)
  const totalOptions = groups.reduce((n, g) => n + g.options.length, 0)
  const showFilter = filter.trim() !== '' || totalOptions > FILTER_THRESHOLD
  if (provider === 'mock' || !config.keysSupported)
    groups.push({
      id: 'mock',
      name: t('ai.providerMock'),
      options: MODELS.mock.map((m) => ({ value: `mock:${m.id}`, label: m.label, hint: undefined })),
      enabled: true
    })

  return (
    <div className="ai-model-menu" ref={ref}>
      {anyKey || provider === 'mock' || !config.keysSupported ? (
        <label className="ai-field">
          <span>{t('ai.model')}</span>
          {showFilter && (
            <input
              value={filter}
              placeholder={t('ai.modelFilter')}
              onChange={(e) => setFilter(e.target.value)}
              spellCheck={false}
            />
          )}
          {/* The closed select echoes the selected model's hint on hover */}
          <select
            value={value}
            title={(() => {
              const cur = modelOptions(provider, config.catalog, config.compat.baseUrl).find((m) => m.id === model)
              if (cur?.missing) return t('ai.modelMissing')
              return cur?.hint ? t(cur.hint) : undefined
            })()}
            onChange={(e) => pick(e.target.value)}
          >
            {groups.map((g) => (
              <optgroup key={g.id} label={g.enabled ? g.name : `${g.name} — ${t('ai.keyMissing')}`}>
                {g.options.map((o) => (
                  <option key={o.value} value={o.value} disabled={!g.enabled} title={o.hint}>
                    {o.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      ) : (
        // No key anywhere: nothing to pick yet — send them to the key manager
        <p className="ai-model-menu-note">{t('ai.noKeysYet')}</p>
      )}
      {thinkingApplies && (
        <label className="ai-field">
          <span>{t('ai.reasoning')}</span>
          <select
            value={config.thinking}
            onChange={(e) => patch({ thinking: e.target.value as ThinkingLevel })}
          >
            {THINKING_LEVELS.map((l) => (
              <option key={l.id} value={l.id}>
                {t(l.key)}
              </option>
            ))}
          </select>
        </label>
      )}
      {/* Conversation text size: fixed steps, not a slider. The hover title is
          the only place the Ctrl+scroll gesture is advertised — a permanent
          hint line would cost real estate in a narrow menu. */}
      <div className="ai-field" title={t('ai.textSizeWheelTip')}>
        <span>{t('ai.textSize')}</span>
        <div className="ai-scale-row">
          <button
            className="ai-scale-btn"
            title={t('ai.textSmallerTip')}
            disabled={textScale <= AI_SCALE_MIN}
            onClick={() => onTextScale(stepAiTextScale(textScale, -1))}
          >
            −
          </button>
          <span className="ai-scale-value">{aiTextScaleLabel(textScale)}</span>
          <button
            className="ai-scale-btn"
            title={t('ai.textLargerTip')}
            disabled={textScale >= AI_SCALE_MAX}
            onClick={() => onTextScale(stepAiTextScale(textScale, 1))}
          >
            +
          </button>
          {textScale !== AI_SCALE_DEFAULT && (
            <button className="ai-scale-reset" onClick={() => onTextScale(AI_SCALE_DEFAULT)}>
              {t('ai.textSizeReset')}
            </button>
          )}
        </div>
      </div>
      <button className="ai-model-more" onClick={onOpenSettings}>
        {anyKey ? t('ai.keysTitle') : t('ai.calloutCta')}
      </button>
    </div>
  )
}
