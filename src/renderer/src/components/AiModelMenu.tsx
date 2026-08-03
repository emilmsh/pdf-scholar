// The popover under the chat header's model chip: pick a model (across all
// providers at once) and the reasoning effort. Split out of AiPanel.tsx because
// it is a self-contained popover with a four-prop interface and one job —
// building the cross-provider option list is fiddly enough to deserve reading
// on its own, and none of it touches the conversation.
//
// It writes config straight through to the main process and hands the result
// back via onSaved; it holds no config state of its own, so the panel header
// and this menu can never disagree about the active model.
import { useEffect, useRef } from 'react'
import type { AiConfigView, AiProviderId, ThinkingLevel } from '../../../shared/types'
import { PROVIDER_PROFILES } from '../../../shared/ai-provider-profile'
import { bridge } from '../bridge'
import { t, useLang } from '../i18n'
import { useDismissable } from '../useDismissable'
import { KEY_PROVIDERS, MODELS, modelOptions, THINKING_LEVELS } from './ai-models'

interface ModelMenuProps {
  config: AiConfigView
  onSaved(next: AiConfigView): void
  onClose(): void
  onOpenSettings(): void
}

/** Popover under the header model chip: EVERY provider's models in one flat
 *  list (keyless providers greyed out) plus reasoning effort. Selecting a
 *  model from another provider switches provider too — the chat history is
 *  resent in full on the next question, so mid-chat switches are safe.
 *  Keys/providers are managed in the key settings (button at the bottom). */
export function ModelQuickMenu({ config, onSaved, onClose, onOpenSettings }: ModelMenuProps): React.JSX.Element {
  useLang()
  const ref = useRef<HTMLDivElement>(null)
  // Was the one surface in the app with no Escape path at all; the shared hook
  // gives it one, and switches mousedown -> pointerdown so touch works too.
  useDismissable(ref, true, onClose)

  const provider = config.provider
  const model = config.models[provider] ?? ''
  const anyKey = KEY_PROVIDERS.some((p) => config.hasKey[p.id])
  // The provider profile decides whether a reasoning control exists at all;
  // Haiku is the model-level exception (ignores effort) within Anthropic
  const thinkingApplies = PROVIDER_PROFILES[provider].thinking !== 'none' && !/haiku/i.test(model)

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

  const groups = KEY_PROVIDERS.map(({ id, name }) => {
    // Curated list merged with the live catalog: new provider models appear on
    // their own; entries the provider no longer lists get a warning marker.
    const merged = modelOptions(id, config.catalog)
    const options = merged.map((m) => ({
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
    // A custom model id typed in an older version still shows up
    if (id === provider && id !== 'azure' && model && !merged.some((m) => m.id === model))
      options.push({ value: `${id}:${model}`, label: model, hint: undefined })
    return { id: id as string, name, options, enabled: config.hasKey[id] }
    // Platforms that cannot store keys (plain-web preview) hide the keyless
    // real providers instead of greying them — there is no way to enable them
  }).filter((g) => g.options.length > 0 && (config.keysSupported || g.enabled))
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
          {/* The closed select echoes the selected model's hint on hover */}
          <select
            value={value}
            title={(() => {
              const cur = modelOptions(provider, config.catalog).find((m) => m.id === model)
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
      <button className="ai-model-more" onClick={onOpenSettings}>
        {anyKey ? t('ai.keysTitle') : t('ai.calloutCta')}
      </button>
    </div>
  )
}
