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
import { compareVendors } from '../../../shared/ai-model-catalog'
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

/** A provider with at most this many models is listed INLINE at the root; a
 *  longer one becomes a row you click into (provider → vendor → model). The
 *  bar is list length, not which provider it is: the curated providers hold 2–4
 *  models each and all of them fit on one screen together, which is the
 *  cross-provider view worth protecting. OpenRouter's ~73 is what breaks it,
 *  and so would a compat endpoint pointed at something equally large. */
const INLINE_MAX = 8

/** Search results are capped — 400 rows of model id help nobody. What the cap
 *  drops is SAID (never silently), and typing more narrows it. */
const RESULT_CAP = 40

/** Which list the menu is showing: the root, a provider's vendors, or one
 *  vendor's models. Filtering overrides all three with a flat result list. */
type MenuView =
  | { level: 'root' }
  | { level: 'vendors'; provider: AiProviderId; name: string }
  | { level: 'models'; provider: AiProviderId; name: string; vendor: string }

interface ModelEntry {
  /** "<provider>:<id>" — what `pick` writes */
  value: string
  label: string
  hint?: string | undefined
  /** The vendor prefix inside an aggregator id (anthropic/claude-… → anthropic) */
  vendor: string
}

interface ProviderGroup {
  id: AiProviderId
  name: string
  /** Has a key (or, for compat, a base URL) — a group without one is a row that
   *  opens the key settings rather than a dead list */
  enabled: boolean
  entries: ModelEntry[]
}

/** Aggregator ids carry a vendor prefix (anthropic/claude-…): group by it so
 *  a huge list reads as sections, not soup. Known vendors get their proper
 *  casing; the rest are capitalised mechanically. */
const VENDOR_NAMES: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  meta: 'Meta',
  'meta-llama': 'Meta',
  mistralai: 'Mistral',
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  'x-ai': 'xAI',
  nvidia: 'NVIDIA',
  // The rest of the vendor level as OpenRouter listed it on 2026-08-13. Only
  // names worth correcting are here — the mechanical fallback handles the
  // others acceptably, and inventing a casing for a company we are unsure
  // about is worse than "Nex-agi".
  moonshotai: 'Moonshot AI',
  'bytedance-seed': 'ByteDance',
  thinkingmachines: 'Thinking Machines',
  minimax: 'MiniMax',
  'z-ai': 'Z.ai',
  rekaai: 'Reka',
  sakana: 'Sakana AI',
  stepfun: 'StepFun',
  perplexity: 'Perplexity',
  amazon: 'Amazon',
  xiaomi: 'Xiaomi',
  openrouter: 'OpenRouter'
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
  // Escape is ours (the hook's documented opt-out): with a level open it has to
  // climb one step rather than close the whole menu, and the hook listens in
  // the capture phase, so a handler inside the menu could never win that race.
  useDismissable(ref, true, onClose, { escape: false })

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
  const [view, setView] = useState<MenuView>({ level: 'root' })
  const listRef = useRef<HTMLDivElement>(null)

  // Entering or leaving a level moves focus to its first row, so the keyboard
  // never lands on nothing after a drill-in — and so a screen reader announces
  // where it now is. Skipped while filtering: focus belongs in the field the
  // user is typing into.
  useEffect(() => {
    if (view.level === 'root') return
    listRef.current?.querySelector<HTMLButtonElement>('[data-menuitem]')?.focus()
  }, [view])

  const back = (): void => {
    setView((v) =>
      v.level === 'models' ? { level: 'vendors', provider: v.provider, name: v.name } : { level: 'root' }
    )
  }

  // One Escape undoes one step: out of a level first, and only from the root
  // out of the menu. Capture phase and on window, exactly where the hook we
  // opted out of listened — anything less loses the race to it.
  useEffect(() => {
    const onEscape = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (view.level !== 'root') back()
      else if (filter.trim() !== '') setFilter('')
      else onClose()
    }
    window.addEventListener('keydown', onEscape, true)
    return () => window.removeEventListener('keydown', onEscape, true)
  }, [view, filter, onClose])

  /** Arrow keys walk the rows, ← climbs back out. */
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowLeft' && view.level !== 'root') {
      back()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[data-menuitem]') ?? [])]
    if (items.length === 0) return
    e.preventDefault()
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = e.key === 'ArrowDown' ? at + 1 : at - 1
    // From the filter field (at === -1) ArrowDown enters the list at the top
    items[((next % items.length) + items.length) % items.length]?.focus()
  }

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

  const searching = filter.trim() !== ''

  /** Every provider's list as one structure. `all` searches past the selection
   *  curateRemoteModels offers — what the menu SHOWS is the selection; what the
   *  filter reaches is everything the endpoint listed. */
  const buildGroups = (all: boolean): ProviderGroup[] => {
    const groups = keyProviders().map(({ id, name }) => {
      // Curated list merged with the live catalog: new provider models appear on
      // their own; entries the provider no longer lists get a warning marker.
      const vendorOf = (modelId: string): string =>
        modelId.includes('/') ? modelId.slice(0, modelId.indexOf('/')) : ''
      const entries: ModelEntry[] = modelOptions(id, config.catalog, config.compat.baseUrl, {
        all
      }).map((m) => ({
        value: `${id}:${m.id}`,
        label: m.missing ? `${m.label} ⚠` : m.label,
        hint: m.missing ? t('ai.modelMissing') : m.hint ? t(m.hint) : undefined,
        vendor: vendorOf(m.id)
      }))
      if (id === 'azure' && config.azure.deployment)
        entries.push({ value: `azure:${config.azure.deployment}`, label: config.azure.deployment, vendor: '' })
      // A stored model outside today's list stays pickable for EVERY provider:
      // the curated-only trim, a shrunk live list (compat server offline) or an
      // id typed by hand must never eat a choice the user already made
      const stored = id === 'azure' ? '' : (config.models[id] ?? '')
      if (stored && !entries.some((o) => o.value === `${id}:${stored}`))
        entries.push({ value: `${id}:${stored}`, label: stored, vendor: vendorOf(stored) })
      // compat opens on the base URL alone: the model that completes the setup
      // is picked from exactly this list once the endpoint's models are fetched
      const enabled = config.hasKey[id] || (id === 'compat' && config.compat.baseUrl.trim() !== '')
      return { id, name, enabled, entries }
      // Platforms that cannot store keys (plain-web preview) hide the keyless
      // real providers instead of greying them — there is no way to enable them.
      //
      // A provider with NO models is still listed (it used to be dropped here,
      // which hid the two that need setting up rather than a key: the custom /
      // local endpoint — Ollama, LM Studio — and Azure. Those have no curated
      // list and nothing live until they are configured, so the one place you
      // would look to find them was the one place that never mentioned them).
    }).filter((g) => config.keysSupported || g.enabled)
    if (provider === 'mock' || !config.keysSupported)
      groups.push({
        id: 'mock' as AiProviderId,
        name: t('ai.providerMock'),
        enabled: true,
        entries: MODELS.mock.map((m) => ({ value: `mock:${m.id}`, label: m.label, vendor: '' }))
      })
    return groups
  }

  const groups = buildGroups(false)
  const totalOptions = groups.reduce((n, g) => n + g.entries.length, 0)
  // The filter field appears only once the combined list is big enough to
  // drown in (an OpenRouter key alone brings hundreds of models)
  const showFilter = searching || totalOptions > FILTER_THRESHOLD
  // Does a live list hold more than the menu offers? Then the field is a search
  // across everything rather than a narrowing of what is on screen, and its
  // placeholder has to say so — otherwise the models the selection leaves out
  // read as gone.
  const offersSelection = keyProviders().some(
    ({ id }) =>
      modelOptions(id, config.catalog, config.compat.baseUrl, { all: true }).length >
      modelOptions(id, config.catalog, config.compat.baseUrl).length
  )

  const group = (id: AiProviderId): ProviderGroup | undefined => groups.find((g) => g.id === id)
  /** One vendor's models inside a provider group. Vendors are ranked by how
   *  likely they are to be wanted (compareVendors), not alphabetically — the
   *  same standard the root menu's provider order already follows. The models
   *  inside keep the order curateRemoteModels produced: strongest first. */
  const vendorsOf = (g: ProviderGroup): { vendor: string; entries: ModelEntry[] }[] => {
    const byVendor = new Map<string, ModelEntry[]>()
    for (const e of g.entries) {
      const list = byVendor.get(e.vendor) ?? []
      list.push(e)
      byVendor.set(e.vendor, list)
    }
    return [...byVendor.entries()]
      .sort(([a], [b]) => compareVendors(a, b))
      .map(([vendor, entries]) => ({ vendor, entries }))
  }

  // Flat search results across every provider, from the UNFILTERED lists
  const f = filter.trim().toLowerCase()
  const hits = searching
    ? buildGroups(true).flatMap((g) =>
        g.entries
          .filter((e) => e.label.toLowerCase().includes(f) || e.value.toLowerCase().includes(f))
          .map((e) => ({ ...e, group: g }))
      )
    : []

  /** One selectable model. The check mark is the only state a row carries —
   *  picking returns to the root rather than closing, so the choice is visible
   *  and the reasoning/text-size rows stay one glance away. */
  const modelRow = (e: ModelEntry, prefix?: string): React.JSX.Element => (
    <button
      key={e.value}
      className={`ai-menu-item${e.value === value ? ' is-picked' : ''}`}
      role="menuitemradio"
      aria-checked={e.value === value}
      data-menuitem
      // The row's identity for tests: "<provider>:<id>", what a picked <option>
      // used to carry as its value (scripts/test-ai-settings.mjs)
      data-value={e.value}
      title={e.hint}
      onClick={() => {
        pick(e.value)
        setFilter('')
        setView({ level: 'root' })
      }}
    >
      <span className="ai-menu-check">{e.value === value ? '✓' : ''}</span>
      <span className="ai-menu-label">
        {prefix && <span className="ai-menu-prefix">{prefix}</span>}
        {e.label}
      </span>
    </button>
  )

  /** A provider row: what it is on one line, what state it is in underneath.
   *  Stacked rather than side by side because both halves can be long —
   *  «Egendefinert / lokal (OpenAI-kompatibel)» next to a count truncated the
   *  name down to «Open…», which is the one word a row like this must keep. */
  const providerRow = (
    key: string,
    label: string,
    detail: string,
    go: () => void,
    kind: 'drill' | 'locked'
  ): React.JSX.Element => (
    <button
      key={key}
      className={`ai-menu-item is-${kind}`}
      role="menuitem"
      data-menuitem
      onClick={go}
    >
      {/* No check gutter here: a provider row is a peer of the section
          headings, not of the models under one. Carrying the gutter indented
          it to model depth and flattened the two levels into each other. */}
      <span className="ai-menu-stack">
        <span className="ai-menu-label">{label}</span>
        <span className="ai-menu-detail">{detail}</span>
      </span>
      {kind === 'drill' && <span className="ai-menu-chevron">›</span>}
    </button>
  )

  const picker = (): React.JSX.Element => {
    // Filtering answers across every provider at once — the level structure is
    // for browsing, and a search that only looked inside the level you happen
    // to stand in would be a worse tool than the flat list this replaced.
    if (searching)
      return (
        <div className="ai-menu-list" role="menu" ref={listRef}>
          {hits.length === 0 && <p className="ai-menu-empty">{t('ai.modelNoHits')}</p>}
          {hits.slice(0, RESULT_CAP).map((h) => modelRow(h, `${h.group.name} · `))}
          {hits.length > RESULT_CAP && (
            <p className="ai-menu-empty">{t('ai.modelMoreHits', { n: hits.length - RESULT_CAP })}</p>
          )}
        </div>
      )
    if (view.level === 'vendors') {
      const g = group(view.provider)
      return (
        <div className="ai-menu-list" role="menu" ref={listRef}>
          {vendorsOf(g ?? { id: view.provider, name: view.name, enabled: true, entries: [] }).map(
            ({ vendor, entries }) =>
              vendor
                ? providerRow(
                    vendor,
                    vendorLabel(vendor),
                    t('ai.modelCountShort', { models: entries.length }),
                    () =>
                      setView({ level: 'models', provider: view.provider, name: view.name, vendor }),
                    'drill'
                  )
                : // Ids with no vendor prefix have nowhere further to go
                  entries.map((e) => modelRow(e))
          )}
        </div>
      )
    }
    if (view.level === 'models') {
      const entries = group(view.provider)?.entries.filter((e) => e.vendor === view.vendor) ?? []
      return (
        <div className="ai-menu-list" role="menu" ref={listRef}>
          {entries.map((e) => modelRow(e))}
        </div>
      )
    }
    return (
      <div className="ai-menu-list" role="menu" ref={listRef}>
        {groups.map((g) => {
          // Nothing to pick yet. The row is not dead — it is the shortest path
          // to the one thing that would fix it, and it says WHICH thing:
          // Anthropic and the hosted services want a key, while the custom /
          // local endpoint and Azure want an address before a key means
          // anything. A configured endpoint that lists nothing is a third
          // state again (server down, or nothing pulled yet).
          if (!g.enabled || g.entries.length === 0)
            return (
              <div key={g.id} className="ai-menu-group">
                {providerRow(
                  g.id,
                  g.name,
                  !g.enabled
                    ? g.id === 'compat' || g.id === 'azure'
                      ? t('ai.notConfigured')
                      : t('ai.keyMissing')
                    : t('ai.noModelsListed'),
                  onOpenSettings,
                  'locked'
                )}
              </div>
            )
          const vendors = vendorsOf(g)
          // A long list becomes one row you click into; a short one is listed
          // where it is, so the curated providers stay comparable at a glance.
          if (g.entries.length > INLINE_MAX && vendors.length > 1)
            return (
              <div key={g.id} className="ai-menu-group">
                {providerRow(
                  g.id,
                  g.name,
                  t('ai.modelCount', { models: g.entries.length, vendors: vendors.length }),
                  () => setView({ level: 'vendors', provider: g.id, name: g.name }),
                  'drill'
                )}
              </div>
            )
          return (
            <div key={g.id} className="ai-menu-group">
              <div className="ai-menu-head">{g.name}</div>
              {g.entries.map((e) => modelRow(e))}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="ai-model-menu" ref={ref} onKeyDown={onKeyDown}>
      {view.level !== 'root' && (
        <button className="ai-menu-back" data-menuitem onClick={back}>
          ‹ {view.level === 'models' ? vendorLabel(view.vendor) : view.name}
        </button>
      )}
      {anyKey || provider === 'mock' || !config.keysSupported ? (
        <div className="ai-field">
          {view.level === 'root' && <span>{t('ai.model')}</span>}
          {showFilter && view.level === 'root' && (
            <input
              value={filter}
              placeholder={t(offersSelection ? 'ai.modelFilterAll' : 'ai.modelFilter')}
              onChange={(e) => setFilter(e.target.value)}
              spellCheck={false}
              autoFocus
            />
          )}
          {picker()}
        </div>
      ) : (
        // No key anywhere: nothing to pick yet — send them to the key manager
        <p className="ai-model-menu-note">{t('ai.noKeysYet')}</p>
      )}
      {view.level === 'root' && thinkingApplies && (
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
      <div
        className="ai-field"
        title={t('ai.textSizeWheelTip')}
        hidden={view.level !== 'root'}
      >
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
      {view.level === 'root' && (
        <button className="ai-model-more" onClick={onOpenSettings}>
          {anyKey ? t('ai.keysTitle') : t('ai.calloutCta')}
        </button>
      )}
    </div>
  )
}
