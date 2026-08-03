// The key manager: every provider's API-key field stacked in one view, plus
// Azure's endpoint/deployment. Its own file because it is not part of the chat
// at all — Welcome.tsx shows it on the start screen, before any document is
// open, and the panel shows it as a full-surface takeover. Three props in, one
// config object out; it shares nothing with the conversation state.
//
// Keys never reach this component: it posts plaintext to the main process once
// on save and reads back only `hasKey` flags. Keep it that way — no key value
// may be held in renderer state beyond the field the user is typing into.
import { useEffect, useState } from 'react'
import type { AiConfigView, AiProviderId } from '../../../shared/types'
import { bridge } from '../bridge'
import { t, useLang } from '../i18n'
import { DEFAULT_AZURE_API_VERSION } from '../../../shared/defaults'
import { compatPresets, DEFAULT_MODELS, keyProviders, SPEND_CAP_URLS } from './ai-models'

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
    compat: '',
    mock: ''
  })
  const [endpoint, setEndpoint] = useState(config.azure.endpoint)
  const [deployment, setDeployment] = useState(config.azure.deployment)
  const [apiVersion, setApiVersion] = useState(config.azure.apiVersion)
  const [compatUrl, setCompatUrl] = useState(config.compat.baseUrl)
  const [compatModel, setCompatModel] = useState(config.models.compat)
  const [saving, setSaving] = useState(false)
  const [ollamaFound, setOllamaFound] = useState(false)

  // Auto-detection: when nothing is configured yet, one quiet probe of
  // Ollama's default port. no-cors on purpose — we only need "is something
  // listening", and an opaque response resolves in every context this
  // component runs in (file://, extension page, dev server) while a refused
  // connection rejects. Never runs against a configured setup.
  useEffect(() => {
    if (config.compat.baseUrl) return
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
    // mount-only probe; config.compat.baseUrl is fixed for this panel's lifetime
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const save = async (): Promise<void> => {
    setSaving(true)
    const compatChanged =
      compatUrl.trim() !== config.compat.baseUrl || compatModel.trim() !== config.models.compat
    const patch: Parameters<typeof bridge.aiSetConfig>[0] = {
      // apiVersion '' = use the app's built-in default (placeholder shows it)
      azure: { endpoint: endpoint.trim(), deployment: deployment.trim(), apiVersion: apiVersion.trim() },
      compat: { baseUrl: compatUrl.trim() },
      models: { ...config.models, compat: compatModel.trim() }
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
    if (patch.keys || compatChanged) next = await bridge.aiRefreshModels(true)
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

  return (
    <div className="ai-settings">
      <div className="ai-settings-heading">{t('ai.keysTitle')}</div>
      <p className="ai-field-hint">
        {t('ai.keyCapHint')}{' '}
        {keyProviders()
          .filter(({ id }) => SPEND_CAP_URLS[id])
          .map(({ id }, i) => (
            <span key={id}>
              {i > 0 && ' · '}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault()
                  bridge.openExternal(SPEND_CAP_URLS[id]!)
                }}
              >
                {id === 'anthropic' ? 'Anthropic' : id === 'openai' ? 'OpenAI' : 'Azure'}
              </a>
            </span>
          ))}
      </p>
      {keyProviders().map(({ id, name }) => (
        <div className="ai-field-group" key={id}>
          <label className="ai-field">
            <span>{name}</span>
            <input
              type="password"
              value={keys[id]}
              placeholder={
                // compat's hasKey means "ready", not "key stored" — its key is
                // genuinely optional, so the field always says exactly that
                id === 'compat'
                  ? t('ai.keyOptional')
                  : config.hasKey[id]
                    ? t('ai.keySaved')
                    : t('ai.keyNew')
              }
              onChange={(e) => setKeys((k) => ({ ...k, [id]: e.target.value }))}
              spellCheck={false}
            />
          </label>
          {id === 'azure' && (
            <>
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
          {id === 'compat' && (
            <>
              {ollamaFound && !compatUrl.trim() && (
                <p className="ai-field-hint">
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault()
                      setCompatUrl('http://localhost:11434/v1')
                    }}
                  >
                    {t('ai.ollamaDetected')}
                  </a>
                </p>
              )}
              <label className="ai-field">
                <span>{t('ai.compatPreset')}</span>
                {/* Prefills the URL field, nothing more — the field below stays
                    the single source of truth and is freely editable */}
                <select
                  value={compatPresets().find((p) => p.url === compatUrl.trim())?.url ?? ''}
                  onChange={(e) => {
                    if (e.target.value) setCompatUrl(e.target.value)
                  }}
                >
                  <option value="">{t('ai.compatPresetPick')}</option>
                  {compatPresets().map((p) => (
                    <option key={p.url} value={p.url}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="ai-field">
                <span>{t('ai.baseUrl')}</span>
                <input
                  value={compatUrl}
                  placeholder="http://localhost:11434/v1"
                  onChange={(e) => setCompatUrl(e.target.value)}
                  spellCheck={false}
                />
              </label>
              <label className="ai-field">
                <span>{t('ai.compatModelId')}</span>
                <input
                  value={compatModel}
                  placeholder={t('ai.compatModelHint')}
                  onChange={(e) => setCompatModel(e.target.value)}
                  spellCheck={false}
                />
              </label>
              <p className="ai-field-hint">{t('ai.compatHint')}</p>
            </>
          )}
        </div>
      ))}
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
