// The key manager: every provider's API-key field stacked in one view, plus
// Azure's endpoint/deployment. Its own file because it is not part of the chat
// at all — Welcome.tsx shows it on the start screen, before any document is
// open, and the panel shows it as a full-surface takeover. Three props in, one
// config object out; it shares nothing with the conversation state.
//
// Keys never reach this component: it posts plaintext to the main process once
// on save and reads back only `hasKey` flags. Keep it that way — no key value
// may be held in renderer state beyond the field the user is typing into.
import { useState } from 'react'
import type { AiConfigView, AiProviderId } from '../../../shared/types'
import { bridge } from '../bridge'
import { t, useLang } from '../i18n'
import { DEFAULT_AZURE_API_VERSION } from '../../../shared/defaults'
import { DEFAULT_MODELS, KEY_CREATE_URLS, KEY_PROVIDERS, SPEND_CAP_URLS } from './ai-models'

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
    mock: ''
  })
  const [endpoint, setEndpoint] = useState(config.azure.endpoint)
  const [deployment, setDeployment] = useState(config.azure.deployment)
  const [apiVersion, setApiVersion] = useState(config.azure.apiVersion)
  const [saving, setSaving] = useState(false)

  const save = async (): Promise<void> => {
    setSaving(true)
    const patch: Parameters<typeof bridge.aiSetConfig>[0] = {
      // apiVersion '' = use the app's built-in default (placeholder shows it)
      azure: { endpoint: endpoint.trim(), deployment: deployment.trim(), apiVersion: apiVersion.trim() }
    }
    for (const { id } of KEY_PROVIDERS) {
      if (keys[id].trim()) (patch.keys ??= {})[id] = keys[id].trim()
    }
    let next = await bridge.aiSetConfig(patch)
    // If the active provider can't do real AI — it's the mock, or a real
    // provider still without a key — switch to the first real provider that now
    // has a key, so the chat is usable right after saving the very first key.
    // (mock's hasKey is always true, so it must be handled explicitly here or
    // saving a key while on the default mock provider would never switch away.)
    if (next.provider === 'mock' || !next.hasKey[next.provider]) {
      const first = KEY_PROVIDERS.find((p) => next.hasKey[p.id])?.id
      if (first) {
        next = await bridge.aiSetConfig({
          provider: first,
          models: { ...next.models, [first]: next.models[first] || DEFAULT_MODELS[first] || '' }
        })
      }
    }
    // A new key is the moment the live model list becomes fetchable — refresh
    // now so the model menu is current the first time it opens.
    if (patch.keys) next = await bridge.aiRefreshModels(true)
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
      <p className="ai-field-hint">{t('ai.keyCapHint')}</p>
      {KEY_PROVIDERS.map(({ id, name }) => (
        <div className="ai-field-group" key={id}>
          <label className="ai-field">
            <span>{name}</span>
            <input
              type="password"
              value={keys[id]}
              placeholder={config.hasKey[id] ? t('ai.keySaved') : t('ai.keyNew')}
              onChange={(e) => setKeys((k) => ({ ...k, [id]: e.target.value }))}
              spellCheck={false}
            />
          </label>
          {/* Each provider's doors, right where they are needed: create the key,
              then cap it. Azure has no create page — prose says where keys live. */}
          <p className="ai-field-hint">
            {id === 'azure' && <>{t('ai.azureKeyHint')} </>}
            {KEY_CREATE_URLS[id] && (
              <>
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault()
                    bridge.openExternal(KEY_CREATE_URLS[id]!)
                  }}
                >
                  {t('ai.keyCreate')}
                </a>
                {' · '}
              </>
            )}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault()
                bridge.openExternal(SPEND_CAP_URLS[id]!)
              }}
            >
              {t('ai.keyCap')}
            </a>
          </p>
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
