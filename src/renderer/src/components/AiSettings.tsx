// The key manager: one line per provider, in one view. Its own file because it
// is not part of the chat at all — Welcome.tsx shows it on the start screen,
// before any document is open, and the panel shows it as a full-surface
// takeover. Three props in, one config object out; it shares nothing with the
// conversation state.
//
// Layout rule (Emil, 2026-08-07): what you meet first is AT MOST one block per
// provider. The two that need more than a key — Azure (key + endpoint +
// deployment + api-version) and the local server (URL + model id) — are folded
// into a disclosure row, so four loose Azure fields can never again read as
// four unrelated providers. «Skjul tomme» collapses the list to what is
// actually in use once anything is.
//
// Keys never reach this component: it posts plaintext to the main process once
// on save and reads back only `hasKey` flags. Keep it that way — no key value
// may be held in renderer state beyond the field the user is typing into.
import { useEffect, useState } from 'react'
import type { AiConfigView, AiProviderId, LocalServiceId } from '../../../shared/types'
import { bridge } from '../bridge'
import { t, useLang } from '../i18n'
import { DEFAULT_AZURE_API_VERSION } from '../../../shared/defaults'
import { DEFAULT_MODELS, keyProviders, KEY_CONSOLE_LABELS, KEY_CONSOLE_URLS } from './ai-models'
import { LOCAL_SERVICES } from '../../../shared/ai-provider-profile'
import { IconChevronDown } from './icons'

/** The providers that need more than one input, and so get a disclosure row
 *  instead of a bare field. Everything else is name + key, one block. */
const MULTI_FIELD: AiProviderId[] = ['azure', 'ollama', 'lmstudio', 'compat']

const LOCAL_IDS = Object.keys(LOCAL_SERVICES) as LocalServiceId[]

interface SettingsProps {
  config: AiConfigView
  onSaved(next: AiConfigView): void
  onClose(): void
}

/** Key manager: one view with every provider's key field stacked — fill in
 *  the keys you have, leave the rest empty. Model and reasoning effort are
 *  NOT here: they are picked from the header chip's menu in the chat. */
export function AiSettings({ config, onSaved, onClose }: SettingsProps): React.JSX.Element {
  useLang()
  const [keys, setKeys] = useState<Record<AiProviderId, string>>({
    anthropic: '',
    openai: '',
    azure: '',
    openrouter: '',
    gemini: '',
    xai: '',
    mistral: '',
    groq: '',
    ollama: '',
    lmstudio: '',
    compat: '',
    mock: ''
  })
  const [endpoint, setEndpoint] = useState(config.azure.endpoint)
  const [deployment, setDeployment] = useState(config.azure.deployment)
  const [apiVersion, setApiVersion] = useState(config.azure.apiVersion)
  const [compatUrl, setCompatUrl] = useState(config.compat.baseUrl)
  const [compatModel, setCompatModel] = useState(config.models.compat)
  // The named local servers: their endpoint ('' = our default) and model id.
  // Same two fields as the custom endpoint — the difference is that these two
  // come with an address that already works.
  const [localUrl, setLocalUrl] = useState<Record<LocalServiceId, string>>({ ...config.local })
  const [localModel, setLocalModel] = useState<Record<LocalServiceId, string>>({
    ollama: config.models.ollama,
    lmstudio: config.models.lmstudio
  })
  const [saving, setSaving] = useState(false)
  const [ollamaFound, setOllamaFound] = useState(false)
  // Which disclosure rows are unfolded. Folding is display only — the fields
  // keep their state while hidden, and save posts them either way.
  const [open, setOpen] = useState<AiProviderId[]>([])
  // Hiding the empty providers is offered only once something is set up — with
  // nothing configured it would empty the list. It starts OFF either way: the
  // full list is what you came for, and hiding is the deliberate second step.
  const anyConfigured = keyProviders().some(({ id }) => config.hasKey[id])
  const [hideEmpty, setHideEmpty] = useState(false)

  // Auto-detection: one quiet probe of Ollama's default port. no-cors on
  // purpose — we only need "is something listening", and an opaque response
  // resolves in every context this component runs in (file://, extension page,
  // dev server) while a refused connection rejects. Never runs against an
  // already-configured Ollama.
  useEffect(() => {
    if (config.models.ollama) return
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1500)
    fetch('http://localhost:11434/api/version', { mode: 'no-cors', signal: controller.signal })
      .then(() => setOllamaFound(true))
      .catch(() => {})
      .finally(() => clearTimeout(timer))
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
    // mount-only probe; the config is fixed for this panel's lifetime
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const save = async (): Promise<void> => {
    setSaving(true)
    // Any endpoint-backed provider whose URL or model changed is a reason to
    // refetch model lists below — a new local model id is as much a "there is
    // something new to list" as a first key.
    const endpointChanged =
      compatUrl.trim() !== config.compat.baseUrl ||
      compatModel.trim() !== config.models.compat ||
      LOCAL_IDS.some(
        (p) => localUrl[p].trim() !== config.local[p] || localModel[p].trim() !== config.models[p]
      )
    const patch: Parameters<typeof bridge.aiSetConfig>[0] = {
      // apiVersion '' = use the app's built-in default (placeholder shows it)
      azure: { endpoint: endpoint.trim(), deployment: deployment.trim(), apiVersion: apiVersion.trim() },
      compat: { baseUrl: compatUrl.trim() },
      local: { ollama: localUrl.ollama.trim(), lmstudio: localUrl.lmstudio.trim() },
      models: {
        ...config.models,
        compat: compatModel.trim(),
        ollama: localModel.ollama.trim(),
        lmstudio: localModel.lmstudio.trim()
      }
    }
    for (const { id } of keyProviders()) {
      if (keys[id].trim()) (patch.keys ??= {})[id] = keys[id].trim()
    }
    let next = await bridge.aiSetConfig(patch)
    // If the active provider can't do real AI — it's the mock, or a real
    // provider still without a key — switch to the first real provider that now
    // has a key, so the chat is usable right after saving the very first key.
    // (mock's hasKey is always true, so it must be handled explicitly here or
    // saving a key while on the default mock provider would never switch away.
    // compat's hasKey means "endpoint + model configured", so an unconfigured
    // compat can never win this pick.)
    if (next.provider === 'mock' || !next.hasKey[next.provider]) {
      const first = keyProviders().find((p) => next.hasKey[p.id])?.id
      if (first) {
        next = await bridge.aiSetConfig({
          provider: first,
          models: { ...next.models, [first]: next.models[first] || DEFAULT_MODELS[first] || '' }
        })
      }
    }
    // A new key — or a changed compat endpoint — is the moment the live model
    // list becomes fetchable — refresh now so the model menu is current the
    // first time it opens.
    if (patch.keys || endpointChanged) next = await bridge.aiRefreshModels(true)
    setSaving(false)
    onSaved(next)
  }

  // The plain-web preview cannot store keys at all — just say so
  if (!config.keysSupported) {
    return (
      <div className="ai-settings">
        <p className="ai-settings-note">{t('ai.calloutMock')}</p>
        <div className="ai-settings-actions">
          <button className="btn-secondary" onClick={onClose}>
            {t('app.cancel')}
          </button>
        </div>
      </div>
    )
  }

  const toggleOpen = (id: AiProviderId): void =>
    setOpen((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  const isLocal = (id: AiProviderId): id is LocalServiceId => LOCAL_IDS.includes(id as LocalServiceId)

  // The key field itself — identical for every provider, so the disclosure rows
  // and the plain rows share exactly one implementation. `label` is the
  // provider's own name on a plain row, and a plain «API-nøkkel» inside a
  // disclosure body, where the row above already carries the name.
  const keyless = (id: AiProviderId): boolean => id === 'compat' || isLocal(id)

  const keyField = (id: AiProviderId, label: string): React.JSX.Element => (
    // The keyless rows' key is the one that needs explaining — «optional» begs
    // the question of when it is not. On hover, not printed under the field.
    <label className="ai-field" title={keyless(id) ? t('ai.keyLocalTip') : undefined}>
      <span>{label}</span>
      <input
        type="password"
        value={keys[id]}
        placeholder={
          // For the local servers and the custom endpoint, hasKey means
          // "ready", not "key stored" — their key is genuinely optional, so
          // the field always says exactly that
          keyless(id)
            ? t('ai.keyOptional')
            : config.hasKey[id]
              ? t('ai.keySaved')
              : t('ai.keyNew')
        }
        onChange={(e) => setKeys((k) => ({ ...k, [id]: e.target.value }))}
        spellCheck={false}
      />
    </label>
  )

  // The two fields an endpoint-backed provider needs. For the local servers
  // the address is prefilled by us and only worth touching for a non-default
  // port or a server on another machine; for the custom one it is the whole
  // point, so it comes first there too but starts empty.
  const endpointFields = (
    id: LocalServiceId | 'compat',
    url: string,
    setUrl: (v: string) => void,
    model: string,
    setModel: (v: string) => void
  ): React.JSX.Element => (
    <>
      <label className="ai-field">
        <span>{t('ai.baseUrl')}</span>
        <input
          value={url}
          placeholder={id === 'compat' ? 'http://…/v1' : LOCAL_SERVICES[id].baseUrl}
          onChange={(e) => setUrl(e.target.value)}
          spellCheck={false}
        />
      </label>
      <label className="ai-field">
        <span>{t('ai.compatModelId')}</span>
        <input
          value={model}
          placeholder={
            // A service-appropriate example — the id format differs per
            // server, and a wrong-shaped guess is the likeliest stumble here
            id === 'compat' ? t('ai.compatModelHint') : LOCAL_SERVICES[id].modelHint
          }
          onChange={(e) => setModel(e.target.value)}
          spellCheck={false}
        />
      </label>
      {keyField(id, t('ai.apiKey'))}
    </>
  )

  // What a folded row says about itself, so it is worth reading before opening
  const summary = (id: AiProviderId): string => {
    if (id === 'azure') {
      const ready =
        (config.hasKey.azure || keys.azure.trim() !== '') &&
        endpoint.trim() !== '' &&
        deployment.trim() !== ''
      return ready ? t('ai.stateReady') : t('ai.stateOff')
    }
    if (isLocal(id)) {
      // The model id IS the state here: the address already works, so what
      // decides whether this server can answer is which model you picked
      const model = localModel[id].trim()
      if (model) return model
      return ollamaFound && id === 'ollama' ? t('ai.stateRunning') : t('ai.stateOff')
    }
    const url = compatUrl.trim()
    if (!url || !compatModel.trim()) return t('ai.stateOff')
    return url.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  }

  // Everything, or only what is in use. A row the user unfolded stays visible
  // even while empty — it is being filled in right now.
  const rows = keyProviders().filter(
    ({ id }) => !hideEmpty || config.hasKey[id] || open.includes(id)
  )

  return (
    <div className="ai-settings">
      <div className="ai-settings-head">
        <div className="ai-settings-heading">{t('ai.keysTitle')}</div>
        {anyConfigured && (
          <label className="theme-menu-toggle ai-settings-filter">
            <input
              type="checkbox"
              checked={hideEmpty}
              onChange={(e) => setHideEmpty(e.target.checked)}
            />
            {t('ai.hideEmpty')}
          </label>
        )}
      </div>
      <p className="ai-field-hint">
        {t('ai.keyCapHint')}{' '}
        {t('ai.keyConsoleHint')}{' '}
        {keyProviders()
          .filter(({ id }) => KEY_CONSOLE_URLS[id])
          .map(({ id }, i) => (
            <span key={id}>
              {i > 0 && ' · '}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault()
                  bridge.openExternal(KEY_CONSOLE_URLS[id]!)
                }}
              >
                {KEY_CONSOLE_LABELS[id] ?? id}
              </a>
            </span>
          ))}
      </p>
      {rows.map(({ id, name }) => {
        if (!MULTI_FIELD.includes(id))
          return (
            <div className="ai-field-group" key={id}>
              {keyField(id, name)}
            </div>
          )
        const isOpen = open.includes(id)
        return (
          <div className="ai-field-group" key={id}>
            {/* Same shape as every other provider — name above, one control
                below, flush left. The control is a closed drawer instead of a
                key field: it states where the setup stands and opens onto the
                fields, which then sit in the same column as everything else. */}
            <div className="ai-field">
              <span>{name}</span>
              <button
                type="button"
                className={`ai-provider-row${isOpen ? ' is-open' : ''}`}
                aria-expanded={isOpen}
                onClick={() => toggleOpen(id)}
              >
                <span className="ai-provider-state">{summary(id)}</span>
                <IconChevronDown size={14} className="ai-provider-caret" />
              </button>
            </div>
            {isOpen && (
              <div className="ai-provider-body">
                {id === 'azure' && (
                  <>
                    {keyField(id, t('ai.apiKey'))}
                    <label className="ai-field">
                      <span>{t('ai.endpoint')}</span>
                      <input
                        value={endpoint}
                        placeholder="https://…openai.azure.com"
                        onChange={(e) => setEndpoint(e.target.value)}
                        spellCheck={false}
                      />
                    </label>
                    <label className="ai-field">
                      <span>{t('ai.deployment')}</span>
                      <input
                        value={deployment}
                        onChange={(e) => setDeployment(e.target.value)}
                        spellCheck={false}
                      />
                    </label>
                    <label className="ai-field">
                      <span>{t('ai.apiVersion')}</span>
                      <input
                        value={apiVersion}
                        placeholder={DEFAULT_AZURE_API_VERSION}
                        onChange={(e) => setApiVersion(e.target.value)}
                        spellCheck={false}
                      />
                    </label>
                  </>
                )}
                {isLocal(id) && (
                  <>
                    {/* One line on what this row is, before the fields */}
                    <p className="ai-field-hint">{t('ai.localHint')}</p>
                    {id === 'ollama' && ollamaFound && !localModel.ollama.trim() && (
                      <p className="ai-field-hint">{t('ai.ollamaDetected')}</p>
                    )}
                    {endpointFields(
                      id,
                      localUrl[id],
                      (v) => setLocalUrl((u) => ({ ...u, [id]: v })),
                      localModel[id],
                      (v) => setLocalModel((m) => ({ ...m, [id]: v }))
                    )}
                  </>
                )}
                {id === 'compat' && (
                  <>
                    {/* The explanation ABOVE the fields: what this row is for,
                        in one line, since it is the one nobody arrives at by
                        recognising a name */}
                    <p className="ai-field-hint">{t('ai.compatHint')}</p>
                    {endpointFields(id, compatUrl, setCompatUrl, compatModel, setCompatModel)}
                  </>
                )}
              </div>
            )}
          </div>
        )
      })}
      <p className="ai-settings-note">
        {t('ai.settingsNote')}
        {/* One sentence per storage mode, saying what actually protects the key
            here. Only the two modes that leave it unprotected on disk, or forget
            it on quit, are emphasised — the OS-keystore case is the quiet
            default and does not need to shout. */}
        {config.keyStorage === 'os-keystore' && t('ai.keyStoreOs')}
        {config.keyStorage === 'browser-nonextractable' && t('ai.keyStoreBrowser')}
        {config.keyStorage === 'session-only' && <strong>{t('ai.keyStoreSession')}</strong>}
        {config.keyStorage === 'plaintext' && <strong>{t('ai.keyStorePlain')}</strong>}
      </p>
      <div className="ai-settings-actions">
        <button className="btn-secondary" onClick={onClose}>
          {t('app.cancel')}
        </button>
        <button className="btn-primary" disabled={saving} onClick={() => void save()}>
          {t('app.save')}
        </button>
      </div>
    </div>
  )
}
